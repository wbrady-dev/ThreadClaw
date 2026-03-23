/**
 * Relation store — entity-to-entity relationships extracted by deep mode.
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
  const existing = db.prepare(
    "SELECT id FROM entity_relations WHERE scope_id = ? AND subject_entity_id = ? AND predicate = ? AND object_entity_id = ?",
  ).get(input.scopeId, input.subjectEntityId, input.predicate, input.objectEntityId) as { id: number } | undefined;

  db.prepare(`
    INSERT INTO entity_relations
      (scope_id, subject_entity_id, predicate, object_entity_id, confidence, source_type, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_id, subject_entity_id, predicate, object_entity_id) DO UPDATE SET
      confidence = (entity_relations.confidence + excluded.confidence) / 2.0
  `).run(
    input.scopeId, input.subjectEntityId, input.predicate, input.objectEntityId,
    input.confidence ?? 0.5, input.sourceType, input.sourceId,
  );

  const row = db.prepare(
    "SELECT id FROM entity_relations WHERE scope_id = ? AND subject_entity_id = ? AND predicate = ? AND object_entity_id = ?",
  ).get(input.scopeId, input.subjectEntityId, input.predicate, input.objectEntityId) as { id: number };

  const isNew = !existing;

  logEvidence(db, {
    scopeId: input.scopeId,
    objectType: "relation",
    objectId: row.id,
    eventType: isNew ? "create" : "update",
    payload: { predicate: input.predicate },
  });

  // RSMA: also write to provenance_links
  try {
    db.prepare(`
      INSERT OR IGNORE INTO provenance_links (subject_id, predicate, object_id, confidence, detail, scope_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `entity:${input.subjectEntityId}`,
      "relates_to",
      `entity:${input.objectEntityId}`,
      input.confidence ?? 0.5,
      input.predicate, // original predicate (e.g. "manages") stored in detail
      input.scopeId,
      JSON.stringify({ source_type: input.sourceType, source_id: input.sourceId }),
    );
  } catch { /* non-fatal */ }

  return { relationId: row.id, isNew };
}

/**
 * Get relations for an entity (as subject, object, or both).
 */
/** Parse "entity:42" → 42, returning 0 on failure. */
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
  // SQLite max variables is 999; batch if needed
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id, display_name FROM entities WHERE id IN (${placeholders})`,
    ).all(...batch) as Array<{ id: number; display_name: string }>;
    for (const r of rows) names.set(r.id, r.display_name);
  }
  return names;
}

/** Convert provenance_links rows to RelationRow format with entity names. */
function mapProvLinksToRelations(
  db: GraphDb,
  rows: Array<Record<string, unknown>>,
): Array<RelationRow & { subject_name: string; object_name: string }> {
  // Batch-resolve all entity names in ONE query
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

  try {
    const rows = db.prepare(`
      SELECT p.id, p.subject_id, p.object_id, p.confidence, p.detail, p.scope_id, p.metadata, p.created_at
      FROM provenance_links p WHERE ${whereClause} ORDER BY p.confidence DESC
    `).all(...args) as Array<Record<string, unknown>>;
    if (rows.length > 0) return mapProvLinksToRelations(db, rows);
  } catch { /* fall through to legacy */ }

  // Fallback to legacy entity_relations table
  if (direction === "subject") {
    return db.prepare(`SELECT r.*, e1.display_name AS subject_name, e2.display_name AS object_name FROM entity_relations r JOIN entities e1 ON r.subject_entity_id = e1.id JOIN entities e2 ON r.object_entity_id = e2.id WHERE r.subject_entity_id = ? ORDER BY r.confidence DESC`).all(entityId) as Array<RelationRow & { subject_name: string; object_name: string }>;
  }
  if (direction === "object") {
    return db.prepare(`SELECT r.*, e1.display_name AS subject_name, e2.display_name AS object_name FROM entity_relations r JOIN entities e1 ON r.subject_entity_id = e1.id JOIN entities e2 ON r.object_entity_id = e2.id WHERE r.object_entity_id = ? ORDER BY r.confidence DESC`).all(entityId) as Array<RelationRow & { subject_name: string; object_name: string }>;
  }
  return db.prepare(`SELECT r.*, e1.display_name AS subject_name, e2.display_name AS object_name FROM entity_relations r JOIN entities e1 ON r.subject_entity_id = e1.id JOIN entities e2 ON r.object_entity_id = e2.id WHERE r.subject_entity_id = ? OR r.object_entity_id = ? ORDER BY r.confidence DESC`).all(entityId, entityId) as Array<RelationRow & { subject_name: string; object_name: string }>;
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

  try {
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

    if (rows.length > 0) return mapProvLinksToRelations(db, rows);
  } catch { /* fall through to legacy */ }

  // Fallback to legacy
  const where = ["r.scope_id = ?"];
  const args: unknown[] = [scopeId];
  if (opts?.predicate) { where.push("r.predicate = ?"); args.push(opts.predicate); }
  args.push(limit);
  return db.prepare(`SELECT r.*, e1.display_name AS subject_name, e2.display_name AS object_name FROM entity_relations r JOIN entities e1 ON r.subject_entity_id = e1.id JOIN entities e2 ON r.object_entity_id = e2.id WHERE ${where.join(" AND ")} ORDER BY r.confidence DESC LIMIT ?`).all(...args) as Array<RelationRow & { subject_name: string; object_name: string }>;
}
