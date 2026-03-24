import { readFile, stat } from "fs/promises";
import { resolve } from "path";
import { v4 as uuidv4 } from "uuid";

import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { contentHash, contentHashBytes } from "../utils/hash.js";
import { trackTokens } from "../utils/token-tracker.js";
import {
  getDb,
  ensureCollection,
} from "../storage/index.js";
import { checkpoint } from "../storage/sqlite.js";
import { getParser } from "./parsers/index.js";
import { chunkDocument } from "./chunker/semantic.js";
import { enrichMetadata } from "./metadata.js";
import { embedBatch } from "../embeddings/batch.js";
import { findIntraBatchDuplicates, findExistingDuplicates } from "./dedup.js";
import { invalidateCollection } from "../query/cache.js";
import { getGraphDb } from "../storage/graph-sqlite.js";
import { extractEntitiesFromDocument } from "../relations/ingest-hook.js";

export interface IngestOptions {
  collection?: string;
  tags?: string[];
  /** Force re-ingestion even if content hash matches */
  force?: boolean;
}

export interface IngestResult {
  documentsAdded: number;
  documentsUpdated: number;
  chunksCreated: number;
  duplicatesSkipped: number;
  elapsedMs: number;
}

/**
 * File-level lock to prevent concurrent ingestion of the same file.
 * Prevents race conditions when the watcher and manual ingest overlap.
 */
const ingestLocks = new Set<string>();

/**
 * Ingest a file into the RAG system.
 *
 * Premium features:
 * - Incremental indexing: detects changed files by content hash + mtime
 * - Auto-update: if file changed, removes old version and re-ingests
 * - Auto-tagging: extracts tags from file type, directory structure, and metadata
 * - Parent-child chunk linking
 * - File-level locking: prevents concurrent ingestion of the same file
 */
export async function ingestFile(
  filePath: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const start = Date.now();
  const absPath = resolve(filePath);
  const collectionName = options.collection ?? config.defaults.collection;

  // File-level lock: skip if already being ingested
  if (ingestLocks.has(absPath)) {
    logger.debug({ filePath: absPath }, "Already ingesting, skipping");
    return {
      documentsAdded: 0,
      documentsUpdated: 0,
      chunksCreated: 0,
      duplicatesSkipped: 1,
      elapsedMs: Date.now() - start,
    };
  }
  ingestLocks.add(absPath);

  try {
    return await ingestFileInner(absPath, collectionName, options, start);
  } finally {
    ingestLocks.delete(absPath);
  }
}

async function ingestFileInner(
  absPath: string,
  collectionName: string,
  options: IngestOptions,
  start: number,
): Promise<IngestResult> {
  // Get DB (migrations run once at server startup)
  const dbPath = resolve(config.dataDir, "threadclaw.db");
  const db = getDb(dbPath);

  // Ensure collection exists
  const collection = ensureCollection(db, collectionName);

  // File size guard — prevent OOM on very large files
  const MAX_FILE_SIZE = config.extraction.ingestMaxFileSizeMb * 1024 * 1024;
  const fileStats = await stat(absPath).catch(() => null);
  const fileMtime = fileStats?.mtime.toISOString() ?? null;

  if (fileStats && fileStats.size > MAX_FILE_SIZE) {
    logger.warn({ filePath: absPath, sizeMB: Math.round(fileStats.size / 1024 / 1024) }, "File too large, skipping");
    return {
      documentsAdded: 0, documentsUpdated: 0, chunksCreated: 0,
      duplicatesSkipped: 1, elapsedMs: Date.now() - start,
    };
  }

  // Read file once as buffer, then try text decode. Avoids double I/O for binary files.
  const fileBuf = await readFile(absPath);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(fileBuf);
  } catch {
    // Binary files (pdf, docx, pptx) — text decode fails, parser handles natively
    raw = "";
  }

  // Stable hash from the buffer (avoids re-reading for binary files)
  const hash = raw
    ? await contentHash(raw)
    : await contentHashBytes(new Uint8Array(fileBuf));

  // Check for existing document at same path in same collection
  const existing = db
    .prepare(
      "SELECT id, content_hash, file_mtime FROM documents WHERE source_path = ? AND collection_id = ?",
    )
    .get(absPath, collection.id) as
    | { id: string; content_hash: string; file_mtime: string | null }
    | undefined;

  if (existing) {
    if (!options.force && existing.content_hash === hash) {
      // Same content hash and not forced — skip
      return {
        documentsAdded: 0,
        documentsUpdated: 0,
        chunksCreated: 0,
        duplicatesSkipped: 1,
        elapsedMs: Date.now() - start,
      };
    }

    logger.info({ filePath: absPath, forced: !!options.force }, "Re-indexing document");
  } else {
    // Also check by content hash (same file, different path)
    const hashDup = db
      .prepare(
        "SELECT id FROM documents WHERE content_hash = ? AND collection_id = ?",
      )
      .get(hash, collection.id);

    if (hashDup && !options.force) {
      return {
        documentsAdded: 0,
        documentsUpdated: 0,
        chunksCreated: 0,
        duplicatesSkipped: 1,
        elapsedMs: Date.now() - start,
      };
    }
  }

  // Parse
  // TODO(BUG 13): Binary parsers (pdf, pptx, docx) re-read the file from disk.
  // Pass fileBuf to parsers that accept a buffer to avoid double I/O.
  const parser = getParser(absPath);
  let parsed;
  try {
    parsed = await parser(absPath);
  } catch (err) {
    logger.error(`Parser failed for ${absPath}: ${err}`);
    return {
      documentsAdded: 0,
      documentsUpdated: 0,
      chunksCreated: 0,
      duplicatesSkipped: 0,
      elapsedMs: Date.now() - start,
    };
  }

  // Enrich metadata with auto-tags
  const autoTags = generateAutoTags(absPath, parsed.metadata.fileType);
  const allTags = [...(options.tags ?? []), ...autoTags];
  const metadata = await enrichMetadata(parsed.metadata, absPath, allTags);

  // Chunk
  const chunks = chunkDocument(parsed);

  if (chunks.length === 0) {
    return {
      documentsAdded: 0,
      documentsUpdated: 0,
      chunksCreated: 0,
      duplicatesSkipped: 0,
      elapsedMs: Date.now() - start,
    };
  }

  // Embed all chunks (include context prefix for better embeddings)
  const chunkTexts = chunks.map((c) =>
    c.contextPrefix ? `${c.contextPrefix}\n${c.text}` : c.text,
  );
  const embeddings = await embedBatch(chunkTexts, "passage");

  // Semantic deduplication — remove near-duplicate chunks
  const intraDupes = findIntraBatchDuplicates(embeddings);
  const existingDupes = findExistingDuplicates(db, embeddings, collection.id);
  const allDupes = new Set([...intraDupes, ...existingDupes]);

  // Filter out duplicates
  let dedupedIndices = chunks.map((_, i) => i).filter((i) => !allDupes.has(i));

  if (dedupedIndices.length === 0 && !existing) {
    // All chunks are duplicates and this is a new document — skip entirely
    return {
      documentsAdded: 0,
      documentsUpdated: 0,
      chunksCreated: 0,
      duplicatesSkipped: chunks.length,
      elapsedMs: Date.now() - start,
    };
  }

  // If updating an existing doc and all chunks deduped, keep the first chunk
  // to preserve the document record (old version is removed atomically in the transaction)
  if (dedupedIndices.length === 0) {
    dedupedIndices = [0];
    allDupes.delete(0);
  }

  // Pre-compute chunk content hashes (async — must happen before synchronous transaction)
  const chunkHashes = await Promise.all(
    dedupedIndices.map((i) => contentHash(chunks[i].text)),
  );

  // Store everything in a single transaction
  const documentId = uuidv4();
  const chunkIds: string[] = dedupedIndices.map(() => uuidv4());
  const isUpdate = !!existing;

  const store = db.transaction(() => {
    // Remove old version FIRST to avoid UNIQUE constraint on source_path
    // and to free up space before inserting new data.
    if (existing) {
      const oldChunkIds = db.prepare("SELECT id FROM chunks WHERE document_id = ?").all(existing.id) as { id: string }[];
      if (oldChunkIds.length > 0) {
        // BUG 2+10: inline vector deletion to avoid nested transaction from deleteVectors
        const delVecStmt = db.prepare("DELETE FROM chunk_vectors WHERE chunk_id = ?");
        for (const c of oldChunkIds) delVecStmt.run(c.id);
      }
      db.prepare("DELETE FROM documents WHERE id = ?").run(existing.id);
    }

    // Insert document with mtime for incremental indexing
    db.prepare(
      "INSERT INTO documents (id, collection_id, source_path, content_hash, metadata_json, size_bytes, file_mtime) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      documentId,
      collection.id,
      absPath,
      hash,
      JSON.stringify(metadata),
      metadata.sizeBytes ?? null,
      fileMtime,
    );

    // Insert chunks with parent linking (only non-duplicate chunks)
    const chunkStmt = db.prepare(
      "INSERT INTO chunks (id, document_id, text, context_prefix, position, token_count, content_hash, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );

    for (let ci = 0; ci < dedupedIndices.length; ci++) {
      const i = dedupedIndices[ci];
      const chunk = chunks[i];
      const parentId = (ci > 0 && dedupedIndices[ci] === dedupedIndices[ci - 1] + 1) ? chunkIds[ci - 1] : null;
      chunkStmt.run(
        chunkIds[ci],
        documentId,
        chunk.text,
        chunk.contextPrefix ?? null,
        chunk.position,
        chunk.tokenCount,
        chunkHashes[ci],
        parentId,
      );
    }

    // Insert vectors inline (avoids nested transaction from insertVector)
    const insertVecStmt = db.prepare(
      "INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?, ?)",
    );
    for (let ci = 0; ci < dedupedIndices.length; ci++) {
      const i = dedupedIndices[ci];
      insertVecStmt.run(chunkIds[ci], new Float32Array(embeddings[i]));
    }

    // Insert metadata index inline (avoids nested transaction from insertMetadata)
    const metaEntries: Record<string, string> = {};
    if (metadata.fileType) metaEntries.fileType = metadata.fileType;
    if (metadata.title) metaEntries.title = metadata.title;
    if (metadata.author) metaEntries.author = metadata.author;
    if (metadata.date) metaEntries.date = metadata.date;
    if (metadata.tags) {
      for (const tag of metadata.tags) {
        metaEntries[`tag:${tag}`] = tag;
      }
    }
    if (Object.keys(metaEntries).length > 0) {
      const metaStmt = db.prepare(
        "INSERT INTO metadata_index (document_id, key, value) VALUES (?, ?, ?)",
      );
      for (const [key, value] of Object.entries(metaEntries)) {
        metaStmt.run(documentId, key, value);
      }
    }
  });

  store();

  // Invalidate query cache for this collection (stale results after new/updated docs)
  invalidateCollection(collectionName);

  // Relations: extract entities from ingested chunks
  // WARNING: This runs outside the main transaction. If it fails, the document
  // is ingested but graph data is missing. This is intentional — graph extraction
  // is best-effort and should not roll back a successful ingest.
  if (config.relations.enabled) {
    try {
      const graphDb = getGraphDb(config.relations.graphDbPath);
      const chunkTexts = dedupedIndices.map((i) => ({
        text: chunks[i].text,
        position: chunks[i].position,
      }));
      await extractEntitiesFromDocument(graphDb, documentId, chunkTexts);
    } catch (graphErr) {
      logger.error(
        { documentId, error: graphErr instanceof Error ? graphErr.message : String(graphErr) },
        "Graph entity extraction failed — document ingested but graph data is missing",
      );
    }
  }

  // Checkpoint WAL after large ingests to prevent unbounded growth
  if (chunks.length >= 50) {
    checkpoint();
  }

  // Track token usage
  const totalIngestTokens = dedupedIndices.reduce((sum, i) => sum + (chunks[i].tokenCount ?? 0), 0);
  trackTokens("ingest", totalIngestTokens);
  trackTokens("embed", totalIngestTokens); // embed processes same tokens

  const elapsed = Date.now() - start;
  const dedupSkipped = allDupes.size;
  logger.info(
    { documentId, chunks: dedupedIndices.length, dedupSkipped, updated: isUpdate, elapsedMs: elapsed },
    "Document ingested",
  );

  return {
    documentsAdded: isUpdate ? 0 : 1,
    documentsUpdated: isUpdate ? 1 : 0,
    chunksCreated: dedupedIndices.length,
    duplicatesSkipped: dedupSkipped,
    elapsedMs: elapsed,
  };
}

/**
 * Generate automatic tags based on file path and type.
 * E.g., files in a "research" folder get tagged "research".
 */
function generateAutoTags(filePath: string, fileType: string): string[] {
  const tags: string[] = [fileType];

  // Extract directory names as potential tags
  const parts = filePath.replace(/\\/g, "/").split("/");
  const meaningfulDirs = parts.slice(-3, -1); // parent and grandparent dirs

  for (const dir of meaningfulDirs) {
    const lower = dir.toLowerCase();
    // Skip generic directory names
    if (
      !["src", "dist", "build", "node_modules", "users", ".openclaw", "workspace", "documents"].includes(lower) &&
      lower.length > 1 &&
      lower.length < 30
    ) {
      tags.push(lower);
    }
  }

  return [...new Set(tags)];
}
