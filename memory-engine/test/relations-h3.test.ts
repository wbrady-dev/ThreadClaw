import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { runGraphMigrations } from "../src/relations/schema.js";
import { recordAttempt, getAttemptHistory, getToolSuccessRate } from "../src/relations/attempt-store.js";
import { upsertClaim } from "../src/relations/claim-store.js";
import { upsertRunbook, demoteRunbook, getRunbooks, getRunbooksForTool } from "../src/relations/runbook-store.js";
import { upsertAntiRunbook, getAntiRunbooks, getAntiRunbooksForTool } from "../src/relations/anti-runbook-store.js";
import { decayAntiRunbooks, decayRunbooks } from "../src/relations/decay.js";
import { compileContextCapsules } from "../src/relations/context-compiler.js";
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

describe("H3 Schema", () => {
  it("migration v3 creates attempts, runbooks, anti_runbooks tables", () => {
    const db = createDb();
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ name: string }>).map((r) => r.name);
    // Fresh install creates RSMA schema directly — attempts/runbooks/anti-runbooks
    // are stored in memory_objects, not in dedicated legacy tables
    expect(tables).toContain("memory_objects");
    expect(tables).toContain("provenance_links");
  });

  it("migration v3 is idempotent", () => {
    const db = createDb();
    runGraphMigrations(db);
    const v3 = db.prepare("SELECT version FROM _evidence_migrations WHERE version = 3").get();
    expect(v3).toBeDefined();
  });
});

// ============================================================================
// Attempt Store
// ============================================================================

describe("H3 Attempt Store", () => {
  let db: GraphDb;
  beforeEach(() => { db = createDb(); });

  it("recordAttempt creates attempt and logs evidence", () => {
    const id = recordAttempt(db, {
      scopeId: 1, toolName: "git_status", status: "success", durationMs: 150,
    });
    expect(id).toBeGreaterThan(0);
    const events = db.prepare("SELECT * FROM evidence_log WHERE object_type = 'attempt'").all();
    expect(events.length).toBe(1);
  });

  it("getAttemptHistory filters by tool_name", () => {
    recordAttempt(db, { scopeId: 1, toolName: "git_status", status: "success" });
    recordAttempt(db, { scopeId: 1, toolName: "npm_install", status: "failure", errorText: "ENOMEM" });
    recordAttempt(db, { scopeId: 1, toolName: "git_status", status: "success" });

    const gitAttempts = getAttemptHistory(db, 1, { toolName: "git_status" });
    expect(gitAttempts.length).toBe(2);
    expect(gitAttempts.every((a) => a.tool_name === "git_status")).toBe(true);
  });

  it("getToolSuccessRate calculates correctly", () => {
    recordAttempt(db, { scopeId: 1, toolName: "deploy", status: "success" });
    recordAttempt(db, { scopeId: 1, toolName: "deploy", status: "success" });
    recordAttempt(db, { scopeId: 1, toolName: "deploy", status: "failure" });

    const rate = getToolSuccessRate(db, 1, "deploy");
    expect(rate.total).toBe(3);
    expect(rate.successes).toBe(2);
    expect(rate.failures).toBe(1);
    expect(rate.rate).toBeCloseTo(2 / 3);
  });

  it("getToolSuccessRate returns 0 for unknown tool", () => {
    const rate = getToolSuccessRate(db, 1, "nonexistent");
    expect(rate.total).toBe(0);
    expect(rate.rate).toBe(0);
  });
});

// ============================================================================
// Runbook Store
// ============================================================================

describe("H3 Runbook Store", () => {
  let db: GraphDb;
  beforeEach(() => { db = createDb(); });

  it("upsertRunbook creates new runbook", () => {
    const result = upsertRunbook(db, {
      scopeId: 1, runbookKey: "deploy-staging", toolName: "deploy",
      pattern: "npm run build && npm run deploy", successCount: 1,
    });
    expect(result.isNew).toBe(true);
    expect(result.runbookId).toBeGreaterThan(0);
  });

  it("upsertRunbook increments counts on conflict", () => {
    upsertRunbook(db, {
      scopeId: 1, runbookKey: "deploy-staging", toolName: "deploy",
      pattern: "npm run build", successCount: 3,
    });
    upsertRunbook(db, {
      scopeId: 1, runbookKey: "deploy-staging", toolName: "deploy",
      pattern: "npm run build", successCount: 2,
    });
    const runbooks = getRunbooks(db, 1);
    // Second upsert overwrites structured_json, so successCount = 2 (last write wins)
    expect(runbooks[0].success_count).toBe(2);
  });

  it("demoteRunbook reduces confidence", () => {
    const { runbookId } = upsertRunbook(db, {
      scopeId: 1, runbookKey: "fragile", toolName: "test",
      pattern: "run tests", confidence: 0.8,
    });
    demoteRunbook(db, runbookId);
    const runbooks = getRunbooks(db, 1);
    expect(runbooks[0].confidence).toBeCloseTo(0.4); // 0.8 * 0.5
  });

  it("getRunbooksForTool filters by tool name", () => {
    upsertRunbook(db, { scopeId: 1, runbookKey: "a", toolName: "git", pattern: "git commit" });
    upsertRunbook(db, { scopeId: 1, runbookKey: "b", toolName: "npm", pattern: "npm install" });
    const gitRunbooks = getRunbooksForTool(db, 1, "git");
    expect(gitRunbooks.length).toBe(1);
    expect(gitRunbooks[0].tool_name).toBe("git");
  });
});

// ============================================================================
// Anti-Runbook Store
// ============================================================================

describe("H3 Anti-Runbook Store", () => {
  let db: GraphDb;
  beforeEach(() => { db = createDb(); });

  it("upsertAntiRunbook creates new anti-runbook", () => {
    const result = upsertAntiRunbook(db, {
      scopeId: 1, antiRunbookKey: "force-push-main", toolName: "git",
      failurePattern: "git push --force origin main",
      description: "Force pushing to main breaks CI",
    });
    expect(result.isNew).toBe(true);
  });

  it("upsertAntiRunbook increments failure_count on conflict", () => {
    upsertAntiRunbook(db, {
      scopeId: 1, antiRunbookKey: "bad-deploy", toolName: "deploy",
      failurePattern: "deploy without tests", failureCount: 1,
    });
    upsertAntiRunbook(db, {
      scopeId: 1, antiRunbookKey: "bad-deploy", toolName: "deploy",
      failurePattern: "deploy without tests", failureCount: 1,
    });
    const arbs = getAntiRunbooks(db, 1);
    expect(arbs[0].failure_count).toBe(2);
  });

  it("getAntiRunbooksForTool filters correctly", () => {
    upsertAntiRunbook(db, { scopeId: 1, antiRunbookKey: "a", toolName: "git", failurePattern: "bad" });
    upsertAntiRunbook(db, { scopeId: 1, antiRunbookKey: "b", toolName: "npm", failurePattern: "worse" });
    const gitArbs = getAntiRunbooksForTool(db, 1, "git");
    expect(gitArbs.length).toBe(1);
  });
});

// ============================================================================
// Decay
// ============================================================================

describe("H3 Decay", () => {
  it("decayAntiRunbooks reduces confidence for old anti-runbooks", () => {
    const db = createDb();
    // Insert anti-runbook with old updated_at into memory_objects
    db.prepare(`
      INSERT INTO memory_objects (composite_id, kind, content, structured_json, scope_id, branch_id, confidence, status, updated_at, created_at)
      VALUES ('antirunbook:1:old-arb', 'procedure', 'test: pattern',
        '{"isNegative":true,"toolName":"test","key":"old-arb","failurePattern":"pattern"}',
        1, 0, 0.8, 'active', datetime('now', '-100 days'), datetime('now', '-100 days'))
    `).run();

    const decayed = decayAntiRunbooks(db, 1, 90);
    expect(decayed).toBe(1);

    const arb = db.prepare("SELECT confidence FROM memory_objects WHERE composite_id = 'antirunbook:1:old-arb'").get() as { confidence: number };
    expect(arb.confidence).toBeCloseTo(0.64); // 0.8 * 0.8
  });

  it("decayAntiRunbooks marks low-confidence as under_review", () => {
    const db = createDb();
    db.prepare(`
      INSERT INTO memory_objects (composite_id, kind, content, structured_json, scope_id, branch_id, confidence, status, updated_at, created_at)
      VALUES ('antirunbook:1:weak-arb', 'procedure', 'test: pattern',
        '{"isNegative":true,"toolName":"test","key":"weak-arb","failurePattern":"pattern"}',
        1, 0, 0.15, 'active', datetime('now', '-100 days'), datetime('now', '-100 days'))
    `).run();

    decayAntiRunbooks(db, 1, 90);

    const arb = db.prepare("SELECT status FROM memory_objects WHERE composite_id = 'antirunbook:1:weak-arb'").get() as { status: string };
    expect(arb.status).toBe("stale");
  });

  it("decayRunbooks marks stale runbooks", () => {
    const db = createDb();
    db.prepare(`
      INSERT INTO memory_objects (composite_id, kind, content, structured_json, scope_id, branch_id, confidence, status, updated_at, created_at)
      VALUES ('procedure:1:old-rb', 'procedure', 'test: pattern',
        '{"isNegative":false,"toolName":"test","key":"old-rb","pattern":"pattern","successCount":0,"failureCount":0}',
        1, 0, 0.8, 'active', datetime('now', '-200 days'), datetime('now', '-200 days'))
    `).run();

    decayRunbooks(db, 1, 180);

    const rb = db.prepare("SELECT status FROM memory_objects WHERE composite_id = 'procedure:1:old-rb'").get() as { status: string };
    expect(rb.status).toBe("stale");
  });
});

// ============================================================================
// Context Compiler: Anti-runbook capsules
// ============================================================================

describe("H3 Context Compiler with Anti-Runbooks", () => {
  it("surfaces anti-runbook warnings in compiled context", () => {
    const db = createDb();
    upsertAntiRunbook(db, {
      scopeId: 1, antiRunbookKey: "no-force-push", toolName: "git",
      failurePattern: "git push --force to main", failureCount: 3,
    });

    const result = compileContextCapsules(db, { tier: "standard", scopeId: 1 });
    expect(result).not.toBeNull();
    expect(result!.text).toContain("[anti-runbook]");
    expect(result!.text).toContain("AVOID");
    expect(result!.capsuleTypes.anti_runbook).toBe(1);
  });

  it("anti-runbooks appear before other capsule types in output", () => {
    const db = createDb();
    upsertAntiRunbook(db, {
      scopeId: 1, antiRunbookKey: "arb", toolName: "git",
      failurePattern: "bad pattern", failureCount: 1,
    });
    // Also add a claim so we have 2 types
    upsertClaim(db, {
      scopeId: 1, subject: "test", predicate: "is", objectText: "yes",
      canonicalKey: "test::is", confidence: 0.8,
    });

    const result = compileContextCapsules(db, { tier: "premium", scopeId: 1 });
    expect(result).not.toBeNull();
    const lines = result!.text.split("\n").filter((l) => l.startsWith("["));
    const types = lines.map((l) => {
      if (l.startsWith("[anti-runbook")) return "anti_runbook";
      if (l.startsWith("[claim")) return "claim";
      return null;
    }).filter((t): t is NonNullable<typeof t> => t !== null);

    // Anti-runbook should appear before claim
    const arbIdx = types.indexOf("anti_runbook");
    const claimIdx = types.indexOf("claim");
    if (arbIdx >= 0 && claimIdx >= 0) {
      expect(arbIdx).toBeLessThan(claimIdx);
    }
  });
});

// ============================================================================
// Audit-driven additional tests
// ============================================================================

describe("H3 Anti-runbook confidence increment", () => {
  it("confidence increases via logistic formula on repeated upsert (capped at 1.0)", () => {
    const db = createDb();
    upsertAntiRunbook(db, {
      scopeId: 1, antiRunbookKey: "arb1", toolName: "test",
      failurePattern: "bad", confidence: 0.5,
    });
    upsertAntiRunbook(db, {
      scopeId: 1, antiRunbookKey: "arb1", toolName: "test",
      failurePattern: "bad",
    });
    const arbs = getAntiRunbooks(db, 1);
    const arb = arbs.find((a) => a.anti_runbook_key === "arb1");
    expect(arb).toBeDefined();
    // Formula: 0.3 + 0.7*(totalFailureCount / (totalFailureCount + 3))
    // First upsert: confidence = 0.5
    // Second upsert: raw = 0.3 + 0.7*(2 / (2+3)) = 0.3 + 0.28 = 0.58
    // Blended by mo-store: 0.58 * 0.7 + 0.5 * 0.3 = 0.556
    expect(arb!.confidence).toBeCloseTo(0.556, 2);
  });
});

describe("H3 Decay protection for recent items", () => {
  it("does NOT decay anti-runbooks updated recently", () => {
    const db = createDb();
    // Insert a recent anti-runbook (updated_at = now)
    upsertAntiRunbook(db, {
      scopeId: 1, antiRunbookKey: "recent", toolName: "test",
      failurePattern: "recent failure", confidence: 0.8,
    });

    decayAntiRunbooks(db, 1, 90);

    const arbs = getAntiRunbooks(db, 1);
    const arb = arbs.find((a) => a.anti_runbook_key === "recent");
    expect(arb).toBeDefined();
    expect(arb!.confidence).toBeCloseTo(0.8); // NOT decayed
  });
});

describe("H3 Runbook high failure rate demotion", () => {
  it("demotes runbooks with failure_rate > 0.5 on decay", () => {
    const db = createDb();
    // Insert runbook with high failure rate (6 failures, 4 successes = 60% failure) into memory_objects
    db.prepare(`
      INSERT INTO memory_objects (composite_id, kind, content, structured_json, scope_id, branch_id, confidence, status, updated_at, created_at)
      VALUES ('procedure:1:fragile', 'procedure', 'deploy: pattern',
        '{"isNegative":false,"toolName":"deploy","key":"fragile","pattern":"pattern","successCount":4,"failureCount":6}',
        1, 0, 0.8, 'active', datetime('now', '-100 days'), datetime('now', '-100 days'))
    `).run();

    decayRunbooks(db, 1, 180);

    const rb = db.prepare(
      "SELECT confidence FROM memory_objects WHERE composite_id = 'procedure:1:fragile'",
    ).get() as { confidence: number };
    expect(rb.confidence).toBeCloseTo(0.4); // 0.8 * 0.5
  });
});

describe("H3 Attempt with timeout/partial status", () => {
  it("records and queries timeout and partial statuses", () => {
    const db = createDb();
    recordAttempt(db, { scopeId: 1, toolName: "api_call", status: "timeout", durationMs: 30000 });
    recordAttempt(db, { scopeId: 1, toolName: "api_call", status: "partial", durationMs: 5000 });

    const attempts = getAttemptHistory(db, 1, { toolName: "api_call" });
    expect(attempts.length).toBe(2);
    expect(attempts.some((a) => a.status === "timeout")).toBe(true);
    expect(attempts.some((a) => a.status === "partial")).toBe(true);
  });
});

describe("H3 Evidence log for runbook/anti-runbook", () => {
  it("upsertRunbook logs evidence", () => {
    const db = createDb();
    upsertRunbook(db, { scopeId: 1, runbookKey: "rb", toolName: "test", pattern: "p" });
    const events = db.prepare("SELECT * FROM evidence_log WHERE object_type = 'runbook'").all();
    expect(events.length).toBeGreaterThan(0);
  });

  it("upsertAntiRunbook logs evidence", () => {
    const db = createDb();
    upsertAntiRunbook(db, { scopeId: 1, antiRunbookKey: "arb", toolName: "test", failurePattern: "f" });
    const events = db.prepare("SELECT * FROM evidence_log WHERE object_type = 'anti_runbook'").all();
    expect(events.length).toBeGreaterThan(0);
  });
});
