/**
 * ThreadClaw MCP Server
 *
 * Exposes ThreadClaw RAG as an MCP (Model Context Protocol) stdio server.
 * OpenClaw agents can call threadclaw_query, threadclaw_ingest, etc. as native tools
 * instead of spawning CLI processes via exec.
 *
 * Usage:
 *   node --import tsx src/mcp.ts
 *
 * Or register in openclaw.json:
 *   plugins.entries.acpx.config.mcpServers.threadclaw.command = "node"
 *   plugins.entries.acpx.config.mcpServers.threadclaw.args = ["--import", "tsx", "src/mcp.ts"]
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "path";
import { z } from "zod";
import { getAppVersion } from "./version.js";

import { config } from "./config.js";
import { getDb, closeDb, runMigrations, listCollections, getCollectionStats } from "./storage/index.js";
import { query, type QueryOptions } from "./query/pipeline.js";
import { ingestFile } from "./ingest/pipeline.js";
import { validateIngestPath } from "./api/ingest.routes.js";

// ── Bootstrap database ──────────────────────────────────────────────
let db!: ReturnType<typeof getDb>;
try {
  const dbPath = resolve(config.dataDir, "threadclaw.db");
  db = getDb(dbPath);
  runMigrations(db);
} catch (err) {
  console.error(`[mcp] Failed to initialize database: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ── Create MCP server ───────────────────────────────────────────────
const server = new McpServer({
  name: "threadclaw",
  version: getAppVersion(),
});

// ── threadclaw_query ─────────────────────────────────────────────────────
server.tool(
  "threadclaw_query",
  "Search the knowledge base. Use mode='brief' by default (~200 tokens). Use 'titles' for exploration (~30 tokens). Use 'full' only when user asks to see a document.",
  {
    query: z.string().describe("Natural language search query"),
    collection: z.string().optional().describe("Collection to search (default: 'default'). Use 'all' to search everything, or specify a custom collection name."),
    mode: z.enum(["brief", "titles", "full"]).optional().describe("Output mode: 'brief' (~200 tokens, default), 'titles' (~30 tokens), 'full' (~1500 tokens)"),
    topK: z.number().min(1).max(100).optional().describe("Max results to return (default: 3, max: 100)"),
  },
  async ({ query: queryText, collection, mode, topK }) => {
    try {
      const opts: QueryOptions = {
        collection: collection ?? "default",
        topK: topK ?? 3,
        brief: mode === "brief" || mode === undefined,
        titlesOnly: mode === "titles",
        useReranker: mode !== "titles",
        useBm25: true,
      };

      const result = await query(queryText, opts);

      if (!result.context || result.context.trim() === "") {
        return {
          content: [{ type: "text", text: "No relevant documents found." }],
        };
      }

      // Append concise query metadata
      const conf = Number.isFinite(result.queryInfo.confidence)
        ? Math.round(result.queryInfo.confidence * 100)
        : 0;
      const meta = `--- ${result.queryInfo.strategy} | ${result.queryInfo.tokensUsed} tokens | ${conf}% conf | ${result.queryInfo.elapsedMs}ms ---`;

      return {
        content: [{ type: "text", text: `${result.highlighted ?? result.context}\n${meta}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Search error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── threadclaw_ingest ────────────────────────────────────────────────────
server.tool(
  "threadclaw_ingest",
  "Ingest a file into the knowledge base. The file watcher handles workspace files automatically — use this for files the user explicitly shares.",
  {
    path: z.string().describe("Absolute path to the file to ingest"),
    collection: z.string().optional().describe("Target collection (default: 'default')"),
    tags: z.array(z.string()).optional().describe("Optional tags for the document"),
  },
  async ({ path: filePath, collection, tags }) => {
    try {
      const pathErr = validateIngestPath(filePath);
      if (pathErr) {
        return {
          content: [{ type: "text", text: `Blocked: ${pathErr}` }],
          isError: true,
        };
      }

      const result = await ingestFile(filePath, {
        collection: collection ?? "default",
        tags: tags ?? [],
      });

      const msg = result.duplicatesSkipped > 0 && result.chunksCreated === 0
        ? `Already ingested (unchanged). ${result.duplicatesSkipped} chunks current.`
        : `Ingested: ${result.documentsAdded} doc, ${result.chunksCreated} chunks in ${result.elapsedMs}ms.`;

      return { content: [{ type: "text", text: msg }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Ingest error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── threadclaw_collections ───────────────────────────────────────────────
server.tool(
  "threadclaw_collections",
  "List all collections with document/chunk counts.",
  {},
  async () => {
    try {
      const collections = listCollections(db);

      if (collections.length === 0) {
        return { content: [{ type: "text", text: "No collections." }] };
      }

      const lines = collections.map((c) => {
        const stats = getCollectionStats(db, c.id);
        return stats
          ? `${c.name}: ${stats.documentCount} docs, ${stats.chunkCount} chunks`
          : `${c.name}: (no stats)`;
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Start stdio transport ───────────────────────────────────────────
try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (err) {
  console.error(`[mcp] Failed to start MCP transport: ${err instanceof Error ? err.message : String(err)}`);
  closeDb();
  process.exit(1);
}

// Graceful shutdown — await server.close() to drain pending requests
process.on("SIGINT", async () => { await server.close(); closeDb(); process.exit(0); });
process.on("SIGTERM", async () => { await server.close(); closeDb(); process.exit(0); });
