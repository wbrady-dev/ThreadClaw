import Fastify from "fastify";
import { resolve } from "path";
import { existsSync, chmodSync, mkdirSync } from "fs";
import { homedir } from "os";
import { createHash, timingSafeEqual } from "crypto";
import { config, warnIfNoApiKey } from "./config.js";
import { logger } from "./utils/logger.js";
import { getDb, closeDb, runMigrations, ensureCollection, closeGraphDb } from "./storage/index.js";
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

  // Ensure staging dir exists with restricted permissions.
  // Hardcoded to ~/.threadclaw/staging — matches THREADCLAW_HOME convention.
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

  // Clean up orphaned chunks from interrupted ingests (chunks without embeddings).
  // Fast (<50ms) — prevents stale partial data from prior crash/restart.
  // NOTE: chunk_vectors is a vec0 virtual table with chunk_id TEXT PRIMARY KEY.
  // We must SELECT chunk_id (not rowid) to match against chunks.id (TEXT UUID).
  try {
    const orphaned = db.prepare(
      `DELETE FROM chunks WHERE id NOT IN (SELECT chunk_id FROM chunk_vectors)`,
    ).run();
    if (orphaned.changes > 0) {
      logger.info({ count: orphaned.changes }, "Cleaned up orphaned chunks from interrupted ingest");
    }
  } catch {}


  const server = Fastify({
    logger: false,
    // Explicit body size limit (10 MiB). The default is 1 MiB which may be
    // too small for large ingest payloads.
    bodyLimit: 10 * 1024 * 1024,
  });

  // Global error handlers — catch unhandled errors and 404s
  server.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    logger.error({ err: error }, "Unhandled server error");
    reply.code(error.statusCode ?? 500).send({ error: error.message ?? "Internal server error" });
  });
  server.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "Not found" });
  });

  // CORS: ThreadClaw binds to localhost by default, so CORS is not needed.
  // If THREADCLAW_HOST is set to 0.0.0.0, consider adding @fastify/cors.

  // Rate limiting (use onRequest for earliest interception)
  registerRateLimit(server);

  // Optional API key authentication (timing-safe comparison)
  if (config.apiKey) {
    const expectedHash = createHash("sha256").update(`Bearer ${config.apiKey}`).digest();
    server.addHook("onRequest", async (request, reply) => {
      // Use routeOptions.url when available for accurate path matching (avoids
      // query string stripping issues). Falls back to URL parsing for safety.
      const path = (request.routeOptions as any)?.url ?? request.url.split("?")[0];
      if (path === "/health") return;
      const auth = request.headers.authorization ?? "";
      const suppliedHash = createHash("sha256").update(auth).digest();
      if (!timingSafeEqual(expectedHash, suppliedHash)) {
        reply.code(401).send({ error: "Unauthorized — set Authorization: Bearer <key>" });
      }
    });
    logger.info("API key authentication enabled");
  }

  // Aggressive shutdown — exit fast, don't wait for connections to drain.
  // SQLite WAL handles crash recovery; orphaned chunks cleaned on next startup.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down...");
    flushTokens();
    // Don't await stopSources — watcher ingests will fail gracefully when DB closes
    stopSources().catch(() => {});
    // Skip server.close() — it waits for connections to drain. Just close DBs and exit.
    closeDb();
    closeGraphDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  // NOTE: SIGTERM is not emitted on Windows — use the /shutdown HTTP endpoint instead.
  process.on("SIGTERM", shutdown);

  // Register all routes (pass shutdown callback for /shutdown endpoint)
  await registerRoutes(server, shutdown);

  // Start source adapters (LocalAdapter handles file watching via WATCH_PATHS).
  // Track health so /health can report source adapter status.
  let _sourceAdaptersHealthy = true;
  startSources().catch((err) => {
    _sourceAdaptersHealthy = false;
    logger.error({ error: String(err) }, "Failed to start source adapters — file watching is disabled");
  });

  // Start HTTP server
  // Bind to localhost only — ThreadClaw serves local processes (OpenClaw, TUI)
  // Set THREADCLAW_HOST=0.0.0.0 in .env to expose to the network if needed
  warnIfNoApiKey();
  await server.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port }, "ThreadClaw HTTP server running");

  return server;
}

