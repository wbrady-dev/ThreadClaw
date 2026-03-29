/**
 * Graph store — entity CRUD, mention storage, re-ingestion cleanup.
 *
 * Phase 3: upsertEntity and insertMention delegate to mo-store.ts.
 * deleteGraphDataForSource uses deleteMemoryObjectsBySource.
 * storeExtractionResult delegates to the rewritten functions.
 *
 * All functions accept a GraphDb interface so they work with both
 * node:sqlite DatabaseSync and better-sqlite3.
 *
 * Function signatures are UNCHANGED — callers don't need to change.
 */

import type {
  GraphDb,
  ExtractionResult,
  UpsertEntityInput,
  InsertMentionInput,
  StoreExtractionInput,
} from "./types.js";
import { logEvidence, withWriteTransaction } from "./evidence-log.js";
import { extractFast } from "./entity-extract.js";
import { invalidateAwarenessCache } from "./awareness.js";
import { upsertMemoryObject, deleteMemoryObjectsBySource } from "../ontology/mo-store.js";
import type { MemoryObject } from "../ontology/types.js";
import { DEFAULT_SCOPE_ID } from "../ontology/types.js";

// ---------------------------------------------------------------------------
// Entity upsert
// ---------------------------------------------------------------------------

export interface UpsertEntityResult {
  entityId: number;
  isNew: boolean;
}

/**
 * Insert or update an entity. Uses memory_objects kind='entity'.
 * Name is lowercased + trimmed before storage.
 */
export function upsertEntity(db: GraphDb, input: UpsertEntityInput): UpsertEntityResult {
  const name = input.name.toLowerCase().trim();
  const displayName = input.displayName ?? input.name.trim();
  const entityType = (input.entityType ?? "unknown").toLowerCase().trim();

  const compositeId = `entity:${entityType}:${name}`;

  const mo: MemoryObject = {
    id: compositeId,
    kind: "entity",
    content: displayName,
    structured: {
      name,
      displayName,
      entityType: input.entityType ?? null,
      mentionCount: 1, // initial value for new entities; updated atomically below for existing
    },
    canonical_key: `entity::${entityType}::${name}`,
    provenance: {
      source_kind: "extraction",
      source_id: compositeId,
      actor: "system",
      trust: 0.5,
    },
    confidence: 0.5,
    freshness: 1.0,
    provisional: false,
    status: "active",
    observed_at: new Date().toISOString(),
    scope_id: 1,
    influence_weight: "standard",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const result = upsertMemoryObject(db, mo);

  logEvidence(db, {
    scopeId: 1,
    objectType: "entity",
    objectId: result.moId,
    eventType: result.isNew ? "create" : "update",
    actor: input.actor ?? "system",
    runId: input.runId,
    payload: { name, entityType, displayName },
  });

  // Atomic mentionCount increment — avoids read-increment-write race under concurrent access
  if (!result.isNew) {
    db.prepare(
      `UPDATE memory_objects SET structured_json = json_set(
        structured_json,
        '$.mentionCount',
        COALESCE(json_extract(structured_json, '$.mentionCount'), 0) + 1
      ) WHERE id = ?`,
    ).run(result.moId);
  }

  invalidateAwarenessCache();
  return { entityId: result.moId, isNew: result.isNew };
}

// ---------------------------------------------------------------------------
// Mention insert
// ---------------------------------------------------------------------------

/**
 * Insert an entity mention. Writes to provenance_links with predicate='mentioned_in'.
 * Returns false if already exists (idempotent).
 */
export function insertMention(db: GraphDb, input: InsertMentionInput): boolean {
  const contextTermsJson = input.contextTerms && input.contextTerms.length > 0
    ? JSON.stringify(input.contextTerms)
    : null;

  // Look up the composite_id for this entity (for provenance_links subject_id consistency)
  const entityRow = db.prepare(
    "SELECT composite_id FROM memory_objects WHERE id = ?",
  ).get(input.entityId) as { composite_id: string } | undefined;
  const subjectId = entityRow?.composite_id ?? `entity:${input.entityId}`;

  const result = db.prepare(`
    INSERT OR IGNORE INTO provenance_links
      (subject_id, predicate, object_id, confidence, detail, scope_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    subjectId,
    "mentioned_in",
    `${input.sourceType}:${input.sourceId}`,
    1.0,
    input.sourceDetail ?? null,
    input.scopeId ?? DEFAULT_SCOPE_ID,
    JSON.stringify({
      context_terms: contextTermsJson,
      actor: input.actor ?? "system",
      run_id: input.runId ?? null,
    }),
  );

  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Re-ingestion cleanup
// ---------------------------------------------------------------------------

export interface DeleteResult {
  entitiesAffected: number;
  mentionsDeleted: number;
  orphansRemoved: number;
}

/**
 * Delete all graph data for a given source. Removes from memory_objects
 * and provenance_links.
 *
 * This function performs multiple SQL operations that must be atomic.
 * It will start a write transaction if not already inside one; if the
 * caller has already opened a transaction the operations run within it.
 */
export function deleteGraphDataForSource(
  db: GraphDb,
  sourceType: string,
  sourceId: string,
): DeleteResult {
  const doDelete = (): DeleteResult => {
    // Count mentions (provenance_links with mentioned_in) for this source
    const objectKey = `${sourceType}:${sourceId}`;

    let mentionsDeleted = 0;
    try {
      const deleteResult = db.prepare(
        "DELETE FROM provenance_links WHERE object_id = ? AND predicate = 'mentioned_in'",
      ).run(objectKey);
      mentionsDeleted = Number(deleteResult.changes);
    } catch { /* non-fatal */ }

    // Count entities before deletion for accurate reporting
    let entitiesAffected = 0;
    try {
      const countRow = db.prepare(
        "SELECT COUNT(*) as cnt FROM memory_objects WHERE source_kind = ? AND source_id = ?",
      ).get(sourceType, sourceId) as { cnt: number } | undefined;
      entitiesAffected = countRow?.cnt ?? 0;
    } catch { /* non-fatal */ }

    // Delete memory_objects from this source
    deleteMemoryObjectsBySource(db, sourceType, sourceId);

    // Clean up orphaned provenance_links where subject no longer exists.
    // Use OR so a link is removed if EITHER side is orphaned (not just both).
    // Skip 'mentioned_in' links from the object_id check because their
    // object_id is a source ref (e.g. "document:xyz") that intentionally
    // doesn't exist in memory_objects.
    let orphansRemoved = 0;
    try {
      const orphanResult = db.prepare(`
        DELETE FROM provenance_links
        WHERE subject_id NOT IN (SELECT composite_id FROM memory_objects)
          OR (predicate != 'mentioned_in'
              AND object_id NOT IN (SELECT composite_id FROM memory_objects))
      `).run();
      orphansRemoved = Number(orphanResult.changes);
    } catch { /* non-fatal */ }

    // Invalidate awareness cache after graph mutations
    invalidateAwarenessCache();

    // Log the cleanup
    logEvidence(db, {
      scopeId: DEFAULT_SCOPE_ID,
      objectType: "source",
      objectId: 0,
      eventType: "delete",
      payload: { sourceType, sourceId, mentionsDeleted, entitiesAffected, orphansRemoved },
    });

    return {
      entitiesAffected,
      mentionsDeleted,
      orphansRemoved,
    };
  };

  // If already inside a transaction, run directly; otherwise wrap in one
  try {
    return withWriteTransaction(db, doDelete);
  } catch (err) {
    if (err instanceof Error && err.message.includes("transaction")) {
      // Already inside a transaction — run directly
      return doDelete();
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Store extraction results
// ---------------------------------------------------------------------------

/**
 * Store a batch of extraction results: upsert entities, insert mentions,
 * and log evidence for each.
 *
 * Wrapped in a write transaction so all entity upserts, mentions, and evidence
 * writes for the batch are atomic. Safe to call from within an existing
 * transaction (falls through without nesting).
 */
export function storeExtractionResult(
  db: GraphDb,
  results: ExtractionResult[],
  input: StoreExtractionInput,
): void {
  const doWork = (): void => {
    for (const result of results) {
      const name = result.name.toLowerCase().trim();
      if (name.length === 0) continue;

      const { entityId } = upsertEntity(db, {
        name: result.name,
        displayName: result.name,
        entityType: result.entityType,
        actor: input.actor,
        runId: input.runId,
      });

      const inserted = insertMention(db, {
        entityId,
        scopeId: input.scopeId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceDetail: input.sourceDetail,
        contextTerms: result.contextTerms,
        actor: input.actor,
        runId: input.runId,
      });

      if (inserted) {
        logEvidence(db, {
          scopeId: input.scopeId,
          objectType: "entity",
          objectId: entityId,
          eventType: "mention_insert",
          actor: input.actor ?? "system",
          runId: input.runId,
          idempotencyKey: `extract:${input.sourceType}:${input.sourceId}:${name}:${result.strategy ?? "unknown"}`,
          payload: {
            confidence: result.confidence,
            strategy: result.strategy,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
          },
        });
      }
    }
  };

  // Wrap in write transaction; if already inside one (e.g. reExtractGraphForDocument), run directly
  try {
    withWriteTransaction(db, doWork);
  } catch (err) {
    if (err instanceof Error && err.message.includes("transaction")) {
      doWork();
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Atomic re-extraction for documents
// ---------------------------------------------------------------------------

/**
 * Atomically delete old graph data for a document and re-extract
 * from new chunks. Wrapped in a single transaction — if the process
 * crashes mid-way, the entire operation rolls back and old data is preserved.
 */
export function reExtractGraphForDocument(
  db: GraphDb,
  documentId: string,
  chunks: Array<{ text: string; position: number }>,
  opts: {
    actor?: string;
    runId?: string;
    scopeId?: number;
    termsListEntries?: string[];
  },
): void {
  withWriteTransaction(db, () => {
    // Step 1: delete old mentions + memory objects for this source
    deleteGraphDataForSource(db, "document", documentId);

    // Step 2: extract and store from new chunks
    for (let i = 0; i < chunks.length; i++) {
      const entities = extractFast(chunks[i].text, opts.termsListEntries);
      if (entities.length > 0) {
        storeExtractionResult(db, entities, {
          sourceType: "document",
          sourceId: documentId,
          sourceDetail: `chunk ${i}`,
          scopeId: opts.scopeId,
          actor: opts.actor,
          runId: opts.runId,
        });
      }
    }
  });
}
