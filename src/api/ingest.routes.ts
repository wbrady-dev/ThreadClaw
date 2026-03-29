import type { FastifyInstance } from "fastify";
import { resolve } from "path";
import { realpathSync } from "fs";
import { writeFile, unlink } from "fs/promises"; // static import instead of dynamic
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { ingestFile } from "../ingest/pipeline.js";
import { isLocalRequest } from "./guards.js";
import { logger } from "../utils/logger.js";
import { toClientError } from "../utils/errors.js";

/**
 * Validate that a file path is safe to ingest.
 * Rejects paths that try to escape expected locations.
 */
export function validateIngestPath(filePath: string): string | null {
  // Resolve symlinks to prevent bypassing blocklist via symlink to sensitive file
  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch {
    return "File not found";
  }

  // Block sensitive paths using segment-aware matching (avoids false positives
  // like "/docs/environment.md" matching ".env" via substring)
  const lower = resolved.toLowerCase().replace(/\\/g, "/");
  const segments = lower.split("/");
  const basename = segments[segments.length - 1] ?? "";

  // Exact basename blocks (expanded blocklist)
  const blockedNames = new Set([
    ".env", "credentials", "secrets",
    "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "id_xmss",
    ".npmrc", ".netrc", ".pgpass", ".my.cnf",
    ".htpasswd", ".boto", ".s3cfg",
    "shadow", "passwd",
    "known_hosts", "authorized_keys",
    "token", "access_token",
  ]);
  if (blockedNames.has(basename)) return `Blocked path: '${basename}'`;

  // .env variant prefix (.env.local, .env.production, etc.)
  if (basename.startsWith(".env.")) return `Blocked path: '${basename}'`;

  // Sensitive directory segments
  const blockedSegments = new Set([".git", ".ssh", ".aws", ".docker", ".gnupg", ".kube", ".azure", "gcloud"]);
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
      return reply.status(400).send({ error: "Request body must include a 'path' field with the absolute file path to ingest." });
    }

    const err = validateIngestPath(filePath);
    if (err) {
      return reply.status(400).send({ error: err });
    }

    try {
      const result = await ingestFile(filePath, { collection, tags });
      return { ok: true, ...result };
    } catch (err) {
      return reply.status(500).send({ error: toClientError(err, "Ingest") });
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

    // Sanitize title: trim whitespace and enforce length limit
    const safeTitle = title ? title.trim().substring(0, 200) : undefined;

    const tmpPath = resolve(tmpdir(), `threadclaw_tmp_${randomUUID()}.md`);

    const content = safeTitle ? `# ${safeTitle.replace(/[#\n\r]/g, "")}\n\n${text}` : text;

    try {
      await writeFile(tmpPath, content, "utf-8");
    } catch (err) {
      return reply.status(500).send({ error: toClientError(err, "Ingest temp file") });
    }

    try {
      const result = await ingestFile(tmpPath, { collection });
      return { ok: true, ...result };
    } catch (err) {
      return reply.status(500).send({ error: toClientError(err, "Ingest") });
    } finally {
      await unlink(tmpPath).catch((err) => {
        logger.warn({ tmpPath, error: String(err) }, "Failed to clean up temp file");
      });
    }
  });
}
