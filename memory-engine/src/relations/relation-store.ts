/**
 * Relation store — entity-to-entity relationships with full lifecycle.
 *
 * Phase 3: Relations are now stored as memory_objects (kind='relation')
 * with full TruthEngine support: supersession, confidence blending,
 * evidence chains, archival, and context compilation.
 *
 * Function signatures are UNCHANGED — callers don't need to change.
 */

import type { GraphDb } from "./types.js";
import type { MemoryObject } from "../ontology/types.js";
import { logEvidence } from "./evidence-log.js";
import { upsertMemoryObject } from "../ontology/mo-store.js";
import { buildCanonicalKey, normalizePredicate } from "../ontology/canonical.js";

export interface UpsertRelationInput {
  scopeId: number;
  subjectEntityId: number;
  predicate: string;
  objectEntityId: number;
  confidence?: number;
  sourceType: string;
  sourceId: string;
}

export interface RelationRow {
  id: number;
  scope_id: number;
  subject_entity_id: number;
  predicate: string;
  object_entity_id: number;
  confidence: number;
  source_type: string;
  source_id: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve entity display name and composite_id from numeric row ID. */
function resolveEntity(db: GraphDb, entityId: number): { name: string; compositeId: string } {
  try {
    const row = db.prepare(
      "SELECT composite_id, content, structured_json FROM memory_objects WHERE id = ? AND kind = 'entity'",
    ).get(entityId) as { composite_id: string; content: string; structured_json: string | null } | undefined;

    if (row) {
      let displayName = row.content;
      try {
        const s = row.structured_json ? JSON.parse(row.structured_json) : {};
        displayName = String(s.displayName ?? s.name ?? row.content);
      } catch { /* use content */ }
      return { name: displayName, compositeId: row.composite_id };
    }
  } catch { /* fall through */ }

  return { name: String(entityId), compositeId: `entity:${entityId}` };
}

/** Parse structured_json safely. */
function safeParseStructured(val: unknown): Record<string, unknown> {
  if (!val || typeof val !== "string") return {};
  try { return JSON.parse(val) as Record<string, unknown>; }
  catch { return {}; }
}

/** Convert a memory_objects row (kind='relation') to RelationRow with names. */
function moRowToRelationRow(row: Record<string, unknown>): RelationRow & { subject_name: string; object_name: string } {
  const s = safeParseStructured(row.structured_json);
  return {
    id: Number(row.id),
    scope_id: Number(row.scope_id ?? 1),
    subject_entity_id: 0, // numeric ID no longer primary — use names/compositeIds
    predicate: String(s.predicate ?? ""),
    object_entity_id: 0,
    confidence: Number(row.confidence ?? 0.5),
    source_type: String(s.sourceType ?? ""),
    source_id: String(s.sourceId ?? ""),
    created_at: String(row.created_at ?? ""),
    subject_name: String(s.subjectName ?? ""),
    object_name: String(s.objectName ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

export function upsertRelation(
  db: GraphDb,
  input: UpsertRelationInput,
): { relationId: number; isNew: boolean } {
  const confidence = input.confidence ?? 0.5;

  // Resolve entity names from numeric IDs (backward compat with all callers)
  const subject = resolveEntity(db, input.subjectEntityId);
  const object = resolveEntity(db, input.objectEntityId);

  const predNorm = normalizePredicate(input.predicate);
  const compositeId = `relation:${input.scopeId}:${input.subjectEntityId}:${predNorm}:${input.objectEntityId}`;
  const content = `${subject.name} ${input.predicate} ${object.name}`;

  const canonicalKey = buildCanonicalKey("relation", content, {
    subjectName: subject.name,
    predicate: input.predicate,
    objectName: object.name,
  });

  const mo: MemoryObject = {
    id: compositeId,
    kind: "relation",
    content,
    structured: {
      subjectName: subject.name,
      predicate: input.predicate,
      objectName: object.name,
      subjectCompositeId: subject.compositeId,
      objectCompositeId: object.compositeId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    },
    canonical_key: canonicalKey ?? undefined,
    provenance: {
      source_kind: "extraction",
      source_id: input.sourceId,
      actor: "system",
      trust: 0.5,
    },
    confidence,
    freshness: 1.0,
    provisional: false,
    status: "active",
    observed_at: new Date().toISOString(),
    scope_id: input.scopeId,
    influence_weight: "standard",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const result = upsertMemoryObject(db, mo);

  logEvidence(db, {
    scopeId: input.scopeId,
    objectType: "relation",
    objectId: result.moId,
    eventType: result.isNew ? "create" : "update",
    payload: { predicate: input.predicate },
  });

  return { relationId: result.moId, isNew: result.isNew };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get relations for an entity (as subject, object, or both).
 */
export function getRelationsForEntity(
  db: GraphDb,
  entityId: number,
  direction: "subject" | "object" | "both" = "both",
): Array<RelationRow & { subject_name: string; object_name: string }> {
  // Resolve the entity's composite_id for matching
  const entity = resolveEntity(db, entityId);

  let whereClause: string;
  let args: unknown[];

  if (direction === "subject") {
    whereClause = "kind = 'relation' AND status = 'active' AND json_extract(structured_json, '$.subjectCompositeId') = ?";
    args = [entity.compositeId];
  } else if (direction === "object") {
    whereClause = "kind = 'relation' AND status = 'active' AND json_extract(structured_json, '$.objectCompositeId') = ?";
    args = [entity.compositeId];
  } else {
    whereClause = "kind = 'relation' AND status = 'active' AND (json_extract(structured_json, '$.subjectCompositeId') = ? OR json_extract(structured_json, '$.objectCompositeId') = ?)";
    args = [entity.compositeId, entity.compositeId];
  }

  const rows = db.prepare(`
    SELECT * FROM memory_objects WHERE ${whereClause} ORDER BY confidence DESC
  `).all(...args) as Array<Record<string, unknown>>;

  return rows.map(moRowToRelationRow);
}

/**
 * Get the relation graph for a scope.
 */
export function getRelationGraph(
  db: GraphDb,
  scopeId: number,
  opts?: { predicate?: string; limit?: number },
): Array<RelationRow & { subject_name: string; object_name: string }> {
  const limit = opts?.limit ?? 500;

  const where = ["kind = 'relation'", "status = 'active'", "scope_id = ?"];
  const args: unknown[] = [scopeId];

  if (opts?.predicate) {
    where.push("json_extract(structured_json, '$.predicate') = ?");
    args.push(opts.predicate);
  }

  args.push(limit);

  const rows = db.prepare(`
    SELECT * FROM memory_objects
    WHERE ${where.join(" AND ")}
    ORDER BY confidence DESC LIMIT ?
  `).all(...args) as Array<Record<string, unknown>>;

  return rows.map(moRowToRelationRow);
}
