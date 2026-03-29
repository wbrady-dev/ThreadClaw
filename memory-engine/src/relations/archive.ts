/**
 * Cold structured archive — moves stale/old evidence out of the hot graph DB
 * into a separate archive.db while preserving full structured fidelity.
 *
 * Phase 3: Archives from the unified memory_objects table into a single
 * archived_memory_objects table. Legacy per-table archive tables preserved
 * for backward compatibility but new archives go to the unified table.
 *
 * Three-tier design:
 *   Hot (graph.db)    — active memory_objects, recent events
 *   Cold (archive.db) — superseded/stale memory_objects, old events
 *   RAG (optional)    — semantic discovery over narratives, NOT the ledger
 *
 * Safety rules:
 *   1. Archive writes happen BEFORE hot deletes (copy-then-delete)
 *   2. Each category is independent (one failing doesn't block others)
 *   3. Every archived row has archive_run_id for traceability
 *   4. Restore is supported from day one
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type { GraphDb } from "./types.js";

// ── Archive DB schema ──

const ARCHIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS archived_memory_objects (
    id INTEGER,
    composite_id TEXT,
    kind TEXT,
    canonical_key TEXT,
    content TEXT,
    structured_json TEXT,
    scope_id INTEGER,
    branch_id INTEGER,
    status TEXT,
    confidence REAL,
    trust_score REAL,
    influence_weight TEXT,
    superseded_by INTEGER,
    source_kind TEXT,
    source_id TEXT,
    source_detail TEXT,
    source_authority REAL,
    first_observed_at TEXT,
    last_observed_at TEXT,
    observed_at TEXT,
    original_created_at TEXT,
    original_updated_at TEXT,
    archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    archive_reason TEXT,
    archive_run_id TEXT
);

CREATE TABLE IF NOT EXISTS archived_evidence_log (
    id INTEGER,
    scope_id INTEGER,
    branch_id INTEGER,
    object_type TEXT,
    object_id INTEGER,
    event_type TEXT,
    actor TEXT,
    run_id TEXT,
    idempotency_key TEXT,
    payload_json TEXT,
    created_at TEXT,
    scope_seq INTEGER,
    archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    archive_run_id TEXT
);

CREATE TABLE IF NOT EXISTS _archive_metadata (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS _archive_runs (
    run_id TEXT PRIMARY KEY,
    started_at TEXT,
    completed_at TEXT,
    objects_archived INTEGER DEFAULT 0,
    events_archived INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running'
);

-- Indexes for queryability
CREATE INDEX IF NOT EXISTS idx_arch_mo_kind ON archived_memory_objects(kind);
CREATE INDEX IF NOT EXISTS idx_arch_mo_composite ON archived_memory_objects(composite_id);
CREATE INDEX IF NOT EXISTS idx_arch_mo_archived_at ON archived_memory_objects(archived_at);
CREATE INDEX IF NOT EXISTS idx_arch_mo_run ON archived_memory_objects(archive_run_id);
CREATE INDEX IF NOT EXISTS idx_arch_events_type ON archived_evidence_log(object_type);
CREATE INDEX IF NOT EXISTS idx_arch_events_created ON archived_evidence_log(created_at);
CREATE INDEX IF NOT EXISTS idx_arch_events_run ON archived_evidence_log(archive_run_id);
`;

// ── Archive DB connection ──

const _archiveDbMap = new Map<string, DatabaseSync>();

export function getArchiveDb(archivePath: string): DatabaseSync {
  const cached = _archiveDbMap.get(archivePath);
  if (cached) return cached;
  mkdirSync(dirname(archivePath), { recursive: true });
  const db = new DatabaseSync(archivePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(ARCHIVE_SCHEMA);
  _archiveDbMap.set(archivePath, db);
  return db;
}

export function closeArchiveDb(): void {
  for (const db of _archiveDbMap.values()) {
    try { db.close(); } catch {}
  }
  _archiveDbMap.clear();
}

// ── Archive result ──

export interface ArchiveResult {
  runId: string;
  claimsArchived: number;
  decisionsArchived: number;
  eventsArchived: number;
  loopsArchived: number;
  claimsCandidates: number;
  decisionsCandidates: number;
  eventsCandidates: number;
  loopsCandidates: number;
  relationsArchived: number;
  relationsCandidates: number;
  errors: string[];
  durationMs: number;
}

// ── Archive operations ──

function archiveStaleObjects(
  hotDb: GraphDb, archiveDb: DatabaseSync, runId: string,
  kind: string, confidenceThreshold: number, staleDays: number,
): { archived: number; candidates: number } {
  const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();
  const stale = hotDb.prepare(`
    SELECT * FROM memory_objects
    WHERE kind = ? AND status = 'active' AND confidence < ? AND last_observed_at < ?
  `).all(kind, confidenceThreshold, cutoff) as any[];

  if (stale.length === 0) return { archived: 0, candidates: 0 };

  const insert = archiveDb.prepare(`
    INSERT OR IGNORE INTO archived_memory_objects
      (id, composite_id, kind, canonical_key, content, structured_json,
       scope_id, branch_id, status, confidence, trust_score,
       influence_weight, superseded_by,
       source_kind, source_id, source_detail, source_authority,
       first_observed_at, last_observed_at, observed_at,
       original_created_at, original_updated_at,
       archive_reason, archive_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Wrap archive inserts in a transaction for atomicity — if any insert fails,
  // none are committed, and we don't proceed to delete from hotDb.
  archiveDb.exec("BEGIN");
  try {
    for (const row of stale) {
      insert.run(
        row.id, row.composite_id, row.kind, row.canonical_key,
        row.content, row.structured_json,
        row.scope_id, row.branch_id, row.status, row.confidence,
        row.trust_score, row.influence_weight, row.superseded_by,
        row.source_kind, row.source_id, row.source_detail, row.source_authority,
        row.first_observed_at, row.last_observed_at, row.observed_at,
        row.created_at, row.updated_at,
        `stale:conf<${confidenceThreshold}:${staleDays}d`, runId,
      );
    }
    archiveDb.exec("COMMIT");
  } catch (err) {
    archiveDb.exec("ROLLBACK");
    throw err;
  }

  hotDb.exec("BEGIN IMMEDIATE");
  try {
    for (const row of stale) {
      hotDb.prepare("DELETE FROM memory_objects WHERE id = ?").run(row.id);
    }
    hotDb.exec("COMMIT");
  } catch (err) {
    hotDb.exec("ROLLBACK");
    throw err;
  }

  return { archived: stale.length, candidates: stale.length };
}

function archiveSupersededObjects(
  hotDb: GraphDb, archiveDb: DatabaseSync, runId: string,
  kind: string, olderThanDays: number,
): { archived: number; candidates: number } {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const old = hotDb.prepare(`
    SELECT * FROM memory_objects
    WHERE kind = ? AND status = 'superseded' AND created_at < ?
  `).all(kind, cutoff) as any[];

  if (old.length === 0) return { archived: 0, candidates: 0 };

  const insert = archiveDb.prepare(`
    INSERT OR IGNORE INTO archived_memory_objects
      (id, composite_id, kind, canonical_key, content, structured_json,
       scope_id, branch_id, status, confidence, trust_score,
       influence_weight, superseded_by,
       source_kind, source_id, source_detail, source_authority,
       first_observed_at, last_observed_at, observed_at,
       original_created_at, original_updated_at,
       archive_reason, archive_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Wrap archive inserts in a transaction for atomicity
  archiveDb.exec("BEGIN");
  try {
    for (const row of old) {
      insert.run(
        row.id, row.composite_id, row.kind, row.canonical_key,
        row.content, row.structured_json,
        row.scope_id, row.branch_id, row.status, row.confidence,
        row.trust_score, row.influence_weight, row.superseded_by,
        row.source_kind, row.source_id, row.source_detail, row.source_authority,
        row.first_observed_at, row.last_observed_at, row.observed_at,
        row.created_at, row.updated_at,
        `superseded:${olderThanDays}d`, runId,
      );
    }
    archiveDb.exec("COMMIT");
  } catch (err) {
    archiveDb.exec("ROLLBACK");
    throw err;
  }

  hotDb.exec("BEGIN IMMEDIATE");
  try {
    for (const row of old) {
      hotDb.prepare("DELETE FROM memory_objects WHERE id = ?").run(row.id);
    }
    hotDb.exec("COMMIT");
  } catch (err) {
    hotDb.exec("ROLLBACK");
    throw err;
  }

  return { archived: old.length, candidates: old.length };
}

function archiveOldEvents(
  hotDb: GraphDb, archiveDb: DatabaseSync, runId: string,
  olderThanDays: number, batchSize = 5000,
): { archived: number; candidates: number } {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();

  const total = (hotDb.prepare(
    "SELECT COUNT(*) as cnt FROM evidence_log WHERE created_at < ?",
  ).get(cutoff) as any).cnt;

  if (total === 0) return { archived: 0, candidates: 0 };

  let archived = 0;
  let iterations = 0;

  while (true) {
    if (++iterations >= 10000) {
      console.warn("[cc-mem] archive: hit iteration limit (10000 batches), some events may remain unarchived");
      break;
    }

    const batch = hotDb.prepare(`
      SELECT * FROM evidence_log WHERE created_at < ? ORDER BY id ASC LIMIT ?
    `).all(cutoff, batchSize) as any[];

    if (batch.length === 0) break;

    const insert = archiveDb.prepare(`
      INSERT OR IGNORE INTO archived_evidence_log
        (id, scope_id, branch_id, object_type, object_id, event_type,
         actor, run_id, idempotency_key, payload_json, created_at, scope_seq,
         archive_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Archive inserts must succeed before we delete from hot DB
    try {
      for (const e of batch) {
        insert.run(
          e.id, e.scope_id, e.branch_id, e.object_type, e.object_id,
          e.event_type, e.actor, e.run_id, e.idempotency_key,
          e.payload_json, e.created_at, e.scope_seq, runId,
        );
      }
    } catch (insertErr) {
      console.error("[cc-mem] archive: INSERT to archive failed, skipping delete:", insertErr instanceof Error ? insertErr.message.slice(0, 500) : "unknown error");
      break;
    }

    const maxId = batch[batch.length - 1].id;
    try {
      hotDb.prepare("DELETE FROM evidence_log WHERE id <= ? AND created_at < ?").run(maxId, cutoff);
    } catch (err) {
      console.error("[cc-mem] archive: DELETE failed:", err instanceof Error ? err.message.slice(0, 500) : "unknown error");
      break;
    }
    archived += batch.length;

    if (batch.length < batchSize) break; // last batch
  }

  return { archived, candidates: total };
}

// ── Public API ──

export function runArchive(
  hotDb: GraphDb,
  archivePath: string,
  opts?: {
    claimConfidenceThreshold?: number;
    claimStaleDays?: number;
    decisionStaleDays?: number;
    eventRetentionDays?: number;
    loopStaleDays?: number;
    eventBatchSize?: number;
  },
): ArchiveResult {
  const start = Date.now();
  const runId = randomUUID().slice(0, 12);
  const archiveDb = getArchiveDb(archivePath);
  const errors: string[] = [];

  // Record run start
  archiveDb.prepare(`
    INSERT INTO _archive_runs (run_id, started_at) VALUES (?, ?)
  `).run(runId, new Date().toISOString());

  let claimsResult = { archived: 0, candidates: 0 };
  let decisionsResult = { archived: 0, candidates: 0 };
  let eventsResult = { archived: 0, candidates: 0 };
  let loopsResult = { archived: 0, candidates: 0 };

  try {
    claimsResult = archiveStaleObjects(hotDb, archiveDb, runId, "claim",
      opts?.claimConfidenceThreshold ?? 0.1, opts?.claimStaleDays ?? 30);
  } catch (e: any) { errors.push(`claims: ${e.message}`); }

  try {
    decisionsResult = archiveSupersededObjects(hotDb, archiveDb, runId, "decision",
      opts?.decisionStaleDays ?? 90);
  } catch (e: any) { errors.push(`decisions: ${e.message}`); }

  try {
    eventsResult = archiveOldEvents(hotDb, archiveDb, runId,
      opts?.eventRetentionDays ?? 60, opts?.eventBatchSize ?? 5000);
  } catch (e: any) { errors.push(`events: ${e.message}`); }

  try {
    // Archive stale/closed loops (status = 'superseded' or 'stale')
    const cutoff = new Date(Date.now() - (opts?.loopStaleDays ?? 30) * 86_400_000).toISOString();
    const old = hotDb.prepare(`
      SELECT * FROM memory_objects
      WHERE kind = 'loop' AND status IN ('superseded', 'stale') AND updated_at < ?
    `).all(cutoff) as any[];

    if (old.length > 0) {
      const insert = archiveDb.prepare(`
        INSERT OR IGNORE INTO archived_memory_objects
          (id, composite_id, kind, canonical_key, content, structured_json,
           scope_id, branch_id, status, confidence, trust_score,
           influence_weight, superseded_by,
           source_kind, source_id, source_detail, source_authority,
           first_observed_at, last_observed_at, observed_at,
           original_created_at, original_updated_at,
           archive_reason, archive_run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Wrap archive inserts in a transaction for atomicity
      archiveDb.exec("BEGIN");
      try {
        for (const row of old) {
          insert.run(
            row.id, row.composite_id, row.kind, row.canonical_key,
            row.content, row.structured_json,
            row.scope_id, row.branch_id, row.status, row.confidence,
            row.trust_score, row.influence_weight, row.superseded_by,
            row.source_kind, row.source_id, row.source_detail, row.source_authority,
            row.first_observed_at, row.last_observed_at, row.observed_at,
            row.created_at, row.updated_at,
            `closed:${opts?.loopStaleDays ?? 30}d`, runId,
          );
        }
        archiveDb.exec("COMMIT");
      } catch (err) {
        archiveDb.exec("ROLLBACK");
        throw err;
      }

      hotDb.exec("BEGIN IMMEDIATE");
      try {
        for (const row of old) {
          hotDb.prepare("DELETE FROM memory_objects WHERE id = ?").run(row.id);
        }
        hotDb.exec("COMMIT");
      } catch (err) {
        hotDb.exec("ROLLBACK");
        throw err;
      }

      loopsResult = { archived: old.length, candidates: old.length };
    }
  } catch (e: any) { errors.push(`loops: ${e.message}`); }

  // Archive superseded/stale relations
  let relationsResult = { archived: 0, candidates: 0 };
  try {
    relationsResult = archiveSupersededObjects(hotDb, archiveDb, runId, "relation",
      opts?.decisionStaleDays ?? 90);
  } catch (e: any) { errors.push(`relations: ${e.message}`); }

  const durationMs = Date.now() - start;
  const totalArchived = claimsResult.archived + decisionsResult.archived + eventsResult.archived + loopsResult.archived + relationsResult.archived;

  // Record run completion
  archiveDb.prepare(`
    UPDATE _archive_runs SET
      completed_at = ?, objects_archived = ?,
      events_archived = ?, status = ?
    WHERE run_id = ?
  `).run(
    new Date().toISOString(),
    claimsResult.archived + decisionsResult.archived + loopsResult.archived,
    eventsResult.archived,
    errors.length > 0 ? "partial" : "complete",
    runId,
  );

  // Update last run metadata
  archiveDb.prepare(`
    INSERT OR REPLACE INTO _archive_metadata (key, value) VALUES ('last_run', ?)
  `).run(new Date().toISOString());
  archiveDb.prepare(`
    INSERT OR REPLACE INTO _archive_metadata (key, value) VALUES ('last_run_id', ?)
  `).run(runId);

  // VACUUM hot DB after large purges to reclaim disk space
  if (totalArchived > 100) {
    try { hotDb.exec("VACUUM"); } catch { /* non-fatal */ }
  }

  return {
    runId,
    claimsArchived: claimsResult.archived,
    decisionsArchived: decisionsResult.archived,
    eventsArchived: eventsResult.archived,
    loopsArchived: loopsResult.archived,
    claimsCandidates: claimsResult.candidates,
    decisionsCandidates: decisionsResult.candidates,
    eventsCandidates: eventsResult.candidates,
    loopsCandidates: loopsResult.candidates,
    relationsArchived: relationsResult.archived,
    relationsCandidates: relationsResult.candidates,
    errors,
    durationMs,
  };
}

// ── Restore ──

export interface RestoreResult {
  restored: number;
  type: string;
}

/**
 * Restore archived items back to the hot graph DB.
 * Supports restore by run_id, by type (kind), or by specific IDs.
 */
export function restoreFromArchive(
  hotDb: GraphDb,
  archivePath: string,
  filter: { runId?: string; type?: "claims" | "decisions" | "loops"; ids?: number[] },
): RestoreResult {
  if (!existsSync(archivePath)) return { restored: 0, type: "none" };
  const archiveDb = getArchiveDb(archivePath);

  // Map legacy type names to memory_objects kinds
  const kindMap: Record<string, string> = {
    claims: "claim",
    decisions: "decision",
    loops: "loop",
  };

  const kind = filter.type ? kindMap[filter.type] : undefined;

  let rows: any[];
  if (filter.ids && filter.ids.length > 0) {
    const placeholders = filter.ids.map(() => "?").join(",");
    const kindClause = kind ? " AND kind = ?" : "";
    rows = archiveDb.prepare(
      `SELECT * FROM archived_memory_objects WHERE id IN (${placeholders})${kindClause}`,
    ).all(...filter.ids, ...(kind ? [kind] : [])) as any[];
  } else if (filter.runId) {
    const kindClause = kind ? " AND kind = ?" : "";
    rows = archiveDb.prepare(
      `SELECT * FROM archived_memory_objects WHERE archive_run_id = ?${kindClause}`,
    ).all(filter.runId, ...(kind ? [kind] : [])) as any[];
  } else if (kind) {
    // No specific filter — restore nothing to avoid accidental mass restore
    return { restored: 0, type: filter.type ?? "none" };
  } else {
    return { restored: 0, type: "none" };
  }

  for (const row of rows) {
    hotDb.prepare(`
      INSERT OR IGNORE INTO memory_objects
        (id, composite_id, kind, canonical_key, content, structured_json,
         scope_id, branch_id, status, confidence, trust_score,
         influence_weight, superseded_by,
         source_kind, source_id, source_detail, source_authority,
         first_observed_at, last_observed_at, observed_at,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.composite_id, row.kind, row.canonical_key,
      row.content, row.structured_json,
      row.scope_id, row.branch_id, row.status, row.confidence,
      row.trust_score, row.influence_weight, row.superseded_by,
      row.source_kind, row.source_id, row.source_detail, row.source_authority,
      row.first_observed_at, row.last_observed_at, row.observed_at,
      row.original_created_at, row.original_updated_at,
    );
  }

  // Remove from archive
  if (filter.ids && filter.ids.length > 0) {
    const placeholders = filter.ids.map(() => "?").join(",");
    archiveDb.prepare(`DELETE FROM archived_memory_objects WHERE id IN (${placeholders})`).run(...filter.ids);
  } else if (filter.runId) {
    const kindClause = kind ? " AND kind = ?" : "";
    archiveDb.prepare(`DELETE FROM archived_memory_objects WHERE archive_run_id = ?${kindClause}`).run(filter.runId, ...(kind ? [kind] : []));
  }

  return { restored: rows.length, type: filter.type ?? "all" };
}

// ── Stats ──

export function getArchiveStats(archivePath: string): {
  claims: number;
  decisions: number;
  events: number;
  loops: number;
  lastRun: string | null;
  lastRunId: string | null;
  totalRuns: number;
} | null {
  if (!existsSync(archivePath)) return null;
  try {
    const db = getArchiveDb(archivePath);
    const safe = (sql: string): number => {
      try { return (db.prepare(sql).get() as { cnt: number }).cnt; } catch { return 0; }
    };
    const getMeta = (key: string): string | null =>
      (db.prepare("SELECT value FROM _archive_metadata WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;

    return {
      claims: safe("SELECT COUNT(*) as cnt FROM archived_memory_objects WHERE kind = 'claim'"),
      decisions: safe("SELECT COUNT(*) as cnt FROM archived_memory_objects WHERE kind = 'decision'"),
      events: safe("SELECT COUNT(*) as cnt FROM archived_evidence_log"),
      loops: safe("SELECT COUNT(*) as cnt FROM archived_memory_objects WHERE kind = 'loop'"),
      lastRun: getMeta("last_run"),
      lastRunId: getMeta("last_run_id"),
      totalRuns: safe("SELECT COUNT(*) as cnt FROM _archive_runs"),
    };
  } catch {
    return null;
  }
}
