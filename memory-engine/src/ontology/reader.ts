/**
 * MemoryReader — unified read layer for memory_objects table.
 *
 * Phase 3: All reads now query the unified memory_objects table
 * instead of 7 legacy per-kind tables. Uses rowToMemoryObject()
 * from mo-store.ts for normalization.
 *
 * Scoring (freshnessDecay, statusPenalty, computeRelevance) stays here.
 */

import type { GraphDb } from "../relations/types.js";
import type {
  MemoryObject,
  MemoryKind,
  MemoryStatus,
  RelevanceSignals,
  TaskMode,
} from "./types.js";
import {
  computeRelevance,
  TASK_MODE_WEIGHTS,
  INFLUENCE_SCORES,
  DEFAULT_SCOPE_ID,
} from "./types.js";
import { rowToMemoryObject } from "./mo-store.js";
import { escapeLikeValue } from "./json-utils.js";

// ── Query Options ───────────────────────────────────────────────────────────

export interface MemoryReaderOptions {
  /** Filter by one or more MemoryKind values. */
  kinds?: MemoryKind[];
  /** Filter by scope. Default: 1 (global). */
  scopeId?: number;
  /** Filter by status. Default: ['active']. */
  statuses?: MemoryStatus[];
  /** Maximum results to return. Default: 50. */
  limit?: number;
  /** Task mode for ranking weights. Default: 'default'. */
  taskMode?: TaskMode;
  /** Optional keyword for basic text matching (LIKE %keyword%). */
  keyword?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const HALF_LIFE_DAYS = 30;

function freshnessDecay(isoDate: string | null): number {
  if (!isoDate) return 0.5;
  try {
    const daysOld = (Date.now() - new Date(isoDate).getTime()) / 86_400_000;
    if (daysOld < 0) return 1.0; // Future date — treat as maximally fresh
    // Exponential decay: half-life curve so older data still has a ranking gradient
    // 0 days = 1.0, 30 days = 0.5, 60 days = 0.25, 90 days = 0.125
    return Math.max(0.1, Math.pow(0.5, daysOld / HALF_LIFE_DAYS));
  } catch {
    return 0.5;
  }
}

function statusPenalty(status: string): number {
  switch (status) {
    case "active": return 1.0;
    case "needs_confirmation": return 0.9;
    case "stale": return 0.3;
    case "superseded":
    case "retracted": return 0.0;
    default: return 0.5;
  }
}

/** Escape FTS5 special characters for safe MATCH queries. */
function escapeFts5(keyword: string): string {
  // Quote the keyword to treat it as a literal phrase in FTS5
  return '"' + keyword.replace(/"/g, '""') + '"';
}

/** Check if memory_objects_fts table exists (cached per db instance). */
const _ftsAvailableCache = new WeakMap<object, boolean>();
function isFts5Available(db: GraphDb): boolean {
  const cached = _ftsAvailableCache.get(db);
  if (cached !== undefined) return cached;
  try {
    db.prepare("SELECT 1 FROM memory_objects_fts LIMIT 0").get();
    _ftsAvailableCache.set(db, true);
    return true;
  } catch {
    _ftsAvailableCache.set(db, false);
    return false;
  }
}

// ── All queryable kinds ─────────────────────────────────────────────────────

const ALL_QUERYABLE_KINDS: MemoryKind[] = [
  "claim", "decision", "entity", "relation", "loop", "attempt", "procedure", "invariant", "capability", "conflict",
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Query the memory_objects table and return normalized MemoryObjects.
 *
 * Results are ranked by relevance-to-action using the specified task mode.
 */
export function readMemoryObjects(
  db: GraphDb,
  options: MemoryReaderOptions = {},
): MemoryObject[] {
  const {
    kinds,
    scopeId = DEFAULT_SCOPE_ID,
    statuses = ["active"],
    limit = 50,
    taskMode = "default",
    keyword,
  } = options;

  const weights = TASK_MODE_WEIGHTS[taskMode] ?? TASK_MODE_WEIGHTS.default;
  const targetKinds = kinds ?? ALL_QUERYABLE_KINDS;

  try {
    let sql = "SELECT * FROM memory_objects WHERE 1=1";
    const params: unknown[] = [];

    // Kind filter
    if (targetKinds.length > 0) {
      sql += ` AND kind IN (${targetKinds.map(() => "?").join(",")})`;
      params.push(...targetKinds);
    }

    // Scope filter
    sql += " AND scope_id = ?";
    params.push(scopeId);

    // Status filter
    if (statuses.length > 0) {
      sql += ` AND status IN (${statuses.map(() => "?").join(",")})`;
      params.push(...statuses);
    }

    // Keyword filter: prefer FTS5 for O(log n) search, fall back to LIKE
    if (keyword) {
      if (isFts5Available(db)) {
        const ftsEscaped = escapeFts5(keyword);
        sql += " AND id IN (SELECT rowid FROM memory_objects_fts WHERE memory_objects_fts MATCH ?)";
        params.push(ftsEscaped);
      } else {
        const escaped = escapeLikeValue(keyword);
        sql += " AND content LIKE ? ESCAPE '\\'";
        params.push(`%${escaped}%`);
      }
    }

    // Fetch more than requested to allow ranking to reorder before slicing
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(limit * 3);

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    const allObjects = rows.map(rowToMemoryObject);

    // Rank by relevance-to-action
    const scored = allObjects.map((obj) => {
      // Compute freshness from updated_at
      obj.freshness = freshnessDecay(obj.updated_at || null);

      const signals: RelevanceSignals = {
        semantic: keyword ? 0.6 : 0.5,
        recency: obj.freshness,
        trust: obj.provenance.trust,
        conflict: obj.status === "needs_confirmation" ? 1.0 : 0.0,
        influence: INFLUENCE_SCORES[obj.influence_weight] ?? 0.5,
        status_penalty: statusPenalty(obj.status),
      };
      return { obj, score: computeRelevance(signals, weights) };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.obj);
  } catch (err) {
    console.error("[reader] queryMemoryObjects failed:", err);
    return [];
  }
}

/**
 * Read a single MemoryObject by its composite ID (e.g. "claim:42").
 */
export function readMemoryObjectById(
  db: GraphDb,
  compositeId: string,
): MemoryObject | undefined {
  try {
    const row = db.prepare(
      "SELECT * FROM memory_objects WHERE composite_id = ?",
    ).get(compositeId) as Record<string, unknown> | undefined;

    if (!row) return undefined;
    return rowToMemoryObject(row);
  } catch {
    return undefined;
  }
}

/**
 * Count MemoryObjects by kind for stats/diagnostics.
 */
export function countMemoryObjects(
  db: GraphDb,
  scopeId: number = DEFAULT_SCOPE_ID,
): Record<string, { total: number; active: number; stale: number; superseded: number; conflicts: number }> {
  const result: Record<string, { total: number; active: number; stale: number; superseded: number; conflicts: number }> = {};

  try {
    const rows = db.prepare(`
      SELECT
        kind,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END) as stale,
        SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) as superseded,
        SUM(CASE WHEN status = 'needs_confirmation' THEN 1 ELSE 0 END) as conflicts
      FROM memory_objects
      WHERE scope_id = ?
      GROUP BY kind
    `).all(scopeId) as Array<{
      kind: string;
      total: number;
      active: number;
      stale: number;
      superseded: number;
      conflicts: number;
    }>;

    for (const row of rows) {
      result[row.kind] = {
        total: row.total ?? 0,
        active: row.active ?? 0,
        stale: row.stale ?? 0,
        superseded: row.superseded ?? 0,
        conflicts: row.conflicts ?? 0,
      };
    }
  } catch {
    // Non-fatal: return empty result
  }

  return result;
}
