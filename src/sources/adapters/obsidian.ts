/**
 * Obsidian Vault Source Adapter
 *
 * Obsidian vaults are local directories of Markdown files.
 * This adapter detects vaults and uses the same real-time watcher as local dirs.
 * The "adapter" is really TUI convenience for detection and configuration.
 */
import { existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { ThreadClawWatcher } from "../../watcher/index.js";
import type { SourceAdapter, SourceConfig, SourceStatus } from "../types.js";

/** Common vault locations by platform */
function getDefaultVaultPaths(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  if (process.platform === "win32") {
    candidates.push(
      join(home, "Documents", "Obsidian"),
      join(home, "Documents", "ObsidianVault"),
      join(home, "OneDrive", "Obsidian"),
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      join(home, "Documents", "Obsidian"),
      join(home, "Documents", "ObsidianVault"),
      join(home, "Library", "Mobile Documents", "iCloud~md~obsidian", "Documents"),
    );
  } else {
    candidates.push(
      join(home, "Documents", "Obsidian"),
      join(home, "Documents", "ObsidianVault"),
      join(home, "obsidian"),
    );
  }

  return candidates;
}

/** Check if a directory looks like an Obsidian vault */
function isObsidianVault(dir: string): boolean {
  return existsSync(join(dir, ".obsidian"));
}

/** Find Obsidian vaults on the system */
export function detectObsidianVaults(): string[] {
  const found: string[] = [];

  for (const candidate of getDefaultVaultPaths()) {
    if (!existsSync(candidate)) continue;

    // Check if it's a vault itself
    if (isObsidianVault(candidate)) {
      found.push(candidate);
      continue;
    }

    // Check subdirectories (common pattern: ~/Documents/Obsidian/VaultName/)
    try {
      const entries = readdirSync(candidate, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subPath = join(candidate, entry.name);
          if (isObsidianVault(subPath)) {
            found.push(subPath);
          }
        }
      }
    } catch {
      // permission error, skip
    }
  }

  return found;
}

export class ObsidianAdapter implements SourceAdapter {
  id = "obsidian";
  name = "Obsidian Vault";
  type = "realtime" as const;

  private watcher: ThreadClawWatcher | null = null;
  private detectedVaults: string[] = [];
  private status: SourceStatus = {
    state: "idle",
    docCount: 0,
  };

  async isAvailable(): Promise<boolean> {
    this.detectedVaults = detectObsidianVaults();
    return this.detectedVaults.length > 0;
  }

  availabilityReason(): string {
    if (this.detectedVaults.length > 0) return "";
    return "No Obsidian vault found. Create one or set OBSIDIAN_VAULT_PATH in .env";
  }

  defaultConfig(): SourceConfig {
    const vault = this.detectedVaults[0] ?? "";
    return {
      enabled: false,
      syncInterval: 0, // real-time
      collections: vault ? [{ path: vault, collection: "obsidian" }] : [],
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

    // NOTE: readdirSync in detectObsidianVaults doesn't follow symlinks.
    // Symlinked vaults won't be auto-detected but can be configured manually.
    const watchConfigs = cfg.collections
      .filter((c) => existsSync(resolve(c.path)))
      .map((c) => ({
        paths: [resolve(c.path)],
        collection: c.collection,
        // TODO: debounceMs is hardcoded — consider using config.watch.debounceMs
        debounceMs: 3000,
      }));

    if (watchConfigs.length === 0) {
      this.status = { state: "error", docCount: 0, error: "Vault path not found" };
      return;
    }

    this.watcher = new ThreadClawWatcher(watchConfigs);

    // Surface watcher errors in status
    this.watcher.onError = (err: Error) => {
      this.status = {
        ...this.status,
        state: "error",
        error: err.message || String(err),
      };
    };

    await this.watcher.start();
    this.status = { state: "watching", docCount: 0 };
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
    this.status = { state: "idle", docCount: 0 };
  }
}
