import { watch } from "chokidar";
import { resolve, extname } from "path";
import { config } from "../config.js";
import { ingestFile } from "../ingest/pipeline.js";
import { getDb, getCollectionByName } from "../storage/index.js";
import { deleteDocument } from "../storage/collections.js";
import { invalidateCollection } from "../query/cache.js";
import { getGraphDb } from "../storage/graph-sqlite.js";
import { deleteSourceData } from "../relations/ingest-hook.js";
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
  /** Optional extension filter (e.g., [".md", ".pdf"]). If set, only these are ingested. */
  fileTypes?: string[];
}

const DEFAULT_DEBOUNCE = 2000;
const MAX_CONCURRENT_INGESTS = config.watch.maxConcurrent;
const MAX_QUEUE_SIZE = config.watch.maxQueue;
const supportedExts = new Set(getSupportedExtensions());

function log(msg: string): void {
  logger.info(msg);
}

function logError(msg: string): void {
  logger.error(msg);
}

/**
 * File watcher service.
 * Monitors directories for new/changed files and auto-ingests them into ThreadClaw.
 */
export class ThreadClawWatcher {
  private watchers: ReturnType<typeof watch>[] = [];
  private configs: WatchConfig[];
  private processing = new Set<string>();

  /** Optional callback invoked when the underlying watcher emits an error. */
  onError?: (err: Error) => void;

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
          // Windows protected junction points inside user folders
          "**/My Videos/**",
          "**/My Music/**",
          "**/My Pictures/**",
          "**/My Documents/**",
          "**/Application Data/**",
          "**/Local Settings/**",
          "**/Cookies/**",
          "**/NetHood/**",
          "**/PrintHood/**",
          "**/Recent/**",
          "**/SendTo/**",
          "**/Templates/**",
          "**/Start Menu/**",
          ...(config.watch.excludePatterns
            ? config.watch.excludePatterns.split(",").map((p) => p.trim()).filter(Boolean)
            : []),
        ],
      });

      watcher.on("add", (filePath) => this.handleFile(filePath, wc));
      watcher.on("change", (filePath) => this.handleFile(filePath, wc));
      watcher.on("unlink", (filePath) => this.handleUnlink(filePath, wc));

      watcher.on("error", (err) => {
        logError(`Watcher error: ${err}`);
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
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
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private handleFile(filePath: string, wc: WatchConfig): void {
    const ext = extname(filePath).toLowerCase();
    if (!supportedExts.has(ext)) return;
    // If the watch config specifies allowed file types, enforce them
    if (wc.fileTypes?.length && !wc.fileTypes.some((ft) => ext === (ft.startsWith(".") ? ft.toLowerCase() : `.${ft.toLowerCase()}`))) return;

    // Skip if already processing this file
    if (this.processing.has(filePath)) return;

    // awaitWriteFinish already debounces — enqueue directly
    if (this.ingestQueue.length >= MAX_QUEUE_SIZE) {
      logger.warn(`Watcher queue full (${MAX_QUEUE_SIZE}), dropping: ${filePath.split(/[\\/]/).pop()}`);
      return;
    }
    this.ingestQueue.push({ filePath, wc });
    this.drainQueue();
  }

  /** Handle file deletion — remove document from index. */
  private handleUnlink(filePath: string, wc: WatchConfig): void {
    const ext = extname(filePath).toLowerCase();
    if (!supportedExts.has(ext)) return;
    if (this.processing.has(filePath)) return; // Don't remove mid-ingest

    try {
      const db = getDb(resolve(config.dataDir, "threadclaw.db"));
      const collectionName = wc.collection ?? config.defaults.collection;
      const collection = getCollectionByName(db, collectionName);
      if (!collection) return;

      const doc = db.prepare(
        "SELECT id FROM documents WHERE source_path = ? AND collection_id = ?",
      ).get(resolve(filePath), collection.id) as { id: string } | undefined;

      if (doc) {
        deleteDocument(db, doc.id);

        // Clean up graph data for deleted document
        if (config.relations.enabled) {
          try {
            const graphDb = getGraphDb(config.relations.graphDbPath);
            deleteSourceData(graphDb, "document", doc.id);
          } catch (graphErr) {
            logger.warn({ filePath, error: String(graphErr) }, "Failed to clean up graph data for deleted file");
          }
        }

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
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.retryPending = false;
          this.drainQueue();
        }, 5000);
        this.retryTimer.unref();
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
    // Cancel pending circuit-breaker retry
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.retryPending = false;
    }

    // Drain the ingest queue (discard pending items)
    this.ingestQueue.length = 0;

    // Wait for active ingests to finish (up to 10s)
    const deadline = Date.now() + 10_000;
    while (this.activeIngests > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    for (const watcher of this.watchers) {
      await watcher.close();
    }
    this.watchers = [];
    log("Watcher stopped.");
  }
}
