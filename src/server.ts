import Fastify from "fastify";
import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "fs";
import { homedir } from "os";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { getDb, closeDb, runMigrations } from "./storage/index.js";
import { registerRoutes } from "./api/routes.js";
import { registerRateLimit } from "./api/ratelimit.js";
import { ClawCoreWatcher } from "./watcher/index.js";
import { startSources, stopSources } from "./sources/index.js";
import { flushTokens } from "./utils/token-tracker.js";

let watcher: ClawCoreWatcher | null = null;

/**
 * Check OpenClaw integration on startup (read-only).
 * Logs warnings if the managed integration block has drifted.
 * Never writes — use 'clawcore integrate --apply' for fixes.
 */
async function checkIntegrationOnStartup(): Promise<void> {
  try {
    const { checkOpenClawIntegration } = await import("./integration.js");
    const { readManifest } = await import("./version.js");
    const manifest = readManifest();

    const status = checkOpenClawIntegration();
    if (!status.openclawFound) return;

    if (!status.ok) {
      logger.warn("OpenClaw integration drift detected. Run 'clawcore doctor' or 'clawcore integrate --apply' to fix.");
      for (const drift of status.drifts) {
        logger.warn(`  ${drift.field}: expected ${JSON.stringify(drift.expected)}, got ${JSON.stringify(drift.actual)}`);
      }
    }
  } catch (e: any) {
    logger.warn(`Integration check skipped: ${e.message}`);
  }
}

/**
 * Harden file permissions on sensitive data (Unix only).
 * On Windows, NTFS ACLs are managed by the OS — chmod is a no-op.
 */
function hardenPermissions(): void {
  if (process.platform === "win32") return;

  const targets = [
    { path: resolve(config.dataDir, "clawcore.db"), mode: 0o600 },
    { path: resolve(config.dataDir, "clawcore.db-wal"), mode: 0o600 },
    { path: resolve(config.dataDir, "clawcore.db-shm"), mode: 0o600 },
    { path: config.relations.graphDbPath, mode: 0o600 },
  ];

  for (const t of targets) {
    try {
      if (existsSync(t.path)) chmodSync(t.path, t.mode);
    } catch {}
  }

  // Ensure staging dir exists with restricted permissions
  const stagingDir = resolve(homedir(), ".clawcore", "staging");
  try {
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  } catch {}

  logger.info("File permissions hardened");
}

export async function startServer() {
  // Check OpenClaw integration (read-only — never writes)
  await checkIntegrationOnStartup();

  // Secure sensitive files
  hardenPermissions();

  // Initialize database
  const dbPath = resolve(config.dataDir, "clawcore.db");
  const db = getDb(dbPath);
  runMigrations(db);

  const server = Fastify({ logger: false });

  // Rate limiting (before routes)
  registerRateLimit(server);

  // Optional API key authentication
  const apiKey = process.env.CLAWCORE_API_KEY;
  if (apiKey) {
    server.addHook("onRequest", async (request, reply) => {
      if (request.url === "/health" || request.url === "/shutdown") return;
      const auth = request.headers.authorization;
      if (!auth || auth !== `Bearer ${apiKey}`) {
        reply.code(401).send({ error: "Unauthorized — set Authorization: Bearer <key>" });
      }
    });
    logger.info("API key authentication enabled");
  }

  // Register all routes
  registerRoutes(server);

  // Start file watcher if configured
  if (config.watch.paths) {
    watcher = startWatcher();
  }

  // Start polling source adapters (Google Drive, Notion, Apple Notes)
  startSources().catch((err) => {
    logger.error({ error: String(err) }, "Failed to start source adapters");
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    flushTokens();
    await stopSources();
    if (watcher) await watcher.stop();
    await server.close();
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start HTTP server
  // Bind to localhost only — ClawCore serves local processes (OpenClaw, TUI)
  // Set CLAWCORE_HOST=0.0.0.0 in .env to expose to the network if needed
  const host = process.env.CLAWCORE_HOST ?? "127.0.0.1";
  await server.listen({ port: config.port, host });
  logger.info({ port: config.port }, "ClawCore HTTP server running");

  return server;
}

/**
 * Parse WATCH_PATHS config and start the file watcher.
 * Format: "path1|collection1,path2|collection2" (pipe-separated)
 * Pipe is used instead of colon because Windows paths contain colons (C:\...).
 * If no collection specified, uses the default collection.
 */
function startWatcher(): ClawCoreWatcher {
  const entries = config.watch.paths
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const watchConfigs = entries.map((entry) => {
    const pipeIdx = entry.lastIndexOf("|");
    const watchPath = pipeIdx > 0 ? entry.slice(0, pipeIdx) : entry;
    const collection = pipeIdx > 0 ? entry.slice(pipeIdx + 1) : "";
    return {
      paths: [resolve(watchPath.trim())],
      collection: collection?.trim() || config.defaults.collection,
      debounceMs: config.watch.debounceMs,
    };
  });

  if (watchConfigs.length === 0) return new ClawCoreWatcher([]);

  logger.info(
    { watchConfigs: watchConfigs.map((w) => `${w.paths[0]} -> ${w.collection}`) },
    "Starting file watchers",
  );

  const w = new ClawCoreWatcher(watchConfigs);
  w.start().catch((err) => {
    logger.error({ error: String(err) }, "Failed to start file watcher");
  });

  return w;
}
