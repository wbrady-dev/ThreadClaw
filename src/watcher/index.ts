import { watch } from "chokidar";
import { resolve, extname, basename } from "path";
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
  /** Additional glob patterns to exclude (merged with global excludes) */
  excludePatterns?: string[];
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
/** Exponential backoff delays for retry queue (attempts 1, 2, 3) */
const RETRY_DELAYS = [5_000, 30_000, 120_000];
const MAX_RETRY_ATTEMPTS = 3;

export class ThreadClawWatcher {
  private watchers: ReturnType<typeof watch>[] = [];
  private configs: WatchConfig[];
  private processing = new Set<string>();
  private retryQueue = new Map<string, { attempts: number; nextRetry: number; wc: WatchConfig }>();
  private retryDrainTimer: ReturnType<typeof setTimeout> | null = null;

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
        followSymlinks: false, // Prevent infinite loops from symlink cycles
        awaitWriteFinish: {
          stabilityThreshold: wc.debounceMs ?? DEFAULT_DEBOUNCE,
          pollInterval: 500,
        },
        ignored: [
          "**/node_modules/**",
          "**/.git/**",
          "**/.DS_Store",
          "**/.gitignore",
          "**/.env",
          "**/.env.*",
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
          // OpenClaw runtime (gateway, sessions, credentials, services, browser data)
          "**/.openclaw/**",
          // ThreadClaw runtime data
          "**/.threadclaw/**",
          // Obsidian vault internals
          "**/.obsidian/**",
          "**/.trash/**",
          ...(config.watch.excludePatterns
            ? config.watch.excludePatterns.split(",").map((p) => p.trim()).filter(Boolean)
            : []),
          ...(wc.excludePatterns ?? []),
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
    // Normalize file path for consistent processing set lookups
    const normalizedPath = resolve(filePath);
    const ext = extname(normalizedPath).toLowerCase();
    if (!supportedExts.has(ext)) return;
    // If the watch config specifies allowed file types, enforce them
    if (wc.fileTypes?.length && !wc.fileTypes.some((ft) => ext === (ft.startsWith(".") ? ft.toLowerCase() : `.${ft.toLowerCase()}`))) return;

    // Skip if already processing this file (check both to handle duplicate queue entries)
    if (this.processing.has(normalizedPath)) return;

    // awaitWriteFinish already debounces — enqueue directly
    // Check for duplicate queue entries before checking capacity (prevents
    // dropping a file as "queue full" when it's actually already queued)
    if (this.ingestQueue.some((q) => resolve(q.filePath) === normalizedPath)) return;
    if (this.ingestQueue.length >= MAX_QUEUE_SIZE) {
      logger.warn(`Watcher queue full (${MAX_QUEUE_SIZE}), dropping: ${normalizedPath.split(/[\\/]/).pop()}`);
      return;
    }
    this.ingestQueue.push({ filePath: normalizedPath, wc });
    this.drainQueue();
  }

  /** Handle file deletion — remove document from index. */
  private handleUnlink(filePath: string, wc: WatchConfig): void {
    const normalizedPath = resolve(filePath);
    const ext = extname(normalizedPath).toLowerCase();
    if (!supportedExts.has(ext)) return;
    if (this.processing.has(normalizedPath)) return; // Don't remove mid-ingest

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
        // Use setImmediate instead of queueMicrotask to avoid starving I/O
        setImmediate(() => this.drainQueue());
      });
    }
  }

  private async ingestSafe(filePath: string, wc: WatchConfig): Promise<void> {
    const name = basename(filePath);

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
      this.scheduleRetry(filePath, wc);
    }
  }

  /** Add a failed file to the retry queue with exponential backoff. */
  private scheduleRetry(filePath: string, wc: WatchConfig): void {
    const existing = this.retryQueue.get(filePath);
    const attempts = existing ? existing.attempts + 1 : 1;

    if (attempts > MAX_RETRY_ATTEMPTS) {
      logger.warn({ filePath, attempts: MAX_RETRY_ATTEMPTS }, "Max retry attempts reached — giving up on file");
      this.retryQueue.delete(filePath);
      return;
    }

    const delay = RETRY_DELAYS[attempts - 1] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
    this.retryQueue.set(filePath, { attempts, nextRetry: Date.now() + delay, wc });
    logger.info({ filePath, attempt: attempts, delayMs: delay }, "Scheduled retry for failed ingestion");

    // Ensure the retry drain timer is running
    this.ensureRetryDrainTimer();
  }

  /** Start the retry drain timer if not already running. */
  private ensureRetryDrainTimer(): void {
    if (this.retryDrainTimer) return;
    this.retryDrainTimer = setTimeout(() => {
      this.retryDrainTimer = null;
      this.drainRetryQueue();
    }, 5000);
    this.retryDrainTimer.unref();
  }

  /** Check retry queue for files past their nextRetry time and re-queue them. */
  private drainRetryQueue(): void {
    const now = Date.now();
    for (const [filePath, entry] of this.retryQueue) {
      if (now >= entry.nextRetry) {
        this.retryQueue.delete(filePath);
        logger.info({ filePath, attempt: entry.attempts }, "Retrying failed ingestion");
        // Re-queue through normal path (handleFile checks will be bypassed since
        // the file isn't in processing set and isn't in ingestQueue)
        if (!this.processing.has(filePath) && !this.ingestQueue.some((q) => q.filePath === filePath)) {
          this.ingestQueue.push({ filePath, wc: entry.wc });
        }
      }
    }
    this.drainQueue();

    // Reschedule if there are still items in the retry queue
    if (this.retryQueue.size > 0) {
      this.ensureRetryDrainTimer();
    }
  }

  async stop(): Promise<void> {
    // Cancel pending circuit-breaker retry
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.retryPending = false;
    }

    // Cancel pending retry drain timer
    if (this.retryDrainTimer) {
      clearTimeout(this.retryDrainTimer);
      this.retryDrainTimer = null;
    }
    this.retryQueue.clear();

    // Drain the ingest queue (discard pending items)
    this.ingestQueue.length = 0;

    // Close watchers immediately — don't wait for active ingests to finish.
    // Active ingests will fail gracefully when the DB closes during shutdown.
    // Orphaned chunks (no embeddings) are cleaned on next startup.
    for (const watcher of this.watchers) {
      try { await watcher.close(); } catch {}
    }
    this.watchers = [];
    log("Watcher stopped.");
  }
}
