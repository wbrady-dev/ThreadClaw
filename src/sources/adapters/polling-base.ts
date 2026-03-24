/**
 * PollingAdapterBase — shared abstract base for polling source adapters.
 *
 * Handles: polling timer, stop(), cleanup(), manifest management,
 * sync loop, ingestion, and removal DB cleanup.
 *
 * Subclasses implement only the adapter-specific logic:
 *   - initClient()
 *   - listRemoteItems()
 *   - downloadItem()
 *   - checkAvailability()
 *   - getStagingPath() (for removal cleanup)
 */
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { resolve } from "path";
import { ingestFile } from "../../ingest/pipeline.js";
import { logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import { getDb } from "../../storage/index.js";
import { deleteDocument } from "../../storage/collections.js";
import type { SourceAdapter, SourceConfig, SourceStatus, ChangeSet, StagedFile } from "../types.js";

// ── Shared types ──

/** A remote item returned by listRemoteItems() */
export interface RemoteItem {
  id: string;
  name: string;
  lastModified: string;
  collection: string;
  tags?: string[];
}

/** Options passed to the PollingAdapterBase constructor */
export interface PollingAdapterOptions {
  id: string;
  name: string;
  stagingDir: string;
  defaultSyncInterval: number;
}

// ── Abstract base class ──

export abstract class PollingAdapterBase implements SourceAdapter {
  readonly id: string;
  readonly name: string;
  readonly type = "polling" as const;

  protected status: SourceStatus = { state: "idle", docCount: 0 };
  protected syncTimer: NodeJS.Timeout | null = null;
  protected manifest = new Map<string, { id: string; name: string; lastModified: string }>();
  protected cfg: SourceConfig | null = null;
  protected unavailableReason = "";
  protected readonly stagingDir: string;
  protected readonly defaultSyncInterval: number;

  constructor(opts: PollingAdapterOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.stagingDir = opts.stagingDir;
    this.defaultSyncInterval = opts.defaultSyncInterval;
  }

  // ── Abstract methods (subclass must implement) ──

  /** Check whether this adapter can run on this system. Sets unavailableReason if not. */
  abstract checkAvailability(): Promise<boolean>;

  /** Initialize the adapter-specific client (API client, auth, etc.) */
  abstract initClient(): Promise<void>;

  /** Fetch the list of remote items across all configured collections. */
  abstract listRemoteItems(): Promise<RemoteItem[]>;

  /**
   * Download a single item to the staging directory.
   * Returns the local file path where it was saved.
   */
  abstract downloadItem(item: RemoteItem): Promise<string>;

  /**
   * Return the staging file path(s) to delete when an item is removed.
   * Default implementation returns [stagingDir/id]. Override if needed.
   */
  protected getStagingPathsForRemoval(id: string, name: string): string[] {
    return [resolve(this.stagingDir, id)];
  }

  /**
   * Build the DB query to find documents matching a removed item.
   * Returns { sql, params } for a SELECT id FROM documents WHERE ... query.
   * Default uses source_path LIKE %stagingDir/id%.
   */
  protected getRemovalDbQuery(id: string, name: string): { sql: string; params: string[] } {
    const stagingPrefix = this.stagingDir.replace(/\\/g, "/");
    return {
      sql: "SELECT id FROM documents WHERE source_path LIKE ?",
      params: [`%${stagingPrefix}/${id}%`],
    };
  }

  // ── SourceAdapter interface ──

  async isAvailable(): Promise<boolean> {
    return this.checkAvailability();
  }

  availabilityReason(): string {
    return this.unavailableReason;
  }

  abstract defaultConfig(): SourceConfig;

  getStatus(): SourceStatus {
    return { ...this.status };
  }

  async start(cfg: SourceConfig): Promise<void> {
    this.cfg = cfg;

    if (!cfg.enabled || cfg.collections.length === 0) {
      this.status = { state: "disabled", docCount: 0 };
      return;
    }

    logger.warn(`${this.name} manifest is in-memory — full re-sync will occur on restart`);

    try {
      await this.initClient();
    } catch (err) {
      this.status = { state: "error", docCount: 0, error: `Init failed: ${err}` };
      return;
    }

    mkdirSync(this.stagingDir, { recursive: true });

    // Initial sync
    try {
      await this.sync();
    } catch (err) {
      logger.error({ source: this.id, error: String(err) }, `Initial ${this.name} sync failed`);
      this.status = { state: "error", docCount: 0, error: `Initial sync failed: ${err}` };
    }

    // Start polling
    const intervalMs = (cfg.syncInterval || this.defaultSyncInterval) * 1000;
    this.syncTimer = setInterval(() => {
      this.sync().catch((err) => {
        logger.error({ source: this.id, error: String(err) }, `${this.name} sync failed`);
        this.status = { ...this.status, state: "error", error: String(err) };
      });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.onStop();
    this.status = { state: "idle", docCount: 0 };
  }

  /** Hook for subclasses to clean up client references on stop. */
  protected onStop(): void {
    // Default: nothing. Override to null out client references.
  }

  async detectChanges(): Promise<ChangeSet> {
    if (!this.cfg) return { added: [], modified: [], removed: [] };

    const changes: ChangeSet = { added: [], modified: [], removed: [] };
    const allCurrentIds = new Set<string>();

    let items: RemoteItem[];
    try {
      items = await this.listRemoteItems();
    } catch (err) {
      logger.error({ source: this.id, error: String(err) }, `Failed to list remote items`);
      return changes;
    }

    for (const item of items) {
      allCurrentIds.add(item.id);
      const existing = this.manifest.get(item.id);

      if (!existing) {
        changes.added.push({
          sourceId: item.id,
          localPath: "",
          collection: item.collection,
          tags: item.tags,
          remoteTimestamp: item.lastModified,
        });
      } else if (existing.lastModified !== item.lastModified) {
        changes.modified.push({
          sourceId: item.id,
          localPath: "",
          collection: item.collection,
          tags: item.tags,
          remoteTimestamp: item.lastModified,
        });
      }
    }

    // Detect removals AFTER iterating all items to avoid cross-collection false positives
    for (const [itemId] of this.manifest) {
      if (!allCurrentIds.has(itemId)) {
        changes.removed.push(itemId);
      }
    }

    return changes;
  }

  async downloadToStaging(changes: ChangeSet): Promise<StagedFile[]> {
    const staged: StagedFile[] = [];
    const toDownload = [...changes.added, ...changes.modified];

    for (const file of toDownload) {
      try {
        const item: RemoteItem = {
          id: file.sourceId,
          name: file.sourceId,
          lastModified: file.remoteTimestamp ?? "",
          collection: file.collection,
          tags: file.tags,
        };
        const localPath = await this.downloadItem(item);
        staged.push({ ...file, localPath });
      } catch (err) {
        logger.error({ source: this.id, itemId: file.sourceId, error: String(err) }, `Failed to download item`);
      }
    }

    return staged;
  }

  cleanup(staged: StagedFile[]): void {
    for (const file of staged) {
      try {
        if (file.localPath && existsSync(file.localPath)) unlinkSync(file.localPath);
      } catch {}
    }
  }

  // ── Sync loop ──

  protected async sync(): Promise<void> {
    this.status = { ...this.status, state: "syncing" };

    const changes = await this.detectChanges();
    const totalChanges = changes.added.length + changes.modified.length + changes.removed.length;
    const interval = this.cfg?.syncInterval ?? this.defaultSyncInterval;

    if (totalChanges === 0) {
      logger.info({ source: this.id }, `${this.name} sync: no changes`);
      this.status = {
        ...this.status,
        state: "idle",
        lastSync: new Date(),
        nextSync: new Date(Date.now() + interval * 1000),
      };
      return;
    }

    logger.info(
      { source: this.id, added: changes.added.length, modified: changes.modified.length, removed: changes.removed.length },
      `${this.name} sync: changes detected`,
    );

    // Process removals — delete staging files, DB docs, and remove from manifest
    for (const itemId of changes.removed) {
      const entry = this.manifest.get(itemId);
      const entryName = entry?.name ?? itemId;

      // Remove staging files
      const paths = this.getStagingPathsForRemoval(itemId, entryName);
      for (const p of paths) {
        try { if (existsSync(p)) unlinkSync(p); } catch {}
      }

      // Clean up DB documents/chunks/vectors to prevent orphans
      try {
        const db = getDb(resolve(config.dataDir, "threadclaw.db"));
        const query = this.getRemovalDbQuery(itemId, entryName);
        const docs = db.prepare(query.sql).all(...query.params) as { id: string }[];
        for (const doc of docs) {
          deleteDocument(db, doc.id);
          logger.info({ source: this.id, itemId, docId: doc.id }, "Deleted orphaned document from DB");
        }
      } catch (dbErr) {
        logger.error({ source: this.id, itemId, error: String(dbErr) }, "Failed to clean up DB on removal");
      }

      this.manifest.delete(itemId);
      logger.info({ source: this.id, itemId }, `${this.name} item removed`);
    }

    const staged = await this.downloadToStaging(changes);

    let ingested = 0;
    for (const file of staged) {
      try {
        await ingestFile(file.localPath, {
          collection: file.collection,
          tags: file.tags,
        });
        ingested++;

        this.manifest.set(file.sourceId, {
          id: file.sourceId,
          name: file.localPath.split(/[/\\]/).pop() ?? file.sourceId,
          lastModified: file.remoteTimestamp ?? new Date().toISOString(),
        });
      } catch (err) {
        logger.error({ source: this.id, file: file.localPath, error: String(err) }, `Failed to ingest ${this.name} item`);
      }
    }

    this.cleanup(staged);

    this.status = {
      state: "idle",
      lastSync: new Date(),
      nextSync: new Date(Date.now() + interval * 1000),
      docCount: this.manifest.size,
    };

    logger.info({ source: this.id, ingested, total: this.manifest.size }, `${this.name} sync complete`);
  }
}
