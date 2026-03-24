import Fastify from "fastify";
import { resolve } from "path";
import { existsSync, chmodSync, mkdirSync } from "fs";
import { homedir } from "os";
import { createHash, timingSafeEqual } from "crypto";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { getDb, closeDb, runMigrations, ensureCollection } from "./storage/index.js";
import { registerRoutes } from "./api/routes.js";
import { registerRateLimit } from "./api/ratelimit.js";
import { startSources, stopSources } from "./sources/index.js";
import { flushTokens } from "./utils/token-tracker.js";

/**
 * Check OpenClaw integration on startup (read-only).
 * Logs warnings if the managed integration block has drifted.
 * Never writes — use 'threadclaw integrate --apply' for fixes.
 */
async function checkIntegrationOnStartup(): Promise<void> {
  try {
    const { checkOpenClawIntegration } = await import("./integration.js");
    const status = checkOpenClawIntegration();
    if (!status.openclawFound) return;

    if (!status.ok) {
      logger.warn("OpenClaw integration drift detected. Run 'threadclaw doctor' or 'threadclaw integrate --apply' to fix.");
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
    { path: resolve(config.dataDir, "threadclaw.db"), mode: 0o600 },
    { path: resolve(config.dataDir, "threadclaw.db-wal"), mode: 0o600 },
    { path: resolve(config.dataDir, "threadclaw.db-shm"), mode: 0o600 },
    { path: config.relations.graphDbPath, mode: 0o600 },
  ];

  for (const t of targets) {
    try {
      if (existsSync(t.path)) chmodSync(t.path, t.mode);
    } catch {}
  }

  // Ensure staging dir exists with restricted permissions
  const stagingDir = resolve(homedir(), ".threadclaw", "staging");
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
  const dbPath = resolve(config.dataDir, "threadclaw.db");
  const db = getDb(dbPath);
  runMigrations(db);
  ensureCollection(db, config.defaults.collection);

  const server = Fastify({ logger: false });

  // Rate limiting (before routes)
  registerRateLimit(server);

  // Optional API key authentication (timing-safe comparison)
  if (config.apiKey) {
    const expectedHash = createHash("sha256").update(`Bearer ${config.apiKey}`).digest();
    server.addHook("onRequest", async (request, reply) => {
      const path = request.url.split("?")[0];
      if (path === "/health") return;
      const auth = request.headers.authorization ?? "";
      const suppliedHash = createHash("sha256").update(auth).digest();
      if (!timingSafeEqual(expectedHash, suppliedHash)) {
        reply.code(401).send({ error: "Unauthorized — set Authorization: Bearer <key>" });
      }
    });
    logger.info("API key authentication enabled");
  }

  // Graceful shutdown (guarded against double-call from SIGINT + /shutdown race)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down...");
    flushTokens();
    await stopSources();
    await server.close();
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  // NOTE: SIGTERM is not emitted on Windows — use the /shutdown HTTP endpoint instead.
  process.on("SIGTERM", shutdown);

  // Register all routes (pass shutdown callback for /shutdown endpoint)
  registerRoutes(server, shutdown);

  // Start source adapters (LocalAdapter handles file watching via WATCH_PATHS)
  startSources().catch((err) => {
    logger.error({ error: String(err) }, "Failed to start source adapters");
  });

  // Start HTTP server
  // Bind to localhost only — ThreadClaw serves local processes (OpenClaw, TUI)
  // Set THREADCLAW_HOST=0.0.0.0 in .env to expose to the network if needed
  await server.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port }, "ThreadClaw HTTP server running");

  return server;
}

