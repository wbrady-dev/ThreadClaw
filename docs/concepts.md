# Core Concepts

## RSMA Architecture

> RSMA (Reconciled Semantic Memory Architecture) is a multi-layer agent architecture that combines retrieval, summary lineage, knowledge graphs, awareness, evidence-backed state, delta tracking, attempt memory, branch governance, and low-token context compilation.

`RSMA = RAG + DAG + KG + AL + SL + DE + AOM + BSG + EEL + CCL`

The layers work together: RAG provides the knowledge base, DAG tracks conversation lineage, KG builds entity graphs, AL surfaces context, SL manages claims/decisions/loops, DE tracks state changes, AOM records tool outcomes, BSG handles speculative branches, EEL provides the audit trail, and CCL compiles it all into a token-budgeted system prompt.

## ThreadClaw Evidence OS

The implementation of RSMA's stateful layers. Tracks structured knowledge extracted from conversations, documents, and tool results. All knowledge is stored as **MemoryObjects** in a single `memory_objects` table with a `kind` discriminator. Cross-references live in `provenance_links`.

### Unified Ontology

All knowledge types are MemoryObjects with one of 15 kinds: event, chunk, message, summary, claim, decision, entity, loop, attempt, procedure, invariant, delta, conflict, capability, relation. This replaced 13 legacy tables with one unified store (migration v16-v18). Relations were moved from provenance_links to memory_objects in migration v25.

### Entities & Awareness
**Entities** (kind='entity') are named concepts extracted from text (people, tools, projects). ThreadClaw tracks where each entity appears via provenance_links (predicate='mentioned_in'). Entity-to-entity relationships are stored as **Relations** (kind='relation') in memory_objects, with full lifecycle support (supersession, evidence chains, decay after 180 days, archival). **Awareness notes** surface relevant entity information in the system prompt -- mismatches across sources, stale references, and connections between entities. **Proactive awareness** surfaces top entities when no matches are found in the current turn.

### Claims & Decisions
**Claims** (kind='claim') are structured facts with StructuredClaim data: subject, predicate, objectText, topic. Each claim has a confidence score, trust score, and evidence chain via provenance_links (predicate='supports' or 'contradicts'). Evidence belief propagation: contradicting evidence reduces confidence, supporting evidence boosts it. **Decisions** (kind='decision') track active choices with automatic supersession -- when a new decision on the same topic is made, the old one is marked superseded.

### Open Loops
**Loops** (kind='loop') are pending items -- tasks, questions, follow-ups, dependencies. They have priority, owner, due date, and status (open, blocked, closed). The context compiler surfaces high-priority loops.

### Invariants
**Invariants** (kind='invariant') are durable constraints that must be respected -- "never force push to main", "always run tests before deploy". Ordered by severity (critical, error, warning, info).

### Capabilities
**Capabilities** track known tools, services, and systems with their current status (available, unavailable, degraded). These remain in their own `capabilities` table. **Capability warnings** are surfaced in the system prompt when tools are unavailable or degraded.

### State Deltas
**Deltas** (kind='delta') record what changed, from what value to what value, and when. Provides a change log for the knowledge base.

### Attempts & Procedures
**Attempts** (kind='attempt') record every tool execution with its outcome (success, failure, partial, timeout), duration, and error text. **Procedures** (kind='procedure') are learned patterns -- both success patterns (runbooks) and failure patterns (anti-runbooks) are stored as procedures. The structured_json field distinguishes them via an `isNegative` flag. Anti-runbooks are surfaced as high-priority warnings. Evidence links connect procedures to their supporting attempts via provenance_links (predicate='supports').

### Branches & Promotion
**Branches** enable speculative memory -- a sub-agent can write to a branch without affecting shared state. **Promotion** validates branch data against promotion policies (minimum confidence, evidence count, optional user confirmation) before merging to shared scope.

### Leases
**Leases** provide advisory coordination for multi-agent resource access. They expire naturally if an agent crashes.

### Evidence Decay
Procedure confidence decays over time. Anti-runbooks (negative procedures) decay by 0.8x every 90 days of inactivity. Runbooks with high failure rates get demoted. Stale items are marked for review. Relations decay after 180 days of inactivity (decayRelations).

### Timeline & Snapshots
The **timeline** is a chronological event log materialized from the append-only evidence log. **Snapshots** reconstruct the knowledge state at any point in time.

### Deep Extraction
Optional LLM-powered extraction of entity relationships and richer claims from unstructured text. Gated by config, uses the same model infrastructure as conversation summarization.

## Evidence Log
Every mutation to the evidence store is recorded in an append-only evidence log. This provides a complete audit trail, enables timeline reconstruction, and powers snapshot queries. Events are ordered by scope-local sequence numbers for causal consistency.

## Scopes & Branches
All evidence is scoped — associated with a scope (global, project, workspace) and optionally a branch (shared, run, subagent, hypothesis). The global scope (id=1) is seeded on first migration.

## Source Trust Hierarchy
MemoryObjects have a trust score based on their source_kind:
- tool_result: 1.0 (highest)
- user_explicit ("Remember: X"): 0.9
- document: 0.7
- message: 0.6
- extraction: 0.5
- compaction: 0.3
- inference: 0.2 (lowest)

## Extraction & Provenance

### Extraction Modes
ThreadClaw extracts structured knowledge from every message using one of two modes:

**Smart mode** (default when deep extraction model is configured): A single structured LLM call classifies the message and extracts all memory events in one pass. The LLM understands natural language without magic prefixes — "We're going with Postgres" is recognized as a decision, "Actually no, use MySQL" as a correction, "I think it's port 8080" as an uncertain claim. Uses the same model configured for deep extraction. Falls back to fast mode if the LLM call fails.

**Fast mode** (default when no model is configured): Regex-only extraction with no LLM calls, completing in <5ms. Detects structured signals: "Remember:" statements, heading+bullet patterns, YAML frontmatter, tool results, "We decided..." patterns, capitalized entity names, and correction/uncertainty/preference/temporal signals.

Configure with: `THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE=smart|fast`

### Unified Ontology
All extracted knowledge is represented as `MemoryObject` instances. There are 15 kinds: event, chunk, message, summary, claim, decision, entity, loop, attempt, procedure, invariant, delta, conflict, capability, and relation. Each MemoryObject carries provenance (where it came from), confidence, freshness, a lifecycle status, and an influence weight.

### Provenance Links
Cross-object relationships are stored in a single `provenance_links` table with typed predicates: derived_from, supports, contradicts, supersedes, mentioned_in, resolved_by. This replaces 7 legacy join tables. Entity-to-entity relations (formerly predicate='relates_to') are now stored as memory_objects (kind='relation') with full lifecycle support. SUPERSESSION_KINDS includes claim, decision, entity, capability, and relation.

### TruthEngine
When new MemoryObjects are extracted, the TruthEngine reconciles them against existing knowledge using 6 rules:
1. Higher confidence supersedes lower
2. Equal confidence — newer wins
3. Lower confidence adds supporting evidence
4. Contradictory values create first-class Conflict objects
5. Correction signals ("actually...") trigger auto-supersession with a 5-point safety guard
6. Provisional statements ("I think...") don't override established beliefs

## Context Compiler & ROI Governor
The context compiler scores every evidence capsule on usefulness, confidence, freshness, and scope fit. It ranks by score-per-token and fills the budget greedily. Budget tiers: Lite (110 tokens), Standard (190), Premium (280).
