/**
 * mo-store.ts — Unified CRUD layer for the memory_objects table.
 *
 * All reads/writes to memory_objects go through this module.
 * Structured data is serialized as JSON in the structured_json column.
 */

import type {
  MemoryObject,
  MemoryKind,
  MemoryStatus,
  SourceKind,
  InfluenceWeight,
} from "./types.js";
import { buildCanonicalKey } from "./canonical.js";

/** Abstract DB interface — compatible with both node:sqlite DatabaseSync and better-sqlite3. */
interface GraphDb {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isoNow(): string {
  return new Date().toISOString();
}

function safeStr(val: unknown, fallback = ""): string {
  return typeof val === "string" ? val : fallback;
}

function safeNum(val: unknown, fallback: number): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

const VALID_SOURCE_KINDS = new Set<string>([
  "document", "message", "tool_result", "user_explicit",
  "extraction", "compaction", "inference",
]);

function validSourceKind(val: unknown): SourceKind {
  const s = typeof val === "string" ? val : "";
  return VALID_SOURCE_KINDS.has(s) ? (s as SourceKind) : "extraction";
}

const VALID_INFLUENCE_WEIGHTS = new Set<string>(["critical", "high", "standard", "low"]);

function validInfluenceWeight(val: unknown): InfluenceWeight {
  const s = typeof val === "string" ? val : "";
  return VALID_INFLUENCE_WEIGHTS.has(s) ? (s as InfluenceWeight) : "standard";
}

const VALID_STATUSES = new Set<string>(["active", "superseded", "retracted", "stale", "needs_confirmation"]);

function validStatus(val: unknown): MemoryStatus {
  const s = typeof val === "string" ? val : "";
  return VALID_STATUSES.has(s) ? (s as MemoryStatus) : "active";
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Insert or update a MemoryObject in the memory_objects table.
 *
 * If the object has a canonical_key, uses ON CONFLICT(scope_id, branch_id, canonical_key)
 * to upsert. Otherwise does a plain INSERT (keyed only by composite_id).
 */
export function upsertMemoryObject(
  db: GraphDb,
  obj: MemoryObject,
): { moId: number; isNew: boolean } {
  const structuredJson = obj.structured != null
    ? JSON.stringify(obj.structured)
    : null;

  const canonicalKey = obj.canonical_key ??
    buildCanonicalKey(obj.kind, obj.content, obj.structured) ??
    null;

  const now = isoNow();
  const sourceKind = obj.provenance?.source_kind ?? "extraction";
  const sourceId = obj.provenance?.source_id ?? "";
  const sourceDetail = obj.provenance?.source_detail ?? null;
  const sourceAuthority = obj.provenance?.trust ?? 0.5;
  const branchId = 0; // default branch

  // Try upsert by composite_id first
  const existing = db.prepare(
    "SELECT id FROM memory_objects WHERE composite_id = ?",
  ).get(obj.id) as { id: number } | undefined;

  if (existing) {
    // Weighted confidence blend: new * 0.7 + old * 0.3 (gives recent evidence more weight)
    const oldRow = db.prepare("SELECT confidence FROM memory_objects WHERE id = ?").get(existing.id) as { confidence: number } | undefined;
    const oldConf = oldRow?.confidence ?? 0.5;
    const newConf = obj.confidence ?? 0.5;
    const blendedConfidence = newConf * 0.7 + oldConf * 0.3;

    db.prepare(`
      UPDATE memory_objects SET
        kind = ?,
        canonical_key = ?,
        content = ?,
        structured_json = ?,
        scope_id = ?,
        branch_id = ?,
        status = ?,
        confidence = ?,
        trust_score = ?,
        influence_weight = ?,
        superseded_by = ?,
        source_kind = ?,
        source_id = ?,
        source_detail = ?,
        source_authority = ?,
        last_observed_at = ?,
        observed_at = ?,
        updated_at = ?
      WHERE composite_id = ?
    `).run(
      obj.kind,
      canonicalKey,
      obj.content,
      structuredJson,
      obj.scope_id ?? 1,
      branchId,
      obj.status ?? "active",
      blendedConfidence,
      obj.provenance?.trust ?? 0.5,
      obj.influence_weight ?? "standard",
      obj.superseded_by != null ? obj.superseded_by : null,
      sourceKind,
      sourceId,
      sourceDetail,
      sourceAuthority,
      now,
      obj.observed_at ?? now,
      now,
      obj.id,
    );
    return { moId: existing.id, isNew: false };
  }

  // New insert
  const result = db.prepare(`
    INSERT INTO memory_objects (
      composite_id, kind, canonical_key, content, structured_json,
      scope_id, branch_id, status, confidence, trust_score,
      influence_weight, superseded_by,
      source_kind, source_id, source_detail, source_authority,
      first_observed_at, last_observed_at, observed_at,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?
    )
  `).run(
    obj.id,
    obj.kind,
    canonicalKey,
    obj.content,
    structuredJson,
    obj.scope_id ?? 1,
    branchId,
    obj.status ?? "active",
    obj.confidence ?? 0.5,
    obj.provenance?.trust ?? 0.5,
    obj.influence_weight ?? "standard",
    obj.superseded_by != null ? obj.superseded_by : null,
    sourceKind,
    sourceId,
    sourceDetail,
    sourceAuthority,
    obj.observed_at ?? now,
    obj.observed_at ?? now,
    obj.observed_at ?? now,
    obj.created_at ?? now,
    obj.updated_at ?? now,
  );

  return { moId: Number(result.lastInsertRowid), isNew: true };
}

/**
 * Mark a MemoryObject as superseded by another.
 */
export function supersedeMemoryObject(
  db: GraphDb,
  oldCompositeId: string,
  newCompositeId: string,
): void {
  db.prepare(`
    UPDATE memory_objects
    SET status = 'superseded',
        superseded_by = (SELECT id FROM memory_objects WHERE composite_id = ?),
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
    WHERE composite_id = ?
  `).run(newCompositeId, oldCompositeId);
}

/**
 * Update the status of a MemoryObject by composite_id.
 */
export function updateMemoryObjectStatus(
  db: GraphDb,
  compositeId: string,
  status: MemoryStatus,
): void {
  db.prepare(`
    UPDATE memory_objects
    SET status = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
    WHERE composite_id = ?
  `).run(status, compositeId);
}

/**
 * Delete all MemoryObjects that came from a specific source.
 */
export function deleteMemoryObjectsBySource(
  db: GraphDb,
  sourceKind: string,
  sourceId: string,
): void {
  db.prepare(
    "DELETE FROM memory_objects WHERE source_kind = ? AND source_id = ?",
  ).run(sourceKind, sourceId);
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Retrieve a single MemoryObject by its composite_id.
 */
export function getMemoryObject(
  db: GraphDb,
  compositeId: string,
): MemoryObject | undefined {
  const row = db.prepare(
    "SELECT * FROM memory_objects WHERE composite_id = ?",
  ).get(compositeId) as Record<string, unknown> | undefined;

  if (!row) return undefined;
  return rowToMemoryObject(row);
}

/** Options for querying multiple MemoryObjects. */
export interface QueryMemoryObjectsOpts {
  kinds?: MemoryKind[];
  scopeId?: number;
  branchId?: number;
  statuses?: MemoryStatus[];
  keyword?: string;
  limit?: number;
}

/**
 * Query memory_objects with dynamic filters.
 */
export function queryMemoryObjects(
  db: GraphDb,
  opts: QueryMemoryObjectsOpts,
): MemoryObject[] {
  let sql = "SELECT * FROM memory_objects WHERE 1=1";
  const params: unknown[] = [];

  if (opts.kinds && opts.kinds.length > 0) {
    sql += ` AND kind IN (${opts.kinds.map(() => "?").join(",")})`;
    params.push(...opts.kinds);
  }

  if (opts.scopeId != null) {
    sql += " AND scope_id = ?";
    params.push(opts.scopeId);
  }

  if (opts.branchId != null) {
    sql += " AND branch_id = ?";
    params.push(opts.branchId);
  }

  if (opts.statuses && opts.statuses.length > 0) {
    sql += ` AND status IN (${opts.statuses.map(() => "?").join(",")})`;
    params.push(...opts.statuses);
  }

  if (opts.keyword) {
    const escaped = opts.keyword.replace(/[%_\\]/g, "\\$&");
    sql += " AND content LIKE ? ESCAPE '\\'";
    params.push(`%${escaped}%`);
  }

  sql += " ORDER BY updated_at DESC";

  const limit = opts.limit ?? 100;
  sql += " LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToMemoryObject);
}

// ── Internal ─────────────────────────────────────────────────────────────────

/**
 * Convert a raw database row into a MemoryObject.
 */
export function rowToMemoryObject(row: Record<string, unknown>): MemoryObject {
  let structured: unknown = undefined;
  if (row.structured_json != null && typeof row.structured_json === "string") {
    try {
      structured = JSON.parse(row.structured_json);
    } catch {
      structured = undefined;
    }
  }

  return {
    id: safeStr(row.composite_id),
    kind: safeStr(row.kind, "claim") as MemoryKind,
    content: safeStr(row.content),
    structured,
    canonical_key: row.canonical_key != null ? safeStr(row.canonical_key) : undefined,

    provenance: {
      source_kind: validSourceKind(row.source_kind),
      source_id: safeStr(row.source_id),
      source_detail: row.source_detail != null ? safeStr(row.source_detail) : undefined,
      actor: "system",
      trust: safeNum(row.trust_score, 0.5),
    },

    confidence: safeNum(row.confidence, 0.5),
    freshness: 1.0, // Freshness is computed at query time, not stored
    provisional: false,

    status: validStatus(row.status),
    superseded_by: row.superseded_by != null ? String(row.superseded_by) : undefined,

    observed_at: safeStr(row.observed_at) || safeStr(row.first_observed_at) || isoNow(),
    scope_id: safeNum(row.scope_id, 1),
    influence_weight: validInfluenceWeight(row.influence_weight),

    created_at: safeStr(row.created_at) || isoNow(),
    updated_at: safeStr(row.updated_at) || isoNow(),
  };
}
