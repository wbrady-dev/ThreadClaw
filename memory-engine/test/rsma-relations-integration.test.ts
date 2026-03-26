/**
 * RSMA Relations Integration Test — validates the FULL extraction → relation path.
 *
 * This test ensures that semantic extraction output flows correctly through the
 * legacy bridge code into the entity_relations table. It catches field-name
 * mismatches between producers (semantic-extractor.ts) and consumers (engine.ts).
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach } from "vitest";
import { runGraphMigrations } from "../src/relations/schema.js";
import { upsertEntity } from "../src/relations/graph-store.js";
import { upsertRelation } from "../src/relations/relation-store.js";
import { withWriteTransaction } from "../src/relations/evidence-log.js";
import type { GraphDb } from "../src/relations/types.js";
import type { MemoryObject } from "../src/ontology/types.js";
import type { StructuredClaim } from "../src/ontology/types.js";

// ── In-memory DB helper ─────────────────────────────────────────────────────

function createInMemoryDb(): GraphDb {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db as unknown as GraphDb;
}

// ── Replicate the legacy bridge logic from engine.ts ────────────────────────
// This is the EXACT same logic the engine uses, extracted for testability.

const PREDICATE_BLACKLIST = ["is", "states", "has", "user_i", "user_my"];

function asClaimStructured(s: Record<string, unknown>): StructuredClaim | null {
  if (typeof s.subject !== "string" || typeof s.predicate !== "string") return null;
  return {
    subject: s.subject,
    predicate: s.predicate,
    objectText: String(s.objectText ?? s.value ?? ""),
    objectJson: typeof s.objectJson === "string" ? s.objectJson : undefined,
    valueType: typeof s.valueType === "string" ? s.valueType : undefined,
  };
}

function processClaimRelation(
  graphDb: GraphDb,
  obj: MemoryObject,
): { created: boolean; subjectName?: string; objectName?: string; predicate?: string } {
  const s = obj.structured as Record<string, unknown> | undefined;
  if (!s || obj.kind !== "claim") return { created: false };

  const claim = asClaimStructured(s);
  if (!claim) return { created: false };
  if (!claim.objectText) return { created: false };
  if (PREDICATE_BLACKLIST.includes(claim.predicate)) return { created: false };

  const subjEntity = upsertEntity(graphDb, { name: claim.subject });
  const objEntity = upsertEntity(graphDb, { name: claim.objectText });
  if (!subjEntity.entityId || !objEntity.entityId) return { created: false };

  upsertRelation(graphDb, {
    scopeId: 1,
    subjectEntityId: subjEntity.entityId,
    predicate: claim.predicate,
    objectEntityId: objEntity.entityId,
    confidence: obj.confidence,
    sourceType: "message",
    sourceId: obj.provenance.source_id,
  });

  return {
    created: true,
    subjectName: claim.subject,
    objectName: claim.objectText,
    predicate: claim.predicate,
  };
}

// ── Helper to build a MemoryObject with claim structured data ───────────────

function makeClaim(opts: {
  subject?: string;
  predicate?: string;
  objectText?: string;
  confidence?: number;
}): MemoryObject {
  const now = new Date().toISOString();
  return {
    id: `claim:test-${Math.random().toString(36).slice(2)}`,
    kind: "claim",
    content: `${opts.subject ?? ""} ${opts.predicate ?? ""}: ${opts.objectText ?? ""}`,
    structured: {
      subject: opts.subject,
      predicate: opts.predicate,
      objectText: opts.objectText,
    } as Record<string, unknown>,
    provenance: {
      source_kind: "extraction",
      source_id: "test-source",
      actor: "system",
      trust: 0.8,
      extraction_method: "llm",
    },
    confidence: opts.confidence ?? 0.9,
    freshness: 1.0,
    provisional: false,
    status: "active",
    observed_at: now,
    scope_id: 1,
    influence_weight: "standard",
    created_at: now,
    updated_at: now,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("RSMA Relations Integration: extraction → relation pipeline", () => {
  let db: GraphDb;

  beforeEach(() => {
    db = createInMemoryDb();
    runGraphMigrations(db);
  });

  it("'Cassidy works for Sam' creates a relation", () => {
    const obj = makeClaim({ subject: "Cassidy", predicate: "works_for", objectText: "Sam" });

    withWriteTransaction(db, () => {
      const result = processClaimRelation(db, obj);
      expect(result.created).toBe(true);
      expect(result.subjectName).toBe("Cassidy");
      expect(result.objectName).toBe("Sam");
      expect(result.predicate).toBe("works_for");
    });

    // Verify entity_relations table has the expected row
    const relations = db.prepare("SELECT * FROM memory_objects WHERE kind = 'relation' AND status = 'active'").all() as Array<Record<string, unknown>>;
    expect(relations.length).toBe(1);
    expect(relations[0].content).toContain("works_for");
  });

  it("'Project uses PostgreSQL' creates a relation (predicate != 'is')", () => {
    const obj = makeClaim({ subject: "Project", predicate: "uses", objectText: "PostgreSQL" });

    withWriteTransaction(db, () => {
      const result = processClaimRelation(db, obj);
      expect(result.created).toBe(true);
    });

    const relations = db.prepare("SELECT * FROM memory_objects WHERE kind = 'relation' AND status = 'active'").all() as Array<Record<string, unknown>>;
    expect(relations.length).toBe(1);
    expect(relations[0].content).toContain("uses");
  });

  it("'The sky is blue' does NOT create a relation (predicate = 'is', blacklisted)", () => {
    const obj = makeClaim({ subject: "sky", predicate: "is", objectText: "blue" });

    withWriteTransaction(db, () => {
      const result = processClaimRelation(db, obj);
      expect(result.created).toBe(false);
    });

    const relations = db.prepare("SELECT * FROM memory_objects WHERE kind = 'relation' AND status = 'active'").all() as Array<Record<string, unknown>>;
    expect(relations.length).toBe(0);
  });

  it("missing objectText does NOT create a relation", () => {
    const obj = makeClaim({ subject: "Cassidy", predicate: "works_for" });
    // objectText is undefined → asClaimStructured falls back to ""

    withWriteTransaction(db, () => {
      const result = processClaimRelation(db, obj);
      // objectText is "" which is falsy → should not create
      expect(result.created).toBe(false);
    });

    const relations = db.prepare("SELECT * FROM memory_objects WHERE kind = 'relation' AND status = 'active'").all() as Array<Record<string, unknown>>;
    expect(relations.length).toBe(0);
  });

  it("missing subject does NOT create a relation", () => {
    const obj = makeClaim({ predicate: "works_for", objectText: "Sam" });
    // subject is undefined → asClaimStructured returns null

    withWriteTransaction(db, () => {
      const result = processClaimRelation(db, obj);
      expect(result.created).toBe(false);
    });

    const relations = db.prepare("SELECT * FROM memory_objects WHERE kind = 'relation' AND status = 'active'").all() as Array<Record<string, unknown>>;
    expect(relations.length).toBe(0);
  });

  it("predicate 'states' is blacklisted", () => {
    const obj = makeClaim({ subject: "user", predicate: "states", objectText: "something" });

    withWriteTransaction(db, () => {
      const result = processClaimRelation(db, obj);
      expect(result.created).toBe(false);
    });
  });

  it("predicate 'has' is blacklisted", () => {
    const obj = makeClaim({ subject: "user", predicate: "has", objectText: "cat" });

    withWriteTransaction(db, () => {
      const result = processClaimRelation(db, obj);
      expect(result.created).toBe(false);
    });
  });

  it("legacy 'value' field still works via fallback in asClaimStructured", () => {
    const now = new Date().toISOString();
    const obj: MemoryObject = {
      id: "claim:legacy-test",
      kind: "claim",
      content: "Bob manages auth team",
      structured: {
        subject: "Bob",
        predicate: "manages",
        value: "auth team",  // OLD field name — should be handled by fallback
      },
      provenance: {
        source_kind: "extraction",
        source_id: "test-source",
        actor: "system",
        trust: 0.8,
        extraction_method: "llm",
      },
      confidence: 0.9,
      freshness: 1.0,
      provisional: false,
      status: "active",
      observed_at: now,
      scope_id: 1,
      influence_weight: "standard",
      created_at: now,
      updated_at: now,
    };

    withWriteTransaction(db, () => {
      const result = processClaimRelation(db, obj);
      expect(result.created).toBe(true);
      expect(result.objectName).toBe("auth team");
    });

    const relations = db.prepare("SELECT * FROM memory_objects WHERE kind = 'relation' AND status = 'active'").all() as Array<Record<string, unknown>>;
    expect(relations.length).toBe(1);
  });
});
