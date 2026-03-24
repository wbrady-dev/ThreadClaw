/**
 * RSMA Semantic Extractor Tests — LLM-powered extraction validation.
 *
 * Uses a mock LLM that returns structured JSON to test the parsing,
 * conversion, and fallback behavior of the semantic extractor.
 */

import { describe, expect, it, vi } from "vitest";
import { semanticExtract, type CompleteFn } from "../src/ontology/semantic-extractor.js";

// ── Mock LLM ────────────────────────────────────────────────────────────────

function mockComplete(response: string): CompleteFn {
  return vi.fn(async () => ({
    content: [{ type: "text", text: response }],
  }));
}

function mockConfig(response: string) {
  return {
    complete: mockComplete(response),
    model: "test-model",
    provider: "test",
  };
}

// ============================================================================
// Basic extraction
// ============================================================================

describe("RSMA Semantic: basic extraction", () => {
  it("extracts a decision from LLM response", async () => {
    const config = mockConfig(JSON.stringify({
      events: [{
        type: "decision",
        content: "Use Postgres for staging",
        subject: "staging database",
        predicate: "technology",
        value: "Postgres",
        confidence: 0.9,
      }],
    }));

    const result = await semanticExtract("We're going with Postgres", "msg-1", "user", config);
    expect(result.objects.length).toBeGreaterThanOrEqual(1);
    const decision = result.objects.find((o) => o.kind === "decision");
    expect(decision).toBeDefined();
    expect(decision!.content).toContain("Postgres");
    expect(decision!.influence_weight).toBe("high");
    expect(decision!.provenance.extraction_method).toBe("llm");
    expect(result.eventTypes).toContain("decision");
  });

  it("extracts a correction with is_correction_of", async () => {
    const config = mockConfig(JSON.stringify({
      events: [{
        type: "correction",
        content: "Switch to MySQL",
        subject: "database",
        predicate: "technology",
        value: "MySQL",
        confidence: 0.9,
        is_correction_of: "PostgreSQL",
      }],
    }));

    const result = await semanticExtract("Actually no, use MySQL", "msg-2", "user", config);
    const claim = result.objects.find((o) => o.kind === "claim");
    expect(claim).toBeDefined();
    expect(claim!.provenance.source_detail).toContain("correction_of: PostgreSQL");
    expect(result.signals.isCorrection).toBe(true);
    expect(result.eventTypes).toContain("correction");
  });

  it("extracts uncertain claims with lowered confidence", async () => {
    const config = mockConfig(JSON.stringify({
      events: [{
        type: "uncertainty",
        content: "Port is 8080",
        subject: "service",
        predicate: "port",
        value: "8080",
        confidence: 0.4,
        is_uncertain: true,
      }],
    }));

    const result = await semanticExtract("I think the port might be 8080", "msg-3", "user", config);
    const claim = result.objects.find((o) => o.kind === "claim");
    expect(claim).toBeDefined();
    expect(claim!.provisional).toBe(true);
    expect(claim!.confidence).toBeLessThanOrEqual(0.4);
    expect(result.signals.isUncertain).toBe(true);
  });

  it("extracts preferences with high influence", async () => {
    const config = mockConfig(JSON.stringify({
      events: [{
        type: "preference",
        content: "Prefer short replies",
        subject: "replies",
        predicate: "style",
        value: "short",
        confidence: 0.95,
      }],
    }));

    const result = await semanticExtract("I prefer short replies", "msg-4", "user", config);
    const claim = result.objects.find((o) => o.kind === "claim");
    expect(claim).toBeDefined();
    expect(claim!.influence_weight).toBe("high");
    expect(result.eventTypes).toContain("preference");
  });

  it("extracts tasks as loops", async () => {
    const config = mockConfig(JSON.stringify({
      events: [{
        type: "task",
        content: "Rotate the API key",
        subject: "API key",
        predicate: "action",
        value: "rotate",
        confidence: 0.9,
        temporal: "before Friday",
      }],
    }));

    const result = await semanticExtract("Need to rotate the API key before Friday", "msg-5", "user", config);
    const loop = result.objects.find((o) => o.kind === "loop");
    expect(loop).toBeDefined();
    expect(loop!.effective_at).toBeUndefined();
    expect(result.eventTypes).toContain("task");
  });

  it("extracts entities from LLM response", async () => {
    const config = mockConfig(JSON.stringify({
      events: [{
        type: "fact",
        content: "PostgreSQL is running on port 5432",
        subject: "PostgreSQL",
        predicate: "port",
        value: "5432",
        confidence: 0.9,
        entities: ["PostgreSQL"],
      }],
    }));

    const result = await semanticExtract("PostgreSQL is running on port 5432", "msg-6", "user", config);
    const entities = result.objects.filter((o) => o.kind === "entity");
    expect(entities.length).toBeGreaterThanOrEqual(1);
    expect(entities[0].content).toBe("PostgreSQL");
    expect(entities[0].provenance.extraction_method).toBe("llm");
  });
});

// ============================================================================
// Multiple events in one message
// ============================================================================

describe("RSMA Semantic: multi-event extraction", () => {
  it("extracts multiple events from one message", async () => {
    const config = mockConfig(JSON.stringify({
      events: [
        { type: "decision", content: "Use Postgres", subject: "db", predicate: "tech", value: "Postgres", confidence: 0.9 },
        { type: "fact", content: "API rotates every 30 days", subject: "api key", predicate: "rotation", value: "30 days", confidence: 0.85 },
        { type: "task", content: "Set up CI pipeline", subject: "CI", predicate: "action", value: "setup", confidence: 0.9, temporal: "by Friday" },
      ],
    }));

    const result = await semanticExtract(
      "We're going with Postgres. The API key rotates every 30 days. Need to set up CI by Friday.",
      "msg-7", "user", config,
    );

    expect(result.objects.length).toBeGreaterThanOrEqual(3);
    const kinds = result.objects.map((o) => o.kind);
    expect(kinds).toContain("decision");
    expect(kinds).toContain("claim");
    expect(kinds).toContain("loop");
  });
});

// ============================================================================
// Fallback to regex
// ============================================================================

describe("RSMA Semantic: fallback behavior", () => {
  it("falls back to regex when LLM fails", async () => {
    const failingComplete: CompleteFn = vi.fn(async () => {
      throw new Error("LLM unavailable");
    });

    const result = await semanticExtract(
      "We decided to use Postgres for staging.",
      "msg-8", "user",
      { complete: failingComplete, model: "test" },
    );

    // Should still produce results via regex fallback
    expect(result.objects.length).toBeGreaterThanOrEqual(1);
    // Regex extraction produces decisions from "We decided to"
    const decision = result.objects.find((o) => o.kind === "decision");
    expect(decision).toBeDefined();
  });

  it("falls back to regex when LLM returns invalid JSON", async () => {
    const config = mockConfig("This is not JSON at all");

    const result = await semanticExtract(
      "We decided to use Postgres for staging.",
      "msg-9", "user", config,
    );

    // Should fall back to regex
    expect(result.objects.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to regex when LLM returns empty events", async () => {
    const config = mockConfig(JSON.stringify({ events: [] }));

    const result = await semanticExtract(
      "We decided to use Postgres for staging.",
      "msg-10", "user", config,
    );

    // Should fall back to regex
    expect(result.objects.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for very short text", async () => {
    const config = mockConfig(JSON.stringify({ events: [] }));
    const result = await semanticExtract("hi", "msg-11", "user", config);
    expect(result.objects.length).toBe(0);
  });
});

// ============================================================================
// MemoryObject structure validation
// ============================================================================

describe("RSMA Semantic: object structure", () => {
  it("all objects have required fields", async () => {
    const config = mockConfig(JSON.stringify({
      events: [
        { type: "decision", content: "Use Postgres", subject: "db", predicate: "tech", value: "Postgres", confidence: 0.9 },
        { type: "fact", content: "Port is 5432", subject: "db", predicate: "port", value: "5432", confidence: 0.8 },
      ],
    }));

    const result = await semanticExtract("Use Postgres on port 5432", "msg-12", "user", config);
    for (const obj of result.objects) {
      expect(obj.id).toBeTruthy();
      expect(obj.kind).toBeTruthy();
      expect(obj.content).toBeTruthy();
      expect(obj.provenance).toBeDefined();
      expect(obj.provenance.extraction_method).toBe("llm");
      expect(obj.confidence).toBeGreaterThanOrEqual(0);
      expect(obj.confidence).toBeLessThanOrEqual(1);
      expect(obj.status).toBe("active");
      expect(obj.created_at).toBeTruthy();
    }
  });

  it("canonical keys are computed", async () => {
    const config = mockConfig(JSON.stringify({
      events: [
        { type: "decision", content: "Use Postgres", subject: "staging database", predicate: "technology", value: "Postgres", confidence: 0.9 },
      ],
    }));

    const result = await semanticExtract("Use Postgres", "msg-13", "user", config);
    const decision = result.objects.find((o) => o.kind === "decision");
    expect(decision?.canonical_key).toBeDefined();
    expect(decision?.canonical_key).toMatch(/^decision::/);
  });
});

// ============================================================================
// LLM response parsing edge cases
// ============================================================================

describe("RSMA Semantic: parsing edge cases", () => {
  it("handles JSON wrapped in markdown code block", async () => {
    const config = mockConfig('```json\n{"events":[{"type":"fact","content":"Port is 8080","subject":"api","predicate":"port","value":"8080","confidence":0.9}]}\n```');
    const result = await semanticExtract("The port is 8080", "msg-14", "user", config);
    expect(result.objects.length).toBeGreaterThanOrEqual(1);
  });

  it("filters out events with missing required fields", async () => {
    const config = mockConfig(JSON.stringify({
      events: [
        { type: "fact", content: "Valid", confidence: 0.8 },
        { type: "fact", content: "", confidence: 0.8 }, // empty content — filtered
        { type: "fact", content: "Also valid", confidence: 0.7 },
      ],
    }));

    const result = await semanticExtract("Test message with some content here", "msg-15", "user", config);
    // Should only get 2 events (the one with empty content is filtered)
    const claims = result.objects.filter((o) => o.kind === "claim");
    expect(claims.length).toBe(2);
  });

  it("filters out events with invalid confidence", async () => {
    const config = mockConfig(JSON.stringify({
      events: [
        { type: "fact", content: "Valid", confidence: 0.8 },
        { type: "fact", content: "Invalid conf", confidence: 1.5 }, // filtered
        { type: "fact", content: "Negative conf", confidence: -0.1 }, // filtered
      ],
    }));

    const result = await semanticExtract("Test message here", "msg-16", "user", config);
    const claims = result.objects.filter((o) => o.kind === "claim");
    expect(claims.length).toBe(1);
  });
});
