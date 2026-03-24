/**
 * Local Directory Source Adapter
 *
 * Wraps ThreadClaw's existing chokidar file watcher as a SourceAdapter.
 * Real-time watching — no polling needed.
 */
import { existsSync } from "fs";
import { resolve } from "path";
import { config } from "../../config.js";
import { ThreadClawWatcher } from "../../watcher/index.js";
import type { SourceAdapter, SourceConfig, SourceStatus } from "../types.js";

export class LocalAdapter implements SourceAdapter {
  id = "local";
  name = "Local Directories";
  type = "realtime" as const;

  private watcher: ThreadClawWatcher | null = null;
  private status: SourceStatus = {
    state: "idle",
    docCount: 0,
  };

  async isAvailable(): Promise<boolean> {
    return true; // always available
  }

  availabilityReason(): string {
    return "";
  }

  defaultConfig(): SourceConfig {
    return {
      enabled: true,
      syncInterval: 0, // real-time, no polling
      collections: [],
      fileTypes: undefined, // use default supported extensions
      maxFileSize: 52_428_800, // 50 MB
    };
  }

  getStatus(): SourceStatus {
    return { ...this.status };
  }

  async start(cfg: SourceConfig): Promise<void> {
    if (!cfg.enabled || cfg.collections.length === 0) {
      this.status = { state: "disabled", docCount: 0 };
      return;
    }

    // Filter to only paths that exist
    const watchConfigs = cfg.collections
      .filter((c) => existsSync(resolve(c.path)))
      .map((c) => ({
        paths: [resolve(c.path)],
        collection: c.collection,
        debounceMs: config.watch.debounceMs,
        ingestExisting: false,
        fileTypes: cfg.fileTypes,
      }));

    if (watchConfigs.length === 0) {
      this.status = { state: "error", docCount: 0, error: "No valid paths found" };
      return;
    }

    this.watcher = new ThreadClawWatcher(watchConfigs);

    // Surface watcher errors in TUI via status
    this.watcher.onError = (err: Error) => {
      this.status = {
        ...this.status,
        state: "error",
        error: err.message || String(err),
      };
    };

    await this.watcher.start();
    this.status = {
      state: "watching",
      docCount: 0, // updated by collection stats
    };
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
    this.status = { state: "idle", docCount: 0 };
  }
}
