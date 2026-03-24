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
 * When updating schema or extraction logic, update both locations.
 *
 * Parity: entity_type storage, evidence logging, scope_id on mentions,
 * word-boundary terms matching.
 */

import type Database from "better-sqlite3";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Fast entity extraction (same logic as memory-engine/src/relations/entity-extract.ts)
// ---------------------------------------------------------------------------

interface ExtractionResult {
  name: string;
  confidence: number;
  strategy: string;
  contextTerms?: string[];
}

const MONTH_NAMES = new Set([
  "january","february","march","april","may","june",
  "july","august","september","october","november","december",
]);
const COMMON_PHRASES = new Set([
  "the","this","that","these","those","here","there",
  "what","which","where","when","while","because","since",
  "however","therefore","although","please","thank",
]);

const CAPITALIZED_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
const QUOTED_RE = /[""\u201C]([^""\u201D]{2,50})[""\u201D]/g;
const VALID_TERM_RE = /^[\p{L}\p{N}\s\-_.'"]+$/u;

/** Cache compiled word-boundary regexes for terms to avoid re-creation per chunk. */
const termRegexCache = new Map<string, RegExp>();

function extractFast(text: string, terms: string[]): ExtractionResult[] {
  if (!text) return [];
  const deduped = new Map<string, ExtractionResult>();
  const lowerText = text.toLowerCase();

  // Strategy 1: Capitalized multi-word
  CAPITALIZED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CAPITALIZED_RE.exec(text)) !== null) {
    const name = m[1]!;
    const first = name.toLowerCase().split(/\s+/)[0] ?? "";
    if (MONTH_NAMES.has(first) || COMMON_PHRASES.has(first) || name.length < 4) continue;
    const key = name.toLowerCase().trim();
    if (!deduped.has(key) || 0.6 > (deduped.get(key)?.confidence ?? 0)) {
      deduped.set(key, { name, confidence: 0.6, strategy: "capitalized" });
    }
  }

  // Strategy 2: Terms-list (word-boundary matching, same as memory-engine)
  const presentTerms: string[] = [];
  for (const term of terms) {
    const lt = term.toLowerCase().trim();
    if (lt.length === 0) continue;
    // Quick substring pre-check before regex (fast path for non-matches)
    if (!lowerText.includes(lt)) continue;
    // Word-boundary check to avoid substring false positives (cached regex)
    let re = termRegexCache.get(lt);
    if (!re) {
      const escaped = lt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp("\\b" + escaped + "\\b", "i");
      termRegexCache.set(lt, re);
    }
    if (re.test(text)) {
      presentTerms.push(term);
      const key = lt;
      if (!deduped.has(key) || 0.9 > (deduped.get(key)?.confidence ?? 0)) {
        deduped.set(key, { name: term, confidence: 0.9, strategy: "terms_list" });
      }
    }
  }

  // Strategy 3: Quoted
  QUOTED_RE.lastIndex = 0;
  while ((m = QUOTED_RE.exec(text)) !== null) {
    const inner = m[1]!.trim();
    if (inner.length < 2) continue;
    if (/^[/\\.]|^https?:|^[{[<]|^[a-z]+[A-Z]|^[a-z]+_[a-z]/.test(inner)) continue;
    if (/\.(ts|js|py|go|rs|json|yaml|yml|md|txt|html|css|sh)$/i.test(inner)) continue;
    const key = inner.toLowerCase().trim();
    if (!deduped.has(key) || 0.5 > (deduped.get(key)?.confidence ?? 0)) {
      deduped.set(key, { name: inner, confidence: 0.5, strategy: "quoted" });
    }
  }

  // Attach context terms
  if (presentTerms.length > 0) {
    for (const r of deduped.values()) {
      r.contextTerms = presentTerms;
    }
  }

  return Array.from(deduped.values());
}

// ---------------------------------------------------------------------------
// Terms loader (same as memory-engine/src/relations/terms.ts)
// ---------------------------------------------------------------------------

let cachedTerms: string[] | null = null;
let cachedAt = 0;

function loadTerms(): string[] {
  if (cachedTerms !== null && Date.now() - cachedAt < 60_000) return cachedTerms;
  termRegexCache.clear();
  try {
    const raw = readFileSync(join(homedir(), ".threadclaw", "relations-terms.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.terms)) {
      cachedTerms = parsed.terms
        .filter((t: unknown) => typeof t === "string" && t.trim().length > 0 && t.length <= 100 && VALID_TERM_RE.test(t as string))
        .map((t: string) => t.trim())
        .slice(0, 500);
    } else {
      cachedTerms = [];
    }
  } catch {
    cachedTerms = [];
  }
  cachedAt = Date.now();
  return cachedTerms!;
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
  const upsertStmt = db.prepare(`
    INSERT INTO memory_objects (
      composite_id, kind, content, structured_json, canonical_key,
      provenance_json, confidence, trust_score, freshness, status,
      scope_id, branch_id, influence_weight,
      first_observed_at, last_observed_at, created_at, updated_at
    ) VALUES (
      ?, 'entity', ?, ?, ?,
      ?, 0.5, 0.5, 1.0, 'active',
      1, 0, 'standard',
      ${now}, ${now}, ${now}, ${now}
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
    const provenanceJson = JSON.stringify({
      source_kind: "extraction",
      source_id: compositeId,
      actor: "system",
      trust: 0.5,
    });

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

    // Upsert — INSERT values + ON CONFLICT update values
    upsertStmt.run(
      compositeId, displayName, structuredJson, canonicalKey,
      provenanceJson,
      structuredJson, // for the ON CONFLICT UPDATE
    );

    // Get the row id
    const row = selectStmt.get(compositeId) as { id: number; structured_json: string | null } | undefined;
    if (!row) continue;

    const ctJson = entity.contextTerms?.length ? JSON.stringify(entity.contextTerms) : null;
    const objectId = `${sourceType}:${sourceId}`;
    const metadataJson = JSON.stringify({
      context_terms: ctJson,
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
    const terms = loadTerms();

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
        const regexEntities = extractFast(chunks[i].text, terms);

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
