import Fastify from "fastify";
import { resolve } from "path";
import { existsSync, chmodSync, mkdirSync, renameSync } from "fs";
import { homedir } from "os";
import { createHash, timingSafeEqual } from "crypto";
import { config, warnIfNoApiKey, cleanupConfigWatcher } from "./config.js";
import { logger } from "./utils/logger.js";
import { getDb, closeDb, runMigrations, ensureCollection } from "./storage/index.js";
import { registerRoutes } from "./api/routes.js";
import { registerRateLimit } from "./api/ratelimit.js";
import { startSources, stopSources } from "./sources/index.js";
import { flushTokens } from "./utils/token-tracker.js";
import { toClientError } from "./utils/errors.js";

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

/**
 * One-time migration: copy data from the old separate graph.db into the main
 * threadclaw.db. Renames the old file to .migrated after success.
 */
function migrateOldGraphDb(db: ReturnType<typeof getDb>): void {
  const oldPaths = [
    resolve(config.dataDir, "threadclaw-graph.db"),
    resolve(config.dataDir, "..", "graph.db"),
    resolve(homedir(), ".threadclaw", "data", "graph.db"),
  ];
  const oldPath = oldPaths.find((p) => existsSync(p));
  if (!oldPath) return;

  // Check if we already have graph data (migration already done)
  try {
    const row = db.prepare(
      "SELECT COUNT(*) AS cnt FROM _evidence_migrations",
    ).get() as { cnt: number } | undefined;
    if (row && row.cnt > 0) {
      // Already migrated — rename old file
      try { renameSync(oldPath, oldPath + ".migrated"); } catch {}
      return;
    }
  } catch {
    // _evidence_migrations doesn't exist yet — migration will create it
  }

  logger.info({ oldPath }, "Migrating data from old graph.db into main database...");
  try {
    db.exec(`ATTACH DATABASE '${oldPath.replace(/'/g, "''")}' AS old_graph`);

    // Get list of tables in old_graph
    const tables = (db.prepare(
      "SELECT name FROM old_graph.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[]).map((r) => r.name);

    for (const table of tables) {
      // Create table in main DB if it doesn't exist (copy DDL)
      const ddlRow = db.prepare(
        "SELECT sql FROM old_graph.sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table) as { sql: string } | undefined;
      if (ddlRow?.sql) {
        try { db.exec(ddlRow.sql); } catch { /* table already exists */ }
      }
      // Copy data
      try {
        db.exec(`INSERT OR IGNORE INTO "${table}" SELECT * FROM old_graph."${table}"`);
      } catch (err) {
        logger.warn({ table, err: err instanceof Error ? err.message : String(err) }, "Skipped table during graph migration");
      }
    }

    db.exec("DETACH DATABASE old_graph");
    renameSync(oldPath, oldPath + ".migrated");
    logger.info("Graph data migration complete");
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Graph data migration failed — old graph.db preserved");
    try { db.exec("DETACH DATABASE old_graph"); } catch {}
  }
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

  // Validate that configured embedding dimensions match existing vec0 table.
  // A mismatch means the model changed but the DB wasn't rebuilt — queries will
  // return garbage or crash. Fail fast with a clear message.
  try {
    const vecSchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunk_vectors'"
    ).get() as { sql: string } | undefined;
    if (vecSchema?.sql) {
      const match = vecSchema.sql.match(/float\[(\d+)\]/);
      if (match) {
        const dbDim = parseInt(match[1], 10);
        if (dbDim !== config.embedding.dimensions) {
          logger.error(
            { configured: config.embedding.dimensions, existing: dbDim },
            "FATAL: Embedding dimension mismatch — configured EMBEDDING_DIMENSIONS does not match existing vec0 table. " +
            "Either change EMBEDDING_DIMENSIONS back to the original value, or delete the database and re-ingest."
          );
          closeDb();
          process.exit(1);
        }
      }
    }
  } catch (err) {
    // vec0 table may not exist yet (fresh DB) — that's fine
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, "Vec0 dimension check skipped");
  }

  // Run graph/evidence migrations against the same DB (consolidated from graph.db).
  // Try .js first (works under tsx ESM loader), then .ts (direct tsx import).
  try {
    let runGraphMigrations: ((db: any, path?: string) => void) | undefined;
    for (const ext of [".js", ".ts"]) {
      try {
        const schemaPath = resolve(config.rootDir, "memory-engine", "src", "relations", "schema" + ext);
        const mod = await import(schemaPath);
        runGraphMigrations = mod.runGraphMigrations;
        break;
      } catch { /* try next extension */ }
    }
    if (runGraphMigrations) {
      runGraphMigrations(db);
      logger.info("Graph migrations applied to main database");
    } else {
      logger.warn("Graph migrations skipped — could not import schema module");
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Graph migrations skipped — memory-engine not available");
  }

  // Migrate data from old separate graph.db if it exists
  migrateOldGraphDb(db);

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
    const code = error.statusCode ?? 500;
    reply.code(code).send({ error: toClientError(error, "Request", code) });
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
    cleanupConfigWatcher();
    // Don't await stopSources — watcher ingests will fail gracefully when DB closes
    stopSources().catch(() => {});
    // Skip server.close() — it waits for connections to drain. Just close DB and exit.
    closeDb();
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

