/**
 * Relations: entity extraction hook for the ingest pipeline.
 *
 * Self-contained module that performs entity extraction from ingested
 * document chunks and stores results in the evidence graph DB.
 *
 * Uses better-sqlite3 (the main ThreadClaw DB driver) for the graph DB.
 *
 * All entity data is stored in the unified ontology tables:
 *   - memory_objects (kind='entity')
 *   - provenance_links (predicate='mentioned_in')
 *
 * Schema is created by memory-engine's runGraphMigrations — this module
 * does NOT create tables.
 *
 * CANONICAL SOURCE: memory-engine/src/relations/graph-store.ts (storage)
 * and memory-engine/src/relations/entity-extract.ts (extraction).
 *
 * extractFast() and loadTerms() are loaded via dynamic import() from
 * memory-engine at runtime (single source of truth — no duplication).
 */

import type Database from "better-sqlite3";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Entity extraction types and loaders.
// CANONICAL SOURCE: memory-engine/src/relations/entity-extract.ts (extractFast)
// CANONICAL SOURCE: memory-engine/src/relations/terms.ts (loadTerms)
// These are loaded via dynamic import() at runtime to avoid cross-rootDir
// static import issues (src/ and memory-engine/src/ are separate TS projects).
// ---------------------------------------------------------------------------

/** Matches memory-engine/src/relations/types.ts ExtractionResult */
interface ExtractionResult {
  name: string;
  confidence: number;
  strategy: string;
  entityType?: string | null;
  snippet?: string;
  contextTerms?: string[];
}

// Paths are constructed at runtime so tsc --noEmit doesn't trace them
// across the rootDir boundary (src/ vs memory-engine/src/).
const _meBase = ["../..", "memory-engine", "src", "relations"].join("/");

let _extractFast: ((text: string, terms?: string[]) => ExtractionResult[]) | null = null;
let _loadTerms: ((path?: string) => string[]) | null = null;

async function getExtractFast(): Promise<(text: string, terms?: string[]) => ExtractionResult[]> {
  if (!_extractFast) {
    const mod = await import(/* webpackIgnore: true */ `${_meBase}/entity-extract.js`);
    _extractFast = mod.extractFast as typeof _extractFast;
  }
  return _extractFast!;
}

async function getLoadTerms(): Promise<(path?: string) => string[]> {
  if (!_loadTerms) {
    const mod = await import(/* webpackIgnore: true */ `${_meBase}/terms.js`);
    _loadTerms = mod.loadTerms as typeof _loadTerms;
  }
  return _loadTerms!;
}

// ---------------------------------------------------------------------------
// Graph store operations (using better-sqlite3 API, targeting memory_objects + provenance_links)
// ---------------------------------------------------------------------------

function storeEntities(
  db: Database.Database,
  entities: ExtractionResult[],
  sourceType: string,
  sourceId: string,
  sourceDetail?: string,
  scopeId: number = 1,
): void {
  const now = "strftime('%Y-%m-%dT%H:%M:%f','now')";

  // Upsert entity into memory_objects (kind='entity')
  // Column list matches mo-store.ts upsertMemoryObject() schema exactly
  const upsertStmt = db.prepare(`
    INSERT INTO memory_objects (
      composite_id, kind, canonical_key, content, structured_json,
      scope_id, branch_id, status, confidence, trust_score,
      influence_weight, superseded_by,
      source_kind, source_id, source_detail, source_authority,
      extraction_method, provisional,
      first_observed_at, last_observed_at, observed_at,
      created_at, updated_at
    ) VALUES (
      ?, 'entity', ?, ?, ?,
      ?, 0, 'active', 0.5, 0.5,
      'standard', NULL,
      'extraction', ?, ?, NULL,
      'regex', 0,
      ${now}, ${now}, ${now},
      ${now}, ${now}
    )
    ON CONFLICT(composite_id) DO UPDATE SET
      structured_json = ?,
      last_observed_at = ${now},
      updated_at = ${now}
  `);

  const selectStmt = db.prepare(
    "SELECT id, structured_json FROM memory_objects WHERE composite_id = ?",
  );

  // Insert mention as provenance_link
  const mentionStmt = db.prepare(`
    INSERT OR IGNORE INTO provenance_links
      (subject_id, predicate, object_id, confidence, detail, scope_id, metadata)
    VALUES (?, 'mentioned_in', ?, 1.0, ?, ?, ?)
  `);

  // Evidence logging (append-only audit trail)
  const scopeSeqBump = db.prepare(
    "INSERT INTO scope_sequences (scope_id, next_seq) VALUES (?, 2) ON CONFLICT(scope_id) DO UPDATE SET next_seq = next_seq + 1",
  );
  const scopeSeqGet = db.prepare(
    "SELECT next_seq - 1 AS seq FROM scope_sequences WHERE scope_id = ?",
  );
  const evidenceInsert = db.prepare(`
    INSERT OR IGNORE INTO evidence_log
      (scope_id, object_type, object_id, event_type, actor, idempotency_key, payload_json, created_at, scope_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ${now}, ?)
  `);

  for (const entity of entities) {
    const name = entity.name.toLowerCase().trim();
    if (!name) continue;

    const compositeId = `entity:${name}`;
    const displayName = entity.name.trim();
    const entityType = entity.strategy.startsWith("ner:") ? entity.strategy.slice(4) : null;
    const canonicalKey = `entity::${name}`;

    // Check existing to increment mentionCount
    let mentionCount = 1;
    const existingRow = selectStmt.get(compositeId) as { id: number; structured_json: string | null } | undefined;
    if (existingRow?.structured_json) {
      try {
        const parsed = JSON.parse(existingRow.structured_json);
        mentionCount = (Number(parsed.mentionCount) || 0) + 1;
      } catch { /* empty */ }
    }

    const structuredJson = JSON.stringify({
      name,
      displayName,
      entityType,
      mentionCount,
    });

    // Upsert — INSERT values match mo-store.ts schema + ON CONFLICT update values
    upsertStmt.run(
      compositeId, canonicalKey, displayName, structuredJson,
      scopeId, compositeId, sourceDetail ?? null,
      structuredJson, // for the ON CONFLICT UPDATE
    );

    // Get the row id
    const row = selectStmt.get(compositeId) as { id: number; structured_json: string | null } | undefined;
    if (!row) continue;

    const objectId = `${sourceType}:${sourceId}`;
    const metadataJson = JSON.stringify({
      context_terms: entity.contextTerms?.length ? entity.contextTerms : null,
      actor: "system",
      run_id: null,
    });
    mentionStmt.run(compositeId, objectId, sourceDetail ?? null, scopeId, metadataJson);

    // Log evidence event with idempotency key
    scopeSeqBump.run(scopeId);
    const seqRow = scopeSeqGet.get(scopeId) as { seq: number } | undefined;
    const seq = seqRow?.seq ?? 0;
    evidenceInsert.run(
      scopeId, "entity", row.id, "mention_insert", "system",
      `extract:${sourceType}:${sourceId}:${name}`,
      JSON.stringify({ confidence: entity.confidence, strategy: entity.strategy, sourceType, sourceId }),
      seq,
    );
  }
}

export function deleteSourceData(db: Database.Database, sourceType: string, sourceId: string): void {
  const objectKey = `${sourceType}:${sourceId}`;

  // Delete mentions (provenance_links with mentioned_in) for this source
  db.prepare(
    "DELETE FROM provenance_links WHERE object_id = ? AND predicate = 'mentioned_in'",
  ).run(objectKey);

  // Note: we don't delete the entity memory_objects themselves — they may be
  // referenced by other sources. Orphan cleanup happens separately.
}

/**
 * Clear all data tables in the graph DB (for full reset).
 * Preserves infrastructure tables (state_scopes, promotion_policies, _evidence_migrations).
 *
 * Only clears memory_objects, provenance_links, and infrastructure data tables.
 */
export function clearAllGraphTables(db: Database.Database): void {
  // Log a reset event to the audit trail BEFORE wiping it
  logger.warn("clearAllGraphTables: destroying all graph data including audit trail (evidence_log)");
  try {
    // Record the reset event so the audit trail captures why it was wiped
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO evidence_log
        (scope_id, object_type, object_id, event_type, actor, payload_json, created_at)
      VALUES (1, 'graph', 0, 'reset', 'system', ?, ?)
    `).run(
      JSON.stringify({ reason: "clearAllGraphTables called", timestamp: now }),
      now,
    );
  } catch { /* table may not exist yet */ }

  // Try to archive evidence_log to archive.db before deletion (sync best-effort)
  try {
    const esmRequire = createRequire(import.meta.url);
    const archiveMod = esmRequire("../../memory-engine/src/relations/archive.js");
    const archivePath = join(homedir(), ".threadclaw", "archive.db");
    archiveMod.runArchive(db, archivePath, { eventRetentionDays: 0 });
    logger.info("clearAllGraphTables: evidence_log archived before wipe");
  } catch {
    logger.warn("clearAllGraphTables: could not archive evidence_log before wipe (archive unavailable)");
  }

  // Unified ontology tables
  try { db.prepare("DELETE FROM provenance_links").run(); } catch {}
  try { db.prepare("DELETE FROM memory_objects").run(); } catch {}

  // Infrastructure tables that hold data (not schema)
  try { db.prepare("DELETE FROM work_leases").run(); } catch {}
  try { db.prepare("DELETE FROM state_deltas").run(); } catch {}
  try { db.prepare("DELETE FROM evidence_log").run(); } catch {}

  // Reset scope sequences to 1
  try { db.prepare("UPDATE scope_sequences SET next_seq = 1").run(); } catch {}
}

// ---------------------------------------------------------------------------
// NER endpoint helper
// ---------------------------------------------------------------------------

async function fetchNerEntities(
  chunks: Array<{ text: string }>,
): Promise<Array<{ text: string; label: string }[]> | null> {
  try {
    const { getModelBaseUrl } = await import("../tui/platform.js");
    const res = await fetch(`${getModelBaseUrl()}/ner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: chunks.map(c => c.text) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { results: Array<{ entities: Array<{ text: string; label: string }> }> };
    return data.results.map(r => r.entities);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API: ingest hook
// ---------------------------------------------------------------------------

/**
 * Extract entities from document chunks and store in the graph DB.
 * Atomic: deletes old data + re-extracts in one transaction.
 * Non-fatal: errors are logged and swallowed.
 *
 * Attempts NER extraction via model server first, then merges with regex
 * results. Falls back to regex-only if NER is unavailable.
 */
export async function extractEntitiesFromDocument(
  graphDb: Database.Database,
  documentId: string,
  chunks: Array<{ text: string; position: number }>,
): Promise<void> {
  try {
    // Schema is managed by memory-engine's runGraphMigrations
    const loadTermsFn = await getLoadTerms();
    const extractFastFn = await getExtractFast();
    const terms = loadTermsFn();

    // Try NER extraction (non-blocking, returns null on failure)
    let nerResults: Array<{ text: string; label: string }[]> | null = null;
    try {
      nerResults = await fetchNerEntities(chunks);
    } catch (err) {
      if (process.env.DEBUG) console.warn('[ingest] NER unavailable, using regex-only:', err instanceof Error ? err.message : String(err));
    }

    const tx = graphDb.transaction(() => {
      // Clean old data for this document
      deleteSourceData(graphDb, "document", documentId);

      // Extract and store from new chunks
      for (let i = 0; i < chunks.length; i++) {
        // Regex entities
        const regexEntities = extractFastFn(chunks[i].text, terms);

        // Build merged entity map (deduplicate by name, highest confidence wins)
        const merged = new Map<string, ExtractionResult>();

        // Add NER entities first (confidence 0.8)
        if (nerResults && nerResults[i]) {
          for (const ent of nerResults[i]) {
            const key = ent.text.toLowerCase().trim();
            if (!key) continue;
            merged.set(key, {
              name: ent.text,
              confidence: 0.8,
              strategy: `ner:${ent.label}`,
            });
          }
        }

        // Merge regex entities (higher confidence wins)
        for (const ent of regexEntities) {
          const key = ent.name.toLowerCase().trim();
          const existing = merged.get(key);
          if (!existing || ent.confidence > existing.confidence) {
            merged.set(key, ent);
          }
        }

        const entities = Array.from(merged.values());
        if (entities.length > 0) {
          storeEntities(graphDb, entities, "document", documentId, `chunk ${i}`);
        }
      }
    });

    tx();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), documentId },
      "Relations: entity extraction failed (non-fatal)",
    );
  }
}

/**
 * Store wikilink references as provenance_links in the graph DB.
 * Links a source document to target documents via the "references" predicate.
 * Non-fatal: errors are logged and swallowed.
 */
export function storeDocumentReferences(
  graphDb: Database.Database,
  sourceDocId: string,
  resolvedLinks: Array<{ target: string; resolvedPath?: string }>,
  mainDb: Database.Database,
): void {
  try {
    const now = new Date().toISOString();
    const insertLink = graphDb.prepare(`
      INSERT OR IGNORE INTO provenance_links
        (subject_id, predicate, object_id, confidence, created_at)
      VALUES (?, 'relates_to', ?, 1.0, ?)
    `);

    const findDoc = mainDb.prepare(
      "SELECT id FROM documents WHERE source_path = ? LIMIT 1",
    );

    const tx = graphDb.transaction(() => {
      // Remove old references from this source
      graphDb.prepare(
        "DELETE FROM provenance_links WHERE subject_id = ? AND predicate = 'relates_to'",
      ).run(`document:${sourceDocId}`);

      for (const link of resolvedLinks) {
        if (!link.resolvedPath) continue;
        const targetRow = findDoc.get(link.resolvedPath) as { id: string } | undefined;
        if (!targetRow) continue; // Target not ingested yet — skip
        insertLink.run(`document:${sourceDocId}`, `document:${targetRow.id}`, now);
      }
    });
    tx();
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), sourceDocId },
      "Relations: wikilink provenance failed (non-fatal)",
    );
  }
}
