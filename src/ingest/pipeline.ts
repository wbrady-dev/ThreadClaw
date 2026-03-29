import { readFile, stat } from "fs/promises";
import { resolve, sep } from "path";
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
import { extractEntitiesFromDocument, extractDeepFromDocument, deleteSourceData, storeDocumentReferences } from "../relations/ingest-hook.js";

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

  // Path containment check — prevent directory traversal attacks.
  // Allow: service root, configured watch paths (not entire homedir), and ~/.threadclaw (staging).
  const allowedBases = [
    resolve(config.dataDir, ".."),                                    // service root
  ];
  // Add configured watch paths (parsed from WATCH_PATHS=path1|col1,path2|col2)
  if (config.watch.paths) {
    for (const entry of config.watch.paths.split(",")) {
      const watchDir = entry.split("|")[0]?.trim();
      if (watchDir) allowedBases.push(resolve(watchDir));
    }
  }
  const pathOk = allowedBases.some(
    (base) => absPath.startsWith(resolve(base) + sep) || absPath === resolve(base),
  );
  if (!pathOk) {
    logger.warn({ filePath: absPath, allowedBases }, "File path outside allowed base directories");
    return {
      documentsAdded: 0, documentsUpdated: 0, chunksCreated: 0,
      duplicatesSkipped: 0, elapsedMs: Date.now() - start,
    };
  }

  // File size guard — prevent OOM on very large files
  const MAX_FILE_SIZE = config.extraction.ingestMaxFileSizeMb * 1024 * 1024;
  const fileStats = await stat(absPath).catch(() => null);
  const fileMtime = fileStats?.mtime.toISOString() ?? null;

  // If stat() failed, the file doesn't exist or is inaccessible — return error early
  if (!fileStats) {
    logger.warn({ filePath: absPath }, "File stat failed — file may not exist or is inaccessible");
    return {
      documentsAdded: 0, documentsUpdated: 0, chunksCreated: 0,
      duplicatesSkipped: 0, elapsedMs: Date.now() - start,
    };
  }

  if (fileStats.size > MAX_FILE_SIZE) {
    logger.warn({ filePath: absPath, sizeMB: Math.round(fileStats.size / 1024 / 1024) }, "File too large, skipping");
    return {
      documentsAdded: 0, documentsUpdated: 0, chunksCreated: 0,
      duplicatesSkipped: 1, elapsedMs: Date.now() - start,
    };
  }

  // Check for existing document at same path in same collection
  const existing = db
    .prepare(
      "SELECT id, content_hash, text_content_hash, file_mtime FROM documents WHERE source_path = ? AND collection_id = ?",
    )
    .get(absPath, collection.id) as
    | { id: string; content_hash: string; text_content_hash: string | null; file_mtime: string | null }
    | undefined;

  // Issue 4 fix: fast mtime pre-check — skip file read if mtime matches exactly
  if (existing && !options.force && existing.file_mtime && existing.file_mtime === fileMtime) {
    logger.debug({ filePath: absPath }, "File mtime unchanged — skipping without read");
    return {
      documentsAdded: 0,
      documentsUpdated: 0,
      chunksCreated: 0,
      duplicatesSkipped: 1,
      elapsedMs: Date.now() - start,
    };
  }

  // TODO: Streaming — entire file is read into memory as a single buffer.
  // For very large files (near the size limit), consider streaming to parsers.
  const fileBuf = await readFile(absPath);
  let raw: string;
  let isBinaryFormat = false;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(fileBuf);
  } catch {
    // Binary files (pdf, docx, pptx) — text decode fails, parser handles natively
    raw = "";
    isBinaryFormat = true;
  }

  // Stable hash from the buffer (avoids re-reading for binary files)
  const hash = raw
    ? await contentHash(raw)
    : await contentHashBytes(new Uint8Array(fileBuf));

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
  // KNOWN ISSUE (TOCTOU): Binary parsers (pdf, pptx, docx) re-read the file from disk.
  // The file could change between our read above and the parser's read. Pass fileBuf
  // to parsers that accept a buffer to avoid both double I/O and this race condition.
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

  // Issue 2 fix: For binary formats where byte hash changed, check if parsed text is
  // actually unchanged. Regenerated PDFs with identical text but different binary
  // encoding will match on text hash, avoiding a full re-ingest.
  if (isBinaryFormat && existing && !options.force && existing.text_content_hash && parsed.text) {
    const parsedTextHash = await contentHash(parsed.text);
    if (existing.text_content_hash === parsedTextHash) {
      // Text content identical — update byte hash and mtime but skip full re-ingest
      db.prepare(
        "UPDATE documents SET content_hash = ?, file_mtime = ? WHERE id = ?",
      ).run(hash, fileMtime, existing.id);
      logger.debug({ filePath: absPath }, "Binary bytes changed but parsed text unchanged — skipping re-ingest");
      return {
        documentsAdded: 0,
        documentsUpdated: 0,
        chunksCreated: 0,
        duplicatesSkipped: 1,
        elapsedMs: Date.now() - start,
      };
    }
  }

  // Check if parsed text is an error placeholder — don't chunk/embed error strings
  const ERROR_PLACEHOLDER_RE = /^\[(PDF|DOCX|PPTX|EPUB|Image|Audio):\s.*(\u2014|--)\s*(parse failed|no text detected|no speech detected|OCR failed|OCR unavailable|transcription failed|transcription disabled|file not found|file too large|Whisper not installed)/;
  if (ERROR_PLACEHOLDER_RE.test(parsed.text.trim())) {
    logger.warn({ filePath: absPath }, `Parser returned error placeholder: ${parsed.text.substring(0, 120)}`);
    return {
      documentsAdded: 0, documentsUpdated: 0, chunksCreated: 0,
      duplicatesSkipped: 0, elapsedMs: Date.now() - start,
    };
  }

  // Enrich metadata with auto-tags
  const autoTags = generateAutoTags(absPath, parsed.metadata.fileType);
  const allTags = [...(options.tags ?? []), ...autoTags];
  const metadata = await enrichMetadata(parsed.metadata, absPath, allTags, fileStats);

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

  // Semantic deduplication — remove near-duplicate chunks.
  // For updates, old embeddings are deleted inside store() transaction below (atomically).
  // Cross-DB dedup uses force=true for updates to avoid self-matching.
  const intraDupes = findIntraBatchDuplicates(embeddings);
  const existingDupes = (options.force || existing)
    ? new Set<number>()
    : findExistingDuplicates(db, embeddings, collection.id);
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

  // Issue 2 fix: compute text_content_hash for binary formats after parsing.
  // Binary files (PDF, DOCX, etc.) with same text but different binary encoding
  // will match on text hash, avoiding unnecessary re-ingestion.
  const textContentHash = isBinaryFormat && parsed.text
    ? await contentHash(parsed.text)
    : null;

  const store = db.transaction(() => {
    // Delete old version inside the same transaction for atomicity (no window for data loss).
    if (existing) {
      const oldChunkIds = db.prepare("SELECT id FROM chunks WHERE document_id = ?").all(existing.id) as { id: string }[];
      if (oldChunkIds.length > 0) {
        const delVecStmt = db.prepare("DELETE FROM chunk_vectors WHERE chunk_id = ?");
        for (const c of oldChunkIds) delVecStmt.run(c.id);
      }
      db.prepare("DELETE FROM chunks WHERE document_id = ?").run(existing.id);
      db.prepare("DELETE FROM metadata_index WHERE document_id = ?").run(existing.id);
      db.prepare("DELETE FROM documents WHERE id = ?").run(existing.id);
    }

    // Insert document with mtime for incremental indexing.
    // ON CONFLICT handles race-condition duplicates (Issue 3).
    db.prepare(
      `INSERT INTO documents (id, collection_id, source_path, content_hash, text_content_hash, metadata_json, size_bytes, file_mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_path, collection_id) DO UPDATE SET
         id = excluded.id,
         content_hash = excluded.content_hash,
         text_content_hash = excluded.text_content_hash,
         metadata_json = excluded.metadata_json,
         size_bytes = excluded.size_bytes,
         file_mtime = excluded.file_mtime`,
    ).run(
      documentId,
      collection.id,
      absPath,
      hash,
      textContentHash,
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
      const parentId = ci > 0 ? chunkIds[ci - 1] : null;
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
      // Clean up old document's graph data on update (old ID differs from new ID)
      if (existing) {
        try { deleteSourceData(graphDb, "document", existing.id); } catch {}
      }
      const relationChunkTexts = dedupedIndices.map((i) => ({
        text: chunks[i].text,
        position: chunks[i].position,
      }));
      await extractEntitiesFromDocument(graphDb, documentId, relationChunkTexts);

      // Deep extraction: claims from document chunks (async, non-blocking)
      if (config.relations?.deepIngestEnabled) {
        extractDeepFromDocument(graphDb, documentId, relationChunkTexts)
          .catch(err => logger.warn({ err: err instanceof Error ? err.message : String(err), documentId }, "Deep doc extraction failed (non-fatal)"));
      }

      // Store wikilink references as graph provenance (Obsidian integration)
      if (metadata.links?.some((l) => l.resolvedPath)) {
        storeDocumentReferences(graphDb, documentId, metadata.links, db);
      }
    } catch (graphErr) {
      logger.error(
        { documentId, error: graphErr instanceof Error ? graphErr.message : String(graphErr) },
        "Graph entity extraction failed — document ingested but graph data is missing",
      );
    }
  }

  // Checkpoint WAL after large ingests to prevent unbounded growth
  // NOTE: Threshold of 50 chunks is hardcoded. Consider making configurable via config.extraction.checkpointThreshold.
  // NOTE: When chunks are deduped, parent-child linking uses dedupedIndices which may have gaps.
  // This means parent_id chains can be broken when intermediate chunks are removed as duplicates.
  // This is acceptable — the parent_id is used for context enrichment, not structural integrity.
  if (chunks.length >= 50) {
    checkpoint();
  }

  // Track token usage
  const totalIngestTokens = dedupedIndices.reduce((sum, i) => sum + (chunks[i].tokenCount ?? 0), 0);
  trackTokens("ingest", totalIngestTokens);

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
  const tags: string[] = [];
  if (fileType) tags.push(fileType);

  // Extract directory names as potential tags
  const parts = filePath.replace(/\\/g, "/").split("/");
  const meaningfulDirs = parts.slice(-3, -1); // parent and grandparent dirs

  for (const dir of meaningfulDirs) {
    const lower = dir.toLowerCase();
    // Skip generic directory names and Windows drive letters (e.g., "c:", "d:")
    if (
      !["src", "dist", "build", "node_modules", "users", ".openclaw", "workspace", "documents"].includes(lower) &&
      !/^[a-z]:$/.test(lower) &&
      lower.length > 1 &&
      lower.length < 30
    ) {
      tags.push(lower);
    }
  }

  return [...new Set(tags)];
}
