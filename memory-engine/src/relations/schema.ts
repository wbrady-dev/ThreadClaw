/**
 * Evidence graph database schema — migration v1.
 *
 * Creates infrastructure tables (evidence_log, scope_sequences, state_scopes,
 * branch_scopes, promotion_policies) and Horizon 1 tables (entities,
 * entity_mentions). All tables live in `clawcore-graph.db`.
 */

import { chmodSync } from "fs";
import type { GraphDb } from "./types.js";

// ---------------------------------------------------------------------------
// Migration v1 DDL
// ---------------------------------------------------------------------------

const MIGRATION_V1_SQL = `
-- ============================================================
-- INFRASTRUCTURE: ships with Horizon 1, used by all horizons
-- ============================================================

-- Evidence event log (append-only, never updated/deleted)
CREATE TABLE IF NOT EXISTS evidence_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id INTEGER,
    branch_id INTEGER,
    object_type TEXT NOT NULL,
    object_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    run_id TEXT,
    idempotency_key TEXT UNIQUE,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    scope_seq INTEGER
);

CREATE INDEX IF NOT EXISTS idx_evidence_log_scope ON evidence_log(scope_id, scope_seq);
CREATE INDEX IF NOT EXISTS idx_evidence_log_object ON evidence_log(object_type, object_id, created_at);
CREATE INDEX IF NOT EXISTS idx_evidence_log_actor ON evidence_log(actor, created_at);
CREATE INDEX IF NOT EXISTS idx_evidence_log_run ON evidence_log(run_id, created_at);

-- Scope-local sequence counter (one counter per scope, total order)
CREATE TABLE IF NOT EXISTS scope_sequences (
    scope_id INTEGER PRIMARY KEY,
    next_seq INTEGER NOT NULL DEFAULT 1
);

-- State scopes
CREATE TABLE IF NOT EXISTS state_scopes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    display_name TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    UNIQUE(scope_type, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_state_scopes_type_key ON state_scopes(scope_type, scope_key);

-- Seed global scope row (id = 1)
INSERT OR IGNORE INTO state_scopes (id, scope_type, scope_key, display_name)
VALUES (1, 'system', 'global', 'Global');

INSERT OR IGNORE INTO scope_sequences (scope_id, next_seq)
VALUES (1, 1);

-- Branch scopes (speculative memory)
CREATE TABLE IF NOT EXISTS branch_scopes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id INTEGER NOT NULL REFERENCES state_scopes(id) ON DELETE CASCADE,
    branch_type TEXT NOT NULL,
    branch_key TEXT NOT NULL,
    parent_branch_id INTEGER REFERENCES branch_scopes(id),
    created_by_actor TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    promoted_at TEXT,
    UNIQUE(scope_id, branch_type, branch_key)
);

CREATE INDEX IF NOT EXISTS idx_branch_scopes_scope_status ON branch_scopes(scope_id, status);

-- Promotion policies (per object type)
CREATE TABLE IF NOT EXISTS promotion_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_type TEXT NOT NULL,
    min_confidence REAL DEFAULT 0.6,
    requires_user_confirm INTEGER DEFAULT 0,
    auto_promote_above_confidence REAL,
    requires_evidence_count INTEGER DEFAULT 1,
    max_age_hours INTEGER,
    policy_text TEXT,
    UNIQUE(object_type)
);

-- Seed default promotion policies
INSERT OR IGNORE INTO promotion_policies (object_type, min_confidence, requires_user_confirm, auto_promote_above_confidence, requires_evidence_count, max_age_hours, policy_text) VALUES
    ('entity',       0.3, 0, NULL, 1, NULL, 'Entities promote freely after MIN_MENTIONS threshold'),
    ('mention',      0.0, 0, NULL, 1, NULL, 'Mentions always write directly to shared scope'),
    ('claim',        0.6, 0, NULL, 2, 168,  'Claims need confidence >= 0.6 and 2+ evidence rows. Expire after 7 days'),
    ('decision',     0.5, 1, 0.7,  1, NULL, 'Decisions need user confirm, OR auto-promote at confidence >= 0.7'),
    ('loop',         0.3, 0, NULL, 1, 72,   'Open loops promote at low confidence. Expire if stale after 3 days'),
    ('attempt',      0.0, 0, NULL, 1, NULL, 'Attempts always write directly (factual records)'),
    ('runbook',      0.5, 0, NULL, 2, NULL, 'Runbooks need 2+ success evidence. No auto-expire'),
    ('anti_runbook', 0.5, 0, NULL, 2, NULL, 'Anti-runbooks need 2+ failure evidence. No auto-expire'),
    ('invariant',    0.7, 1, 0.9,  1, NULL, 'Invariants need user confirm, OR auto-promote at confidence >= 0.9'),
    ('capability',   0.0, 0, NULL, 1, NULL, 'Capabilities always write directly (observed state)');

-- Migration tracking
CREATE TABLE IF NOT EXISTS _evidence_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);

-- ============================================================
-- HORIZON 1: Entity Awareness Graph
-- ============================================================

CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    entity_type TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    mention_count INTEGER DEFAULT 1,
    UNIQUE(name)
);

CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_last_seen ON entities(last_seen_at);

-- Entity mentions with context terms and scope reference
CREATE TABLE IF NOT EXISTS entity_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    scope_id INTEGER REFERENCES state_scopes(id),
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_detail TEXT,
    context_terms TEXT,
    actor TEXT DEFAULT 'system',
    run_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions(entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mentions_source ON entity_mentions(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_mentions_scope ON entity_mentions(scope_id, entity_id);
`;

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Migration v2 DDL — Horizon 2: Stateful Evidence Engine
// ---------------------------------------------------------------------------

const MIGRATION_V2_SQL = `
-- ============================================================
-- HORIZON 2: Stateful Evidence Engine
-- ============================================================

CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id INTEGER NOT NULL REFERENCES state_scopes(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL DEFAULT 0,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object_text TEXT,
    object_json TEXT,
    value_type TEXT NOT NULL DEFAULT 'text',
    status TEXT NOT NULL DEFAULT 'active',
    confidence REAL NOT NULL DEFAULT 0.5,
    freshness_score REAL NOT NULL DEFAULT 1.0,
    trust_score REAL NOT NULL DEFAULT 0.5,
    source_authority REAL NOT NULL DEFAULT 0.5,
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    superseded_by INTEGER REFERENCES claims(id),
    canonical_key TEXT NOT NULL,
    extraction_version INTEGER NOT NULL DEFAULT 1,
    seq INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    UNIQUE(scope_id, branch_id, canonical_key)
);

CREATE INDEX IF NOT EXISTS idx_claims_scope_status ON claims(scope_id, branch_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_claims_subject ON claims(subject, predicate);
CREATE INDEX IF NOT EXISTS idx_claims_canonical ON claims(canonical_key);
CREATE INDEX IF NOT EXISTS idx_claims_last_seen ON claims(last_seen_at);

CREATE TABLE IF NOT EXISTS claim_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_detail TEXT,
    evidence_role TEXT NOT NULL DEFAULT 'support',
    snippet_hash TEXT,
    observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    confidence_delta REAL NOT NULL DEFAULT 0.0
);

CREATE INDEX IF NOT EXISTS idx_claim_evidence_claim ON claim_evidence(claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_evidence_source ON claim_evidence(source_type, source_id);

CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id INTEGER NOT NULL REFERENCES state_scopes(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL DEFAULT 0,
    topic TEXT NOT NULL,
    decision_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    superseded_by INTEGER REFERENCES decisions(id),
    source_type TEXT,
    source_id TEXT,
    source_detail TEXT,
    seq INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_decisions_scope_status ON decisions(scope_id, branch_id, status);
CREATE INDEX IF NOT EXISTS idx_decisions_topic ON decisions(topic);

CREATE TABLE IF NOT EXISTS open_loops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id INTEGER NOT NULL REFERENCES state_scopes(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL DEFAULT 0,
    loop_type TEXT NOT NULL DEFAULT 'task',
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    priority INTEGER NOT NULL DEFAULT 0,
    owner TEXT,
    due_at TEXT,
    waiting_on TEXT,
    opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    closed_at TEXT,
    source_type TEXT,
    source_id TEXT,
    source_detail TEXT,
    seq INTEGER
);

CREATE INDEX IF NOT EXISTS idx_open_loops_scope_status ON open_loops(scope_id, branch_id, status, priority);

CREATE TABLE IF NOT EXISTS state_deltas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id INTEGER NOT NULL REFERENCES state_scopes(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL DEFAULT 0,
    delta_type TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    summary TEXT,
    old_value TEXT,
    new_value TEXT,
    confidence REAL,
    source_type TEXT,
    source_id TEXT,
    source_detail TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    seq INTEGER
);

CREATE INDEX IF NOT EXISTS idx_state_deltas_scope ON state_deltas(scope_id, branch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_state_deltas_entity ON state_deltas(entity_key);

CREATE TABLE IF NOT EXISTS capabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id INTEGER NOT NULL REFERENCES state_scopes(id) ON DELETE CASCADE,
    capability_type TEXT NOT NULL,
    capability_key TEXT NOT NULL,
    display_name TEXT,
    status TEXT NOT NULL DEFAULT 'available',
    summary TEXT,
    metadata_json TEXT,
    last_checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    UNIQUE(scope_id, capability_type, capability_key)
);

CREATE INDEX IF NOT EXISTS idx_capabilities_scope ON capabilities(scope_id, capability_type, status);

CREATE TABLE IF NOT EXISTS invariants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id INTEGER NOT NULL REFERENCES state_scopes(id) ON DELETE CASCADE,
    invariant_key TEXT NOT NULL,
    category TEXT,
    description TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    enforcement_mode TEXT NOT NULL DEFAULT 'advisory',
    status TEXT NOT NULL DEFAULT 'active',
    source_type TEXT,
    source_id TEXT,
    source_detail TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    UNIQUE(scope_id, invariant_key)
);

CREATE INDEX IF NOT EXISTS idx_invariants_scope ON invariants(scope_id, status, severity);
`;

// ---------------------------------------------------------------------------
// Migration v3 DDL — Horizon 3: Multi-Agent Durability
// ---------------------------------------------------------------------------

const MIGRATION_V3_SQL = `
-- ============================================================
-- HORIZON 3: Multi-Agent Durability
-- ============================================================

CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id INTEGER NOT NULL REFERENCES state_scopes(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL DEFAULT 0,
    tool_name TEXT NOT NULL,
    input_summary TEXT,
    output_summary TEXT,
    status TEXT NOT NULL DEFAULT 'success',
    duration_ms INTEGER,
    error_text TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_attempts_scope_tool ON attempts(scope_id, tool_name, created_at);
CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts(status, created_at);

CREATE TABLE IF NOT EXISTS runbooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id INTEGER NOT NULL REFERENCES state_scopes(id) ON DELETE CASCADE,
    runbook_key TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    pattern TEXT NOT NULL,
    description TEXT,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    UNIQUE(scope_id, runbook_key)
);

CREATE INDEX IF NOT EXISTS idx_runbooks_scope ON runbooks(scope_id, tool_name, status);

CREATE TABLE IF NOT EXISTS anti_runbooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id INTEGER NOT NULL REFERENCES state_scopes(id) ON DELETE CASCADE,
    anti_runbook_key TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    failure_pattern TEXT NOT NULL,
    description TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    UNIQUE(scope_id, anti_runbook_key)
);

CREATE INDEX IF NOT EXISTS idx_anti_runbooks_scope ON anti_runbooks(scope_id, tool_name, status);
`;

// ---------------------------------------------------------------------------
// Migration v6 DDL — Horizon 5: Deep Extraction
// ---------------------------------------------------------------------------

const MIGRATION_V6_SQL = `
CREATE TABLE IF NOT EXISTS entity_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id INTEGER NOT NULL REFERENCES state_scopes(id) ON DELETE CASCADE,
    subject_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    predicate TEXT NOT NULL,
    object_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    confidence REAL NOT NULL DEFAULT 0.5,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    UNIQUE(scope_id, subject_entity_id, predicate, object_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_relations_subject ON entity_relations(subject_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_object ON entity_relations(object_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_scope ON entity_relations(scope_id);
`;

// ---------------------------------------------------------------------------
// Migration v5 DDL — Horizon 4: Procedural Memory
// ---------------------------------------------------------------------------

const MIGRATION_V5_SQL = `
CREATE TABLE IF NOT EXISTS runbook_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runbook_id INTEGER NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
    attempt_id INTEGER REFERENCES attempts(id),
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    evidence_role TEXT NOT NULL DEFAULT 'success',
    recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_runbook_evidence_runbook ON runbook_evidence(runbook_id);
CREATE INDEX IF NOT EXISTS idx_runbook_evidence_attempt ON runbook_evidence(attempt_id);
`;

// ---------------------------------------------------------------------------
// Migration v4 DDL — Horizon 3: Leases
// ---------------------------------------------------------------------------

const MIGRATION_V4_SQL = `
CREATE TABLE IF NOT EXISTS work_leases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id INTEGER NOT NULL REFERENCES state_scopes(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    resource_key TEXT NOT NULL,
    lease_until TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    UNIQUE(scope_id, resource_key)
);

CREATE INDEX IF NOT EXISTS idx_leases_scope ON work_leases(scope_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_leases_expiry ON work_leases(lease_until);
`;

// ---------------------------------------------------------------------------
// Migration v7 DDL — Anti-runbook evidence (mirrors runbook_evidence)
// ---------------------------------------------------------------------------

const MIGRATION_V7_SQL = `
CREATE TABLE IF NOT EXISTS anti_runbook_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anti_runbook_id INTEGER NOT NULL REFERENCES anti_runbooks(id) ON DELETE CASCADE,
    attempt_id INTEGER REFERENCES attempts(id),
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    evidence_role TEXT NOT NULL DEFAULT 'failure',
    recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_anti_runbook_evidence_arb ON anti_runbook_evidence(anti_runbook_id);
CREATE INDEX IF NOT EXISTS idx_anti_runbook_evidence_attempt ON anti_runbook_evidence(attempt_id);
`;

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

function isMigrationApplied(db: GraphDb, version: number): boolean {
  const row = db.prepare(
    "SELECT version FROM _evidence_migrations WHERE version = ?",
  ).get(version) as { version: number } | undefined;
  return row != null;
}

function markMigrationApplied(db: GraphDb, version: number): void {
  db.prepare("INSERT INTO _evidence_migrations (version) VALUES (?)").run(version);
}

/**
 * Run all pending graph database migrations.
 * Idempotent — safe to call on every startup.
 */
export function runGraphMigrations(db: GraphDb, dbPath?: string): void {
  // Ensure _evidence_migrations exists first (chicken-and-egg for v1)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _evidence_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
    )
  `);

  if (!isMigrationApplied(db, 1)) {
    db.exec(MIGRATION_V1_SQL);
    markMigrationApplied(db, 1);
  }

  if (!isMigrationApplied(db, 2)) {
    db.exec(MIGRATION_V2_SQL);
    markMigrationApplied(db, 2);
  }

  if (!isMigrationApplied(db, 3)) {
    db.exec(MIGRATION_V3_SQL);
    markMigrationApplied(db, 3);
  }

  if (!isMigrationApplied(db, 4)) {
    db.exec(MIGRATION_V4_SQL);
    markMigrationApplied(db, 4);
  }

  if (!isMigrationApplied(db, 5)) {
    db.exec(MIGRATION_V5_SQL);
    markMigrationApplied(db, 5);
  }

  if (!isMigrationApplied(db, 6)) {
    db.exec(MIGRATION_V6_SQL);
    markMigrationApplied(db, 6);
  }

  if (!isMigrationApplied(db, 7)) {
    db.exec(MIGRATION_V7_SQL);
    markMigrationApplied(db, 7);
  }

  if (!isMigrationApplied(db, 8)) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mentions_created ON entity_mentions(created_at);
      CREATE INDEX IF NOT EXISTS idx_claims_confidence ON claims(scope_id, confidence DESC);
      CREATE INDEX IF NOT EXISTS idx_decisions_topic_status ON decisions(topic, status);
    `);
    markMigrationApplied(db, 8);
  }

  if (!isMigrationApplied(db, 9)) {
    db.exec(`
      -- Deduplicate existing claim_evidence rows before adding UNIQUE constraint
      DELETE FROM claim_evidence WHERE id NOT IN (
        SELECT MIN(id) FROM claim_evidence
        GROUP BY claim_id, source_type, source_id, evidence_role
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_evidence_unique
        ON claim_evidence(claim_id, source_type, source_id, evidence_role);
    `);
    markMigrationApplied(db, 9);
  }

  // Migration v10: RSMA provenance_links table
  if (!isMigrationApplied(db, 10)) {
    db.exec(`
      -- RSMA: Unified provenance links — replaces 7 separate join tables.
      -- Typed predicates: derived_from, supports, contradicts, supersedes,
      -- mentioned_in, relates_to, resolved_by.
      CREATE TABLE IF NOT EXISTS provenance_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subject_id TEXT NOT NULL,
          predicate TEXT NOT NULL CHECK(predicate IN ('derived_from', 'supports', 'contradicts', 'supersedes', 'mentioned_in', 'relates_to', 'resolved_by')),
          object_id TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0.0 AND confidence <= 1.0),
          detail TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
          UNIQUE(subject_id, predicate, object_id)
      );
      CREATE INDEX IF NOT EXISTS idx_prov_subject ON provenance_links(subject_id);
      CREATE INDEX IF NOT EXISTS idx_prov_object ON provenance_links(object_id);
      CREATE INDEX IF NOT EXISTS idx_prov_predicate ON provenance_links(predicate);
      CREATE INDEX IF NOT EXISTS idx_prov_created_at ON provenance_links(created_at);
    `);
    markMigrationApplied(db, 10);
  }

  // Migration v11: RSMA — extend provenance_links with scope_id + metadata
  if (!isMigrationApplied(db, 11)) {
    // Add columns (safe: ALTER TABLE ADD COLUMN works on existing data with defaults)
    try { db.exec(`ALTER TABLE provenance_links ADD COLUMN scope_id INTEGER DEFAULT 1`); } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE provenance_links ADD COLUMN metadata TEXT`); } catch { /* already exists */ }

    // Composite indexes for filtered queries (predicate + subject/object)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_prov_scope ON provenance_links(scope_id);
      CREATE INDEX IF NOT EXISTS idx_prov_pred_subj ON provenance_links(predicate, subject_id);
      CREATE INDEX IF NOT EXISTS idx_prov_pred_obj ON provenance_links(predicate, object_id);
    `);
    markMigrationApplied(db, 11);
  }

  // File permissions: chmod 600 on Unix/macOS, skip on Windows
  if (dbPath && process.platform !== "win32") {
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // Non-fatal: directory ACLs may prevent chmod
    }
  }
}
