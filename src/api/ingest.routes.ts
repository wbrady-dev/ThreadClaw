import type { FastifyInstance } from "fastify";
import { resolve } from "path";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { ingestFile } from "../ingest/pipeline.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Validate that a file path is safe to ingest.
 * Rejects paths that try to escape expected locations.
 */
function validateIngestPath(filePath: string): string | null {
  const resolved = resolve(filePath);

  // Must be an absolute path to a real file
  if (!existsSync(resolved)) return "File not found";

  // Block obvious sensitive paths
  const lower = resolved.toLowerCase().replace(/\\/g, "/");
  const blocked = [".env", "credentials", "secrets", ".git/config", "id_rsa", ".ssh/"];
  for (const b of blocked) {
    if (lower.includes(b)) return `Blocked path: contains '${b}'`;
  }

  return null; // valid
}

export function registerIngestRoutes(server: FastifyInstance) {
  server.post("/ingest", async (req, reply) => {
    const { path: filePath, collection, tags } = req.body as {
      path: string;
      collection?: string;
      tags?: string[];
    };

    if (!filePath) {
      return reply.status(400).send({ error: "path required" });
    }

    const err = validateIngestPath(filePath);
    if (err) {
      return reply.status(400).send({ error: err });
    }

    const result = await ingestFile(filePath, { collection, tags });
    return result;
  });

  server.post("/ingest/text", async (req, reply) => {
    const { text, title, collection } = req.body as {
      text: string;
      title?: string;
      collection?: string;
    };

    if (!text) {
      return reply.status(400).send({ error: "text required" });
    }

    const MAX_TEXT_SIZE = 10_000_000; // 10MB
    if (text.length > MAX_TEXT_SIZE) {
      return reply.status(413).send({ error: `Text too large (${(text.length / 1_000_000).toFixed(1)} MB). Maximum: ${MAX_TEXT_SIZE / 1_000_000} MB` });
    }

    // Write to temp file and ingest
    const { writeFile, unlink } = await import("fs/promises");
    const tmpPath = resolve(tmpdir(), `clawcore_tmp_${randomUUID()}.md`);

    const content = title ? `# ${title}\n\n${text}` : text;
    await writeFile(tmpPath, content, "utf-8");

    try {
      const result = await ingestFile(tmpPath, { collection });
      return result;
    } finally {
      await unlink(tmpPath).catch((err) => {
        logger.warn({ tmpPath, error: String(err) }, "Failed to clean up temp file");
      });
    }
  });
}
