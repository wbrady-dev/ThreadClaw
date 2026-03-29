/**
 * RSMA Historical Data Migration — backfill provenance_links.
 *
 * Migrates existing cross-object relationships from legacy join tables
 * into the unified provenance_links table. Safe to run multiple times
 * (INSERT OR IGNORE handles duplicates).
 *
 * Legacy tables may be renamed to _legacy_* (v18 migration).
 * Tries both renamed and original table names.
 */

import type { GraphDb } from "../relations/types.js";

interface MigrationStats {
  entityMentions: number;
  claimEvidence: number;
  entityRelations: number;
  runbookEvidence: number;
  antiRunbookEvidence: number;
  total: number;
  errors: number;
}

/** Try a SQL statement with both _legacy_* and original table names. */
function tryLegacy(db: GraphDb, sql: string, legacyTable: string): number {
  // Assert table name is safe (alphanumeric + underscore only) to prevent injection via replacement
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(legacyTable)) {
    throw new Error(`Unsafe legacy table name: ${legacyTable}`);
  }
  // Try _legacy_ prefixed name first, then original
  for (const table of [`_legacy_${legacyTable}`, legacyTable]) {
    try {
      const result = db.prepare(sql.replace(`__TABLE__`, table)).run();
      return Number(result.changes);
    } catch { /* try next */ }
  }
  return 0;
}

/**
 * Migrate all legacy join tables into provenance_links.
 * Safe to call repeatedly — uses INSERT OR IGNORE.
 */
export function migrateToProvenanceLinks(db: GraphDb): MigrationStats {
  const stats: MigrationStats = {
    entityMentions: 0,
    claimEvidence: 0,
    entityRelations: 0,
    runbookEvidence: 0,
    antiRunbookEvidence: 0,
    total: 0,
    errors: 0,
  };

  // entity_mentions → mentioned_in
  stats.entityMentions = tryLegacy(db, `
    INSERT OR IGNORE INTO provenance_links (subject_id, predicate, object_id, confidence, detail)
    SELECT
      'entity:' || entity_id,
      'mentioned_in',
      COALESCE(source_type, 'unknown') || ':' || COALESCE(source_id, ''),
      1.0,
      source_detail
    FROM __TABLE__
    WHERE entity_id IS NOT NULL AND source_id IS NOT NULL
  `, "entity_mentions");

  // claim_evidence → supports/contradicts (evidence source is subject, claim is object)
  stats.claimEvidence = tryLegacy(db, `
    INSERT OR IGNORE INTO provenance_links (subject_id, predicate, object_id, confidence, detail)
    SELECT
      COALESCE(source_type, 'unknown') || ':' || COALESCE(source_id, ''),
      CASE
        WHEN evidence_role = 'contradict' THEN 'contradicts'
        WHEN evidence_role = 'contradicts' THEN 'contradicts'
        WHEN evidence_role = 'update' THEN 'supports'
        ELSE 'supports'
      END,
      'claim:' || claim_id,
      MAX(0.0, MIN(1.0, COALESCE(confidence_delta, 1.0))),
      source_detail
    FROM __TABLE__
    WHERE claim_id IS NOT NULL AND source_id IS NOT NULL
  `, "claim_evidence");

  // entity_relations → relates_to
  stats.entityRelations = tryLegacy(db, `
    INSERT OR IGNORE INTO provenance_links (subject_id, predicate, object_id, confidence, detail)
    SELECT
      'entity:' || subject_entity_id,
      'relates_to',
      'entity:' || object_entity_id,
      COALESCE(confidence, 1.0),
      predicate
    FROM __TABLE__
    WHERE subject_entity_id IS NOT NULL AND object_entity_id IS NOT NULL
  `, "entity_relations");

  // runbook_evidence → supports
  stats.runbookEvidence = tryLegacy(db, `
    INSERT OR IGNORE INTO provenance_links (subject_id, predicate, object_id, confidence, detail)
    SELECT
      'procedure:' || runbook_id,
      'supports',
      'attempt:' || attempt_id,
      1.0,
      evidence_role
    FROM __TABLE__
    WHERE runbook_id IS NOT NULL AND attempt_id IS NOT NULL
  `, "runbook_evidence");

  // anti_runbook_evidence → supports
  stats.antiRunbookEvidence = tryLegacy(db, `
    INSERT OR IGNORE INTO provenance_links (subject_id, predicate, object_id, confidence, detail)
    SELECT
      'procedure:' || anti_runbook_id,
      'supports',
      'attempt:' || attempt_id,
      1.0,
      evidence_role
    FROM __TABLE__
    WHERE anti_runbook_id IS NOT NULL AND attempt_id IS NOT NULL
  `, "anti_runbook_evidence");

  stats.total = stats.entityMentions + stats.claimEvidence + stats.entityRelations
    + stats.runbookEvidence + stats.antiRunbookEvidence;

  return stats;
}

/**
 * Check if migration has already been performed (any rows in provenance_links).
 */
export function isMigrationNeeded(db: GraphDb): boolean {
  try {
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM provenance_links").get() as { cnt: number }).cnt;
    return count === 0;
  } catch {
    return true; // Table doesn't exist — migration IS needed
  }
}
