/**
 * RSMA Canonical Key Tests — core infrastructure validation.
 *
 * Canonical keys are what make supersession, dedup, and conflict detection work.
 * These tests verify per-kind key strategies are stable and correct.
 */

import { describe, expect, it } from "vitest";
import { buildCanonicalKey, normalize, hashPrefix } from "../src/ontology/canonical.js";

describe("RSMA Canonical: normalize()", () => {
  it("lowercases and trims", () => {
    expect(normalize("  Hello World  ")).toBe("hello world");
  });

  it("collapses whitespace", () => {
    expect(normalize("hello   world")).toBe("hello world");
  });

  it("handles undefined/null", () => {
    expect(normalize(undefined)).toBe("");
    expect(normalize(null)).toBe("");
  });

  it("handles empty string", () => {
    expect(normalize("")).toBe("");
  });
});

describe("RSMA Canonical: hashPrefix()", () => {
  it("produces stable 16-char hex digest", () => {
    const h = hashPrefix("hello world", 100);
    expect(h.length).toBe(16);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    expect(hashPrefix("test input", 50)).toBe(hashPrefix("test input", 50));
  });

  it("truncates long input before hashing", () => {
    const long = "a".repeat(1000);
    const h1 = hashPrefix(long, 100);
    const h2 = hashPrefix("a".repeat(100), 100);
    expect(h1).toBe(h2);
  });

  it("is case-insensitive", () => {
    expect(hashPrefix("Hello World", 50)).toBe(hashPrefix("hello world", 50));
  });
});

describe("RSMA Canonical: claim keys", () => {
  it("builds subject::predicate key", () => {
    const key = buildCanonicalKey("claim", "", { subject: "Postgres", predicate: "is_used_for" });
    expect(key).toBe("claim::postgres::is_used_for");
  });

  it("normalizes subject and predicate", () => {
    const key = buildCanonicalKey("claim", "", { subject: "  API Key  ", predicate: "  Expires  " });
    expect(key).toBe("claim::api key::expires");
  });

  it("returns undefined when subject is missing", () => {
    expect(buildCanonicalKey("claim", "", { predicate: "is" })).toBeUndefined();
  });

  it("returns undefined when predicate is missing", () => {
    expect(buildCanonicalKey("claim", "", { subject: "postgres" })).toBeUndefined();
  });

  it("returns undefined for whitespace-only subject", () => {
    expect(buildCanonicalKey("claim", "", { subject: "   ", predicate: "is" })).toBeUndefined();
  });

  it("returns undefined for whitespace-only predicate", () => {
    expect(buildCanonicalKey("claim", "", { subject: "postgres", predicate: "   " })).toBeUndefined();
  });

  it("same claim = same key regardless of casing", () => {
    const k1 = buildCanonicalKey("claim", "", { subject: "PostgreSQL", predicate: "Status" });
    const k2 = buildCanonicalKey("claim", "", { subject: "postgresql", predicate: "status" });
    expect(k1).toBe(k2);
  });
});

describe("RSMA Canonical: decision keys", () => {
  it("builds decision::topic key", () => {
    const key = buildCanonicalKey("decision", "", { topic: "staging database" });
    expect(key).toMatch(/^decision::[0-9a-f]{16}$/);
  });

  it("hashes long topics consistently", () => {
    const longTopic = "a".repeat(100);
    const key = buildCanonicalKey("decision", "", { topic: longTopic });
    expect(key).toMatch(/^decision::[0-9a-f]{16}$/);
    // same input → same hash
    const key2 = buildCanonicalKey("decision", "", { topic: longTopic });
    expect(key2).toBe(key);
  });

  it("returns undefined when topic is missing", () => {
    expect(buildCanonicalKey("decision", "", {})).toBeUndefined();
  });

  it("returns undefined for whitespace-only topic", () => {
    expect(buildCanonicalKey("decision", "", { topic: "   " })).toBeUndefined();
  });
});

describe("RSMA Canonical: entity keys", () => {
  it("builds entity::name key from content", () => {
    const key = buildCanonicalKey("entity", "Wesley Brady");
    expect(key).toBe("entity::unknown::wesley brady");
  });

  it("returns undefined for empty content", () => {
    expect(buildCanonicalKey("entity", "")).toBeUndefined();
  });
});

describe("RSMA Canonical: loop keys", () => {
  it("builds hash-based key", () => {
    const key = buildCanonicalKey("loop", "Rotate the API key by Friday");
    expect(key).toMatch(/^loop::[0-9a-f]{16}$/);
  });

  it("near-identical tasks share the same key", () => {
    const k1 = buildCanonicalKey("loop", "Rotate the API key");
    const k2 = buildCanonicalKey("loop", "Rotate the API key");
    expect(k1).toBe(k2);
  });

  it("different tasks produce different keys", () => {
    const k1 = buildCanonicalKey("loop", "Rotate the API key");
    const k2 = buildCanonicalKey("loop", "Deploy to staging");
    expect(k1).not.toBe(k2);
  });

  it("returns undefined for very short content", () => {
    expect(buildCanonicalKey("loop", "hi")).toBeUndefined();
  });

  it("accepts exactly 3-char trimmed content", () => {
    const key = buildCanonicalKey("loop", "abc");
    expect(key).toBeDefined();
    expect(key).toMatch(/^loop::[0-9a-f]{16}$/);
  });

  it("returns undefined for whitespace-only content", () => {
    expect(buildCanonicalKey("loop", "   ")).toBeUndefined();
  });
});

describe("RSMA Canonical: procedure keys", () => {
  it("builds proc::tool::key", () => {
    const key = buildCanonicalKey("procedure", "", { toolName: "git_push", key: "retry_on_fail" });
    expect(key).toBe("proc::git_push::retry_on_fail");
  });

  it("returns undefined when toolName missing", () => {
    expect(buildCanonicalKey("procedure", "", { key: "something" })).toBeUndefined();
  });

  it("returns undefined when key missing", () => {
    expect(buildCanonicalKey("procedure", "", { toolName: "git_push" })).toBeUndefined();
  });
});

describe("RSMA Canonical: invariant keys", () => {
  it("builds inv::key", () => {
    const key = buildCanonicalKey("invariant", "", { key: "no_friday_deploys" });
    expect(key).toBe("inv::no_friday_deploys");
  });

  it("returns undefined when key missing", () => {
    expect(buildCanonicalKey("invariant", "", {})).toBeUndefined();
  });
});

describe("RSMA Canonical: conflict keys", () => {
  it("builds conflict::hash key", () => {
    const key = buildCanonicalKey("conflict", "staging DB: MySQL vs Postgres");
    expect(key).toMatch(/^conflict::[0-9a-f]{16}$/);
  });

  it("returns undefined for whitespace-only content", () => {
    expect(buildCanonicalKey("conflict", "   ")).toBeUndefined();
  });

  it("returns undefined for empty content", () => {
    expect(buildCanonicalKey("conflict", "")).toBeUndefined();
  });
});

describe("RSMA Canonical: kinds with no dedup", () => {
  it("event returns undefined", () => {
    expect(buildCanonicalKey("event", "some event")).toBeUndefined();
  });

  it("chunk returns undefined", () => {
    expect(buildCanonicalKey("chunk", "some chunk text")).toBeUndefined();
  });

  it("message returns undefined", () => {
    expect(buildCanonicalKey("message", "hello")).toBeUndefined();
  });

  it("summary returns undefined", () => {
    expect(buildCanonicalKey("summary", "summary text")).toBeUndefined();
  });

  it("attempt returns undefined", () => {
    expect(buildCanonicalKey("attempt", "git push")).toBeUndefined();
  });

  it("delta returns undefined", () => {
    expect(buildCanonicalKey("delta", "field changed")).toBeUndefined();
  });
});
