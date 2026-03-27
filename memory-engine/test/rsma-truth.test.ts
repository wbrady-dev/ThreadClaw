/**
 * RSMA TruthEngine Tests — reconciliation validation.
 *
 * Tests all 6 supersession rules, conflict creation, 5-point safety guards,
 * provisional handling, and loop/invariant supersession.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { runGraphMigrations } from "../src/relations/schema.js";
import type { GraphDb } from "../src/relations/types.js";
import { reconcile } from "../src/ontology/truth.js";
import type { MemoryObject } from "../src/ontology/types.js";
import { buildCanonicalKey } from "../src/ontology/canonical.js";

let db: GraphDb;

function createDb(): GraphDb {
  const d = new DatabaseSync(":memory:");
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("PRAGMA foreign_keys = ON");
  return d as unknown as GraphDb;
}

const NOW = new Date().toISOString();

function makeClaim(overrides: Partial<MemoryObject> = {}): MemoryObject {
  return {
    id: `claim:test-${Math.random().toString(36).substring(2, 8)}`,
    kind: "claim", content: "postgres is_used_for: staging",
    structured: { subject: "postgres", predicate: "is_used_for", objectText: "staging" },
    canonical_key: "claim::postgres::is_used_for",
    provenance: { source_kind: "user_explicit", source_id: "msg-1", actor: "system", trust: 0.9 },
    confidence: 0.8, freshness: 1.0, provisional: false, status: "active",
    observed_at: NOW, scope_id: 1, influence_weight: "standard",
    created_at: NOW, updated_at: NOW, ...overrides,
  };
}

function makeDecision(overrides: Partial<MemoryObject> = {}): MemoryObject {
  return {
    id: `decision:test-${Math.random().toString(36).substring(2, 8)}`,
    kind: "decision", content: "staging database: Use Postgres",
    structured: { topic: "staging database", decisionText: "Use Postgres" },
    canonical_key: "decision::staging database",
    provenance: { source_kind: "user_explicit", source_id: "msg-1", actor: "system", trust: 0.9 },
    confidence: 0.9, freshness: 1.0, provisional: false, status: "active",
    observed_at: NOW, scope_id: 1, influence_weight: "high",
    created_at: NOW, updated_at: NOW, ...overrides,
  };
}

function seedClaimInDb(db: GraphDb, overrides: Record<string, unknown> = {}): number {
  const d = {
    scope_id: 1, branch_id: 0, subject: "postgres", predicate: "is_used_for",
    object_text: "staging", status: "active", confidence: 0.8,
    trust_score: 0.7, source_authority: 0.7, canonical_key: "claim::postgres::is_used_for",
    first_seen_at: NOW, last_seen_at: NOW, created_at: NOW, updated_at: NOW,
  };
  const v = { ...d, ...overrides };
  const compositeId = `claim:seed:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const content = `${v.subject} ${v.predicate}: ${v.object_text}`;
  const structuredJson = JSON.stringify({
    subject: v.subject, predicate: v.predicate,
    objectText: v.object_text, valueType: "text",
  });
  return Number(db.prepare(`
    INSERT INTO memory_objects (composite_id, kind, canonical_key, content, structured_json,
      scope_id, branch_id, status, confidence, trust_score, source_authority,
      first_observed_at, last_observed_at, created_at, updated_at)
    VALUES (?, 'claim', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(compositeId, v.canonical_key, content, structuredJson,
    v.scope_id, v.branch_id, v.status, v.confidence,
    v.trust_score, v.source_authority,
    v.first_seen_at, v.last_seen_at, v.created_at, v.updated_at,
  ).lastInsertRowid);
}

function seedDecisionInDb(db: GraphDb, overrides: Record<string, unknown> = {}): number {
  const d = { scope_id: 1, branch_id: 0, topic: "staging database", decision_text: "Use MySQL", status: "active", decided_at: NOW, created_at: NOW };
  const v = { ...d, ...overrides };
  const topic = String(v.topic).toLowerCase().trim().replace(/\s+/g, " ");
  const canonicalKey = `decision::${topic}`;
  const compositeId = `decision:seed:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const content = `${v.topic}: ${v.decision_text}`;
  const structuredJson = JSON.stringify({ topic: v.topic, decisionText: v.decision_text });
  return Number(db.prepare(`
    INSERT INTO memory_objects (composite_id, kind, canonical_key, content, structured_json,
      scope_id, branch_id, status, confidence, created_at, updated_at)
    VALUES (?, 'decision', ?, ?, ?, ?, ?, ?, 0.5, ?, ?)
  `).run(compositeId, canonicalKey, content, structuredJson,
    v.scope_id, v.branch_id, v.status, v.decided_at, v.created_at,
  ).lastInsertRowid);
}

function seedLoopInDb(db: GraphDb, overrides: Record<string, unknown> = {}): number {
  const d = { scope_id: 1, branch_id: 0, loop_type: "task", text: "Rotate the API key", status: "open", priority: 5, opened_at: NOW };
  const v = { ...d, ...overrides };
  const compositeId = `loop:seed:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const loopCanonicalKey = buildCanonicalKey("loop", String(v.text));
  const structuredJson = JSON.stringify({ loopType: v.loop_type, text: v.text, priority: v.priority });
  return Number(db.prepare(`
    INSERT INTO memory_objects (composite_id, kind, canonical_key, content, structured_json,
      scope_id, branch_id, status, confidence, created_at, updated_at)
    VALUES (?, 'loop', ?, ?, ?, ?, ?, 'active', 0.5, ?, ?)
  `).run(compositeId, loopCanonicalKey, v.text, structuredJson,
    v.scope_id, v.branch_id, v.opened_at, v.opened_at,
  ).lastInsertRowid);
}

function seedInvariantInDb(db: GraphDb, overrides: Record<string, unknown> = {}): number {
  const d = { scope_id: 1, invariant_key: "no_friday_deploys", category: "ops", description: "Never deploy on Fridays", severity: "critical", enforcement_mode: "warn", status: "active", created_at: NOW, updated_at: NOW };
  const v = { ...d, ...overrides };
  const compositeId = `invariant:seed:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const structuredJson = JSON.stringify({
    key: v.invariant_key, category: v.category, description: v.description,
    severity: v.severity, enforcementMode: v.enforcement_mode,
  });
  return Number(db.prepare(`
    INSERT INTO memory_objects (composite_id, kind, canonical_key, content, structured_json,
      scope_id, branch_id, status, confidence, created_at, updated_at)
    VALUES (?, 'invariant', ?, ?, ?, ?, 0, ?, 0.5, ?, ?)
  `).run(compositeId, `inv::${String(v.invariant_key).toLowerCase().trim()}`,
    v.description, structuredJson,
    v.scope_id, v.status, v.created_at, v.updated_at,
  ).lastInsertRowid);
}

beforeEach(() => { db = createDb(); runGraphMigrations(db); });

// ============================================================================
// No existing data — plain inserts
// ============================================================================

describe("RSMA Truth: no existing data", () => {
  it("inserts objects with no canonical key directly", () => {
    const result = reconcile(db, [makeClaim({ kind: "entity", canonical_key: undefined })]);
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].type).toBe("insert");
  });

  it("inserts when no DB match", () => {
    const result = reconcile(db, [makeClaim()]);
    expect(result.actions[0].type).toBe("insert");
  });

  it("inserts attempts directly (not dedup-eligible)", () => {
    const result = reconcile(db, [makeClaim({ kind: "attempt", canonical_key: undefined })]);
    expect(result.actions[0].type).toBe("insert");
  });

  it("handles empty candidate list", () => {
    const result = reconcile(db, []);
    expect(result.actions.length).toBe(0);
    expect(result.stats.totalCandidates).toBe(0);
  });
});

// ============================================================================
// Rule 1: Higher confidence supersedes
// ============================================================================

describe("RSMA Truth: Rule 1 — higher confidence", () => {
  it("supersedes existing claim", () => {
    seedClaimInDb(db, { confidence: 0.6 });
    const result = reconcile(db, [makeClaim({ confidence: 0.9 })]);
    const s = result.actions.find((a) => a.type === "supersede");
    expect(s).toBeDefined();
    expect((s as any).reason).toContain("higher confidence");
  });

  it("supersedes existing decision", () => {
    seedDecisionInDb(db);
    const result = reconcile(db, [makeDecision({ confidence: 0.95 })]);
    const s = result.actions.find((a) => a.type === "supersede");
    expect(s).toBeDefined();
  });
});

// ============================================================================
// Rule 2: Same confidence, newer wins
// ============================================================================

describe("RSMA Truth: Rule 2 — same confidence", () => {
  it("adds evidence with same confidence and same value", () => {
    seedClaimInDb(db, { confidence: 0.8 });
    const result = reconcile(db, [makeClaim({ confidence: 0.8 })]);
    // Same confidence + same value ("staging") → evidence, not supersede
    const e = result.actions.find((a) => a.type === "evidence");
    expect(e).toBeDefined();
    expect((e as any).reason).toContain("same value");
  });
});

// ============================================================================
// Rule 3: Lower confidence → evidence only
// ============================================================================

describe("RSMA Truth: Rule 3 — lower confidence", () => {
  it("adds as evidence", () => {
    seedClaimInDb(db, { confidence: 0.95 });
    const result = reconcile(db, [makeClaim({ confidence: 0.5 })]);
    const e = result.actions.find((a) => a.type === "evidence");
    expect(e).toBeDefined();
    expect((e as any).reason).toContain("lower confidence");
  });
});

// ============================================================================
// Rule 4: Contradiction → Conflict (INDEPENDENTLY of supersession)
// ============================================================================

describe("RSMA Truth: Rule 4 — conflict creation", () => {
  it("creates conflict when low-confidence candidate has different value", () => {
    seedClaimInDb(db, { confidence: 0.9, object_text: "MySQL" });
    const candidate = makeClaim({ confidence: 0.5, structured: { subject: "postgres", predicate: "is_used_for", objectText: "PostgreSQL" } });
    const result = reconcile(db, [candidate]);
    const conflict = result.actions.find((a) => a.type === "conflict");
    expect(conflict).toBeDefined();
    expect((conflict as any).conflictObject.kind).toBe("conflict");
    expect((conflict as any).conflictObject.status).toBe("needs_confirmation");
  });

  it("creates conflict EVEN when supersession happens (informational)", () => {
    seedClaimInDb(db, { confidence: 0.5, object_text: "MySQL" });
    const candidate = makeClaim({ confidence: 0.9, structured: { subject: "postgres", predicate: "is_used_for", objectText: "PostgreSQL" } });
    const result = reconcile(db, [candidate]);
    const supersede = result.actions.find((a) => a.type === "supersede");
    const conflict = result.actions.find((a) => a.type === "conflict");
    expect(supersede).toBeDefined();
    expect(conflict).toBeDefined();
    // Conflict status should be "active" (not "needs_confirmation") since supersession resolved it
    expect((conflict as any).conflictObject.status).toBe("active");
  });

  it("does NOT create conflict when values are the same", () => {
    seedClaimInDb(db, { confidence: 0.9, object_text: "staging" });
    const result = reconcile(db, [makeClaim({ confidence: 0.5 })]);
    const conflict = result.actions.find((a) => a.type === "conflict");
    expect(conflict).toBeUndefined();
  });

  it("does NOT create conflict when confidence is too low", () => {
    seedClaimInDb(db, { confidence: 0.9, object_text: "MySQL" });
    const candidate = makeClaim({ confidence: 0.1, structured: { subject: "postgres", predicate: "is_used_for", objectText: "PostgreSQL" } });
    const result = reconcile(db, [candidate]);
    const conflict = result.actions.find((a) => a.type === "conflict");
    expect(conflict).toBeUndefined();
  });
});

// ============================================================================
// Rule 5: Correction with 5-point guards
// ============================================================================

describe("RSMA Truth: Rule 5 — correction supersession", () => {
  it("supersedes with correction when all guards pass", () => {
    seedClaimInDb(db, { confidence: 0.7 });
    const candidate = makeClaim({ confidence: 0.6 });
    const result = reconcile(db, [candidate], { isCorrection: true, correctionSignal: "actually" });
    const s = result.actions.find((a) => a.type === "supersede");
    expect(s).toBeDefined();
    expect((s as any).reason).toContain("correction_supersession");
    // Correction bonus applied — but NOT to the original object (immutability)
    expect((s as any).newObject.confidence).toBeGreaterThan(0.6);
    // Original candidate is NOT mutated
    expect(candidate.confidence).toBe(0.6);
  });

  it("fails guard: different scope", () => {
    seedClaimInDb(db, { scope_id: 1 });
    const candidate = makeClaim({ scope_id: 2 });
    const result = reconcile(db, [candidate], { isCorrection: true });
    // Should NOT correct-supersede (falls through to standard rules which also won't match since scope mismatch means no DB match)
    const correctionSupersede = result.actions.find(
      (a) => a.type === "supersede" && (a as any).reason.includes("correction_supersession"),
    );
    expect(correctionSupersede).toBeUndefined();
  });

  it("fails guard: confidence below minimum", () => {
    seedClaimInDb(db, { confidence: 0.5 });
    const candidate = makeClaim({ confidence: 0.2 });
    const result = reconcile(db, [candidate], { isCorrection: true });
    const correctionSupersede = result.actions.find(
      (a) => a.type === "supersede" && (a as any).reason.includes("correction_supersession"),
    );
    expect(correctionSupersede).toBeUndefined();
  });
});

// ============================================================================
// Rule 6: Provisional doesn't supersede firm
// ============================================================================

describe("RSMA Truth: Rule 6 — provisional handling", () => {
  it("provisional adds evidence instead of superseding", () => {
    seedClaimInDb(db, { confidence: 0.8 });
    const candidate = makeClaim({ confidence: 0.9, provisional: true });
    const result = reconcile(db, [candidate]);
    const evidence = result.actions.find((a) => a.type === "evidence");
    expect(evidence).toBeDefined();
    expect((evidence as any).reason).toContain("provisional");
    expect(result.actions.find((a) => a.type === "supersede")).toBeUndefined();
  });
});

// ============================================================================
// Loop supersession
// ============================================================================

describe("RSMA Truth: loop supersession", () => {
  it("detects existing loop with same text via canonical key hash", () => {
    seedLoopInDb(db, { text: "Rotate the API key" });
    const candidate: MemoryObject = {
      ...makeClaim(),
      kind: "loop",
      content: "Rotate the API key",
      structured: { loopType: "task" },
      canonical_key: undefined, // will be computed
      confidence: 0.5, // match the seed's confidence so Rule 2 (same confidence) applies
    };
    // Compute canonical key (same as what reader would)
    candidate.canonical_key = buildCanonicalKey("loop", "Rotate the API key");
    expect(candidate.canonical_key).toBeDefined();

    const result = reconcile(db, [candidate]);
    // Same confidence + same value → evidence (no pointless supersession churn)
    const e = result.actions.find((a) => a.type === "evidence");
    expect(e).toBeDefined();
    expect((e as any).reason).toContain("same value");
  });

  it("inserts when no matching loop exists", () => {
    seedLoopInDb(db, { text: "Deploy to staging" });
    const candidate: MemoryObject = {
      ...makeClaim(),
      kind: "loop",
      content: "Completely different task",
      structured: { loopType: "task" },
      canonical_key: undefined,
    };
    // buildCanonicalKey imported at top
    candidate.canonical_key = buildCanonicalKey("loop", "Completely different task");

    const result = reconcile(db, [candidate]);
    expect(result.actions[0].type).toBe("insert");
  });
});

// ============================================================================
// Invariant supersession
// ============================================================================

describe("RSMA Truth: invariant supersession", () => {
  it("detects existing invariant with same key", () => {
    seedInvariantInDb(db, { invariant_key: "no_friday_deploys" });
    const candidate: MemoryObject = {
      ...makeClaim(),
      kind: "invariant",
      content: "[critical] Updated: never deploy on Fridays or weekends",
      structured: { key: "no_friday_deploys", severity: "critical" },
      canonical_key: "inv::no_friday_deploys",
      confidence: 0.95,
    };

    const result = reconcile(db, [candidate]);
    const s = result.actions.find((a) => a.type === "supersede");
    expect(s).toBeDefined();
  });

  it("inserts when no matching invariant exists", () => {
    const candidate: MemoryObject = {
      ...makeClaim(),
      kind: "invariant",
      content: "[warning] Always use HTTPS",
      structured: { key: "use_https", severity: "warning" },
      canonical_key: "inv::use_https",
    };

    const result = reconcile(db, [candidate]);
    expect(result.actions[0].type).toBe("insert");
  });
});

// ============================================================================
// Decision supersession
// ============================================================================

describe("RSMA Truth: decision supersession", () => {
  it("supersedes existing decision on same topic", () => {
    seedDecisionInDb(db, { topic: "staging database", decision_text: "Use MySQL" });
    const result = reconcile(db, [makeDecision()]);
    const s = result.actions.find((a) => a.type === "supersede");
    expect(s).toBeDefined();
  });

  it("creates conflict when decision changes value", () => {
    seedDecisionInDb(db, { topic: "staging database", decision_text: "Use MySQL" });
    const result = reconcile(db, [makeDecision({ structured: { topic: "staging database", decisionText: "Use Postgres" } })]);
    const conflict = result.actions.find((a) => a.type === "conflict");
    expect(conflict).toBeDefined();
  });
});

// ============================================================================
// Immutability
// ============================================================================

describe("RSMA Truth: immutability", () => {
  it("does NOT mutate input candidate during correction bonus", () => {
    seedClaimInDb(db, { confidence: 0.5 });
    const candidate = makeClaim({ confidence: 0.6 });
    const originalConfidence = candidate.confidence;
    reconcile(db, [candidate], { isCorrection: true, correctionSignal: "actually" });
    expect(candidate.confidence).toBe(originalConfidence);
  });
});

// ============================================================================
// Multiple candidates
// ============================================================================

describe("RSMA Truth: multiple candidates", () => {
  it("stats reflect action counts correctly", () => {
    seedClaimInDb(db);
    seedClaimInDb(db, { confidence: 0.95, canonical_key: "claim::mysql::status", subject: "mysql", predicate: "status", object_text: "deprecated" });
    const claim1 = makeClaim({ confidence: 0.9 }); // supersedes postgres claim
    const claim2 = makeClaim({ confidence: 0.5, canonical_key: "claim::mysql::status", structured: { subject: "mysql", predicate: "status", objectText: "active" } }); // evidence for mysql
    const entity = makeClaim({ kind: "entity", canonical_key: undefined });
    const result = reconcile(db, [claim1, claim2, entity]);
    expect(result.stats.totalCandidates).toBe(3);
    expect(result.stats.supersessions).toBe(1);
    expect(result.stats.evidence).toBeGreaterThanOrEqual(1);
    expect(result.stats.inserts).toBe(1);
  });

  it("reconciles each candidate independently", () => {
    seedClaimInDb(db);
    const claim = makeClaim({ confidence: 0.9 });
    const entity = makeClaim({ kind: "entity", canonical_key: undefined, content: "PostgreSQL" });
    const result = reconcile(db, [claim, entity]);
    expect(result.actions.length).toBe(2);
    expect(result.actions[0].type).toBe("supersede");
    expect(result.actions[1].type).toBe("insert");
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe("RSMA Truth: edge cases", () => {
  it("ignores superseded claims in DB", () => {
    seedClaimInDb(db, { status: "superseded" });
    const result = reconcile(db, [makeClaim({ confidence: 0.5 })]);
    expect(result.actions[0].type).toBe("insert");
  });

  it("conflict object has correct structure", () => {
    seedClaimInDb(db, { confidence: 0.9, object_text: "MySQL" });
    const candidate = makeClaim({ confidence: 0.5, structured: { subject: "postgres", predicate: "is_used_for", objectText: "PostgreSQL" } });
    const result = reconcile(db, [candidate]);
    const conflict = result.actions.find((a) => a.type === "conflict");
    if (conflict && conflict.type === "conflict") {
      expect(conflict.conflictObject.id).toMatch(/^conflict:/);
      expect(conflict.conflictObject.kind).toBe("conflict");
      expect(conflict.conflictObject.influence_weight).toBe("high");
      expect(conflict.conflictObject.provenance.source_kind).toBe("inference");
      expect(conflict.conflictObject.canonical_key).toMatch(/^conflict::/);
    }
  });

  it("handles multiple existing matches — picks highest confidence", () => {
    // Seed two active claims with same canonical key in same branch (data anomaly)
    seedClaimInDb(db, { confidence: 0.6, branch_id: 0 });
    seedClaimInDb(db, { confidence: 0.9, branch_id: 0, object_text: "production" });
    // Reconcile against the highest-confidence match (0.9)
    const candidate = makeClaim({ confidence: 0.85 });
    const result = reconcile(db, [candidate]);
    // Should compare against the 0.9 match, so 0.85 < 0.9 → evidence
    const evidence = result.actions.find((a) => a.type === "evidence");
    expect(evidence).toBeDefined();
  });

  it("matches decision despite DB having multiple internal spaces", () => {
    seedDecisionInDb(db, { topic: "staging   database" });
    const candidate = makeDecision({
      canonical_key: "decision::staging database", // normalized
      structured: { topic: "staging database", decisionText: "Use Postgres" },
    });
    const result = reconcile(db, [candidate]);
    const s = result.actions.find((a) => a.type === "supersede");
    expect(s).toBeDefined(); // must match despite whitespace difference
  });

  it("correction + provisional: provisional wins (skips supersession)", () => {
    seedClaimInDb(db, { confidence: 0.5 });
    const candidate = makeClaim({ confidence: 0.6, provisional: true });
    const result = reconcile(db, [candidate], { isCorrection: true, correctionSignal: "actually" });
    // Rule 6 fires first — provisional adds evidence, does NOT supersede
    expect(result.actions.find((a) => a.type === "supersede")).toBeUndefined();
    expect(result.actions.find((a) => a.type === "evidence")).toBeDefined();
  });

  it("deep copy: correction bonus does not share provenance reference", () => {
    seedClaimInDb(db, { confidence: 0.5 });
    const candidate = makeClaim({ confidence: 0.6 });
    const originalProvenance = candidate.provenance;
    const result = reconcile(db, [candidate], { isCorrection: true, correctionSignal: "actually" });
    const s = result.actions.find((a) => a.type === "supersede");
    expect(s).toBeDefined();
    // The action's newObject.provenance should be a different reference
    expect((s as any).newObject.provenance).not.toBe(originalProvenance);
  });
});
