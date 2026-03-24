import { Command } from "commander";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { config } from "../../config.js";
import { getDb } from "../../storage/index.js";
import { getGraphDb, closeGraphDb } from "../../storage/graph-sqlite.js";
import { extractEntitiesFromDocument } from "../../relations/ingest-hook.js";

export const relationsCommand = new Command("relations")
  .description("Entity graph management");

relationsCommand
  .command("backfill")
  .description("Extract entities from all existing chunks into the evidence graph")
  .option("-c, --collection <name>", "Limit to a specific collection")
  .action(async (opts: { collection?: string }) => {
    const start = Date.now();
    console.log("Relations backfill: extracting entities from existing chunks...");

    if (!config.relations) { console.error("Relations not configured. Enable Evidence OS in the TUI (Configure > Evidence OS) or set THREADCLAW_RELATIONS_ENABLED=true in .env"); process.exit(1); }
    const db = getDb(config.dataDir + "/threadclaw.db");
    const graphDb = getGraphDb(config.relations.graphDbPath);


    // Query all documents (optionally filtered by collection)
    let documents: Array<{ id: string; source_path: string }>;
    if (opts.collection) {
      documents = db.prepare(`
        SELECT d.id, d.source_path FROM documents d
        JOIN collections c ON d.collection_id = c.id
        WHERE c.name = ?
      `).all(opts.collection) as Array<{ id: string; source_path: string }>;
      console.log(`Collection: ${opts.collection} (${documents.length} documents)`);
    } else {
      documents = db.prepare("SELECT id, source_path FROM documents").all() as Array<{ id: string; source_path: string }>;
      console.log(`All collections (${documents.length} documents)`);
    }

    let totalChunks = 0;
    let processedDocs = 0;
    let errors = 0;

    for (let di = 0; di < documents.length; di++) {
      const doc = documents[di];
      const chunks = db.prepare(
        "SELECT text, position FROM chunks WHERE document_id = ? ORDER BY position",
      ).all(doc.id) as Array<{ text: string; position: number }>;

      if (chunks.length === 0) continue;

      totalChunks += chunks.length;

      try {
        await extractEntitiesFromDocument(graphDb, doc.id, chunks);
        processedDocs++;
      } catch (e) {
        errors++;
        console.warn(`  Warning: failed to process ${doc.source_path}: ${e instanceof Error ? e.message : String(e)}`);
      }

      if ((di + 1) % 100 === 0) {
        console.log(`  Processed ${di + 1}/${documents.length} documents...`);
      }
    }

    // Count total entities in graph
    const entityCount = (graphDb.prepare("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'entity'").get() as { cnt: number }).cnt;
    const mentionCount = (graphDb.prepare("SELECT COUNT(*) as cnt FROM provenance_links WHERE predicate = 'mentioned_in'").get() as { cnt: number }).cnt;

    const elapsed = Date.now() - start;
    console.log(`\nBackfill complete:`);
    console.log(`  Documents processed: ${processedDocs}`);
    console.log(`  Chunks scanned: ${totalChunks}`);
    console.log(`  Entities in graph: ${entityCount}`);
    console.log(`  Total mentions: ${mentionCount}`);
    if (errors > 0) console.log(`  Errors: ${errors}`);
    console.log(`  Elapsed: ${(elapsed / 1000).toFixed(1)}s`);

    closeGraphDb();
  });

relationsCommand
  .command("stats")
  .description("Show entity graph statistics")
  .action(async () => {
    if (!config.relations) { console.error("Relations not configured. Enable Evidence OS in the TUI (Configure > Evidence OS) or set THREADCLAW_RELATIONS_ENABLED=true in .env"); process.exit(1); }
    const graphDb = getGraphDb(config.relations.graphDbPath);


    const entities = (graphDb.prepare("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'entity'").get() as { cnt: number }).cnt;
    const mentions = (graphDb.prepare("SELECT COUNT(*) as cnt FROM provenance_links WHERE predicate = 'mentioned_in'").get() as { cnt: number }).cnt;
    const events = (graphDb.prepare("SELECT COUNT(*) as cnt FROM evidence_log").get() as { cnt: number }).cnt;

    const topEntities = graphDb.prepare(
      "SELECT json_extract(structured_json, '$.name') as name, json_extract(structured_json, '$.displayName') as display_name, json_extract(structured_json, '$.mentionCount') as mention_count FROM memory_objects WHERE kind = 'entity' ORDER BY json_extract(structured_json, '$.mentionCount') DESC LIMIT 10",
    ).all() as Array<{ name: string; display_name: string; mention_count: number }>;

    console.log(`Evidence Graph Statistics`);
    console.log(`  Entities: ${entities}`);
    console.log(`  Mentions: ${mentions}`);
    console.log(`  Evidence log events: ${events}`);
    console.log(`\nTop entities by mention count:`);
    for (const e of topEntities) {
      console.log(`  ${e.display_name} (${e.mention_count} mentions)`);
    }

    closeGraphDb();
  });

relationsCommand
  .command("archive")
  .description("Archive stale claims, old decisions, and old evidence events to cold storage")
  .option("--claim-days <n>", "Days before stale claims are archived", "30")
  .option("--decision-days <n>", "Days before superseded decisions are archived", "90")
  .option("--event-days <n>", "Days of evidence events to keep hot", "60")
  .option("--dry-run", "Show what would be archived without doing it")
  .action(async (opts: { claimDays: string; decisionDays: string; eventDays: string; dryRun?: boolean }) => {
    if (!config.relations) { console.error("Relations not configured. Enable Evidence OS in the TUI (Configure > Evidence OS) or set THREADCLAW_RELATIONS_ENABLED=true in .env"); process.exit(1); }
    const graphDb = getGraphDb(config.relations.graphDbPath);

    const archivePath = resolve(homedir(), ".threadclaw", "data", "archive.db");

    if (opts.dryRun) {
      const claimDays = parseInt(opts.claimDays, 10);
      const decisionDays = parseInt(opts.decisionDays, 10);
      const eventDays = parseInt(opts.eventDays, 10);
      const claimCutoff = new Date(Date.now() - claimDays * 86_400_000).toISOString();
      const decCutoff = new Date(Date.now() - decisionDays * 86_400_000).toISOString();
      const evCutoff = new Date(Date.now() - eventDays * 86_400_000).toISOString();

      const staleClaims = (graphDb.prepare("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'claim' AND status = 'active' AND confidence < 0.1 AND last_observed_at < ?").get(claimCutoff) as any).cnt;
      const oldDecs = (graphDb.prepare("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'decision' AND status = 'superseded' AND json_extract(structured_json, '$.decidedAt') < ?").get(decCutoff) as any).cnt;
      const oldEvents = (graphDb.prepare("SELECT COUNT(*) as cnt FROM evidence_log WHERE created_at < ?").get(evCutoff) as any).cnt;

      console.log("Archive dry run:");
      console.log(`  Stale claims (conf<0.1, ${claimDays}d): ${staleClaims}`);
      console.log(`  Superseded decisions (${decisionDays}d): ${oldDecs}`);
      console.log(`  Old evidence events (${eventDays}d): ${oldEvents}`);
      console.log(`  Archive path: ${archivePath}`);
    } else {
      // Run archive via tsx subprocess (memory-engine has different rootDir)
      const { execFileSync } = await import("child_process");
      const { writeFileSync: writeTmp, unlinkSync: unlinkTmp } = await import("fs");
      const { tmpdir } = await import("os");
      const { join: joinTmp } = await import("path");
      const rootDir = resolve(__dirname, "..", "..", "..");
      const meDir = resolve(rootDir, "memory-engine");
      const script = [
        "import { runArchive, getArchiveStats } from './src/relations/archive.js';",
        "import { DatabaseSync } from 'node:sqlite';",
        "const db = new DatabaseSync(process.env.GRAPH_PATH);",
        `const r = runArchive(db, process.env.ARCHIVE_PATH, {`,
        `  claimStaleDays: ${Math.max(1, parseInt(opts.claimDays, 10))},`,
        `  decisionStaleDays: ${Math.max(1, parseInt(opts.decisionDays, 10))},`,
        `  eventRetentionDays: ${Math.max(1, parseInt(opts.eventDays, 10))},`,
        `  loopStaleDays: ${Math.max(1, parseInt(opts.claimDays, 10))},`,
        "});",
        "const s = getArchiveStats(process.env.ARCHIVE_PATH);",
        "console.log(JSON.stringify({ result: r, stats: s }));",
        "db.close();",
      ].join("\n");
      const tmpScript = joinTmp(tmpdir(), `threadclaw-archive-${Date.now()}.mts`);
      writeTmp(tmpScript, script);
      try {
        const out = execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", tmpScript], {
          cwd: meDir, stdio: ["pipe", "pipe", "pipe"], timeout: 30000,
          env: { ...process.env, GRAPH_PATH: config.relations.graphDbPath, ARCHIVE_PATH: archivePath },
        }).toString().trim();
        const { result, stats } = JSON.parse(out);
        console.log("Archive complete:");
        console.log(`  Claims: ${result.claimsArchived}`);
        console.log(`  Decisions: ${result.decisionsArchived}`);
        console.log(`  Events: ${result.eventsArchived}`);
        console.log(`  Loops: ${result.loopsArchived}`);
        if (stats) {
          console.log(`\nArchive totals: ${stats.claims} claims, ${stats.decisions} decisions, ${stats.events} events, ${stats.loops} loops`);
        }
        console.log(`Archive: ${archivePath}`);
      } catch (e: any) {
        console.error("Archive failed:", e.message);
      } finally {
        try { unlinkTmp(tmpScript); } catch {}
      }
    }

    closeGraphDb();
  });

relationsCommand
  .command("archive-status")
  .description("Show archive run history and cold storage stats")
  .action(async () => {
    const archivePath = resolve(homedir(), ".threadclaw", "data", "archive.db");
    const { existsSync: exists } = await import("fs");
    if (!exists(archivePath)) {
      console.log("No archive DB found. Run 'threadclaw relations archive' first.");
      return;
    }

    const { execFileSync } = await import("child_process");
    const { writeFileSync: writeTmp, unlinkSync: unlinkTmp } = await import("fs");
    const { tmpdir } = await import("os");
    const { join: joinTmp } = await import("path");
    const rootDir = resolve(__dirname, "..", "..", "..");
    const meDir = resolve(rootDir, "memory-engine");
    const script = [
      "import { getArchiveDb } from './src/relations/archive.js';",
      "const db = getArchiveDb(process.env.ARCHIVE_PATH);",
      "const safe = (sql) => { try { return db.prepare(sql).get()?.cnt ?? 0; } catch { return 0; } };",
      "const runs = db.prepare('SELECT * FROM _archive_runs ORDER BY started_at DESC LIMIT 10').all();",
      "console.log(JSON.stringify({",
      "  claims: safe('SELECT COUNT(*) as cnt FROM archived_claims'),",
      "  decisions: safe('SELECT COUNT(*) as cnt FROM archived_decisions'),",
      "  events: safe('SELECT COUNT(*) as cnt FROM archived_evidence_log'),",
      "  loops: safe('SELECT COUNT(*) as cnt FROM archived_loops'),",
      "  runs,",
      "}));",
    ].join("\n");
    const tmpScript = joinTmp(tmpdir(), `threadclaw-archive-status-${Date.now()}.mts`);
    writeTmp(tmpScript, script);

    try {
      const out = execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", tmpScript], {
        cwd: meDir, stdio: ["pipe", "pipe", "pipe"], timeout: 15000,
        env: { ...process.env, ARCHIVE_PATH: archivePath },
      }).toString().trim();
      const data = JSON.parse(out);

      console.log("Cold Archive Statistics");
      console.log(`  Archived claims:    ${data.claims}`);
      console.log(`  Archived decisions: ${data.decisions}`);
      console.log(`  Archived events:    ${data.events}`);
      console.log(`  Archived loops:     ${data.loops}`);
      console.log(`  Archive path:       ${archivePath}`);

      if (data.runs?.length > 0) {
        console.log(`\nRecent runs (last ${data.runs.length}):`);
        for (const r of data.runs) {
          const total = (r.claims_archived ?? 0) + (r.decisions_archived ?? 0) + (r.events_archived ?? 0) + (r.loops_archived ?? 0);
          console.log(`  ${r.started_at} [${r.status}] ${total} items (C:${r.claims_archived} D:${r.decisions_archived} E:${r.events_archived} L:${r.loops_archived})`);
        }
      }
    } catch (e: any) {
      console.error("Failed to read archive:", e.message);
    } finally {
      try { unlinkTmp(tmpScript); } catch {}
    }
  });
