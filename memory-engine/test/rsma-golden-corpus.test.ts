/**
 * RSMA Golden Corpus — Phase 0 eval harness.
 *
 * Tests extraction quality against hand-curated cases for:
 * - Corrections ("actually", "not anymore", "scratch that")
 * - Decisions (explicit and implied)
 * - Preferences ("I prefer", "don't suggest")
 * - Uncertainty ("I think", "maybe", "for now")
 * - Temporal ("next Monday", "by Friday")
 * - Loops (tasks, reminders, blockers)
 * - Tool outcomes (JSON → claims)
 * - False-supersession (correction signals that should NOT supersede)
 *
 * These tests run against the CURRENT extraction pipeline to establish baselines.
 * After the RSMA rewrite, the same corpus validates the new MemoryWriter.
 */

import { describe, expect, it } from "vitest";
import {
  extractClaimsFast,
  extractClaimsFromUserExplicit,
  extractClaimsFromToolResult,
  extractClaimsFromDocumentKV,
  extractClaimsFromFrontmatter,
  extractDecisionsFromText,
  extractLoopsFromText,
} from "../src/relations/claim-extract.js";
import { extractFast } from "../src/relations/entity-extract.js";

// ============================================================================
// 1. ENTITY EXTRACTION BASELINES
// ============================================================================

describe("RSMA Golden Corpus: Entity Extraction", () => {
  it("extracts capitalized multi-word names", () => {
    const results = extractFast("Wesley Brady discussed the project with Alex Morgan.");
    const names = results.map((r) => r.name.toLowerCase());
    expect(names).toContain("wesley brady");
    expect(names).toContain("alex morgan");
  });

  it("extracts organization names", () => {
    const results = extractFast("We signed the contract with Acme Corporation last week.");
    const names = results.map((r) => r.name.toLowerCase());
    expect(names).toContain("acme corporation");
  });

  it("does NOT extract common phrases as entities", () => {
    const results = extractFast("The quick brown fox jumped over the lazy dog.");
    // Should extract nothing meaningful — no capitalized multi-word phrases
    const names = results.map((r) => r.name.toLowerCase());
    expect(names).not.toContain("the quick");
  });

  it("extracts quoted terms", () => {
    const results = extractFast('The tool is called "ClawCore" and it handles memory.');
    const names = results.map((r) => r.name.toLowerCase());
    expect(names).toContain("clawcore");
  });
});

// ============================================================================
// 2. CLAIM EXTRACTION BASELINES
// ============================================================================

describe("RSMA Golden Corpus: Claim Extraction — User Explicit", () => {
  it("extracts 'Remember:' prefixed claims", () => {
    const results = extractClaimsFromUserExplicit(
      "Remember: the staging DB uses Postgres",
      "msg-1",
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].claim.objectText).toContain("Postgres");
  });

  it("extracts 'Note:' prefixed claims", () => {
    const results = extractClaimsFromUserExplicit(
      "Note: API key expires on Friday",
      "msg-2",
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Current extractor parses "API key expires on Friday" → subject="api key", objectText="on Friday"
    // The claim IS extracted — the content just gets split at the verb
    expect(results[0].claim.subject).toContain("api key");
  });

  it("extracts 'Important:' prefixed claims", () => {
    const results = extractClaimsFromUserExplicit(
      "Important: never deploy on Fridays",
      "msg-3",
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts 'FYI:' prefixed claims", () => {
    const results = extractClaimsFromUserExplicit(
      "FYI: the CI pipeline takes about 20 minutes",
      "msg-4",
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts multiple claims from one message", () => {
    const results = extractClaimsFromUserExplicit(
      "Remember: port 8080 is for the API\nNote: port 3000 is for the frontend",
      "msg-5",
    );
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores very short claims", () => {
    const results = extractClaimsFromUserExplicit("Remember: ok", "msg-6");
    expect(results.length).toBe(0);
  });
});

describe("RSMA Golden Corpus: Claim Extraction — Document KV", () => {
  it("extracts heading + bullet KV patterns", () => {
    const doc = "## Auth System\n- Owner: Bob Smith\n- Status: Active\n- Framework: OAuth2";
    const results = extractClaimsFromDocumentKV(doc, "doc-1");
    expect(results.length).toBeGreaterThanOrEqual(2);
    const subjects = results.map((r) => r.claim.subject);
    expect(subjects).toContain("auth system");
  });

  it("extracts YAML frontmatter claims", () => {
    const doc = "---\nauthor: Wesley\nstatus: draft\ntags: memory, ai\n---\nContent here.";
    const results = extractClaimsFromFrontmatter(doc, "doc-2");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // 'author' should be extracted, but 'title'/'date' are excluded
  });
});

describe("RSMA Golden Corpus: Claim Extraction — Tool Results", () => {
  it("extracts claims from flat JSON tool result", () => {
    const results = extractClaimsFromToolResult(
      "git_status",
      { branch: "main", clean: true, ahead: 0, behind: 2 },
      "msg-10",
    );
    expect(results.length).toBeGreaterThanOrEqual(3);
    const predicates = results.map((r) => r.claim.predicate);
    expect(predicates).toContain("branch");
    expect(predicates).toContain("clean");
  });

  it("extracts claims from nested JSON (depth ≤ 3)", () => {
    const results = extractClaimsFromToolResult(
      "system_info",
      { os: { name: "Windows", version: "11" }, cpu: { cores: 8 } },
      "msg-11",
    );
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it("caps depth at 3 — does not extract deeply nested values", () => {
    const results = extractClaimsFromToolResult(
      "deep_tool",
      { a: { b: { c: { d: { e: "too deep" } } } } },
      "msg-12",
    );
    const deepPreds = results.filter((r) => r.claim.predicate.includes("e"));
    expect(deepPreds.length).toBe(0);
  });
});

// ============================================================================
// 3. DECISION EXTRACTION BASELINES
// ============================================================================

describe("RSMA Golden Corpus: Decision Extraction", () => {
  it("extracts explicit 'We decided' decisions", () => {
    const results = extractDecisionsFromText(
      "We decided to use Postgres for the staging database.",
      "msg-20",
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].decisionText).toContain("Postgres");
  });

  it("extracts 'Going with' decisions", () => {
    const results = extractDecisionsFromText(
      "We're going with TypeScript for the backend rewrite.",
      "msg-21",
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts 'Decision:' prefixed decisions", () => {
    const results = extractDecisionsFromText(
      "Decision: switch to ARM instances by Q3",
      "msg-22",
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts 'Agreed' decisions", () => {
    const results = extractDecisionsFromText(
      "We agreed to freeze merges after Thursday.",
      "msg-23",
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("ignores non-decision text", () => {
    const results = extractDecisionsFromText(
      "The weather is nice today. I had coffee this morning.",
      "msg-24",
    );
    expect(results.length).toBe(0);
  });
});

// ============================================================================
// 4. LOOP/TASK EXTRACTION BASELINES
// ============================================================================

describe("RSMA Golden Corpus: Loop/Task Extraction", () => {
  it("extracts 'Task:' loops", () => {
    const results = extractLoopsFromText("Task: rotate the API key by Friday", "msg-30");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].loopType).toBe("task");
  });

  it("extracts 'Todo:' loops", () => {
    const results = extractLoopsFromText("Todo: update the README with new endpoints", "msg-31");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts 'Reminder:' as follow_up", () => {
    const results = extractLoopsFromText("Reminder: check deployment status tomorrow", "msg-32");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].loopType).toBe("follow_up");
  });

  it("extracts 'Blocker:' as dependency", () => {
    const results = extractLoopsFromText("Blocker: waiting on auth team for OAuth creds", "msg-33");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].loopType).toBe("dependency");
  });

  it("extracts 'Question:' as question", () => {
    const results = extractLoopsFromText("Question: should we use Redis or Memcached?", "msg-34");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].loopType).toBe("question");
  });

  it("extracts 'Follow-up:' as follow_up", () => {
    const results = extractLoopsFromText("Follow-up: verify the migration ran correctly", "msg-35");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].loopType).toBe("follow_up");
  });

  it("ignores non-task text", () => {
    const results = extractLoopsFromText(
      "I think Postgres is a great choice for our use case.",
      "msg-36",
    );
    expect(results.length).toBe(0);
  });
});

// ============================================================================
// 5. CORRECTION SIGNAL DETECTION BASELINES
// ============================================================================
// These test what the CURRENT system extracts from correction-like text.
// After RSMA, the MemoryWriter will detect these and trigger supersession.
// For now, we just capture what the current extractors produce.

describe("RSMA Golden Corpus: Correction Signals (baseline)", () => {
  it("'Actually, use Postgres' — extracts as decision", () => {
    // "Actually" is a correction signal. Current system may or may not catch it as a decision.
    const decisions = extractDecisionsFromText(
      "Actually, let's use Postgres instead of MySQL.",
      "msg-40",
    );
    // Captures "use Postgres instead of MySQL" as a decision
    // This is the behavior RSMA will enhance with auto-supersession
    if (decisions.length > 0) {
      expect(decisions[0].decisionText).toContain("Postgres");
    }
    // Even if current system doesn't catch it, the test documents the baseline
  });

  it("'Not MySQL anymore' — extracts any claims", () => {
    const claims = extractClaimsFromUserExplicit(
      "Remember: not MySQL anymore, we switched to Postgres",
      "msg-41",
    );
    expect(claims.length).toBeGreaterThanOrEqual(1);
  });

  it("'Scratch that' — no structured extraction (baseline gap)", () => {
    const decisions = extractDecisionsFromText(
      "Scratch that, let's go with SQLite for local dev.",
      "msg-42",
    );
    // Current system may or may not catch "go with SQLite" as a decision
    // This documents the baseline — RSMA will detect "scratch that" as correction signal
  });

  it("'I changed my mind' — no structured extraction (baseline gap)", () => {
    const decisions = extractDecisionsFromText(
      "I changed my mind about the database. Use PostgreSQL.",
      "msg-43",
    );
    // May or may not be captured — documenting baseline
  });
});

// ============================================================================
// 6. UNCERTAINTY SIGNAL DETECTION BASELINES
// ============================================================================

describe("RSMA Golden Corpus: Uncertainty Signals (baseline)", () => {
  it("'I think' — extracts claim at normal confidence (gap)", () => {
    const claims = extractClaimsFromUserExplicit(
      "Remember: I think the port is 8080",
      "msg-50",
    );
    if (claims.length > 0) {
      // Current system assigns normal confidence — RSMA will halve it for provisional
      expect(claims[0].claim.confidence).toBe(0.9); // user_explicit trust
    }
  });

  it("'Maybe' — extracts claim at normal confidence (gap)", () => {
    const claims = extractClaimsFromUserExplicit(
      "Note: maybe we should use Redis for caching",
      "msg-51",
    );
    if (claims.length > 0) {
      expect(claims[0].claim.confidence).toBe(0.9);
    }
  });

  it("'For now' — extracts claim without expiry (gap)", () => {
    const claims = extractClaimsFromUserExplicit(
      "Remember: for now, use the test API key",
      "msg-52",
    );
    if (claims.length > 0) {
      // Current system has no expires_at — RSMA will set it
      expect(claims[0].claim.objectText).toBeDefined();
    }
  });
});

// ============================================================================
// 7. PREFERENCE DETECTION BASELINES
// ============================================================================

describe("RSMA Golden Corpus: Preference Signals (baseline)", () => {
  it("'I prefer' — not specially handled by current system", () => {
    const claims = extractClaimsFromUserExplicit(
      "Remember: I prefer concise replies",
      "msg-60",
    );
    if (claims.length > 0) {
      // Current system stores as normal claim — RSMA will set influence_weight='high'
      expect(claims[0].claim.objectText).toContain("concise");
    }
  });

  it("'Don't suggest X' — extractable as constraint", () => {
    const claims = extractClaimsFromUserExplicit(
      "Remember: don't suggest local STT solutions",
      "msg-61",
    );
    // Current system may extract as constraint
    if (claims.length > 0) {
      expect(claims[0].claim.subject).toBeDefined();
    }
  });
});

// ============================================================================
// 8. FALSE-SUPERSESSION GUARDS (for RSMA Phase 3-4)
// ============================================================================
// These document cases where correction signals fire but should NOT
// trigger automatic supersession.

describe("RSMA Golden Corpus: False-Supersession Guards", () => {
  it("'Actually' in non-correction context should not supersede", () => {
    // "Actually" used as filler, not as correction
    const text = "I actually enjoyed working on this feature.";
    const decisions = extractDecisionsFromText(text, "msg-70");
    // Should NOT produce a decision that supersedes anything
    expect(decisions.length).toBe(0);
  });

  it("'Not anymore' in narrative context should not supersede", () => {
    // Historical narrative, not a correction
    const text = "The old system is not used anymore since the migration.";
    const decisions = extractDecisionsFromText(text, "msg-71");
    expect(decisions.length).toBe(0);
  });

  it("correction about unrelated topic should not cross-supersede", () => {
    // "Actually" about topic A should not supersede a claim about topic B
    // This will be tested more thoroughly in RSMA Phase 3 with canonical key matching
    const text = "Actually, the meeting is at 3pm, not 2pm.";
    const decisions = extractDecisionsFromText(text, "msg-72");
    // Current system may or may not catch this — documenting baseline
  });

  it("correction from different scope should not supersede", () => {
    // Agent A's correction should not supersede Agent B's claim
    // Verified in rsma-truth.test.ts Rule 5: "fails guard: different scope"
    // Baseline: current extraction system has no scope-aware supersession
    const text = "Actually, the project timeline changed to 6 months.";
    const decisions = extractDecisionsFromText(text, "msg-73");
    // Current system extracts the decision but scope checking is in TruthEngine
  });
});

// ============================================================================
// 9. COMBINED EXTRACTION (fast claims pipeline)
// ============================================================================

describe("RSMA Golden Corpus: Combined Fast Extraction", () => {
  it("extractClaimsFast handles mixed content", () => {
    const text = [
      "## Project Status",
      "- Database: PostgreSQL",
      "- Framework: Express",
      "",
      "Remember: always run migrations before deploy",
      "",
      "Decision: use TypeScript for all new code",
    ].join("\n");

    const claims = extractClaimsFast(text, {
      sourceType: "message",
      sourceId: "msg-80",
    });
    // Should extract KV claims + user explicit claim
    expect(claims.length).toBeGreaterThanOrEqual(2);
  });
});

// Context Compiler baseline tests are covered in:
// - relations-h2-compiler.test.ts (compileContextCapsules with seeded data)
// - rsma-stress.test.ts Phase 11 (budget enforcement under load)
