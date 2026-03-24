/**
 * Source Registry — manages all source adapters.
 *
 * Reads source config from .env, starts/stops adapters,
 * and provides a unified status view for the TUI.
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { SourceAdapter, SourceConfig, SourceStatus } from "./types.js";
import { LocalAdapter } from "./adapters/local.js";
import { ObsidianAdapter } from "./adapters/obsidian.js";
import { GDriveAdapter } from "./adapters/gdrive.js";
import { NotionAdapter } from "./adapters/notion.js";
import { AppleNotesAdapter } from "./adapters/apple-notes.js";
import { OneDriveAdapter } from "./adapters/onedrive.js";

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
  const envPath = resolve(config.rootDir, ".env");
  let env = "";
  try {
    if (existsSync(envPath)) env = readFileSync(envPath, "utf-8");
  } catch (err) {
    if (process.env.DEBUG) console.warn('[sources] Failed to read .env:', err instanceof Error ? err.message : String(err));
  }

  // --- Local adapter: use canonical config (process.env via dotenv) ---
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
  const obsEnabled = envMatch(env, "OBSIDIAN_ENABLED") === "true";
  const obsVault = envMatch(env, "OBSIDIAN_VAULT_PATH");
  const obsCollection = envMatch(env, "OBSIDIAN_COLLECTION") || "obsidian";
  if (obsVault) {
    configs.set("obsidian", {
      enabled: obsEnabled,
      syncInterval: 0,
      collections: [{ path: obsVault, collection: obsCollection }],
    });
  }

  // --- Google Drive adapter (future) ---
  const gdriveEnabled = envMatch(env, "GDRIVE_ENABLED") === "true";
  const gdriveFolders = envMatch(env, "GDRIVE_FOLDERS");
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
      syncInterval: parseInt(envMatch(env, "GDRIVE_SYNC_INTERVAL") || "300", 10),
      collections,
    });
  }

  // --- OneDrive adapter ---
  const onedriveEnabled = envMatch(env, "ONEDRIVE_ENABLED") === "true";
  const onedriveLocalPath = envMatch(env, "ONEDRIVE_LOCAL_PATH");
  const onedriveFolders = envMatch(env, "ONEDRIVE_FOLDERS");
  if (onedriveEnabled) {
    const collections: { path: string; collection: string }[] = [];
    if (onedriveLocalPath) {
      collections.push({ path: onedriveLocalPath, collection: "onedrive" });
    }
    if (onedriveFolders) {
      for (const entry of onedriveFolders.split(",").map((e) => e.trim()).filter(Boolean)) {
        const pipe = entry.lastIndexOf("|");
        collections.push({
          path: pipe > 0 ? entry.slice(0, pipe).trim() : entry.trim(),
          collection: pipe > 0 ? entry.slice(pipe + 1).trim() : "onedrive",
        });
      }
    }
    configs.set("onedrive", {
      enabled: onedriveEnabled,
      syncInterval: parseInt(envMatch(env, "ONEDRIVE_SYNC_INTERVAL") || "300", 10),
      collections,
      maxFileSize: parseInt(envMatch(env, "ONEDRIVE_MAX_FILE_SIZE") || "52428800", 10),
    });
  }

  // --- Notion adapter (future) ---
  const notionEnabled = envMatch(env, "NOTION_ENABLED") === "true";
  const notionDbs = envMatch(env, "NOTION_DATABASES");
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
      syncInterval: parseInt(envMatch(env, "NOTION_SYNC_INTERVAL") || "600", 10),
      collections,
    });
  }

  // --- Apple Notes adapter (future, macOS only) ---
  const notesEnabled = envMatch(env, "APPLE_NOTES_ENABLED") === "true";
  const notesFolders = envMatch(env, "APPLE_NOTES_FOLDERS");
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
      syncInterval: parseInt(envMatch(env, "APPLE_NOTES_SYNC_INTERVAL") || "600", 10),
      collections,
    });
  }

  return configs;
}

function envMatch(env: string, key: string): string {
  const raw = env.match(new RegExp(`^${key}=(.*)`, "m"))?.[1]?.trim() ?? "";
  // Strip surrounding quotes (single or double)
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** All registered adapters */
const adapters: SourceAdapter[] = [
  new LocalAdapter(),
  new ObsidianAdapter(),
  new GDriveAdapter(),
  new OneDriveAdapter(),
  new NotionAdapter(),
  new AppleNotesAdapter(),
];

/**
 * Get a snapshot of all sources with their config and status.
 * Used by the TUI Sources screen.
 */
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
