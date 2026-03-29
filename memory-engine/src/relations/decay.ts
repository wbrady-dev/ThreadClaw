/**
 * Evidence decay — lazy confidence reduction for procedures and loops.
 *
 * Phase 3: All queries now target the unified memory_objects table.
 *
 * Anti-runbooks (procedure with isNegative=true): If no new failure evidence
 *   in decayDays (default 90), reduce confidence by toolSuccessMultiplier/stalenessMultiplier.
 *   If confidence < floor, mark 'under_review'.
 *
 * Runbooks (procedure with isNegative=false/null): If failure_rate > 0.5,
 *   demote confidence. If no usage in staleDays, mark 'stale'.
 *
 * Loops: Mark as 'stale' when they exceed their max_age_hours policy.
 */

import type { GraphDb } from "./types.js";
import { logEvidence } from "./evidence-log.js";

export interface DecayConfig {
  toolSuccessMultiplier?: number;   // default 0.7
  stalenessMultiplier?: number;     // default 0.8
  toolSuccessFloor?: number;        // default 0.3
  stalenessFloor?: number;          // default 0.2
}

/**
 * Apply decay to anti-runbooks (procedure kind, isNegative=true) that
 * haven't seen new failure evidence recently.
 */
export function decayAntiRunbooks(
  db: GraphDb,
  scopeId: number,
  decayDays = 90,
  opts?: DecayConfig,
): number {
  const toolSuccessMultiplier = opts?.toolSuccessMultiplier ?? 0.7;
  const stalenessMultiplier = opts?.stalenessMultiplier ?? 0.8;
  const toolSuccessFloor = opts?.toolSuccessFloor ?? 0.3;
  const stalenessFloor = opts?.stalenessFloor ?? 0.2;

  // First: decay anti-runbooks whose tool has recent successes (tool-success decay)
  const toolDecayed = db.prepare(`
    UPDATE memory_objects
    SET confidence = confidence * ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
    WHERE scope_id = ?
      AND kind = 'procedure'
      AND json_extract(structured_json, '$.isNegative') = 1
      AND status = 'active'
      AND confidence > ?
      AND json_extract(structured_json, '$.toolName') IN (
        SELECT DISTINCT json_extract(mo2.structured_json, '$.toolName')
        FROM memory_objects mo2
        WHERE mo2.scope_id = ? AND mo2.kind = 'attempt' AND mo2.status = 'active'
        AND json_extract(mo2.structured_json, '$.status') = 'success'
        AND mo2.created_at > datetime('now', '-' || ? || ' days')
      )
  `).run(toolSuccessMultiplier, scopeId, toolSuccessFloor, scopeId, decayDays);

  // Second: staleness decay — exclude rows already decayed by tool-success above
  const decayed = db.prepare(`
    UPDATE memory_objects
    SET confidence = confidence * ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
    WHERE scope_id = ?
      AND kind = 'procedure'
      AND json_extract(structured_json, '$.isNegative') = 1
      AND status = 'active'
      AND confidence > ?
      AND updated_at < datetime('now', '-' || ? || ' days')
  `).run(stalenessMultiplier, scopeId, stalenessFloor, decayDays);

  // Mark very low confidence for review
  const reviewed = db.prepare(`
    UPDATE memory_objects
    SET status = 'stale',
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
    WHERE scope_id = ?
      AND kind = 'procedure'
      AND json_extract(structured_json, '$.isNegative') = 1
      AND confidence <= ?
      AND status = 'active'
  `).run(scopeId, stalenessFloor);

  if (Number(decayed.changes) > 0 || Number(reviewed.changes) > 0 || Number(toolDecayed.changes) > 0) {
    logEvidence(db, {
      scopeId,
      objectType: "procedure",
      objectId: 0,
      eventType: "decay",
      payload: {
        subKind: "anti_runbook",
        toolSuccessDecayed: Number(toolDecayed.changes),
        confidenceDecayed: Number(decayed.changes),
        markedStale: Number(reviewed.changes),
      },
    });
  }

  return Number(decayed.changes);
}

/**
 * Apply decay to runbooks (procedure kind, isNegative=false/null) with
 * high failure rates or no recent usage.
 */
export function decayRunbooks(db: GraphDb, scopeId: number, staleDays = 180): number {
  // Demote runbooks with failure_rate > 0.5
  const demoted = db.prepare(`
    UPDATE memory_objects
    SET confidence = confidence * 0.5,
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
    WHERE scope_id = ?
      AND kind = 'procedure'
      AND (json_extract(structured_json, '$.isNegative') IS NULL
           OR json_extract(structured_json, '$.isNegative') = 0)
      AND status = 'active'
      AND (COALESCE(json_extract(structured_json, '$.successCount'), 0)
           + COALESCE(json_extract(structured_json, '$.failureCount'), 0)) > 0
      AND CAST(COALESCE(json_extract(structured_json, '$.failureCount'), 0) AS REAL)
          / (COALESCE(json_extract(structured_json, '$.successCount'), 0)
             + COALESCE(json_extract(structured_json, '$.failureCount'), 0)) > 0.5
      AND updated_at < datetime('now', '-' || ? || ' days')
  `).run(scopeId, Math.floor(staleDays / 2));

  // Mark stale if no usage in staleDays
  const staled = db.prepare(`
    UPDATE memory_objects
    SET status = 'stale',
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
    WHERE scope_id = ?
      AND kind = 'procedure'
      AND (json_extract(structured_json, '$.isNegative') IS NULL
           OR json_extract(structured_json, '$.isNegative') = 0)
      AND status = 'active'
      AND updated_at < datetime('now', '-' || ? || ' days')
  `).run(scopeId, staleDays);

  if (Number(demoted.changes) > 0 || Number(staled.changes) > 0) {
    logEvidence(db, {
      scopeId,
      objectType: "procedure",
      objectId: 0,
      eventType: "decay",
      payload: {
        subKind: "runbook",
        confidenceDemoted: Number(demoted.changes),
        markedStale: Number(staled.changes),
      },
    });
  }

  return Number(demoted.changes);
}

/**
 * Mark open loops as 'stale' when they exceed their max_age_hours policy.
 * Default: 72 hours (3 days) per the promotion_policies seed.
 */
export function decayLoops(db: GraphDb, scopeId: number): number {
  const policy = db.prepare(
    "SELECT max_age_hours FROM promotion_policies WHERE object_type = 'loop'",
  ).get() as { max_age_hours: number | null } | undefined;

  const maxAgeHours = policy?.max_age_hours ?? 72;

  const staled = db.prepare(`
    UPDATE memory_objects
    SET status = 'stale',
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
    WHERE scope_id = ?
      AND kind = 'loop'
      AND status = 'active'
      AND COALESCE(updated_at, created_at) < datetime('now', '-' || ? || ' hours')
  `).run(scopeId, maxAgeHours);

  if (Number(staled.changes) > 0) {
    logEvidence(db, {
      scopeId,
      objectType: "loop",
      objectId: 0,
      eventType: "decay",
      payload: { markedStale: Number(staled.changes), maxAgeHours },
    });
  }

  return Number(staled.changes);
}

/**
 * Mark relations as 'stale' when not updated in staleDays.
 */
export function decayRelations(db: GraphDb, scopeId: number, staleDays = 180): number {
  const staled = db.prepare(`
    UPDATE memory_objects
    SET status = 'stale',
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
    WHERE scope_id = ?
      AND kind = 'relation'
      AND status = 'active'
      AND updated_at < datetime('now', '-' || ? || ' days')
  `).run(scopeId, staleDays);

  if (Number(staled.changes) > 0) {
    logEvidence(db, {
      scopeId,
      objectType: "relation",
      objectId: 0,
      eventType: "decay",
      payload: { markedStale: Number(staled.changes), staleDays },
    });
  }

  return Number(staled.changes);
}

/**
 * Deduplicate active memory objects with the same canonical_key.
 *
 * Race conditions can create multiple active objects with the same key.
 * Keeps the highest-confidence one active and supersedes the rest.
 */
export function deduplicateActiveObjects(db: GraphDb, scopeId: number): number {
  // Find canonical_keys with multiple active entries
  const dupes = db.prepare(`
    SELECT canonical_key, COUNT(*) as cnt
    FROM memory_objects
    WHERE scope_id = ? AND status = 'active' AND canonical_key IS NOT NULL
    GROUP BY canonical_key
    HAVING cnt > 1
  `).all(scopeId) as Array<{ canonical_key: string; cnt: number }>;

  if (dupes.length === 0) return 0;

  let totalSuperseded = 0;

  for (const { canonical_key } of dupes) {
    // Get all active objects for this key, ordered by confidence DESC then id DESC (newest wins ties)
    const rows = db.prepare(`
      SELECT id, composite_id FROM memory_objects
      WHERE scope_id = ? AND canonical_key = ? AND status = 'active'
      ORDER BY confidence DESC, id DESC
    `).all(scopeId, canonical_key) as Array<{ id: number; composite_id: string }>;

    if (rows.length <= 1) continue;

    // Keep the first (highest confidence), supersede the rest
    const keepCompositeId = rows[0].composite_id;
    const supersedIds = rows.slice(1).map((r) => r.id);

    for (const id of supersedIds) {
      db.prepare(`
        UPDATE memory_objects
        SET status = 'superseded', superseded_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
        WHERE id = ? AND status = 'active'
      `).run(keepCompositeId, id);
      totalSuperseded++;
    }
  }

  if (totalSuperseded > 0) {
    logEvidence(db, {
      scopeId,
      objectType: "memory_object",
      objectId: 0,
      eventType: "dedup",
      payload: { duplicateKeysFound: dupes.length, objectsSuperseded: totalSuperseded },
    });
  }

  return totalSuperseded;
}

/**
 * Apply all decay rules for a scope. Call lazily before queries.
 */
export function applyDecay(
  db: GraphDb,
  scopeId: number,
  decayDays = 90,
  staleDays = 180,
  opts?: DecayConfig,
): void {
  try {
    decayAntiRunbooks(db, scopeId, decayDays, opts);
    decayRunbooks(db, scopeId, staleDays);
    decayLoops(db, scopeId);
    decayRelations(db, scopeId, staleDays);
    deduplicateActiveObjects(db, scopeId);
  } catch {
    // Non-fatal: decay failure should not block queries
  }
}
