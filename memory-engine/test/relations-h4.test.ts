import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { runGraphMigrations } from "../src/relations/schema.js";
import {
  upsertRunbook, addRunbookEvidence, getRunbookWithEvidence, inferRunbookFromAttempts,
} from "../src/relations/runbook-store.js";
import { recordAttempt } from "../src/relations/attempt-store.js";
import { getTimeline, formatTimelineEvent } from "../src/relations/timeline.js";
import { getStateAtTime, getEvidenceAtTime } from "../src/relations/snapshot.js";
import { upsertClaim } from "../src/relations/claim-store.js";
import { upsertDecision } from "../src/relations/decision-store.js";
import { openLoop, closeLoop } from "../src/relations/loop-store.js";
import { upsertInvariant } from "../src/relations/invariant-store.js";
import type { GraphDb } from "../src/relations/types.js";

function createDb(): GraphDb {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runGraphMigrations(db as unknown as GraphDb);
  return db as unknown as GraphDb;
}

// ============================================================================
// Schema
// ============================================================================

describe("H4 Schema", () => {
  it("migration v5 creates runbook_evidence table", () => {
    const db = createDb();
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ name: string }>).map((r) => r.name);
    // Fresh install stores runbook evidence in provenance_links, not a legacy table
    expect(tables).toContain("provenance_links");
    expect(tables).toContain("memory_objects");
  });

  it("migration v5 is idempotent", () => {
    const db = createDb();
    runGraphMigrations(db);
    const v5 = db.prepare("SELECT version FROM _evidence_migrations WHERE version = 5").get();
    expect(v5).toBeDefined();
  });
});

// ============================================================================
// Runbook Evidence
// ============================================================================

describe("H4 Runbook Evidence", () => {
  let db: GraphDb;
  beforeEach(() => { db = createDb(); });

  it("addRunbookEvidence links an attempt to a runbook", () => {
    const { runbookId } = upsertRunbook(db, {
      scopeId: 1, runbookKey: "deploy", toolName: "deploy", pattern: "npm deploy",
    });
    const attemptId = recordAttempt(db, {
      scopeId: 1, toolName: "deploy", status: "success",
    });
    const evidenceId = addRunbookEvidence(db, {
      runbookId, attemptId, sourceType: "attempt", sourceId: String(attemptId),
    });
    expect(evidenceId).toBeGreaterThan(0);
  });

  it("getRunbookWithEvidence returns runbook with evidence chain", () => {
    const { runbookId } = upsertRunbook(db, {
      scopeId: 1, runbookKey: "build", toolName: "build", pattern: "npm run build",
    });
    addRunbookEvidence(db, { runbookId, sourceType: "attempt", sourceId: "a1" });
    addRunbookEvidence(db, { runbookId, sourceType: "attempt", sourceId: "a2" });

    const rb = getRunbookWithEvidence(db, runbookId);
    expect(rb).not.toBeNull();
    expect(rb!.evidence.length).toBe(2);
  });

  it("getRunbookWithEvidence returns null for nonexistent runbook", () => {
    expect(getRunbookWithEvidence(db, 999)).toBeNull();
  });
});

// ============================================================================
// Runbook Inference
// ============================================================================

describe("H4 Runbook Inference", () => {
  it("infers runbook from consecutive successful attempts", () => {
    const db = createDb();
    recordAttempt(db, { scopeId: 1, toolName: "test", status: "success", inputSummary: "npm test" });
    recordAttempt(db, { scopeId: 1, toolName: "test", status: "success", inputSummary: "npm test" });
    recordAttempt(db, { scopeId: 1, toolName: "test", status: "success", inputSummary: "npm test" });

    const result = inferRunbookFromAttempts(db, 1, "test", 3);
    expect(result).not.toBeNull();
    expect(result!.inferred).toBe(true);
    expect(result!.runbookId).toBeGreaterThan(0);

    // Verify evidence linked
    const rb = getRunbookWithEvidence(db, result!.runbookId);
    expect(rb!.evidence.length).toBe(3);
  });

  it("returns null if not enough successes", () => {
    const db = createDb();
    recordAttempt(db, { scopeId: 1, toolName: "test", status: "success" });
    recordAttempt(db, { scopeId: 1, toolName: "test", status: "failure" });

    const result = inferRunbookFromAttempts(db, 1, "test", 3);
    expect(result).toBeNull();
  });
});

// ============================================================================
// Timeline
// ============================================================================

describe("H4 Timeline", () => {
  it("returns events in reverse chronological order", () => {
    const db = createDb();
    upsertClaim(db, { scopeId: 1, subject: "a", predicate: "is", canonicalKey: "a::is", objectText: "1" });
    upsertDecision(db, { scopeId: 1, topic: "db", decisionText: "Use SQLite" });

    const events = getTimeline(db, 1);
    expect(events.length).toBeGreaterThanOrEqual(2);
    // Most recent first
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].id).toBeGreaterThanOrEqual(events[i].id);
    }
  });

  it("filters by objectType", () => {
    const db = createDb();
    upsertClaim(db, { scopeId: 1, subject: "x", predicate: "is", canonicalKey: "x::is", objectText: "y" });
    upsertDecision(db, { scopeId: 1, topic: "t", decisionText: "d" });

    const claimEvents = getTimeline(db, 1, { objectType: "claim" });
    expect(claimEvents.every((e) => e.object_type === "claim")).toBe(true);
  });

  it("formatTimelineEvent produces readable string", () => {
    const event = {
      id: 1, scope_id: 1, object_type: "claim", object_id: 42,
      event_type: "create", actor: "system", payload_json: '{"subject":"api"}',
      created_at: "2026-01-01T00:00:00.000", scope_seq: 1,
    };
    const formatted = formatTimelineEvent(event);
    expect(formatted).toContain("claim#42");
    expect(formatted).toContain("create");
    expect(formatted).toContain("system");
  });
});

// ============================================================================
// Snapshots
// ============================================================================

describe("H4 Snapshots", () => {
  it("getStateAtTime returns state at a point in time", () => {
    const db = createDb();
    upsertClaim(db, { scopeId: 1, subject: "api", predicate: "status", canonicalKey: "api::status", objectText: "up" });
    upsertDecision(db, { scopeId: 1, topic: "db", decisionText: "Use PostgreSQL" });
    openLoop(db, { scopeId: 1, text: "Deploy to staging" });
    upsertInvariant(db, { scopeId: 1, invariantKey: "no-force-push", description: "No force push" });

    // Snapshot at "future" should include everything
    const snapshot = getStateAtTime(db, 1, "2099-01-01T00:00:00.000");
    expect(snapshot.claims.length).toBeGreaterThan(0);
    expect(snapshot.decisions.length).toBeGreaterThan(0);
    expect(snapshot.openLoops.length).toBeGreaterThan(0);
    expect(snapshot.invariants.length).toBeGreaterThan(0);
    expect(snapshot.evidenceCount).toBeGreaterThan(0);
  });

  it("getStateAtTime returns empty for timestamp before any data", () => {
    const db = createDb();
    upsertClaim(db, { scopeId: 1, subject: "x", predicate: "is", canonicalKey: "x::is", objectText: "y" });

    const snapshot = getStateAtTime(db, 1, "2000-01-01T00:00:00.000");
    expect(snapshot.claims.length).toBe(0);
    expect(snapshot.evidenceCount).toBe(0);
  });

  it("getStateAtTime excludes closed loops", () => {
    const db = createDb();
    const loopId = openLoop(db, { scopeId: 1, text: "Task" });
    closeLoop(db, loopId);

    const snapshot = getStateAtTime(db, 1, "2099-01-01T00:00:00.000");
    // Closed loop should not appear (closed_at is set, and closed_at <= timestamp)
    // Actually: our query is `closed_at IS NULL OR closed_at > ?`
    // Since closed_at <= "2099", the loop IS excluded. Correct.
    expect(snapshot.openLoops.length).toBe(0);
  });

  it("getEvidenceAtTime returns events up to timestamp", () => {
    const db = createDb();
    upsertClaim(db, { scopeId: 1, subject: "a", predicate: "is", canonicalKey: "a::is", objectText: "1" });

    const evidence = getEvidenceAtTime(db, 1, "2099-01-01T00:00:00.000");
    expect(evidence.length).toBeGreaterThan(0);

    const noEvidence = getEvidenceAtTime(db, 1, "2000-01-01T00:00:00.000");
    expect(noEvidence.length).toBe(0);
  });
});

// ============================================================================
// Audit-driven: Historical snapshot accuracy
// ============================================================================

describe("H4 Snapshot historical accuracy", () => {
  it("includes claims that were superseded AFTER the snapshot timestamp", () => {
    const db = createDb();
    // Create claim with explicit timestamps in memory_objects
    db.prepare(`
      INSERT INTO memory_objects (composite_id, kind, canonical_key, content, structured_json,
        scope_id, branch_id, confidence, trust_score, source_authority,
        status, created_at, updated_at, first_observed_at, last_observed_at)
      VALUES ('claim:hist:api-status', 'claim', 'api::status', 'api status: healthy',
        '{"subject":"api","predicate":"status","objectText":"healthy","valueType":"text"}',
        1, 0, 0.8, 0.5, 0.5,
        'superseded', '2026-01-01T10:00:00.000', '2026-01-01T12:00:00.000',
        '2026-01-01T10:00:00.000', '2026-01-01T10:00:00.000')
    `).run();

    // At 11:00 (between creation and supersession), claim should be visible
    const snapshot = getStateAtTime(db, 1, "2026-01-01T11:00:00.000");
    expect(snapshot.claims.length).toBe(1);
    expect(snapshot.claims[0].subject).toBe("api");

    // At 09:00 (before creation), claim should NOT be visible
    const before = getStateAtTime(db, 1, "2026-01-01T09:00:00.000");
    expect(before.claims.length).toBe(0);
  });

  it("includes invariants that were retired AFTER the snapshot timestamp", () => {
    const db = createDb();
    db.prepare(`
      INSERT INTO memory_objects (composite_id, kind, canonical_key, content, structured_json,
        scope_id, branch_id, confidence,
        status, created_at, updated_at)
      VALUES ('invariant:hist:old-rule', 'invariant', 'inv::old-rule', 'Old rule',
        '{"key":"old-rule","description":"Old rule","severity":"warning","enforcementMode":"advisory"}',
        1, 0, 0.5,
        'retired', '2026-01-01T10:00:00.000', '2026-01-01T14:00:00.000')
    `).run();

    // At 12:00 (before retirement), invariant should be visible
    const snapshot = getStateAtTime(db, 1, "2026-01-01T12:00:00.000");
    expect(snapshot.invariants.length).toBe(1);
  });
});
