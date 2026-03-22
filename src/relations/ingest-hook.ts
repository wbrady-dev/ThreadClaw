/**
 * Relations: entity extraction hook for the ingest pipeline.
 *
 * Self-contained module that performs entity extraction from ingested
 * document chunks and stores results in the evidence graph DB.
 *
 * Uses better-sqlite3 (the main ClawCore DB driver) for the graph DB.
 *
 * The entity extraction logic is intentionally duplicated from
 * memory-engine/src/relations/ to avoid cross-module dependencies
 * (different DB drivers: better-sqlite3 vs node:sqlite).
 *
 * CANONICAL SOURCE: memory-engine/src/relations/schema.ts (DDL) and
 * memory-engine/src/relations/entity-extract.ts (extraction).
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
// Schema migration (idempotent, same SQL as memory-engine/src/relations/schema.ts)
// ---------------------------------------------------------------------------

const MIGRATION_CHECK_SQL = "SELECT version FROM _evidence_migrations WHERE version = ?";

export function ensureGraphSchema(db: Database.Database): void {
  // Create migration tracking table first
  db.exec(`
    CREATE TABLE IF NOT EXISTS _evidence_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
    )
  `);

  const row = db.prepare(MIGRATION_CHECK_SQL).get(1) as { version: number } | undefined;
  if (row) return; // Already migrated

  // Run full v1 migration (same SQL as memory-engine schema.ts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_id INTEGER, branch_id INTEGER,
        object_type TEXT NOT NULL, object_id INTEGER NOT NULL,
        event_type TEXT NOT NULL, actor TEXT, run_id TEXT,
        idempotency_key TEXT UNIQUE, payload_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        scope_seq INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_log_scope ON evidence_log(scope_id, scope_seq);
    CREATE INDEX IF NOT EXISTS idx_evidence_log_object ON evidence_log(object_type, object_id, created_at);

    CREATE TABLE IF NOT EXISTS scope_sequences (
        scope_id INTEGER PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS state_scopes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_type TEXT NOT NULL, scope_key TEXT NOT NULL, display_name TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        UNIQUE(scope_type, scope_key)
    );
    INSERT OR IGNORE INTO state_scopes (id, scope_type, scope_key, display_name)
    VALUES (1, 'system', 'global', 'Global');
    INSERT OR IGNORE INTO scope_sequences (scope_id, next_seq) VALUES (1, 1);

    CREATE TABLE IF NOT EXISTS branch_scopes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_id INTEGER NOT NULL REFERENCES state_scopes(id) ON DELETE CASCADE,
        branch_type TEXT NOT NULL, branch_key TEXT NOT NULL,
        parent_branch_id INTEGER REFERENCES branch_scopes(id),
        created_by_actor TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        promoted_at TEXT,
        UNIQUE(scope_id, branch_type, branch_key)
    );

    CREATE TABLE IF NOT EXISTS promotion_policies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_type TEXT NOT NULL, min_confidence REAL DEFAULT 0.6,
        requires_user_confirm INTEGER DEFAULT 0,
        auto_promote_above_confidence REAL,
        requires_evidence_count INTEGER DEFAULT 1,
        max_age_hours INTEGER, policy_text TEXT,
        UNIQUE(object_type)
    );
    INSERT OR IGNORE INTO promotion_policies (object_type, min_confidence, requires_user_confirm, auto_promote_above_confidence, requires_evidence_count, max_age_hours, policy_text) VALUES
        ('entity',0.3,0,NULL,1,NULL,'Entities promote freely'),
        ('mention',0.0,0,NULL,1,NULL,'Mentions write directly'),
        ('claim',0.6,0,NULL,2,168,'Claims need 0.6+ and 2+ evidence'),
        ('decision',0.5,1,0.7,1,NULL,'Decisions need confirm or 0.7+'),
        ('loop',0.3,0,NULL,1,72,'Loops expire after 3 days'),
        ('attempt',0.0,0,NULL,1,NULL,'Attempts write directly'),
        ('runbook',0.5,0,NULL,2,NULL,'Runbooks need 2+ evidence'),
        ('anti_runbook',0.5,0,NULL,2,NULL,'Anti-runbooks need 2+ evidence'),
        ('invariant',0.7,1,0.9,1,NULL,'Invariants need confirm or 0.9+'),
        ('capability',0.0,0,NULL,1,NULL,'Capabilities write directly');

    CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, display_name TEXT NOT NULL, entity_type TEXT,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        mention_count INTEGER DEFAULT 1,
        UNIQUE(name)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    CREATE INDEX IF NOT EXISTS idx_entities_last_seen ON entities(last_seen_at);

    CREATE TABLE IF NOT EXISTS entity_mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        scope_id INTEGER REFERENCES state_scopes(id),
        source_type TEXT NOT NULL, source_id TEXT NOT NULL,
        source_detail TEXT, context_terms TEXT,
        actor TEXT DEFAULT 'system', run_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions(entity_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_mentions_source ON entity_mentions(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_mentions_scope ON entity_mentions(scope_id, entity_id);

    INSERT INTO _evidence_migrations (version) VALUES (1);
  `);
}

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
    // Word-boundary check to avoid substring false positives
    const escaped = lt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp("\\b" + escaped + "\\b", "i").test(text)) {
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
  try {
    const raw = readFileSync(join(homedir(), ".clawcore", "relations-terms.json"), "utf-8");
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
// Graph store operations (using better-sqlite3 API)
// ---------------------------------------------------------------------------

function storeEntities(
  db: Database.Database,
  entities: ExtractionResult[],
  sourceType: string,
  sourceId: string,
  sourceDetail?: string,
  scopeId: number = 1,
): void {
  const upsertStmt = db.prepare(`
    INSERT INTO entities (name, display_name, entity_type, first_seen_at, last_seen_at, mention_count)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%f','now'), strftime('%Y-%m-%dT%H:%M:%f','now'), 1)
    ON CONFLICT(name) DO UPDATE SET
      mention_count = mention_count + 1,
      last_seen_at = strftime('%Y-%m-%dT%H:%M:%f','now'),
      entity_type = COALESCE(excluded.entity_type, entities.entity_type)
  `);
  const selectStmt = db.prepare("SELECT id FROM entities WHERE name = ?");
  const mentionStmt = db.prepare(`
    INSERT OR IGNORE INTO entity_mentions
      (entity_id, scope_id, source_type, source_id, source_detail, context_terms, actor)
    VALUES (?, ?, ?, ?, ?, ?, 'system')
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
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%f','now'), ?)
  `);

  for (const entity of entities) {
    const name = entity.name.toLowerCase().trim();
    if (!name) continue;
    // Derive entity_type from NER strategy (e.g. "ner:PERSON" → "PERSON")
    const entityType = entity.strategy.startsWith("ner:") ? entity.strategy.slice(4) : null;
    upsertStmt.run(name, entity.name.trim(), entityType);
    const row = selectStmt.get(name) as { id: number } | undefined;
    if (!row) continue;
    const ctJson = entity.contextTerms?.length ? JSON.stringify(entity.contextTerms) : null;
    mentionStmt.run(row.id, scopeId, sourceType, sourceId, sourceDetail ?? null, ctJson);

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
  const counts = db.prepare(`
    SELECT entity_id, COUNT(*) as cnt FROM entity_mentions
    WHERE source_type = ? AND source_id = ? GROUP BY entity_id
  `).all(sourceType, sourceId) as Array<{ entity_id: number; cnt: number }>;

  for (const { entity_id, cnt } of counts) {
    db.prepare("UPDATE entities SET mention_count = MAX(0, mention_count - ?) WHERE id = ?")
      .run(cnt, entity_id);
  }
  db.prepare("DELETE FROM entity_mentions WHERE source_type = ? AND source_id = ?")
    .run(sourceType, sourceId);
  db.prepare("DELETE FROM entities WHERE mention_count <= 0").run();
}

/**
 * Clear all data tables in the graph DB (for full reset).
 * Preserves infrastructure tables (state_scopes, promotion_policies, _evidence_migrations).
 * FK-safe deletion order: children before parents.
 */
export function clearAllGraphTables(db: Database.Database): void {
  const tables = [
    "work_leases", "anti_runbook_evidence", "runbook_evidence", "claim_evidence",
    "entity_mentions", "state_deltas", "anti_runbooks", "runbooks", "attempts",
    "invariants", "capabilities", "open_loops", "decisions", "claims",
    "entity_relations", "entities", "evidence_log",
  ];
  for (const table of tables) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch {}
  }
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
    ensureGraphSchema(graphDb);
    const terms = loadTerms();

    // Try NER extraction (non-blocking, returns null on failure)
    let nerResults: Array<{ text: string; label: string }[]> | null = null;
    try {
      nerResults = await fetchNerEntities(chunks);
    } catch {
      // NER failure is non-fatal — fall back to regex-only
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
