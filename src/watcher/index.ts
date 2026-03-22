import { watch } from "chokidar";
import { resolve, extname } from "path";
import { config } from "../config.js";
import { ingestFile } from "../ingest/pipeline.js";
import { getDb, getCollectionByName } from "../storage/index.js";
import { deleteDocument } from "../storage/collections.js";
import { invalidateCollection } from "../query/cache.js";
import { getSupportedExtensions } from "../ingest/parsers/index.js";
import { isCircuitBreakerOpen } from "../embeddings/client.js";
import { logger } from "../utils/logger.js";

export interface WatchConfig {
  /** Directories to watch */
  paths: string[];
  /** Collection to ingest into */
  collection: string;
  /** Tags to apply */
  tags?: string[];
  /** Debounce delay in ms (avoid re-ingesting during active saves) */
  debounceMs?: number;
  /** Whether to ingest existing files on startup */
  ingestExisting?: boolean;
}

const DEFAULT_DEBOUNCE = 2000;
const MAX_CONCURRENT_INGESTS = 5;
const MAX_QUEUE_SIZE = 1000;
const supportedExts = new Set(getSupportedExtensions());

function log(msg: string): void {
  logger.info(msg);
}

function logError(msg: string): void {
  logger.error(msg);
}

/**
 * File watcher service.
 * Monitors directories for new/changed files and auto-ingests them into ClawCore.
 */
// Module-level singleton guard — survives hot reload, multiple instances, test isolation
if (!process.listeners("unhandledRejection").some((l) => (l as any).__clawcoreWatcher)) {
  const handler = (err: unknown) => { logger.error(`Watcher unhandled rejection: ${err}`); };
  (handler as any).__clawcoreWatcher = true;
  process.on("unhandledRejection", handler);
}

export class ClawCoreWatcher {
  private watchers: ReturnType<typeof watch>[] = [];
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private configs: WatchConfig[];
  private processing = new Set<string>();

  constructor(configs: WatchConfig[]) {
    this.configs = configs;
  }

  async start(): Promise<void> {
    for (const wc of this.configs) {
      log(`Watching: ${wc.paths.join(", ")} -> collection "${wc.collection}"`);

      const watcher = watch(wc.paths, {
        persistent: true,
        ignoreInitial: !wc.ingestExisting,
        awaitWriteFinish: {
          stabilityThreshold: wc.debounceMs ?? DEFAULT_DEBOUNCE,
          pollInterval: 500,
        },
        ignored: [
          "**/node_modules/**",
          "**/.git/**",
          "**/.*",
          "**/.venv/**",
          "**/venv/**",
          "**/__pycache__/**",
          "**/site-packages/**",
          "**/dist-packages/**",
          "**/.tox/**",
          "**/.mypy_cache/**",
          "**/.pytest_cache/**",
          "**/build/**",
          "**/dist/**",
          "**/*.tmp",
          "**/*.swp",
          "**/*.db",
          "**/*.db-journal",
          "**/*.db-wal",
        ],
      });

      watcher.on("add", (filePath) => this.handleFile(filePath, wc));
      watcher.on("change", (filePath) => this.handleFile(filePath, wc));
      watcher.on("unlink", (filePath) => this.handleUnlink(filePath, wc));

      watcher.on("error", (err) => {
        logError(`Watcher error: ${err}`);
      });

      watcher.on("ready", () => {
        log("Watcher ready. Waiting for changes...");
      });

      this.watchers.push(watcher);
    }
  }

  private ingestQueue: { filePath: string; wc: WatchConfig }[] = [];
  private activeIngests = 0;
  private retryPending = false;

  private handleFile(filePath: string, wc: WatchConfig): void {
    const ext = extname(filePath).toLowerCase();
    if (!supportedExts.has(ext)) return;

    // Skip if already processing this file
    if (this.processing.has(filePath)) return;

    // Debounce: if the same file changes rapidly, only ingest once
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      if (this.ingestQueue.length >= MAX_QUEUE_SIZE) {
        logger.warn(`Watcher queue full (${MAX_QUEUE_SIZE}), dropping: ${filePath.split(/[\\/]/).pop()}`);
        return;
      }
      this.ingestQueue.push({ filePath, wc });
      this.drainQueue();
    }, wc.debounceMs ?? DEFAULT_DEBOUNCE);

    this.debounceTimers.set(filePath, timer);
  }

  /** Handle file deletion — remove document from index. */
  private handleUnlink(filePath: string, wc: WatchConfig): void {
    const ext = extname(filePath).toLowerCase();
    if (!supportedExts.has(ext)) return;
    if (this.processing.has(filePath)) return; // Don't remove mid-ingest

    try {
      const db = getDb(resolve(config.dataDir, "clawcore.db"));
      const collectionName = wc.collection ?? config.defaults.collection;
      const collection = getCollectionByName(db, collectionName);
      if (!collection) return;

      const doc = db.prepare(
        "SELECT id FROM documents WHERE source_path = ? AND collection_id = ?",
      ).get(filePath, collection.id) as { id: string } | undefined;

      if (doc) {
        deleteDocument(db, doc.id);
        invalidateCollection(collectionName);
        logger.info({ filePath }, "Document removed (file deleted)");
      }
    } catch (err) {
      logger.warn({ filePath, error: String(err) }, "Failed to remove deleted file from index");
    }
  }

  private drainQueue(): void {
    // Pause ingestion while the embedding server is unreachable
    if (isCircuitBreakerOpen()) {
      // Single retry timer — prevents unbounded setTimeout chains during outages
      if (!this.retryPending) {
        this.retryPending = true;
        setTimeout(() => {
          this.retryPending = false;
          this.drainQueue();
        }, 5000);
      }
      return;
    }

    while (this.activeIngests < MAX_CONCURRENT_INGESTS && this.ingestQueue.length > 0) {
      const item = this.ingestQueue.shift()!;
      if (this.processing.has(item.filePath)) continue;
      this.processing.add(item.filePath);
      this.activeIngests++;

      this.ingestSafe(item.filePath, item.wc).finally(() => {
        this.processing.delete(item.filePath);
        this.activeIngests--;
        queueMicrotask(() => this.drainQueue());
      });
    }
  }

  private async ingestSafe(filePath: string, wc: WatchConfig): Promise<void> {
    const name = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;

    try {
      log(`Ingesting: ${name}`);
      const result = await ingestFile(filePath, {
        collection: wc.collection,
        tags: wc.tags,
      });

      if (result.duplicatesSkipped > 0) {
        log(`  ${name} — unchanged, skipped`);
      } else if (result.documentsUpdated > 0) {
        log(`  ${name} — updated (${result.chunksCreated} chunks, ${result.elapsedMs}ms)`);
      } else {
        log(`  ${name} — ingested (${result.chunksCreated} chunks, ${result.elapsedMs}ms)`);
      }
    } catch (err) {
      logError(`Failed to ingest ${name}: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) {
        logError(err.stack);
      }
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const watcher of this.watchers) {
      await watcher.close();
    }
    this.watchers = [];
    log("Watcher stopped.");
  }
}
