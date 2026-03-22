/**
 * Branch promotion engine — creates, promotes, and discards speculative branches.
 *
 * Uses the seeded promotion_policies table from H1 migration to validate
 * whether a branch can be promoted to shared scope.
 */

import type { GraphDb } from "./types.js";
import { logEvidence, withWriteTransaction } from "./evidence-log.js";

// ---------------------------------------------------------------------------
// Policy checking
// ---------------------------------------------------------------------------

export interface PromotionCheckResult {
  canPromote: boolean;
  reason: string;
}

/**
 * Check if an object meets its promotion policy requirements.
 * Reads from the promotion_policies table seeded in H1 migration.
 */
export function checkPromotionPolicy(
  db: GraphDb,
  objectType: string,
  confidence: number,
  evidenceCount: number,
  userConfirmed = false,
  createdAt?: string,
): PromotionCheckResult {
  const policy = db.prepare(
    "SELECT * FROM promotion_policies WHERE object_type = ?",
  ).get(objectType) as {
    min_confidence: number;
    requires_user_confirm: number;
    auto_promote_above_confidence: number | null;
    requires_evidence_count: number;
    max_age_hours: number | null;
  } | undefined;

  if (!policy) {
    return { canPromote: false, reason: `No promotion policy for object type: ${objectType}` };
  }

  // Check confidence threshold
  if (confidence < policy.min_confidence) {
    return {
      canPromote: false,
      reason: `Confidence ${confidence.toFixed(2)} below minimum ${policy.min_confidence}`,
    };
  }

  // Check evidence count
  if (evidenceCount < policy.requires_evidence_count) {
    return {
      canPromote: false,
      reason: `Evidence count ${evidenceCount} below required ${policy.requires_evidence_count}`,
    };
  }

  // Check age limit (if policy specifies max_age_hours and caller provides createdAt)
  if (policy.max_age_hours != null && createdAt) {
    const ageHours = (Date.now() - new Date(createdAt).getTime()) / 3_600_000;
    if (ageHours > policy.max_age_hours) {
      return {
        canPromote: false,
        reason: `Age ${ageHours.toFixed(1)}h exceeds max ${policy.max_age_hours}h`,
      };
    }
  }

  // Check user confirmation (unless auto-promote threshold is met)
  if (policy.requires_user_confirm === 1) {
    if (
      policy.auto_promote_above_confidence != null &&
      confidence >= policy.auto_promote_above_confidence
    ) {
      // Auto-promote: confidence exceeds auto threshold
      return { canPromote: true, reason: `Auto-promoted: confidence ${confidence.toFixed(2)} >= ${policy.auto_promote_above_confidence}` };
    }
    if (!userConfirmed) {
      return {
        canPromote: false,
        reason: `User confirmation required (confidence ${confidence.toFixed(2)}, auto-promote at ${policy.auto_promote_above_confidence ?? "N/A"})`,
      };
    }
  }

  return { canPromote: true, reason: "Meets all promotion criteria" };
}

// ---------------------------------------------------------------------------
// Branch lifecycle
// ---------------------------------------------------------------------------

export interface BranchRow {
  id: number;
  scope_id: number;
  branch_type: string;
  branch_key: string;
  parent_branch_id: number | null;
  created_by_actor: string | null;
  status: string;
  created_at: string;
  promoted_at: string | null;
}

/** Create a new speculative branch. */
export function createBranch(
  db: GraphDb,
  scopeId: number,
  branchType: string,
  branchKey: string,
  actor?: string,
): BranchRow {
  db.prepare(`
    INSERT INTO branch_scopes (scope_id, branch_type, branch_key, created_by_actor)
    VALUES (?, ?, ?, ?)
  `).run(scopeId, branchType, branchKey, actor ?? null);

  const row = db.prepare(
    "SELECT * FROM branch_scopes WHERE scope_id = ? AND branch_type = ? AND branch_key = ?",
  ).get(scopeId, branchType, branchKey) as BranchRow;

  logEvidence(db, {
    scopeId,
    branchId: row.id,
    objectType: "branch",
    objectId: row.id,
    eventType: "create",
    actor,
    payload: { branchType, branchKey },
  });

  return row;
}

/** Promote a branch to shared scope — migrates all branch-scoped data. */
export function promoteBranch(db: GraphDb, branchId: number, actor?: string): void {
  const branch = db.prepare("SELECT scope_id FROM branch_scopes WHERE id = ?").get(branchId) as { scope_id: number } | undefined;
  if (!branch) throw new Error(`Branch ${branchId} not found`);
  const scopeId = branch.scope_id;

  withWriteTransaction(db, () => {
    // --- Claims: on conflict, higher confidence wins ---
    const branchClaims = db.prepare(
      "SELECT id, canonical_key, confidence FROM claims WHERE scope_id = ? AND branch_id = ?",
    ).all(scopeId, branchId) as Array<{ id: number; canonical_key: string; confidence: number }>;

    for (const bc of branchClaims) {
      const shared = db.prepare(
        "SELECT id, confidence FROM claims WHERE scope_id = ? AND branch_id = 0 AND canonical_key = ?",
      ).get(scopeId, bc.canonical_key) as { id: number; confidence: number } | undefined;

      if (shared) {
        if (bc.confidence > shared.confidence) {
          // Branch wins: supersede shared, move branch to shared scope
          db.prepare("UPDATE claims SET status = 'superseded', superseded_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?").run(bc.id, shared.id);
          db.prepare("UPDATE claims SET branch_id = 0 WHERE id = ?").run(bc.id);
        } else {
          // Shared wins: mark branch claim as superseded
          db.prepare("UPDATE claims SET status = 'superseded', superseded_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?").run(shared.id, bc.id);
        }
      } else {
        // No conflict: move to shared scope
        db.prepare("UPDATE claims SET branch_id = 0 WHERE id = ?").run(bc.id);
      }
    }

    // --- Decisions: on conflict (same topic), supersede shared one ---
    const branchDecisions = db.prepare(
      "SELECT id, topic FROM decisions WHERE scope_id = ? AND branch_id = ? AND status = 'active'",
    ).all(scopeId, branchId) as Array<{ id: number; topic: string }>;

    for (const bd of branchDecisions) {
      const shared = db.prepare(
        "SELECT id FROM decisions WHERE scope_id = ? AND branch_id = 0 AND topic = ? AND status = 'active' ORDER BY decided_at DESC LIMIT 1",
      ).get(scopeId, bd.topic) as { id: number } | undefined;

      if (shared) {
        db.prepare("UPDATE decisions SET status = 'superseded', superseded_by = ? WHERE id = ?").run(bd.id, shared.id);
      }
      db.prepare("UPDATE decisions SET branch_id = 0 WHERE id = ?").run(bd.id);
    }

    // --- Simple tables: move all to shared scope ---
    // Only tables with branch_id columns: open_loops, attempts, state_deltas
    for (const table of ["open_loops", "attempts", "state_deltas"]) {
      db.prepare(`UPDATE ${table} SET branch_id = 0 WHERE scope_id = ? AND branch_id = ?`).run(scopeId, branchId);
    }

    // --- Flip branch status ---
    db.prepare(`
      UPDATE branch_scopes
      SET status = 'promoted', promoted_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
      WHERE id = ?
    `).run(branchId);

    logEvidence(db, {
      scopeId,
      branchId,
      objectType: "branch",
      objectId: branchId,
      eventType: "promote",
      actor,
      payload: {
        claimsMigrated: branchClaims.length,
        decisionsMigrated: branchDecisions.length,
      },
    });
  });
}

/** Discard a branch (speculative memory abandoned). */
export function discardBranch(db: GraphDb, branchId: number, actor?: string): void {
  const branch = db.prepare("SELECT scope_id FROM branch_scopes WHERE id = ?").get(branchId) as { scope_id: number } | undefined;

  db.prepare(
    "UPDATE branch_scopes SET status = 'discarded' WHERE id = ?",
  ).run(branchId);

  logEvidence(db, {
    scopeId: branch?.scope_id,
    branchId,
    objectType: "branch",
    objectId: branchId,
    eventType: "discard",
    actor,
  });
}

/** Get branches for a scope, optionally filtered by status. */
export function getBranches(
  db: GraphDb,
  scopeId: number,
  status?: string,
): BranchRow[] {
  if (status) {
    return db.prepare(
      "SELECT * FROM branch_scopes WHERE scope_id = ? AND status = ? ORDER BY created_at DESC",
    ).all(scopeId, status) as BranchRow[];
  }
  return db.prepare(
    "SELECT * FROM branch_scopes WHERE scope_id = ? ORDER BY created_at DESC",
  ).all(scopeId) as BranchRow[];
}
