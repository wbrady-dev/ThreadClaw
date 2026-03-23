/**
 * StoreProjector — writes reconciled MemoryObjects to physical stores.
 *
 * Takes MemoryObjects produced by the Writer + reconciled by the TruthEngine
 * and projects them into the appropriate physical stores (graph.db, memory.db,
 * clawcore.db) plus the unified provenance_links table.
 *
 * Phase 2: Dual-write mode — writes to BOTH old tables AND provenance_links.
 * Phase 5: provenance_links becomes sole source for cross-object relationships.
 */

import type { GraphDb } from "../relations/types.js";
import type { MemoryObject, LinkPredicate } from "./types.js";

// ── Provenance Link Writer ──────────────────────────────────────────────────

/**
 * Insert a provenance link between two MemoryObjects.
 * Ignores duplicates (ON CONFLICT DO NOTHING via UNIQUE constraint).
 */
export function insertProvenanceLink(
  db: GraphDb,
  subjectId: string,
  predicate: LinkPredicate,
  objectId: string,
  confidence: number = 1.0,
  detail?: string,
  scopeId: number = 1,
  metadata?: string,
): void {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO provenance_links (subject_id, predicate, object_id, confidence, detail, scope_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(subjectId, predicate, objectId, Math.min(1.0, Math.max(0.0, confidence)), detail ?? null, scopeId, metadata ?? null);
  } catch {
    // Non-fatal: link insertion failure must not break primary writes
  }
}

/**
 * Query provenance links for a given subject.
 */
export function getProvenanceLinksForSubject(
  db: GraphDb,
  subjectId: string,
  predicate?: LinkPredicate,
): Array<{ predicate: string; object_id: string; confidence: number; detail: string | null; created_at: string }> {
  try {
    if (predicate) {
      return db.prepare(
        "SELECT predicate, object_id, confidence, detail, created_at FROM provenance_links WHERE subject_id = ? AND predicate = ?",
      ).all(subjectId, predicate) as Array<{ predicate: string; object_id: string; confidence: number; detail: string | null; created_at: string }>;
    }
    return db.prepare(
      "SELECT predicate, object_id, confidence, detail, created_at FROM provenance_links WHERE subject_id = ?",
    ).all(subjectId) as Array<{ predicate: string; object_id: string; confidence: number; detail: string | null; created_at: string }>;
  } catch {
    return [];
  }
}

/**
 * Query provenance links pointing TO a given object.
 */
export function getProvenanceLinksForObject(
  db: GraphDb,
  objectId: string,
  predicate?: LinkPredicate,
): Array<{ subject_id: string; predicate: string; confidence: number; detail: string | null; created_at: string }> {
  try {
    if (predicate) {
      return db.prepare(
        "SELECT subject_id, predicate, confidence, detail, created_at FROM provenance_links WHERE object_id = ? AND predicate = ?",
      ).all(objectId, predicate) as Array<{ subject_id: string; predicate: string; confidence: number; detail: string | null; created_at: string }>;
    }
    return db.prepare(
      "SELECT subject_id, predicate, confidence, detail, created_at FROM provenance_links WHERE object_id = ?",
    ).all(objectId) as Array<{ subject_id: string; predicate: string; confidence: number; detail: string | null; created_at: string }>;
  } catch {
    return [];
  }
}

// ── Projection: MemoryObject → Physical Stores ─────────────────────────────

/**
 * Project a MemoryObject into the appropriate physical store.
 *
 * This function dispatches based on `obj.kind` and calls the existing
 * store functions. It also writes provenance_links for cross-object
 * relationships.
 *
 * NOTE: This does NOT call the store functions directly yet — that happens
 * in Phase 3 when the Writer replaces engine.ts extraction. For now, this
 * only writes provenance_links as a dual-write layer on top of existing writes.
 */
export function projectProvenance(
  db: GraphDb,
  obj: MemoryObject,
  links: Array<{ predicate: LinkPredicate; targetId: string; confidence?: number; detail?: string }> = [],
): void {
  // Write all provenance links for this object
  for (const link of links) {
    insertProvenanceLink(db, obj.id, link.predicate, link.targetId, link.confidence ?? 1.0, link.detail);
  }

  // If this object supersedes another, record the supersession link
  if (obj.superseded_by) {
    insertProvenanceLink(db, obj.superseded_by, "supersedes", obj.id, 1.0);
  }
}

/**
 * Record a supersession: new object replaces old.
 * Creates a provenance link and optionally updates the old object's status.
 */
export function recordSupersession(
  db: GraphDb,
  newId: string,
  oldId: string,
  reason?: string,
): void {
  insertProvenanceLink(db, newId, "supersedes", oldId, 1.0, reason);
}

/**
 * Record a conflict: two objects contradict each other.
 *
 * Creates links FROM the conflict object TO each contradicting object:
 *   conflict --contradicts--> objectA
 *   conflict --contradicts--> objectB
 *
 * The conflict is a first-class MemoryObject (kind='conflict') that serves
 * as the hub linking the disagreeing objects. To find what a conflict is about,
 * query provenance_links where subject_id = conflictId and predicate = 'contradicts'.
 */
export function recordConflict(
  db: GraphDb,
  conflictId: string,
  objectIdA: string,
  objectIdB: string,
  detail?: string,
): void {
  insertProvenanceLink(db, conflictId, "contradicts", objectIdA, 1.0, detail);
  insertProvenanceLink(db, conflictId, "contradicts", objectIdB, 1.0, detail);
}

/**
 * Record an entity mention: entity was found in a source.
 */
export function recordMention(
  db: GraphDb,
  entityId: string,
  sourceId: string,
  confidence: number = 0.8,
): void {
  insertProvenanceLink(db, entityId, "mentioned_in", sourceId, confidence);
}

/**
 * Record evidence supporting or contradicting a claim.
 */
export function recordEvidence(
  db: GraphDb,
  claimId: string,
  sourceId: string,
  role: "supports" | "contradicts",
  confidence: number = 1.0,
  detail?: string,
): void {
  insertProvenanceLink(db, claimId, role, sourceId, confidence, detail);
}

/**
 * Record a derivation: summary derived from messages, or condensed from leaves.
 */
export function recordDerivation(
  db: GraphDb,
  derivedId: string,
  sourceId: string,
  confidence: number = 1.0,
): void {
  insertProvenanceLink(db, derivedId, "derived_from", sourceId, confidence);
}

/**
 * Record a conflict resolution.
 */
export function recordResolution(
  db: GraphDb,
  conflictId: string,
  resolvedById: string,
  detail?: string,
): void {
  insertProvenanceLink(db, conflictId, "resolved_by", resolvedById, 1.0, detail);
}
