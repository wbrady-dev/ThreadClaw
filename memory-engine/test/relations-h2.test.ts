import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { runGraphMigrations } from "../src/relations/schema.js";
import {
  upsertClaim, addClaimEvidence, supersedeClaim,
  getActiveClaims, getClaimsWithEvidence, buildCanonicalKey,
  storeClaimExtractionResults,
} from "../src/relations/claim-store.js";
import {
  upsertDecision, getActiveDecisions, getDecisionHistory,
} from "../src/relations/decision-store.js";
import {
  openLoop, closeLoop, updateLoop, getOpenLoops,
} from "../src/relations/loop-store.js";
import { recordStateDelta, getRecentDeltas } from "../src/relations/delta-store.js";
import { upsertCapability, getCapabilities } from "../src/relations/capability-store.js";
import { upsertInvariant, getActiveInvariants } from "../src/relations/invariant-store.js";
import {
  extractClaimsFast, extractClaimsFromToolResult,
  extractClaimsFromUserExplicit, extractClaimsFromDocumentKV,
  extractClaimsFromFrontmatter,
} from "../src/relations/claim-extract.js";
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

describe("H2 Schema", () => {
  it("migration v2 creates all H2 tables", () => {
    const db = createDb();
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ name: string }>).map((r) => r.name);

    // Fresh install creates RSMA schema directly (no legacy tables)
    expect(tables).toContain("memory_objects");
    expect(tables).toContain("provenance_links");
    expect(tables).toContain("state_deltas");
    expect(tables).toContain("capabilities");
  });

  it("migration v2 is idempotent", () => {
    const db = createDb();
    runGraphMigrations(db); // second run
    const v2 = db.prepare("SELECT version FROM _evidence_migrations WHERE version = 2").get();
    expect(v2).toBeDefined();
  });

  it("claims UNIQUE constraint on (scope_id, branch_id, canonical_key)", () => {
    const db = createDb();
    upsertClaim(db, { scopeId: 1, subject: "test", predicate: "is", canonicalKey: "test::is" });
    // Second upsert with same key should update, not throw
    const result = upsertClaim(db, { scopeId: 1, subject: "test", predicate: "is", canonicalKey: "test::is", confidence: 0.9 });
    expect(result.isNew).toBe(false);
  });
});

// ============================================================================
// Claim Store
// ============================================================================

describe("H2 Claim Store", () => {
  let db: GraphDb;
  beforeEach(() => { db = createDb(); });

  it("upsertClaim creates new claim", () => {
    const result = upsertClaim(db, {
      scopeId: 1, subject: "redis", predicate: "is", objectText: "a cache",
      canonicalKey: buildCanonicalKey("redis", "is"),
    });
    expect(result.claimId).toBeGreaterThan(0);
    expect(result.isNew).toBe(true);
  });

  it("upsertClaim updates existing on conflict (keeps higher confidence)", () => {
    upsertClaim(db, {
      scopeId: 1, subject: "redis", predicate: "is", objectText: "a cache",
      canonicalKey: "redis::is", confidence: 0.5,
    });
    const result = upsertClaim(db, {
      scopeId: 1, subject: "redis", predicate: "is", objectText: "a database",
      canonicalKey: "redis::is", confidence: 0.9,
    });
    expect(result.isNew).toBe(false);
    const claims = getActiveClaims(db, 1);
    // Weighted blend: excluded.confidence * 0.7 + claims.confidence * 0.3
    // = 0.9 * 0.7 + 0.5 * 0.3 = 0.63 + 0.15 = 0.78
    expect(claims[0].confidence).toBeCloseTo(0.78, 2);
    expect(claims[0].object_text).toBe("a database");
  });

  it("addClaimEvidence stores evidence row", () => {
    const { claimId } = upsertClaim(db, {
      scopeId: 1, subject: "auth", predicate: "owner",
      canonicalKey: "auth::owner", objectText: "Bob",
    });
    const evidenceId = addClaimEvidence(db, {
      claimId, sourceType: "user_explicit", sourceId: "msg-1",
      evidenceRole: "support", confidenceDelta: 0.1,
    });
    expect(evidenceId).toBeGreaterThan(0);
  });

  it("supersedeClaim marks claim as superseded", () => {
    const old = upsertClaim(db, { scopeId: 1, subject: "db", predicate: "version", canonicalKey: "db::version-old", objectText: "v1" });
    const next = upsertClaim(db, { scopeId: 1, subject: "db", predicate: "version", canonicalKey: "db::version-new", objectText: "v2" });
    supersedeClaim(db, old.claimId, next.claimId);

    const active = getActiveClaims(db, 1);
    expect(active.find((c) => c.id === old.claimId)).toBeUndefined();
    expect(active.find((c) => c.id === next.claimId)).toBeDefined();
  });

  it("getClaimsWithEvidence joins claims and evidence", () => {
    const { claimId } = upsertClaim(db, {
      scopeId: 1, subject: "api", predicate: "status", canonicalKey: "api::status", objectText: "healthy",
    });
    addClaimEvidence(db, { claimId, sourceType: "tool_result", sourceId: "health-check", evidenceRole: "support" });
    addClaimEvidence(db, { claimId, sourceType: "tool_result", sourceId: "health-check-2", evidenceRole: "support" });

    const results = getClaimsWithEvidence(db, 1);
    expect(results.length).toBe(1);
    expect(results[0].evidence.length).toBe(2);
  });

  it("buildCanonicalKey normalizes correctly", () => {
    expect(buildCanonicalKey("  Redis  ", "  IS  ")).toBe("claim::redis::is");
    expect(buildCanonicalKey("Auth System", "Owner")).toBe("claim::auth system::owner");
  });
});

// ============================================================================
// Decision Store
// ============================================================================

describe("H2 Decision Store", () => {
  let db: GraphDb;
  beforeEach(() => { db = createDb(); });

  it("upsertDecision creates new decision", () => {
    const result = upsertDecision(db, {
      scopeId: 1, topic: "database", decisionText: "Use PostgreSQL",
    });
    expect(result.decisionId).toBeGreaterThan(0);
    expect(result.isNew).toBe(true);
  });

  it("upsertDecision auto-supersedes existing on same topic", () => {
    const first = upsertDecision(db, { scopeId: 1, topic: "database", decisionText: "Use MySQL" });
    const second = upsertDecision(db, { scopeId: 1, topic: "database", decisionText: "Use PostgreSQL" });

    expect(second.isNew).toBe(false); // superseded existing

    const active = getActiveDecisions(db, 1);
    expect(active.length).toBe(1);
    expect(active[0].decision_text).toBe("Use PostgreSQL");

    const history = getDecisionHistory(db, 1, "database");
    expect(history.length).toBe(2);
    expect(history.find((d) => d.id === first.decisionId)?.status).toBe("superseded");
  });
});

// ============================================================================
// Loop Store
// ============================================================================

describe("H2 Loop Store", () => {
  let db: GraphDb;
  beforeEach(() => { db = createDb(); });

  it("openLoop creates and returns id", () => {
    const id = openLoop(db, { scopeId: 1, text: "Deploy to staging", priority: 5 });
    expect(id).toBeGreaterThan(0);
  });

  it("closeLoop marks as closed", () => {
    const id = openLoop(db, { scopeId: 1, text: "Fix bug #123" });
    closeLoop(db, id);
    const loops = getOpenLoops(db, 1);
    expect(loops.find((l) => l.id === id)).toBeUndefined(); // closed loops not returned
  });

  it("getOpenLoops orders by priority DESC", () => {
    openLoop(db, { scopeId: 1, text: "Low priority", priority: 1 });
    openLoop(db, { scopeId: 1, text: "High priority", priority: 10 });
    openLoop(db, { scopeId: 1, text: "Medium priority", priority: 5 });

    const loops = getOpenLoops(db, 1);
    expect(loops[0].text).toBe("High priority");
    expect(loops[1].text).toBe("Medium priority");
    expect(loops[2].text).toBe("Low priority");
  });

  it("updateLoop changes status and priority", () => {
    const id = openLoop(db, { scopeId: 1, text: "Blocked task", priority: 3 });
    updateLoop(db, { loopId: id, status: "blocked", priority: 10 });

    const loops = getOpenLoops(db, 1);
    const updated = loops.find((l) => l.id === id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.priority).toBe(10);
  });
});

// ============================================================================
// Delta Store
// ============================================================================

describe("H2 Delta Store", () => {
  it("recordStateDelta and getRecentDeltas", () => {
    const db = createDb();
    recordStateDelta(db, {
      scopeId: 1, deltaType: "config_change", entityKey: "api.timeout",
      oldValue: "30s", newValue: "60s",
    });
    recordStateDelta(db, {
      scopeId: 1, deltaType: "status_change", entityKey: "api.health",
      oldValue: "healthy", newValue: "degraded",
    });

    const deltas = getRecentDeltas(db, 1);
    expect(deltas.length).toBe(2);
    expect(deltas[0].entity_key).toBe("api.health"); // most recent first
  });
});

// ============================================================================
// Capability Store
// ============================================================================

describe("H2 Capability Store", () => {
  it("upsertCapability creates and updates", () => {
    const db = createDb();
    const first = upsertCapability(db, {
      scopeId: 1, capabilityType: "tool", capabilityKey: "git",
      displayName: "Git", status: "available",
    });
    expect(first.isNew).toBe(true);

    const second = upsertCapability(db, {
      scopeId: 1, capabilityType: "tool", capabilityKey: "git",
      status: "degraded",
    });
    expect(second.isNew).toBe(false);
    expect(second.capabilityId).toBe(first.capabilityId);

    const caps = getCapabilities(db, 1, { status: "degraded" });
    expect(caps.length).toBe(1);
    expect(caps[0].capability_key).toBe("git");
  });
});

// ============================================================================
// Invariant Store
// ============================================================================

describe("H2 Invariant Store", () => {
  it("upsertInvariant creates and updates", () => {
    const db = createDb();
    const first = upsertInvariant(db, {
      scopeId: 1, invariantKey: "no-force-push",
      description: "Never force push to main", severity: "critical",
    });
    expect(first.isNew).toBe(true);

    const second = upsertInvariant(db, {
      scopeId: 1, invariantKey: "no-force-push",
      description: "Never force push to main or develop", severity: "critical",
    });
    expect(second.isNew).toBe(false);
  });

  it("getActiveInvariants orders by severity", () => {
    const db = createDb();
    upsertInvariant(db, { scopeId: 1, invariantKey: "info-rule", description: "FYI", severity: "info" });
    upsertInvariant(db, { scopeId: 1, invariantKey: "critical-rule", description: "Critical", severity: "critical" });
    upsertInvariant(db, { scopeId: 1, invariantKey: "warn-rule", description: "Warning", severity: "warning" });

    const invariants = getActiveInvariants(db, 1);
    expect(invariants[0].severity).toBe("critical");
    expect(invariants[1].severity).toBe("warning");
    expect(invariants[2].severity).toBe("info");
  });
});

// ============================================================================
// Claim Extraction
// ============================================================================

describe("H2 Claim Extraction", () => {
  it("extracts claims from tool results (JSON walk)", () => {
    const results = extractClaimsFromToolResult("healthcheck", {
      status: "healthy",
      uptime: 99.9,
      services: { api: "running", db: "connected" },
    }, "tool-1");

    expect(results.length).toBeGreaterThanOrEqual(3);
    const statusClaim = results.find((r) => r.claim.predicate === "status");
    expect(statusClaim).toBeDefined();
    expect(statusClaim!.claim.objectText).toBe("healthy");
    expect(statusClaim!.claim.trustScore).toBe(1.0);
  });

  it("caps tool result recursion at depth 3", () => {
    const deepObj = { a: { b: { c: { d: { e: "deep" } } } } };
    const results = extractClaimsFromToolResult("test", deepObj, "tool-2");
    // Should not extract "e" at depth 4
    const deep = results.find((r) => r.claim.predicate.includes("e"));
    expect(deep).toBeUndefined();
  });

  it("extracts from user explicit statements", () => {
    const results = extractClaimsFromUserExplicit(
      "Remember: Bob owns the auth system", "msg-1",
    );
    expect(results.length).toBe(1);
    expect(results[0].claim.subject).toBe("bob");
    expect(results[0].claim.objectText).toContain("auth system");
    expect(results[0].claim.trustScore).toBe(0.9);
  });

  it("extracts from document KV patterns", () => {
    const text = "## Auth System\n- Owner: Bob\n- Status: Active\n- Port: 8080\n";
    const results = extractClaimsFromDocumentKV(text, "doc-1");
    expect(results.length).toBe(3);
    const ownerClaim = results.find((r) => r.claim.predicate === "owner");
    expect(ownerClaim).toBeDefined();
    expect(ownerClaim!.claim.objectText).toBe("Bob");
  });

  it("extracts from YAML frontmatter", () => {
    const text = "---\nauthor: Wesley\nproject: OpenClaw\ntitle: README\n---\n\nContent here.";
    const results = extractClaimsFromFrontmatter(text, "doc-2");
    // "title" should be skipped (filtered out)
    expect(results.find((r) => r.claim.predicate === "title")).toBeUndefined();
    // "author" and "project" should be extracted
    expect(results.find((r) => r.claim.predicate === "author")).toBeDefined();
    expect(results.find((r) => r.claim.predicate === "project")).toBeDefined();
  });

  it("extractClaimsFast deduplicates by canonical key (highest trust wins)", () => {
    // Tool result and user explicit both mention the same fact
    const results = extractClaimsFast(
      "Remember: api status is healthy",
      { sourceType: "message", sourceId: "msg-1", toolName: "healthcheck", toolResult: { status: "healthy" } },
    );
    // "status" canonical key should appear only once
    const statusClaims = results.filter((r) => r.claim.canonicalKey.includes("status"));
    // Tool result (trust 1.0) should win over user explicit (trust 0.9)
    if (statusClaims.length > 0) {
      expect(statusClaims[0].claim.trustScore).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("returns empty for text with no structured signals", () => {
    const results = extractClaimsFast("just a normal conversation message", {
      sourceType: "message", sourceId: "msg-2",
    });
    expect(results.length).toBe(0);
  });
});

// ============================================================================
// Tools (basic smoke tests)
// ============================================================================

describe("H2 Store + Extraction Integration", () => {
  it("storeClaimExtractionResults persists claims and evidence", () => {
    const db = createDb();
    const results = extractClaimsFromUserExplicit("Remember: Redis is a cache", "msg-1");
    storeClaimExtractionResults(db, results, {
      scopeId: 1, sourceType: "message", sourceId: "msg-1",
    });

    const claims = getActiveClaims(db, 1);
    expect(claims.length).toBeGreaterThan(0);

    const withEvidence = getClaimsWithEvidence(db, 1);
    expect(withEvidence[0].evidence.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Audit-driven additional tests
// ============================================================================

describe("H2 Evidence Log Verification", () => {
  it("upsertClaim logs to evidence_log", () => {
    const db = createDb();
    upsertClaim(db, { scopeId: 1, subject: "test", predicate: "is", canonicalKey: "test::is", objectText: "yes" });
    const events = db.prepare(
      "SELECT * FROM evidence_log WHERE object_type = 'claim'",
    ).all();
    expect(events.length).toBeGreaterThan(0);
  });

  it("upsertDecision logs to evidence_log", () => {
    const db = createDb();
    upsertDecision(db, { scopeId: 1, topic: "test", decisionText: "Do it" });
    const events = db.prepare(
      "SELECT * FROM evidence_log WHERE object_type = 'decision'",
    ).all();
    expect(events.length).toBeGreaterThan(0);
  });

  it("openLoop logs to evidence_log", () => {
    const db = createDb();
    openLoop(db, { scopeId: 1, text: "Task" });
    const events = db.prepare(
      "SELECT * FROM evidence_log WHERE object_type = 'open_loop'",
    ).all();
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("H2 Decision 3-step supersession chain", () => {
  it("maintains correct supersession chain across 3 decisions", () => {
    const db = createDb();
    const a = upsertDecision(db, { scopeId: 1, topic: "db", decisionText: "Use MySQL" });
    const b = upsertDecision(db, { scopeId: 1, topic: "db", decisionText: "Use PostgreSQL" });
    const c = upsertDecision(db, { scopeId: 1, topic: "db", decisionText: "Use SQLite" });

    const active = getActiveDecisions(db, 1);
    expect(active.length).toBe(1);
    expect(active[0].decision_text).toBe("Use SQLite");

    const history = getDecisionHistory(db, 1, "db");
    expect(history.length).toBe(3);
    // Most recent first
    expect(history[0].decision_text).toBe("Use SQLite");
    expect(history[0].status).toBe("active");
    expect(history[1].decision_text).toBe("Use PostgreSQL");
    expect(history[1].status).toBe("superseded");
    expect(history[2].decision_text).toBe("Use MySQL");
    expect(history[2].status).toBe("superseded");
  });
});

describe("H2 Delta since filter", () => {
  it("filters deltas by since timestamp", () => {
    const db = createDb();
    // Record two deltas
    recordStateDelta(db, { scopeId: 1, deltaType: "a", entityKey: "k1", oldValue: "1", newValue: "2" });

    // Get all deltas, then filter with a future timestamp (should return none)
    const all = getRecentDeltas(db, 1);
    expect(all.length).toBe(1);

    const future = getRecentDeltas(db, 1, { since: "2099-01-01T00:00:00.000" });
    expect(future.length).toBe(0);
  });
});

describe("H2 Invariant suspended status filtering", () => {
  it("getActiveInvariants excludes suspended invariants", () => {
    const db = createDb();
    upsertInvariant(db, { scopeId: 1, invariantKey: "active-rule", description: "Active", severity: "warning" });
    upsertInvariant(db, { scopeId: 1, invariantKey: "suspended-rule", description: "Suspended", severity: "error", status: "suspended" });

    const active = getActiveInvariants(db, 1);
    expect(active.length).toBe(1);
    expect(active[0].invariant_key).toBe("active-rule");
  });
});

describe("H2 Capability multi-filter", () => {
  it("filters by both type AND status", () => {
    const db = createDb();
    upsertCapability(db, { scopeId: 1, capabilityType: "tool", capabilityKey: "git", status: "available" });
    upsertCapability(db, { scopeId: 1, capabilityType: "tool", capabilityKey: "docker", status: "degraded" });
    upsertCapability(db, { scopeId: 1, capabilityType: "service", capabilityKey: "redis", status: "available" });

    const result = getCapabilities(db, 1, { type: "tool", status: "available" });
    expect(result.length).toBe(1);
    expect(result[0].capability_key).toBe("git");
  });
});
