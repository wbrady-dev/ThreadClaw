import type { FastifyInstance } from "fastify";
import { resolve } from "path";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { ingestFile } from "../ingest/pipeline.js";
import { isLocalRequest } from "./guards.js";
import { logger } from "../utils/logger.js";

/**
 * Validate that a file path is safe to ingest.
 * Rejects paths that try to escape expected locations.
 */
function validateIngestPath(filePath: string): string | null {
  const resolved = resolve(filePath);

  // Must be an absolute path to a real file
  if (!existsSync(resolved)) return "File not found";

  // Block sensitive paths using segment-aware matching (avoids false positives
  // like "/docs/environment.md" matching ".env" via substring)
  const lower = resolved.toLowerCase().replace(/\\/g, "/");
  const segments = lower.split("/");
  const basename = segments[segments.length - 1] ?? "";

  // Exact basename blocks
  const blockedNames = new Set([".env", "credentials", "secrets", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "id_xmss"]);
  if (blockedNames.has(basename)) return `Blocked path: '${basename}'`;

  // .env variant prefix (.env.local, .env.production, etc.)
  if (basename.startsWith(".env.")) return `Blocked path: '${basename}'`;

  // Sensitive directory segments
  const blockedSegments = new Set([".git", ".ssh", ".aws", ".docker", ".gnupg", ".kube", ".azure"]);
  for (const seg of segments) {
    if (blockedSegments.has(seg)) return `Blocked path: contains '${seg}/'`;
  }

  return null; // valid
}

export function registerIngestRoutes(server: FastifyInstance) {
  server.post("/ingest", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });
    const { path: filePath, collection, tags } = (req.body ?? {}) as {
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

    try {
      const result = await ingestFile(filePath, { collection, tags });
      return result;
    } catch (err) {
      return reply.status(500).send({ error: `Ingest failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  server.post("/ingest/text", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.status(403).send({ error: "Forbidden" });
    const { text, title, collection } = (req.body ?? {}) as {
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
