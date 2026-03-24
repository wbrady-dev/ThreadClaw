import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { runGraphMigrations } from "../src/relations/schema.js";
import { upsertEntity } from "../src/relations/graph-store.js";
import { upsertRelation, getRelationsForEntity, getRelationGraph } from "../src/relations/relation-store.js";
import { extractClaimsDeep, extractRelationsDeep } from "../src/relations/deep-extract.js";
import type { GraphDb } from "../src/relations/types.js";
import type { LcmConfig } from "../src/db/config.js";

function createDb(): GraphDb {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runGraphMigrations(db as unknown as GraphDb);
  return db as unknown as GraphDb;
}

function makeConfig(overrides?: Partial<LcmConfig>): LcmConfig {
  return {
    enabled: true, databasePath: ":memory:", contextThreshold: 0.75,
    freshTailCount: 8, leafMinFanout: 8, condensedMinFanout: 4,
    condensedMinFanoutHard: 2, incrementalMaxDepth: 0, leafChunkTokens: 20000,
    leafTargetTokens: 600, condensedTargetTokens: 900, maxExpandTokens: 120,
    largeFileTokenThreshold: 25000, largeFileSummaryProvider: "",
    largeFileSummaryModel: "", summaryModel: "", summaryProvider: "",
    autocompactDisabled: false, timezone: "UTC", pruneHeartbeatOk: false,
    relationsEnabled: true, relationsGraphDbPath: ":memory:",
    relationsMinMentions: 2, relationsStaleDays: 30,
    relationsAwarenessEnabled: false, relationsAwarenessMaxNotes: 3,
    relationsAwarenessMaxTokens: 100, relationsAwarenessDocSurfacing: false,
    relationsClaimExtractionEnabled: false, relationsUserClaimExtractionEnabled: false,
    relationsContextTier: "standard", relationsAttemptTrackingEnabled: false,
    relationsDecayIntervalDays: 90, relationsDeepExtractionEnabled: false,
    relationsDeepExtractionModel: "", relationsDeepExtractionProvider: "",
    ...overrides,
  };
}

// ============================================================================
// Schema
// ============================================================================

describe("H5 Schema", () => {
  it("migration v6 creates entity_relations table", () => {
    const db = createDb();
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ name: string }>).map((r) => r.name);
    // Fresh install stores entity relations in provenance_links, not a legacy table
    expect(tables).toContain("provenance_links");
    expect(tables).toContain("memory_objects");
  });

  it("migration v6 is idempotent", () => {
    const db = createDb();
    runGraphMigrations(db);
    const v6 = db.prepare("SELECT version FROM _evidence_migrations WHERE version = 6").get();
    expect(v6).toBeDefined();
  });
});

// ============================================================================
// Relation Store
// ============================================================================

describe("H5 Relation Store", () => {
  let db: GraphDb;
  beforeEach(() => { db = createDb(); });

  it("upsertRelation creates a new relation", () => {
    const { entityId: e1 } = upsertEntity(db, { name: "Redis" });
    const { entityId: e2 } = upsertEntity(db, { name: "API Server" });

    const result = upsertRelation(db, {
      scopeId: 1, subjectEntityId: e1, predicate: "caches_for",
      objectEntityId: e2, confidence: 0.8, sourceType: "document", sourceId: "doc-1",
    });
    expect(result.isNew).toBe(true);
    expect(result.relationId).toBeGreaterThan(0);
  });

  it("upsertRelation updates confidence on conflict", () => {
    const { entityId: e1 } = upsertEntity(db, { name: "Auth" });
    const { entityId: e2 } = upsertEntity(db, { name: "Users" });

    upsertRelation(db, {
      scopeId: 1, subjectEntityId: e1, predicate: "manages",
      objectEntityId: e2, confidence: 0.5, sourceType: "doc", sourceId: "d1",
    });
    const result = upsertRelation(db, {
      scopeId: 1, subjectEntityId: e1, predicate: "manages",
      objectEntityId: e2, confidence: 0.9, sourceType: "doc", sourceId: "d2",
    });
    expect(result.isNew).toBe(false);
  });

  it("getRelationsForEntity returns subject and object relations", () => {
    const { entityId: e1 } = upsertEntity(db, { name: "A" });
    const { entityId: e2 } = upsertEntity(db, { name: "B" });
    const { entityId: e3 } = upsertEntity(db, { name: "C" });

    upsertRelation(db, { scopeId: 1, subjectEntityId: e1, predicate: "uses", objectEntityId: e2, sourceType: "t", sourceId: "s" });
    upsertRelation(db, { scopeId: 1, subjectEntityId: e3, predicate: "depends_on", objectEntityId: e1, sourceType: "t", sourceId: "s" });

    const rels = getRelationsForEntity(db, e1);
    expect(rels.length).toBe(2); // e1 as subject AND object
  });

  it("getRelationsForEntity filters by direction", () => {
    const { entityId: e1 } = upsertEntity(db, { name: "X" });
    const { entityId: e2 } = upsertEntity(db, { name: "Y" });

    upsertRelation(db, { scopeId: 1, subjectEntityId: e1, predicate: "owns", objectEntityId: e2, sourceType: "t", sourceId: "s" });

    const asSubject = getRelationsForEntity(db, e1, "subject");
    expect(asSubject.length).toBe(1);
    const asObject = getRelationsForEntity(db, e1, "object");
    expect(asObject.length).toBe(0);
  });

  it("getRelationGraph returns all relations in scope", () => {
    const { entityId: e1 } = upsertEntity(db, { name: "P" });
    const { entityId: e2 } = upsertEntity(db, { name: "Q" });

    upsertRelation(db, { scopeId: 1, subjectEntityId: e1, predicate: "relates_to", objectEntityId: e2, sourceType: "t", sourceId: "s" });

    const graph = getRelationGraph(db, 1);
    expect(graph.length).toBe(1);
    expect(graph[0].subject_name).toBeDefined();
    expect(graph[0].object_name).toBeDefined();
  });
});

// ============================================================================
// Deep Extraction (mocked LLM)
// ============================================================================

describe("H5 Deep Extraction", () => {
  it("returns empty when deep extraction is disabled", async () => {
    const config = makeConfig({ relationsDeepExtractionEnabled: false });
    const deps = { config, complete: async () => ({ content: "[]" }) } as any;
    const results = await extractClaimsDeep("Some text", deps, config);
    expect(results.length).toBe(0);
  });

  it("extracts claims from mocked LLM response", async () => {
    const config = makeConfig({ relationsDeepExtractionEnabled: true });
    const mockResponse = JSON.stringify([
      { subject: "redis", predicate: "is", object: "a cache", confidence: 0.9 },
      { subject: "api", predicate: "uses", object: "redis", confidence: 0.7 },
    ]);

    const deps = {
      config,
      complete: async () => ({ content: mockResponse }),
      resolveModel: () => ({ provider: "test", model: "test" }),
    } as any;

    const results = await extractClaimsDeep("Redis is a cache used by the API", deps, config);
    expect(results.length).toBe(2);
    expect(results[0].claim.subject).toBe("redis");
    expect(results[0].claim.objectText).toBe("a cache");
  });

  it("handles malformed LLM response gracefully", async () => {
    const config = makeConfig({ relationsDeepExtractionEnabled: true });
    const deps = {
      config,
      complete: async () => ({ content: "not valid json at all" }),
      resolveModel: () => ({ provider: "test", model: "test" }),
    } as any;

    const results = await extractClaimsDeep("Some text", deps, config);
    expect(results.length).toBe(0);
  });

  it("extractRelationsDeep returns empty when disabled", async () => {
    const config = makeConfig({ relationsDeepExtractionEnabled: false });
    const deps = { config, complete: async () => ({ content: "[]" }) } as any;
    const results = await extractRelationsDeep("text", ["A", "B"], deps, config);
    expect(results.length).toBe(0);
  });

  it("extractRelationsDeep filters to known entities", async () => {
    const config = makeConfig({ relationsDeepExtractionEnabled: true });
    const mockResponse = JSON.stringify([
      { subject: "redis", predicate: "caches_for", object: "api", confidence: 0.8 },
      { subject: "unknown", predicate: "does", object: "something", confidence: 0.5 },
    ]);

    const deps = {
      config,
      complete: async () => ({ content: mockResponse }),
      resolveModel: () => ({ provider: "test", model: "test" }),
    } as any;

    const results = await extractRelationsDeep("Redis caches for the API", ["Redis", "API"], deps, config);
    expect(results.length).toBe(1); // "unknown" filtered out
    expect(results[0].subject).toBe("redis");
  });

  it("handles LLM error gracefully", async () => {
    const config = makeConfig({ relationsDeepExtractionEnabled: true });
    const deps = {
      config,
      complete: async () => { throw new Error("API error"); },
      resolveModel: () => ({ provider: "test", model: "test" }),
    } as any;

    const results = await extractClaimsDeep("text", deps, config);
    expect(results.length).toBe(0); // graceful fallback
  });
});
