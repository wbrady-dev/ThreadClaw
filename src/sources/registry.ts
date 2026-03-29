/**
 * Source Registry — manages all source adapters.
 *
 * Reads source config from .env, starts/stops adapters,
 * and provides a unified status view for the TUI.
 */
import { resolve } from "path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { readEnvMap } from "../tui/env.js";
import type { SourceAdapter, SourceConfig, SourceStatus } from "./types.js";
import { LocalAdapter } from "./adapters/local.js";
import { ObsidianAdapter } from "./adapters/obsidian.js";
import { GDriveAdapter } from "./adapters/gdrive.js";
import { OneDriveAdapter } from "./adapters/onedrive.js";
import { NotionAdapter } from "./adapters/notion.js";
import { AppleNotesAdapter } from "./adapters/apple-notes.js";
import { WebAdapter } from "./adapters/web.js";


export interface SourceEntry {
  adapter: SourceAdapter;
  config: SourceConfig;
  status: SourceStatus;
}

/**
 * Parse the .env file to build source configs.
 * Local adapter reads from WATCH_PATHS.
 * Obsidian reads from OBSIDIAN_* vars.
 * Future adapters (gdrive, notion, etc.) read from their own prefixed vars.
 */
function loadSourceConfigs(): Map<string, SourceConfig> {
  const configs = new Map<string, SourceConfig>();
  const env = readEnvMap(config.rootDir);

  // --- Local adapter: uses config object (frozen at startup from process.env) ---
  if (config.watch.paths) {
    const collections = config.watch.paths
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .map((entry) => {
        const pipe = entry.lastIndexOf("|");
        return {
          path: pipe > 0 ? entry.slice(0, pipe).trim() : entry.trim(),
          collection: pipe > 0 ? entry.slice(pipe + 1).trim() : config.defaults.collection,
        };
      });
    configs.set("local", {
      enabled: collections.length > 0,
      syncInterval: 0,
      collections,
    });
  }

  // --- Obsidian adapter ---
  const obsEnabled = (env.OBSIDIAN_ENABLED ?? "") === "true";
  const obsVault = (env.OBSIDIAN_VAULT_PATH ?? "");
  const obsCollection = env.OBSIDIAN_COLLECTION || "obsidian";
  if (obsVault) {
    configs.set("obsidian", {
      enabled: obsEnabled,
      syncInterval: 0,
      collections: [{ path: obsVault, collection: obsCollection }],
    });
  }

  // --- Google Drive adapter ---
  const gdriveEnabled = (env.GDRIVE_ENABLED ?? "") === "true";
  const gdriveFolders = env.GDRIVE_FOLDERS ?? "";
  if (gdriveFolders) {
    const collections = gdriveFolders
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .map((entry) => {
        const pipe = entry.lastIndexOf("|");
        return {
          path: pipe > 0 ? entry.slice(0, pipe).trim() : entry.trim(),
          collection: pipe > 0 ? entry.slice(pipe + 1).trim() : "gdrive",
        };
      });
    configs.set("gdrive", {
      enabled: gdriveEnabled,
      syncInterval: parseInt(env.GDRIVE_SYNC_INTERVAL || "300", 10),
      collections,
    });
  }

  // --- OneDrive adapter ---
  const onedriveEnabled = (env.ONEDRIVE_ENABLED ?? "") === "true";
  const onedriveFolders = env.ONEDRIVE_FOLDERS ?? "";
  if (onedriveFolders) {
    const collections = onedriveFolders
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .map((entry) => {
        const pipe = entry.lastIndexOf("|");
        return {
          path: pipe > 0 ? entry.slice(0, pipe).trim() : entry.trim(),
          collection: pipe > 0 ? entry.slice(pipe + 1).trim() : "onedrive",
        };
      });
    configs.set("onedrive", {
      enabled: onedriveEnabled,
      syncInterval: parseInt(env.ONEDRIVE_SYNC_INTERVAL || "300", 10),
      collections,
    });
  }

  // --- Notion adapter ---
  const notionEnabled = (env.NOTION_ENABLED ?? "") === "true";
  const notionDbs = env.NOTION_DATABASES ?? "";
  if (notionDbs) {
    const collections = notionDbs
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .map((entry) => {
        const pipe = entry.lastIndexOf("|");
        return {
          path: pipe > 0 ? entry.slice(0, pipe).trim() : entry.trim(),
          collection: pipe > 0 ? entry.slice(pipe + 1).trim() : "notion",
        };
      });
    configs.set("notion", {
      enabled: notionEnabled,
      syncInterval: parseInt(env.NOTION_SYNC_INTERVAL || "600", 10),
      collections,
    });
  }

  // --- Apple Notes adapter (macOS only) ---
  const notesEnabled = (env.APPLE_NOTES_ENABLED ?? "") === "true";
  const notesFolders = env.APPLE_NOTES_FOLDERS ?? "";
  if (notesFolders) {
    const collections = notesFolders
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .map((entry) => {
        const pipe = entry.lastIndexOf("|");
        return {
          path: pipe > 0 ? entry.slice(0, pipe).trim() : entry.trim(),
          collection: pipe > 0 ? entry.slice(pipe + 1).trim() : "notes",
        };
      });
    configs.set("apple-notes", {
      enabled: notesEnabled,
      syncInterval: parseInt(env.APPLE_NOTES_SYNC_INTERVAL || "600", 10),
      collections,
    });
  }

  // --- Web URL adapter ---
  const webEnabled = (env.WEB_ENABLED ?? "") === "true" || !!(env.WEB_URLS ?? "");
  const webUrls = env.WEB_URLS ?? "";
  if (webUrls) {
    const collections = webUrls
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .map((entry) => {
        const pipe = entry.lastIndexOf("|");
        const url = pipe > 0 ? entry.slice(0, pipe).trim() : entry.trim();
        let hostname = "web";
        try { hostname = new URL(url).hostname.replace(/^www\./, ""); } catch {}
        return {
          path: url,
          collection: pipe > 0 ? entry.slice(pipe + 1).trim() : hostname,
        };
      });
    configs.set("web", {
      enabled: webEnabled,
      syncInterval: parseInt(env.WEB_POLL_INTERVAL || "3600", 10),
      collections,
    });
  }

  return configs;
}

/** All registered adapters.
 * NOTE: All adapters are eagerly instantiated at import time. Consider dynamic import
 * for adapters that require heavy dependencies (googleapis, @notionhq/client).
 */
const adapters: SourceAdapter[] = [
  new LocalAdapter(),
  new ObsidianAdapter(),
  new GDriveAdapter(),
  new OneDriveAdapter(),

  new NotionAdapter(),
  new AppleNotesAdapter(),
  new WebAdapter(),
];

/**
 * Get a snapshot of all sources with their config and status.
 * Used by the TUI Sources screen.
 */
// NOTE: getSourceEntries() re-reads .env on every call via loadSourceConfigs().
// This ensures config changes are picked up without restart, but has I/O cost.
// Consider caching with a short TTL if called frequently (e.g., TUI polling).
export function getSourceEntries(): SourceEntry[] {
  const configs = loadSourceConfigs();
  return adapters.map((adapter) => {
    const cfg = configs.get(adapter.id) ?? adapter.defaultConfig();
    return {
      adapter,
      config: cfg,
      status: adapter.getStatus(),
    };
  });
}

/**
 * Get a specific adapter by ID.
 */
export function getAdapter(id: string): SourceAdapter | undefined {
  return adapters.find((a) => a.id === id);
}

/**
 * Start all enabled source adapters.
 * Called during ThreadClaw server startup.
 */
export async function startSources(): Promise<void> {
  const configs = loadSourceConfigs();

  // Check availability sequentially (some checks have side effects like setting reasons)
  const eligible: { adapter: SourceAdapter; cfg: SourceConfig }[] = [];
  for (const adapter of adapters) {
    const cfg = configs.get(adapter.id);
    if (!cfg || !cfg.enabled) continue;

    const available = await adapter.isAvailable();
    if (!available) {
      logger.warn(
        { source: adapter.id, reason: adapter.availabilityReason() },
        `Source ${adapter.name} not available`,
      );
      continue;
    }
    eligible.push({ adapter, cfg });
  }

  // Start all eligible adapters in parallel
  const results = await Promise.allSettled(
    eligible.map(async ({ adapter, cfg }) => {
      await adapter.start(cfg);
      logger.info(
        { source: adapter.id, collections: cfg.collections.length },
        `Source ${adapter.name} started`,
      );
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      logger.error(
        { source: eligible[i].adapter.id, error: String(result.reason) },
        `Failed to start source ${eligible[i].adapter.name}`,
      );
    }
  }
}

/**
 * Stop all running source adapters.
 */
export async function stopSources(): Promise<void> {
  for (const adapter of adapters) {
    try {
      await adapter.stop();
    } catch (err) {
      logger.error({ source: adapter.id, error: String(err) }, `Failed to stop source ${adapter.name}`);
    }
  }
}
