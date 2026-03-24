/**
 * RSMA MemoryReader Tests — unified read layer validation.
 *
 * Tests that the reader correctly normalizes rows from graph.db
 * into MemoryObjects and ranks them by relevance-to-action.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { runGraphMigrations } from "../src/relations/schema.js";
import type { GraphDb } from "../src/relations/types.js";
import {
  readMemoryObjects,
  readMemoryObjectById,
  countMemoryObjects,
} from "../src/ontology/reader.js";
import {
  insertProvenanceLink,
  getProvenanceLinksForSubject,
} from "../src/ontology/projector.js";
import { computeRelevance, TASK_MODE_WEIGHTS } from "../src/ontology/types.js";

let db: GraphDb;

function createDb(): GraphDb {
  const d = new DatabaseSync(":memory:");
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("PRAGMA foreign_keys = ON");
  return d as unknown as GraphDb;
}

function seedClaim(db: GraphDb, overrides: Record<string, unknown> = {}): number {
  const defaults = {
    scope_id: 1, branch_id: 0, subject: "postgres", predicate: "is_used_for",
    object_text: "staging", status: "active", confidence: 0.8,
    trust_score: 0.7, source_authority: 0.7, canonical_key: "claim::postgres::is_used_for",
    first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const vals = { ...defaults, ...overrides };
  const compositeId = `claim:seed:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const content = `${vals.subject} ${vals.predicate}: ${vals.object_text}`;
  const structuredJson = JSON.stringify({
    subject: vals.subject, predicate: vals.predicate,
    objectText: vals.object_text, valueType: "text",
  });
  const result = db.prepare(`
    INSERT INTO memory_objects (composite_id, kind, canonical_key, content, structured_json,
      scope_id, branch_id, status, confidence, trust_score, source_authority,
      first_observed_at, last_observed_at, created_at, updated_at)
    VALUES (?, 'claim', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(compositeId, vals.canonical_key, content, structuredJson,
    vals.scope_id, vals.branch_id, vals.status, vals.confidence,
    vals.trust_score, vals.source_authority,
    vals.first_seen_at, vals.last_seen_at, vals.created_at, vals.updated_at,
  );
  return Number(result.lastInsertRowid);
}

function seedDecision(db: GraphDb, overrides: Record<string, unknown> = {}): number {
  const defaults = {
    scope_id: 1, branch_id: 0, topic: "staging database",
    decision_text: "Use Postgres", status: "active",
    decided_at: new Date().toISOString(), created_at: new Date().toISOString(),
  };
  const vals = { ...defaults, ...overrides };
  const compositeId = `decision:seed:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const content = `${vals.topic}: ${vals.decision_text}`;
  const structuredJson = JSON.stringify({ topic: vals.topic, decisionText: vals.decision_text });
  const result = db.prepare(`
    INSERT INTO memory_objects (composite_id, kind, canonical_key, content, structured_json,
      scope_id, branch_id, status, confidence, influence_weight, created_at, updated_at)
    VALUES (?, 'decision', ?, ?, ?, ?, ?, ?, 0.5, 'high', ?, ?)
  `).run(compositeId, `decision::${String(vals.topic).toLowerCase().trim()}`,
    content, structuredJson,
    vals.scope_id, vals.branch_id, vals.status, vals.decided_at, vals.created_at,
  );
  return Number(result.lastInsertRowid);
}

function seedLoop(db: GraphDb, overrides: Record<string, unknown> = {}): number {
  const defaults = {
    scope_id: 1, branch_id: 0, loop_type: "task", text: "Rotate API key",
    status: "open", priority: 5, opened_at: new Date().toISOString(),
  };
  const vals = { ...defaults, ...overrides };
  const compositeId = `loop:seed:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const structuredJson = JSON.stringify({ loopType: vals.loop_type, text: vals.text, priority: vals.priority });
  const result = db.prepare(`
    INSERT INTO memory_objects (composite_id, kind, content, structured_json,
      scope_id, branch_id, status, confidence, created_at, updated_at)
    VALUES (?, 'loop', ?, ?, ?, ?, 'active', 0.5, ?, ?)
  `).run(compositeId, vals.text, structuredJson,
    vals.scope_id, vals.branch_id, vals.opened_at, vals.opened_at,
  );
  return Number(result.lastInsertRowid);
}

function seedAttempt(db: GraphDb, overrides: Record<string, unknown> = {}): number {
  const defaults = {
    scope_id: 1, branch_id: 0, tool_name: "git_push", status: "success",
    created_at: new Date().toISOString(),
  };
  const vals = { ...defaults, ...overrides };
  const compositeId = `attempt:seed:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const structuredJson = JSON.stringify({ toolName: vals.tool_name, status: vals.status });
  const result = db.prepare(`
    INSERT INTO memory_objects (composite_id, kind, content, structured_json,
      scope_id, branch_id, status, confidence, created_at, updated_at)
    VALUES (?, 'attempt', ?, ?, ?, ?, 'active', 1.0, ?, ?)
  `).run(compositeId, `${vals.tool_name}: ${vals.status}`, structuredJson,
    vals.scope_id, vals.branch_id, vals.created_at, vals.created_at,
  );
  return Number(result.lastInsertRowid);
}

function seedEntity(db: GraphDb, overrides: Record<string, unknown> = {}): number {
  const defaults = {
    name: "postgres", display_name: "PostgreSQL", entity_type: "technology",
    mention_count: 5, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
  };
  const vals = { ...defaults, ...overrides };
  const compositeId = `entity:${String(vals.name).toLowerCase()}`;
  const structuredJson = JSON.stringify({
    name: String(vals.name).toLowerCase(), displayName: vals.display_name,
    entityType: vals.entity_type, mentionCount: vals.mention_count,
  });
  const result = db.prepare(`
    INSERT INTO memory_objects (composite_id, kind, canonical_key, content, structured_json,
      scope_id, branch_id, status, confidence, first_observed_at, last_observed_at, created_at, updated_at)
    VALUES (?, 'entity', ?, ?, ?, 1, 0, 'active', 0.5, ?, ?, ?, ?)
  `).run(compositeId, `entity::${String(vals.name).toLowerCase()}`,
    vals.display_name, structuredJson,
    vals.first_seen_at, vals.last_seen_at, vals.first_seen_at, vals.last_seen_at,
  );
  return Number(result.lastInsertRowid);
}

function seedRunbook(db: GraphDb, overrides: Record<string, unknown> = {}): number {
  const defaults = {
    scope_id: 1, runbook_key: "retry_on_fail", tool_name: "git_push",
    pattern: "Retry with exponential backoff", description: "Works for transient failures",
    success_count: 5, failure_count: 1, confidence: 0.8, status: "active",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const vals = { ...defaults, ...overrides };
  const compositeId = `procedure:${vals.scope_id}:${vals.runbook_key}`;
  const structuredJson = JSON.stringify({
    isNegative: false, toolName: vals.tool_name, key: vals.runbook_key,
    pattern: vals.pattern, description: vals.description,
    successCount: vals.success_count, failureCount: vals.failure_count,
  });
  const result = db.prepare(`
    INSERT INTO memory_objects (composite_id, kind, canonical_key, content, structured_json,
      scope_id, branch_id, status, confidence, influence_weight, created_at, updated_at)
    VALUES (?, 'procedure', ?, ?, ?, ?, 0, ?, ?, 'standard', ?, ?)
  `).run(compositeId, `proc::${String(vals.tool_name).toLowerCase()}::${String(vals.runbook_key).toLowerCase()}`,
    vals.description ?? `${vals.tool_name}: ${vals.pattern}`, structuredJson,
    vals.scope_id, vals.status, vals.confidence, vals.created_at, vals.updated_at,
  );
  return Number(result.lastInsertRowid);
}

function seedAntiRunbook(db: GraphDb, overrides: Record<string, unknown> = {}): number {
  const defaults = {
    scope_id: 1, anti_runbook_key: "force_push_bad", tool_name: "git_push",
    failure_pattern: "Force push to main causes data loss", description: "Never force push to main",
    failure_count: 3, confidence: 0.9, status: "active",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const vals = { ...defaults, ...overrides };
  const compositeId = `antirunbook:${vals.scope_id}:${vals.anti_runbook_key}`;
  const structuredJson = JSON.stringify({
    isNegative: true, toolName: vals.tool_name, key: vals.anti_runbook_key,
    failurePattern: vals.failure_pattern, description: vals.description,
    failureCount: vals.failure_count,
  });
  const result = db.prepare(`
    INSERT INTO memory_objects (composite_id, kind, canonical_key, content, structured_json,
      scope_id, branch_id, status, confidence, influence_weight, created_at, updated_at)
    VALUES (?, 'procedure', ?, ?, ?, ?, 0, ?, ?, 'standard', ?, ?)
  `).run(compositeId, `proc::${String(vals.tool_name).toLowerCase()}::${String(vals.anti_runbook_key).toLowerCase()}`,
    vals.description ?? `${vals.tool_name}: ${vals.failure_pattern}`, structuredJson,
    vals.scope_id, vals.status, vals.confidence, vals.created_at, vals.updated_at,
  );
  return Number(result.lastInsertRowid);
}

function seedInvariant(db: GraphDb, overrides: Record<string, unknown> = {}): number {
  const defaults = {
    scope_id: 1, invariant_key: "no_friday_deploys", category: "operations",
    description: "Never deploy on Fridays", severity: "critical",
    enforcement_mode: "warn", status: "active",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const vals = { ...defaults, ...overrides };
  const compositeId = `invariant:${vals.scope_id}:${vals.invariant_key}`;
  const structuredJson = JSON.stringify({
    key: vals.invariant_key, category: vals.category, description: vals.description,
    severity: vals.severity, enforcementMode: vals.enforcement_mode,
  });
  const result = db.prepare(`
    INSERT INTO memory_objects (composite_id, kind, canonical_key, content, structured_json,
      scope_id, branch_id, status, confidence, created_at, updated_at)
    VALUES (?, 'invariant', ?, ?, ?, ?, 0, ?, 0.5, ?, ?)
  `).run(compositeId, `inv::${String(vals.invariant_key).toLowerCase()}`,
    vals.description, structuredJson,
    vals.scope_id, vals.status, vals.created_at, vals.updated_at,
  );
  return Number(result.lastInsertRowid);
}

beforeEach(() => {
  db = createDb();
  runGraphMigrations(db);
});

// ============================================================================
// readMemoryObjects — basic queries
// ============================================================================

describe("RSMA Reader: readMemoryObjects", () => {
  it("returns claims as MemoryObjects", () => {
    seedClaim(db);
    const results = readMemoryObjects(db, { kinds: ["claim"] });
    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("claim");
    expect(results[0].id).toMatch(/^claim:/);
    expect(results[0].content).toContain("postgres");
    expect(results[0].confidence).toBe(0.8);
    expect(results[0].status).toBe("active");
  });

  it("returns decisions as MemoryObjects", () => {
    seedDecision(db);
    const results = readMemoryObjects(db, { kinds: ["decision"] });
    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("decision");
    expect(results[0].content).toContain("Postgres");
    expect(results[0].influence_weight).toBe("high");
  });

  it("returns entities as MemoryObjects", () => {
    seedEntity(db);
    const results = readMemoryObjects(db, { kinds: ["entity"] });
    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("entity");
    expect(results[0].content).toBe("PostgreSQL");
    expect(results[0].canonical_key).toBe("entity::postgres");
  });

  it("returns loops as MemoryObjects", () => {
    seedLoop(db);
    const results = readMemoryObjects(db, { kinds: ["loop"] });
    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("loop");
    expect(results[0].content).toContain("API key");
  });

  it("returns attempts as MemoryObjects", () => {
    seedAttempt(db);
    const results = readMemoryObjects(db, { kinds: ["attempt"] });
    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("attempt");
    expect(results[0].confidence).toBe(1.0);
  });

  it("returns all kinds when no filter specified", () => {
    seedClaim(db);
    seedDecision(db);
    seedEntity(db);
    seedLoop(db);
    seedAttempt(db);
    const results = readMemoryObjects(db);
    expect(results.length).toBe(5);
    const kinds = results.map((r) => r.kind);
    expect(kinds).toContain("claim");
    expect(kinds).toContain("decision");
    expect(kinds).toContain("entity");
    expect(kinds).toContain("loop");
    expect(kinds).toContain("attempt");
  });

  it("respects status filter", () => {
    seedClaim(db, { status: "active" });
    seedClaim(db, { status: "superseded", canonical_key: "claim::mysql::is_used_for" });
    const active = readMemoryObjects(db, { kinds: ["claim"], statuses: ["active"] });
    expect(active.length).toBe(1);
    const all = readMemoryObjects(db, { kinds: ["claim"], statuses: ["active", "superseded"] });
    expect(all.length).toBe(2);
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      seedClaim(db, { canonical_key: `claim::item${i}::count` });
    }
    const results = readMemoryObjects(db, { kinds: ["claim"], limit: 3 });
    expect(results.length).toBe(3);
  });

  it("filters by keyword", () => {
    seedClaim(db, { object_text: "staging environment" });
    seedClaim(db, { object_text: "production environment", canonical_key: "claim::prod::env" });
    const results = readMemoryObjects(db, { kinds: ["claim"], keyword: "staging" });
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("staging");
  });

  it("handles empty database gracefully", () => {
    const results = readMemoryObjects(db);
    expect(results.length).toBe(0);
  });
});

// ============================================================================
// Ranking
// ============================================================================

describe("RSMA Reader: relevance ranking", () => {
  it("ranks higher-trust claims above lower", () => {
    seedClaim(db, { confidence: 0.9, trust_score: 0.9, canonical_key: "claim::high::conf" });
    seedClaim(db, { confidence: 0.3, trust_score: 0.3, canonical_key: "claim::low::conf" });
    const results = readMemoryObjects(db, { kinds: ["claim"] });
    expect(results[0].confidence).toBeGreaterThan(results[1].confidence);
  });

  it("decisions rank above claims in planning mode (higher influence)", () => {
    seedClaim(db);
    seedDecision(db);
    const results = readMemoryObjects(db, { taskMode: "planning" });
    // Decision has influence_weight='high', claim has 'standard'
    // Planning mode: influence weight = 0.25
    const decisionIdx = results.findIndex((r) => r.kind === "decision");
    const claimIdx = results.findIndex((r) => r.kind === "claim");
    expect(decisionIdx).toBeLessThan(claimIdx);
  });

  it("superseded objects are excluded with default status filter", () => {
    seedClaim(db, { status: "superseded", canonical_key: "claim::old::thing" });
    seedClaim(db, { status: "active", canonical_key: "claim::new::thing" });
    const results = readMemoryObjects(db);
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("active");
  });
});

// ============================================================================
// readMemoryObjectById
// ============================================================================

describe("RSMA Reader: readMemoryObjectById", () => {
  it("finds a claim by composite ID", () => {
    const claimId = seedClaim(db);
    const row = db.prepare("SELECT composite_id FROM memory_objects WHERE id = ?").get(claimId) as { composite_id: string };
    const obj = readMemoryObjectById(db, row.composite_id);
    expect(obj).toBeDefined();
    expect(obj!.kind).toBe("claim");
  });

  it("finds a decision by composite ID", () => {
    const decisionId = seedDecision(db);
    const row = db.prepare("SELECT composite_id FROM memory_objects WHERE id = ?").get(decisionId) as { composite_id: string };
    const obj = readMemoryObjectById(db, row.composite_id);
    expect(obj).toBeDefined();
    expect(obj!.kind).toBe("decision");
  });

  it("returns undefined for non-existent ID", () => {
    expect(readMemoryObjectById(db, "claim:99999")).toBeUndefined();
  });

  it("returns undefined for invalid composite ID", () => {
    expect(readMemoryObjectById(db, "invalid")).toBeUndefined();
  });

  it("returns undefined for unknown kind", () => {
    expect(readMemoryObjectById(db, "unknown:1")).toBeUndefined();
  });
});

// ============================================================================
// countMemoryObjects
// ============================================================================

describe("RSMA Reader: countMemoryObjects", () => {
  it("counts by kind with status breakdown", () => {
    seedClaim(db, { status: "active" });
    seedClaim(db, { status: "active", canonical_key: "claim::b::c" });
    seedClaim(db, { status: "superseded", canonical_key: "claim::old::val" });
    seedDecision(db);
    seedLoop(db);

    const counts = countMemoryObjects(db);
    expect(counts.claim.total).toBe(3);
    expect(counts.claim.active).toBe(2);
    expect(counts.claim.superseded).toBe(1);
    expect(counts.decision.total).toBe(1);
    expect(counts.decision.active).toBe(1);
    expect(counts.loop.total).toBe(1);
  });

  it("returns zeros for empty database", () => {
    const counts = countMemoryObjects(db);
    for (const kind of Object.keys(counts)) {
      expect(counts[kind].total).toBe(0);
    }
  });

  it("counts procedures including both runbooks and anti-runbooks", () => {
    seedRunbook(db);
    seedRunbook(db, { runbook_key: "retry_v2" });
    seedAntiRunbook(db);
    const counts = countMemoryObjects(db);
    expect(counts.procedure.total).toBe(3); // 2 runbooks + 1 anti-runbook
    expect(counts.procedure.active).toBe(3);
  });
});

// ============================================================================
// Procedures (runbooks + anti-runbooks)
// ============================================================================

describe("RSMA Reader: procedures", () => {
  it("returns runbooks as procedure MemoryObjects", () => {
    seedRunbook(db);
    const results = readMemoryObjects(db, { kinds: ["procedure"] });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].kind).toBe("procedure");
    expect(results[0].content).toBeTruthy();
  });

  it("returns anti-runbooks as procedure MemoryObjects", () => {
    seedAntiRunbook(db);
    const results = readMemoryObjects(db, { kinds: ["procedure"] });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].kind).toBe("procedure");
  });

  it("returns both runbooks and anti-runbooks together", () => {
    seedRunbook(db);
    seedAntiRunbook(db);
    const results = readMemoryObjects(db, { kinds: ["procedure"] });
    expect(results.length).toBe(2);
  });
});

// ============================================================================
// Invariants
// ============================================================================

describe("RSMA Reader: invariants", () => {
  it("returns invariants as MemoryObjects", () => {
    seedInvariant(db);
    const results = readMemoryObjects(db, { kinds: ["invariant"] });
    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("invariant");
    expect(results[0].content).toContain("Friday");
  });

  it("invariants are readable", () => {
    seedInvariant(db, { invariant_key: "warn_test", severity: "warning" });
    const results = readMemoryObjects(db, { kinds: ["invariant"] });
    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("invariant");
  });
});

// ============================================================================
// Integration: projector → reader round-trip
// ============================================================================

describe("RSMA Reader + Projector: integration", () => {
  it("provenance links written by projector are queryable", () => {
    seedClaim(db);
    insertProvenanceLink(db, "claim:1", "supports", "msg:10", 0.9, "user stated");
    const links = getProvenanceLinksForSubject(db, "claim:1");
    expect(links.length).toBe(1);
    expect(links[0].predicate).toBe("supports");
  });

  it("seeded data round-trips through reader correctly", () => {
    seedClaim(db);
    seedDecision(db);
    seedLoop(db);
    seedAttempt(db);
    seedEntity(db);
    seedRunbook(db);
    seedAntiRunbook(db);
    seedInvariant(db);

    const results = readMemoryObjects(db, { limit: 100 });
    expect(results.length).toBe(8);

    const kindSet = new Set(results.map((r) => r.kind));
    expect(kindSet.has("claim")).toBe(true);
    expect(kindSet.has("decision")).toBe(true);
    expect(kindSet.has("loop")).toBe(true);
    expect(kindSet.has("attempt")).toBe(true);
    expect(kindSet.has("entity")).toBe(true);
    expect(kindSet.has("procedure")).toBe(true);
    expect(kindSet.has("invariant")).toBe(true);

    // Every object has required fields
    for (const obj of results) {
      expect(obj.id).toBeTruthy();
      expect(obj.kind).toBeTruthy();
      expect(obj.content).toBeTruthy();
      expect(obj.provenance).toBeDefined();
      expect(obj.provenance.trust).toBeGreaterThanOrEqual(0);
      expect(obj.provenance.trust).toBeLessThanOrEqual(1);
      expect(obj.confidence).toBeGreaterThanOrEqual(0);
      expect(obj.confidence).toBeLessThanOrEqual(1);
      expect(obj.status).toBeTruthy();
      expect(obj.created_at).toBeTruthy();
    }
  });
});

// ============================================================================
// Canonical key consistency (critical for TruthEngine)
// ============================================================================

describe("RSMA Reader: canonical key consistency", () => {
  it("claim canonical_key is normalized in DB", () => {
    seedClaim(db, { subject: "PostgreSQL", predicate: "Is Used For", canonical_key: "claim::postgresql::is used for" });
    const results = readMemoryObjects(db, { kinds: ["claim"] });
    expect(results.length).toBe(1);
    // canonical_key comes from DB
    expect(results[0].canonical_key).toBe("claim::postgresql::is used for");
  });

  it("decision canonical_key is normalized", () => {
    seedDecision(db, { topic: "  Staging Database  " });
    const results = readMemoryObjects(db, { kinds: ["decision"] });
    expect(results.length).toBe(1);
    expect(results[0].canonical_key).toBe("decision::staging database");
  });

  it("different claims produce different canonical keys", () => {
    seedClaim(db, { subject: "postgres", predicate: "is_used_for", canonical_key: "x" });
    seedClaim(db, { subject: "mysql", predicate: "is_used_for", canonical_key: "y" });
    const results = readMemoryObjects(db, { kinds: ["claim"], limit: 10 });
    expect(results.length).toBe(2);
    expect(results[0].canonical_key).not.toBe(results[1].canonical_key);
  });
});

// ============================================================================
// Relevance scoring bounds
// ============================================================================

describe("RSMA Reader: relevance score bounds", () => {
  it("computeRelevance always returns [0, 1] for random signals", () => {
    for (let i = 0; i < 100; i++) {
      const signals = {
        semantic: Math.random(),
        recency: Math.random(),
        trust: Math.random(),
        conflict: Math.random(),
        influence: Math.random(),
        status_penalty: Math.random(),
      };
      const score = computeRelevance(signals, TASK_MODE_WEIGHTS.default);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

// ============================================================================
// readMemoryObjectById for all kinds
// ============================================================================

describe("RSMA Reader: readMemoryObjectById all kinds", () => {
  function getCompositeId(db: GraphDb, rowId: number): string {
    return (db.prepare("SELECT composite_id FROM memory_objects WHERE id = ?").get(rowId) as { composite_id: string }).composite_id;
  }

  it("finds loop by composite ID", () => {
    const id = seedLoop(db);
    const obj = readMemoryObjectById(db, getCompositeId(db, id));
    expect(obj).toBeDefined();
    expect(obj!.kind).toBe("loop");
  });

  it("finds attempt by composite ID", () => {
    const id = seedAttempt(db);
    const obj = readMemoryObjectById(db, getCompositeId(db, id));
    expect(obj).toBeDefined();
    expect(obj!.kind).toBe("attempt");
  });

  it("finds entity by composite ID", () => {
    const id = seedEntity(db);
    const obj = readMemoryObjectById(db, getCompositeId(db, id));
    expect(obj).toBeDefined();
    expect(obj!.kind).toBe("entity");
  });

  it("finds runbook by composite ID", () => {
    const id = seedRunbook(db);
    const obj = readMemoryObjectById(db, getCompositeId(db, id));
    expect(obj).toBeDefined();
    expect(obj!.kind).toBe("procedure");
  });

  it("finds invariant by composite ID", () => {
    const id = seedInvariant(db);
    const obj = readMemoryObjectById(db, getCompositeId(db, id));
    expect(obj).toBeDefined();
    expect(obj!.kind).toBe("invariant");
  });
});
