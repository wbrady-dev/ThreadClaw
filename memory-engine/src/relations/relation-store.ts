/**
 * Relation store — entity-to-entity relationships extracted by deep mode.
 *
 * Phase 2: All writes go to provenance_links ONLY. Legacy entity_relations
 * table writes removed. Reads from provenance_links only.
 *
 * Function signatures are UNCHANGED — callers don't need to change.
 */

import type { GraphDb } from "./types.js";
import { logEvidence } from "./evidence-log.js";

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

export function upsertRelation(
  db: GraphDb,
  input: UpsertRelationInput,
): { relationId: number; isNew: boolean } {
  const subjectKey = `entity:${input.subjectEntityId}`;
  const objectKey = `entity:${input.objectEntityId}`;
  const confidence = input.confidence ?? 0.5;

  // Check for existing
  const existing = db.prepare(
    "SELECT id FROM provenance_links WHERE subject_id = ? AND predicate = 'relates_to' AND object_id = ? AND detail = ? AND scope_id = ?",
  ).get(subjectKey, objectKey, input.predicate, input.scopeId) as { id: number } | undefined;

  if (existing) {
    // Update confidence (average)
    db.prepare(`
      UPDATE provenance_links SET
        confidence = (confidence + ?) / 2.0
      WHERE id = ?
    `).run(confidence, existing.id);
  } else {
    db.prepare(`
      INSERT INTO provenance_links (subject_id, predicate, object_id, confidence, detail, scope_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      subjectKey,
      "relates_to",
      objectKey,
      confidence,
      input.predicate,
      input.scopeId,
      JSON.stringify({ source_type: input.sourceType, source_id: input.sourceId }),
    );
  }

  const row = db.prepare(
    "SELECT id FROM provenance_links WHERE subject_id = ? AND predicate = 'relates_to' AND object_id = ? AND detail = ? AND scope_id = ?",
  ).get(subjectKey, objectKey, input.predicate, input.scopeId) as { id: number };

  const isNew = !existing;

  logEvidence(db, {
    scopeId: input.scopeId,
    objectType: "relation",
    objectId: row.id,
    eventType: isNew ? "create" : "update",
    payload: { predicate: input.predicate },
  });

  return { relationId: row.id, isNew };
}

/**
 * Get relations for an entity (as subject, object, or both).
 */
/** Parse "entity:42" -> 42, returning 0 on failure. */
function parseEntityId(compositeId: unknown): number {
  const parts = String(compositeId ?? "").split(":");
  const n = Number(parts[1]);
  return Number.isFinite(n) ? n : 0;
}

/** Safely parse JSON metadata, returning {} on failure. */
function safeParseMeta(val: unknown): Record<string, unknown> {
  if (!val || typeof val !== "string") return {};
  try { return JSON.parse(val) as Record<string, unknown>; }
  catch { return {}; }
}

/** Batch-resolve entity display names (1 query instead of N). */
function batchResolveEntityNames(db: GraphDb, ids: number[]): Map<number, string> {
  const names = new Map<number, string>();
  if (ids.length === 0) return names;
  const unique = [...new Set(ids)];

  // Try memory_objects first for entity names
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(",");
    try {
      const rows = db.prepare(
        `SELECT id, structured_json FROM memory_objects WHERE id IN (${placeholders}) AND kind = 'entity'`,
      ).all(...batch) as Array<{ id: number; structured_json: string | null }>;
      for (const r of rows) {
        try {
          const s = r.structured_json ? JSON.parse(r.structured_json) : {};
          names.set(r.id, String(s.displayName ?? s.name ?? r.id));
        } catch { names.set(r.id, String(r.id)); }
      }
    } catch { /* fall through */ }

    // Fill in any missing with their numeric ID as fallback
    const missing = batch.filter((id) => !names.has(id));
    for (const id of missing) names.set(id, String(id));
  }
  return names;
}

/** Convert provenance_links rows to RelationRow format with entity names. */
function mapProvLinksToRelations(
  db: GraphDb,
  rows: Array<Record<string, unknown>>,
): Array<RelationRow & { subject_name: string; object_name: string }> {
  const allIds = rows.flatMap((r) => [parseEntityId(r.subject_id), parseEntityId(r.object_id)]);
  const names = batchResolveEntityNames(db, allIds);

  return rows.map((r) => {
    const subjId = parseEntityId(r.subject_id);
    const objId = parseEntityId(r.object_id);
    const meta = safeParseMeta(r.metadata);
    return {
      id: Number(r.id),
      scope_id: Number(r.scope_id ?? 1),
      subject_entity_id: subjId,
      predicate: String(r.detail ?? "relates_to"),
      object_entity_id: objId,
      confidence: Number(r.confidence),
      source_type: String(meta.source_type ?? ""),
      source_id: String(meta.source_id ?? ""),
      created_at: String(r.created_at),
      subject_name: names.get(subjId) ?? String(r.subject_id),
      object_name: names.get(objId) ?? String(r.object_id),
    } as RelationRow & { subject_name: string; object_name: string };
  });
}

export function getRelationsForEntity(
  db: GraphDb,
  entityId: number,
  direction: "subject" | "object" | "both" = "both",
): Array<RelationRow & { subject_name: string; object_name: string }> {
  const entityKey = `entity:${entityId}`;
  let whereClause: string;
  let args: unknown[];

  if (direction === "subject") {
    whereClause = "p.subject_id = ? AND p.predicate = 'relates_to'";
    args = [entityKey];
  } else if (direction === "object") {
    whereClause = "p.object_id = ? AND p.predicate = 'relates_to'";
    args = [entityKey];
  } else {
    whereClause = "(p.subject_id = ? OR p.object_id = ?) AND p.predicate = 'relates_to'";
    args = [entityKey, entityKey];
  }

  const rows = db.prepare(`
    SELECT p.id, p.subject_id, p.object_id, p.confidence, p.detail, p.scope_id, p.metadata, p.created_at
    FROM provenance_links p WHERE ${whereClause} ORDER BY p.confidence DESC
  `).all(...args) as Array<Record<string, unknown>>;

  return mapProvLinksToRelations(db, rows);
}

/**
 * Get the relation graph for a scope.
 */
export function getRelationGraph(
  db: GraphDb,
  scopeId: number,
  opts?: { predicate?: string; limit?: number },
): Array<RelationRow & { subject_name: string; object_name: string }> {
  const limit = opts?.limit ?? 50;

  const where = ["p.predicate = 'relates_to'", "p.scope_id = ?"];
  const args: unknown[] = [scopeId];
  if (opts?.predicate) {
    where.push("p.detail = ?");
    args.push(opts.predicate);
  }
  args.push(limit);

  const rows = db.prepare(`
    SELECT p.id, p.subject_id, p.object_id, p.confidence, p.detail, p.scope_id, p.metadata, p.created_at
    FROM provenance_links p
    WHERE ${where.join(" AND ")}
    ORDER BY p.confidence DESC LIMIT ?
  `).all(...args) as Array<Record<string, unknown>>;

  return mapProvLinksToRelations(db, rows);
}
