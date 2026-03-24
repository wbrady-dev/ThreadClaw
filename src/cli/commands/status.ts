import { Command } from "commander";
import { resolve } from "path";
import { existsSync, statSync } from "fs";
import chalk from "chalk";
import { config } from "../../config.js";
import { getInitializedDb, listCollections } from "../../storage/index.js";
import { getCollectionStats } from "../../storage/collections.js";
import { getGraphDb, closeGraphDb } from "../../storage/graph-sqlite.js";
import { isPortReachable } from "../../tui/runtime-status.js";
import { getApiPort, getModelPort } from "../../tui/platform.js";


export const statusCommand = new Command("status")
  .description("Show ThreadClaw system status")
  .action(async () => {
    console.log(chalk.bold("\nThreadClaw RAG System Status\n"));

    // Service liveness checks
    const apiPort = getApiPort();
    const modelPort = getModelPort();
    const [modelsUp, apiUp] = await Promise.all([
      isPortReachable(modelPort),
      isPortReachable(apiPort),
    ]);

    console.log(
      modelsUp
        ? chalk.green(`  Models:  RUNNING`) + chalk.dim(` on port ${modelPort}`)
        : chalk.red(`  Models:  STOPPED`),
    );
    console.log(
      apiUp
        ? chalk.green(`  API:     RUNNING`) + chalk.dim(` on port ${apiPort}`)
        : chalk.red(`  API:     STOPPED`),
    );
    console.log("");

    // Check embedding/rerank server
    try {
      const res = await fetch(`${config.embedding.url.replace("/v1", "")}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const data = await res.json() as { models?: { embed?: { ready?: boolean; id?: string }; rerank?: { ready?: boolean; id?: string } } };
      const embed = data.models?.embed;
      const rerank = data.models?.rerank;
      console.log(`  Embedding:  ${embed?.ready ? "OK" : "DOWN"}  ${embed?.id ?? ""}`);
      console.log(`  Reranker:   ${rerank?.ready ? "OK" : "DOWN"}  ${rerank?.id ?? ""}`);
    } catch {
      console.log("  Embedding:  DOWN  (server not responding)");
      console.log("  Reranker:   DOWN  (server not responding)");
    }

    // Database
    const dbPath = resolve(config.dataDir, "threadclaw.db");
    try {
      const size = statSync(dbPath).size;
      console.log(`  Database:   OK  ${(size / 1024 / 1024).toFixed(2)} MB`);
    } catch {
      console.log("  Database:   MISSING");
    }

    // Collections
    try {
      const db = getInitializedDb();
      const collections = listCollections(db);

      console.log(`\nCollections: ${collections.length}\n`);
      for (const c of collections) {
        const stats = getCollectionStats(db, c.id);
        console.log(
          `  ${c.name} — ${stats?.documentCount ?? 0} docs, ${stats?.chunkCount ?? 0} chunks`,
        );
      }
    } catch {
      console.log("\nCollections: unable to read database");
    }

    // Evidence OS
    console.log(`\nEvidence OS:`);
    if (!config.relations) {
      console.log(`  Relations: not configured`);
    } else {
    console.log(`  Relations: ${config.relations.enabled ? "enabled" : "disabled"}`);
    const graphPath = config.relations.graphDbPath;
    if (existsSync(graphPath)) {
      try {
        const graphDb = getGraphDb(graphPath);

        const sz = statSync(graphPath).size;
        const entities = (graphDb.prepare("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'entity'").get() as { cnt: number }).cnt;
        const events = (graphDb.prepare("SELECT COUNT(*) as cnt FROM evidence_log").get() as { cnt: number }).cnt;
        console.log(`  Graph DB:  ${(sz / 1024 / 1024).toFixed(2)} MB`);
        console.log(`  Entities:  ${entities}`);
        console.log(`  Evidence:  ${events} events`);
        closeGraphDb();
      } catch {
        console.log(`  Graph DB:  exists but unreadable`);
      }
    } else {
      console.log(`  Graph DB:  not created yet`);
    }
    }

    console.log(`\nEndpoints:`);
    console.log(`  CLI:  threadclaw query / threadclaw ingest`);
    console.log(`  HTTP: http://localhost:${config.port}/query`);
  });
