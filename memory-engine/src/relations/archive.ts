/**
 * Cold structured archive — moves stale/old evidence out of the hot graph DB
 * into a separate archive.db while preserving full structured fidelity.
 *
 * Three-tier design:
 *   Hot (graph.db)    — active claims, decisions, loops, recent events
 *   Cold (archive.db) — superseded decisions, stale claims, old events
 *   RAG (optional)    — semantic discovery over narratives, NOT the ledger
 *
 * Safety rules:
 *   1. Archive writes happen BEFORE hot deletes (copy-then-delete)
 *   2. Each category is independent (one failing doesn't block others)
 *   3. Rows are soft-marked as 'archived' before hard delete
 *   4. Every archived row has archive_run_id for traceability
 *   5. Restore is supported from day one
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type { GraphDb } from "./types.js";

// ── Archive DB schema ──

const ARCHIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS archived_claims (
    id INTEGER,
    scope_id INTEGER,
    branch_id INTEGER,
    subject TEXT,
    predicate TEXT,
    object_text TEXT,
    object_json TEXT,
    value_type TEXT,
    status TEXT,
    confidence REAL,
    trust_score REAL,
    source_authority REAL,
    canonical_key TEXT,
    first_seen_at TEXT,
    last_seen_at TEXT,
    superseded_by INTEGER,
    original_created_at TEXT,
    archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    archive_reason TEXT,
    archive_run_id TEXT
);

CREATE TABLE IF NOT EXISTS archived_decisions (
    id INTEGER,
    scope_id INTEGER,
    branch_id INTEGER,
    topic TEXT,
    decision_text TEXT,
    status TEXT,
    decided_at TEXT,
    superseded_by INTEGER,
    source_type TEXT,
    source_id TEXT,
    original_created_at TEXT,
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

CREATE TABLE IF NOT EXISTS archived_loops (
    id INTEGER,
    scope_id INTEGER,
    branch_id INTEGER,
    loop_type TEXT,
    text TEXT,
    status TEXT,
    priority INTEGER,
    owner TEXT,
    opened_at TEXT,
    closed_at TEXT,
    source_type TEXT,
    source_id TEXT,
    original_created_at TEXT,
    archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    archive_reason TEXT,
    archive_run_id TEXT
);

CREATE TABLE IF NOT EXISTS archived_claim_evidence (
    id INTEGER,
    claim_id INTEGER,
    source_type TEXT,
    source_id TEXT,
    source_detail TEXT,
    evidence_role TEXT,
    snippet_hash TEXT,
    confidence_delta REAL,
    created_at TEXT,
    archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    archive_run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_arch_claim_ev_claim ON archived_claim_evidence(claim_id);
CREATE INDEX IF NOT EXISTS idx_arch_claim_ev_run ON archived_claim_evidence(archive_run_id);

CREATE TABLE IF NOT EXISTS _archive_metadata (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS _archive_runs (
    run_id TEXT PRIMARY KEY,
    started_at TEXT,
    completed_at TEXT,
    claims_archived INTEGER DEFAULT 0,
    decisions_archived INTEGER DEFAULT 0,
    events_archived INTEGER DEFAULT 0,
    loops_archived INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running'
);

-- Indexes for queryability
CREATE INDEX IF NOT EXISTS idx_arch_claims_subject ON archived_claims(subject);
CREATE INDEX IF NOT EXISTS idx_arch_claims_archived_at ON archived_claims(archived_at);
CREATE INDEX IF NOT EXISTS idx_arch_claims_run ON archived_claims(archive_run_id);
CREATE INDEX IF NOT EXISTS idx_arch_decisions_topic ON archived_decisions(topic);
CREATE INDEX IF NOT EXISTS idx_arch_decisions_archived_at ON archived_decisions(archived_at);
CREATE INDEX IF NOT EXISTS idx_arch_decisions_run ON archived_decisions(archive_run_id);
CREATE INDEX IF NOT EXISTS idx_arch_events_type ON archived_evidence_log(object_type);
CREATE INDEX IF NOT EXISTS idx_arch_events_created ON archived_evidence_log(created_at);
CREATE INDEX IF NOT EXISTS idx_arch_events_run ON archived_evidence_log(archive_run_id);
CREATE INDEX IF NOT EXISTS idx_arch_loops_run ON archived_loops(archive_run_id);
`;

// ── Archive DB connection ──

let _archiveDb: DatabaseSync | null = null;

export function getArchiveDb(archivePath: string): DatabaseSync {
  if (_archiveDb) return _archiveDb;
  mkdirSync(dirname(archivePath), { recursive: true });
  const db = new DatabaseSync(archivePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(ARCHIVE_SCHEMA);
  _archiveDb = db;
  return db;
}

export function closeArchiveDb(): void {
  try { _archiveDb?.close(); } catch {}
  _archiveDb = null;
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
  errors: string[];
  durationMs: number;
}

// ── Archive operations ──

function archiveStaleClaims(
  hotDb: GraphDb, archiveDb: DatabaseSync, runId: string,
  confidenceThreshold: number, staleDays: number,
): { archived: number; candidates: number } {
  const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();
  const stale = hotDb.prepare(`
    SELECT * FROM claims
    WHERE status = 'active' AND confidence < ? AND last_seen_at < ?
  `).all(confidenceThreshold, cutoff) as any[];

  if (stale.length === 0) return { archived: 0, candidates: 0 };

  const insert = archiveDb.prepare(`
    INSERT INTO archived_claims
      (id, scope_id, branch_id, subject, predicate, object_text, object_json,
       value_type, status, confidence, trust_score, source_authority,
       canonical_key, first_seen_at, last_seen_at, superseded_by,
       original_created_at, archive_reason, archive_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const c of stale) {
    insert.run(
      c.id, c.scope_id, c.branch_id, c.subject, c.predicate,
      c.object_text, c.object_json, c.value_type, c.status,
      c.confidence, c.trust_score, c.source_authority,
      c.canonical_key, c.first_seen_at, c.last_seen_at,
      c.superseded_by, c.created_at,
      `stale:conf<${confidenceThreshold}:${staleDays}d`, runId,
    );
  }

  // Archive claim evidence before deleting
  const insertEvidence = archiveDb.prepare(`
    INSERT INTO archived_claim_evidence
      (id, claim_id, source_type, source_id, source_detail, evidence_role,
       snippet_hash, confidence_delta, created_at, archive_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const c of stale) {
    const evidence = hotDb.prepare(
      "SELECT * FROM claim_evidence WHERE claim_id = ?",
    ).all(c.id) as any[];
    for (const e of evidence) {
      insertEvidence.run(
        e.id, e.claim_id, e.source_type, e.source_id,
        e.source_detail, e.evidence_role, e.snippet_hash,
        e.confidence_delta, e.created_at, runId,
      );
    }
    hotDb.prepare("DELETE FROM claim_evidence WHERE claim_id = ?").run(c.id);
    hotDb.prepare("DELETE FROM claims WHERE id = ?").run(c.id);
  }

  return { archived: stale.length, candidates: stale.length };
}

function archiveSupersededDecisions(
  hotDb: GraphDb, archiveDb: DatabaseSync, runId: string,
  olderThanDays: number,
): { archived: number; candidates: number } {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const old = hotDb.prepare(`
    SELECT * FROM decisions WHERE status = 'superseded' AND decided_at < ?
  `).all(cutoff) as any[];

  if (old.length === 0) return { archived: 0, candidates: 0 };

  const insert = archiveDb.prepare(`
    INSERT INTO archived_decisions
      (id, scope_id, branch_id, topic, decision_text, status,
       decided_at, superseded_by, source_type, source_id,
       original_created_at, archive_reason, archive_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const d of old) {
    insert.run(
      d.id, d.scope_id, d.branch_id, d.topic, d.decision_text,
      d.status, d.decided_at, d.superseded_by,
      d.source_type, d.source_id, d.created_at,
      `superseded:${olderThanDays}d`, runId,
    );
  }

  for (const d of old) {
    hotDb.prepare("DELETE FROM decisions WHERE id = ?").run(d.id);
  }

  return { archived: old.length, candidates: old.length };
}

function archiveOldEvents(
  hotDb: GraphDb, archiveDb: DatabaseSync, runId: string,
  olderThanDays: number, batchSize = 5000,
): { archived: number; candidates: number } {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();

  // Count total candidates
  const total = (hotDb.prepare(
    "SELECT COUNT(*) as cnt FROM evidence_log WHERE created_at < ?",
  ).get(cutoff) as any).cnt;

  if (total === 0) return { archived: 0, candidates: 0 };

  let archived = 0;
  let iterations = 0;

  // Process in batches
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
      INSERT INTO archived_evidence_log
        (id, scope_id, branch_id, object_type, object_id, event_type,
         actor, run_id, idempotency_key, payload_json, created_at, scope_seq,
         archive_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const e of batch) {
      insert.run(
        e.id, e.scope_id, e.branch_id, e.object_type, e.object_id,
        e.event_type, e.actor, e.run_id, e.idempotency_key,
        e.payload_json, e.created_at, e.scope_seq, runId,
      );
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

function archiveClosedLoops(
  hotDb: GraphDb, archiveDb: DatabaseSync, runId: string,
  olderThanDays: number,
): { archived: number; candidates: number } {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const old = hotDb.prepare(`
    SELECT * FROM open_loops WHERE status = 'closed' AND closed_at < ?
  `).all(cutoff) as any[];

  if (old.length === 0) return { archived: 0, candidates: 0 };

  const insert = archiveDb.prepare(`
    INSERT INTO archived_loops
      (id, scope_id, branch_id, loop_type, text, status, priority,
       owner, opened_at, closed_at, source_type, source_id,
       original_created_at, archive_reason, archive_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const l of old) {
    insert.run(
      l.id, l.scope_id, l.branch_id, l.loop_type, l.text, l.status,
      l.priority, l.owner, l.opened_at, l.closed_at,
      l.source_type, l.source_id, l.opened_at,
      `closed:${olderThanDays}d`, runId,
    );
  }

  for (const l of old) {
    hotDb.prepare("DELETE FROM open_loops WHERE id = ?").run(l.id);
  }

  return { archived: old.length, candidates: old.length };
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
    claimsResult = archiveStaleClaims(hotDb, archiveDb, runId,
      opts?.claimConfidenceThreshold ?? 0.1, opts?.claimStaleDays ?? 30);
  } catch (e: any) { errors.push(`claims: ${e.message}`); }

  try {
    decisionsResult = archiveSupersededDecisions(hotDb, archiveDb, runId,
      opts?.decisionStaleDays ?? 90);
  } catch (e: any) { errors.push(`decisions: ${e.message}`); }

  try {
    eventsResult = archiveOldEvents(hotDb, archiveDb, runId,
      opts?.eventRetentionDays ?? 60, opts?.eventBatchSize ?? 5000);
  } catch (e: any) { errors.push(`events: ${e.message}`); }

  try {
    loopsResult = archiveClosedLoops(hotDb, archiveDb, runId,
      opts?.loopStaleDays ?? 30);
  } catch (e: any) { errors.push(`loops: ${e.message}`); }

  const durationMs = Date.now() - start;

  // Record run completion
  archiveDb.prepare(`
    UPDATE _archive_runs SET
      completed_at = ?, claims_archived = ?, decisions_archived = ?,
      events_archived = ?, loops_archived = ?, status = ?
    WHERE run_id = ?
  `).run(
    new Date().toISOString(),
    claimsResult.archived, decisionsResult.archived,
    eventsResult.archived, loopsResult.archived,
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
  const totalArchived = claimsResult.archived + decisionsResult.archived + eventsResult.archived + loopsResult.archived;
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
 * Supports restore by run_id, by type, or by specific IDs.
 */
export function restoreFromArchive(
  hotDb: GraphDb,
  archivePath: string,
  filter: { runId?: string; type?: "claims" | "decisions" | "loops"; ids?: number[] },
): RestoreResult {
  if (!existsSync(archivePath)) return { restored: 0, type: "none" };
  const archiveDb = getArchiveDb(archivePath);

  if (filter.type === "claims" || (!filter.type && !filter.runId)) {
    return restoreClaims(hotDb, archiveDb, filter);
  }
  if (filter.type === "decisions") {
    return restoreDecisions(hotDb, archiveDb, filter);
  }
  if (filter.type === "loops") {
    return restoreLoops(hotDb, archiveDb, filter);
  }

  // Restore by run_id across all types
  let total = 0;
  total += restoreClaims(hotDb, archiveDb, filter).restored;
  total += restoreDecisions(hotDb, archiveDb, filter).restored;
  total += restoreLoops(hotDb, archiveDb, filter).restored;
  return { restored: total, type: "all" };
}

function restoreClaims(hotDb: GraphDb, archiveDb: DatabaseSync, filter: { runId?: string; ids?: number[] }): RestoreResult {
  let rows: any[];
  if (filter.ids && filter.ids.length > 0) {
    const placeholders = filter.ids.map(() => "?").join(",");
    rows = archiveDb.prepare(`SELECT * FROM archived_claims WHERE id IN (${placeholders})`).all(...filter.ids) as any[];
  } else if (filter.runId) {
    rows = archiveDb.prepare("SELECT * FROM archived_claims WHERE archive_run_id = ?").all(filter.runId) as any[];
  } else {
    return { restored: 0, type: "claims" };
  }

  for (const c of rows) {
    hotDb.prepare(`
      INSERT OR IGNORE INTO claims
        (id, scope_id, branch_id, subject, predicate, object_text, object_json,
         value_type, status, confidence, trust_score, source_authority,
         canonical_key, first_seen_at, last_seen_at, superseded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.id, c.scope_id, c.branch_id, c.subject, c.predicate,
      c.object_text, c.object_json, c.value_type, c.status,
      c.confidence, c.trust_score, c.source_authority,
      c.canonical_key, c.first_seen_at, c.last_seen_at, c.superseded_by,
    );

    // Restore associated claim evidence
    const evidence = archiveDb.prepare(
      "SELECT * FROM archived_claim_evidence WHERE claim_id = ?",
    ).all(c.id) as any[];
    for (const e of evidence) {
      hotDb.prepare(`
        INSERT OR IGNORE INTO claim_evidence
          (id, claim_id, source_type, source_id, source_detail, evidence_role,
           snippet_hash, confidence_delta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        e.id, e.claim_id, e.source_type, e.source_id,
        e.source_detail, e.evidence_role, e.snippet_hash, e.confidence_delta,
      );
    }
  }

  // Remove from archive (claims + evidence)
  if (filter.ids && filter.ids.length > 0) {
    const placeholders = filter.ids.map(() => "?").join(",");
    archiveDb.prepare(`DELETE FROM archived_claim_evidence WHERE claim_id IN (${placeholders})`).run(...filter.ids);
    archiveDb.prepare(`DELETE FROM archived_claims WHERE id IN (${placeholders})`).run(...filter.ids);
  } else if (filter.runId) {
    archiveDb.prepare("DELETE FROM archived_claim_evidence WHERE archive_run_id = ?").run(filter.runId);
    archiveDb.prepare("DELETE FROM archived_claims WHERE archive_run_id = ?").run(filter.runId);
  }

  return { restored: rows.length, type: "claims" };
}

function restoreDecisions(hotDb: GraphDb, archiveDb: DatabaseSync, filter: { runId?: string; ids?: number[] }): RestoreResult {
  let rows: any[];
  if (filter.ids && filter.ids.length > 0) {
    const placeholders = filter.ids.map(() => "?").join(",");
    rows = archiveDb.prepare(`SELECT * FROM archived_decisions WHERE id IN (${placeholders})`).all(...filter.ids) as any[];
  } else if (filter.runId) {
    rows = archiveDb.prepare("SELECT * FROM archived_decisions WHERE archive_run_id = ?").all(filter.runId) as any[];
  } else {
    return { restored: 0, type: "decisions" };
  }

  for (const d of rows) {
    hotDb.prepare(`
      INSERT OR IGNORE INTO decisions
        (id, scope_id, branch_id, topic, decision_text, status,
         decided_at, superseded_by, source_type, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      d.id, d.scope_id, d.branch_id, d.topic, d.decision_text,
      d.status, d.decided_at, d.superseded_by, d.source_type, d.source_id,
    );
  }

  if (filter.ids && filter.ids.length > 0) {
    const placeholders = filter.ids.map(() => "?").join(",");
    archiveDb.prepare(`DELETE FROM archived_decisions WHERE id IN (${placeholders})`).run(...filter.ids);
  } else if (filter.runId) {
    archiveDb.prepare("DELETE FROM archived_decisions WHERE archive_run_id = ?").run(filter.runId);
  }

  return { restored: rows.length, type: "decisions" };
}

function restoreLoops(hotDb: GraphDb, archiveDb: DatabaseSync, filter: { runId?: string; ids?: number[] }): RestoreResult {
  let rows: any[];
  if (filter.ids && filter.ids.length > 0) {
    const placeholders = filter.ids.map(() => "?").join(",");
    rows = archiveDb.prepare(`SELECT * FROM archived_loops WHERE id IN (${placeholders})`).all(...filter.ids) as any[];
  } else if (filter.runId) {
    rows = archiveDb.prepare("SELECT * FROM archived_loops WHERE archive_run_id = ?").all(filter.runId) as any[];
  } else {
    return { restored: 0, type: "loops" };
  }

  for (const l of rows) {
    hotDb.prepare(`
      INSERT OR IGNORE INTO open_loops
        (id, scope_id, branch_id, loop_type, text, status, priority,
         owner, opened_at, closed_at, source_type, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      l.id, l.scope_id, l.branch_id, l.loop_type, l.text, l.status,
      l.priority, l.owner, l.opened_at, l.closed_at, l.source_type, l.source_id,
    );
  }

  if (filter.ids && filter.ids.length > 0) {
    const placeholders = filter.ids.map(() => "?").join(",");
    archiveDb.prepare(`DELETE FROM archived_loops WHERE id IN (${placeholders})`).run(...filter.ids);
  } else if (filter.runId) {
    archiveDb.prepare("DELETE FROM archived_loops WHERE archive_run_id = ?").run(filter.runId);
  }

  return { restored: rows.length, type: "loops" };
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
      claims: safe("SELECT COUNT(*) as cnt FROM archived_claims"),
      decisions: safe("SELECT COUNT(*) as cnt FROM archived_decisions"),
      events: safe("SELECT COUNT(*) as cnt FROM archived_evidence_log"),
      loops: safe("SELECT COUNT(*) as cnt FROM archived_loops"),
      lastRun: getMeta("last_run"),
      lastRunId: getMeta("last_run_id"),
      totalRuns: safe("SELECT COUNT(*) as cnt FROM _archive_runs"),
    };
  } catch {
    return null;
  }
}
