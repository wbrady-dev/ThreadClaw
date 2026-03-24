/**
 * RSMA Migration Tests — historical data backfill validation.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { runGraphMigrations } from "../src/relations/schema.js";
import type { GraphDb } from "../src/relations/types.js";
import { migrateToProvenanceLinks, isMigrationNeeded } from "../src/ontology/migration.js";

let db: GraphDb;

function createDb(): GraphDb {
  const d = new DatabaseSync(":memory:");
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("PRAGMA foreign_keys = ON");
  return d as unknown as GraphDb;
}

const NOW = new Date().toISOString();

function linkCount(db: GraphDb): number {
  return (db.prepare("SELECT COUNT(*) as cnt FROM provenance_links").get() as { cnt: number }).cnt;
}

/**
 * Create legacy tables that the migration code expects to read from.
 * On a fresh install the fast-path skips these, so tests that exercise
 * the historical backfill must create them explicitly.
 */
function createLegacyTables(db: GraphDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _legacy_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      entity_type TEXT,
      mention_count INTEGER DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(name)
    );
    CREATE TABLE IF NOT EXISTS _legacy_entity_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL,
      scope_id INTEGER,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_detail TEXT,
      context_terms TEXT,
      actor TEXT DEFAULT 'system',
      run_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
    );
    CREATE TABLE IF NOT EXISTS _legacy_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL DEFAULT 0,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object_text TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.5,
      trust_score REAL NOT NULL DEFAULT 0.5,
      source_authority REAL NOT NULL DEFAULT 0.5,
      canonical_key TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS _legacy_claim_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_detail TEXT,
      evidence_role TEXT NOT NULL DEFAULT 'support',
      confidence_delta REAL
    );
    CREATE TABLE IF NOT EXISTS _legacy_entity_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id INTEGER NOT NULL,
      subject_entity_id INTEGER NOT NULL,
      predicate TEXT NOT NULL,
      object_entity_id INTEGER NOT NULL,
      confidence REAL DEFAULT 1.0,
      source_type TEXT,
      source_id TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS _legacy_runbooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id INTEGER NOT NULL,
      runbook_key TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      pattern TEXT,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0.5,
      status TEXT DEFAULT 'active',
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS _legacy_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL DEFAULT 0,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
    );
    CREATE TABLE IF NOT EXISTS _legacy_runbook_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runbook_id INTEGER NOT NULL,
      attempt_id INTEGER,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      evidence_role TEXT,
      recorded_at TEXT
    );
  `);
}

beforeEach(() => {
  db = createDb();
  runGraphMigrations(db);
  createLegacyTables(db);
});

describe("RSMA Migration: isMigrationNeeded", () => {
  it("returns true when provenance_links is empty", () => {
    expect(isMigrationNeeded(db)).toBe(true);
  });

  it("returns false when provenance_links has data", () => {
    db.prepare(
      "INSERT INTO provenance_links (subject_id, predicate, object_id, confidence) VALUES (?, ?, ?, ?)",
    ).run("a", "supports", "b", 1.0);
    expect(isMigrationNeeded(db)).toBe(false);
  });
});

describe("RSMA Migration: entity_mentions", () => {
  it("migrates entity mentions to mentioned_in links", () => {
    // Seed an entity and mention
    db.prepare("INSERT INTO _legacy_entities (name, display_name, mention_count, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run("postgres", "PostgreSQL", 3, NOW, NOW);
    db.prepare("INSERT INTO _legacy_entity_mentions (entity_id, scope_id, source_type, source_id, source_detail, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(1, 1, "message", "42", "user said it", "system", NOW);

    const stats = migrateToProvenanceLinks(db);
    expect(stats.entityMentions).toBe(1);
    expect(linkCount(db)).toBe(1);

    const link = db.prepare("SELECT * FROM provenance_links WHERE subject_id = 'entity:1'").get() as Record<string, unknown>;
    expect(link.predicate).toBe("mentioned_in");
    expect(link.object_id).toBe("message:42");
  });
});

describe("RSMA Migration: claim_evidence", () => {
  it("migrates supporting evidence to supports links", () => {
    // Seed a claim and evidence
    db.prepare(`INSERT INTO _legacy_claims (scope_id, branch_id, subject, predicate, object_text, status, confidence, trust_score, source_authority, canonical_key, first_seen_at, last_seen_at, created_at, updated_at) VALUES (1, 0, 'test', 'is', 'true', 'active', 0.8, 0.7, 0.7, 'claim::test::is', ?, ?, ?, ?)`).run(NOW, NOW, NOW, NOW);
    db.prepare(`INSERT INTO _legacy_claim_evidence (claim_id, source_type, source_id, source_detail, evidence_role, confidence_delta) VALUES (1, 'message', '10', 'user said', 'support', 0.1)`).run();

    const stats = migrateToProvenanceLinks(db);
    expect(stats.claimEvidence).toBe(1);

    // Migration puts source as subject, claim as object
    const link = db.prepare("SELECT * FROM provenance_links WHERE object_id = 'claim:1'").get() as Record<string, unknown>;
    expect(link.predicate).toBe("supports");
    expect(link.subject_id).toBe("message:10");
  });

  it("migrates contradicting evidence to contradicts links", () => {
    db.prepare(`INSERT INTO _legacy_claims (scope_id, branch_id, subject, predicate, object_text, status, confidence, trust_score, source_authority, canonical_key, first_seen_at, last_seen_at, created_at, updated_at) VALUES (1, 0, 'x', 'y', 'z', 'active', 0.8, 0.7, 0.7, 'claim::x::y', ?, ?, ?, ?)`).run(NOW, NOW, NOW, NOW);
    db.prepare(`INSERT INTO _legacy_claim_evidence (claim_id, source_type, source_id, evidence_role) VALUES (1, 'message', '11', 'contradict')`).run();

    const stats = migrateToProvenanceLinks(db);
    // Migration puts source as subject, claim as object
    const link = db.prepare("SELECT * FROM provenance_links WHERE object_id = 'claim:1'").get() as Record<string, unknown>;
    expect(link.predicate).toBe("contradicts");
  });
});

describe("RSMA Migration: entity_relations", () => {
  it("migrates entity relations to relates_to links", () => {
    db.prepare("INSERT INTO _legacy_entities (name, display_name, mention_count, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run("alice", "Alice", 1, NOW, NOW);
    db.prepare("INSERT INTO _legacy_entities (name, display_name, mention_count, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run("bob", "Bob", 1, NOW, NOW);
    db.prepare("INSERT INTO _legacy_entity_relations (scope_id, subject_entity_id, predicate, object_entity_id, confidence, source_type, source_id, created_at) VALUES (1, 1, 'manages', 2, 0.9, 'message', '5', ?)").run(NOW);

    const stats = migrateToProvenanceLinks(db);
    expect(stats.entityRelations).toBe(1);

    const link = db.prepare("SELECT * FROM provenance_links WHERE subject_id = 'entity:1'").get() as Record<string, unknown>;
    expect(link.predicate).toBe("relates_to");
    expect(link.object_id).toBe("entity:2");
    expect(link.detail).toBe("manages"); // original predicate stored in detail
  });
});

describe("RSMA Migration: runbook_evidence", () => {
  it("migrates runbook evidence to supports links", () => {
    db.prepare("INSERT INTO _legacy_runbooks (scope_id, runbook_key, tool_name, pattern, success_count, failure_count, confidence, status, created_at, updated_at) VALUES (1, 'test', 'git_push', 'retry', 3, 0, 0.9, 'active', ?, ?)").run(NOW, NOW);
    db.prepare("INSERT INTO _legacy_attempts (scope_id, branch_id, tool_name, status, created_at) VALUES (1, 0, 'git_push', 'success', ?)").run(NOW);
    db.prepare("INSERT INTO _legacy_runbook_evidence (runbook_id, attempt_id, source_type, source_id, evidence_role, recorded_at) VALUES (1, 1, 'attempt', '1', 'success', ?)").run(NOW);

    const stats = migrateToProvenanceLinks(db);
    expect(stats.runbookEvidence).toBe(1);

    const link = db.prepare("SELECT * FROM provenance_links WHERE subject_id = 'procedure:1'").get() as Record<string, unknown>;
    expect(link.predicate).toBe("supports");
    expect(link.object_id).toBe("attempt:1");
  });
});

describe("RSMA Migration: idempotency", () => {
  it("running migration twice produces no duplicates", () => {
    db.prepare("INSERT INTO _legacy_entities (name, display_name, mention_count, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run("test", "Test", 1, NOW, NOW);
    db.prepare("INSERT INTO _legacy_entity_mentions (entity_id, scope_id, source_type, source_id, actor, created_at) VALUES (1, 1, 'message', '1', 'system', ?)").run(NOW);

    const stats1 = migrateToProvenanceLinks(db);
    expect(stats1.entityMentions).toBe(1);
    expect(linkCount(db)).toBe(1);

    const stats2 = migrateToProvenanceLinks(db);
    expect(stats2.entityMentions).toBe(0); // no new rows (INSERT OR IGNORE)
    expect(linkCount(db)).toBe(1);
  });
});

describe("RSMA Migration: empty tables", () => {
  it("handles empty legacy tables gracefully", () => {
    const stats = migrateToProvenanceLinks(db);
    expect(stats.total).toBe(0);
    expect(stats.errors).toBe(0);
  });
});
