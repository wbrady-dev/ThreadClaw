# RSMA Architecture — Canonical Reference

> **RSMA (Reconciled Semantic Memory Architecture)** is a multi-layer agent architecture that combines retrieval, summary lineage, knowledge graphs, awareness, evidence-backed state, delta tracking, attempt memory, branch governance, and low-token context compilation.

> `RSMA = RAG + DAG + KG + AL + SL + DE + AOM + BSG + EEL + CCL`

## Layer Summary

| Layer | Name | What It Does | What Proves It |
|-------|------|-------------|----------------|
| **RAG** | Retrieval-Augmented Generation | Hybrid search (vector + BM25 + reranking) across documents and conversation history | 89 src tests (routes, parsers, chunking, CLI), full retrieval pipeline |
| **DAG** | Directed Acyclic Graph | Summary lineage with provenance — compacted context traces back to source messages | `engine.test.ts`: compaction rounds, summary DAG traversal, grep across summaries |
| **KG** | Knowledge Graph | Entity extraction, mention tracking, relationship mapping (relations stored as memory_objects kind='relation'), mismatch detection | 1000 entities upserted in 56ms, re-ingestion atomicity verified, relation queries |
| **AL** | Awareness Layer | Injects 1-3 contextual notes per turn — mismatches, stale refs, connections. Proactive awareness surfaces top entities when no matches in current turn | Eval harness: 26% fire rate, p50=18ms, p95=28ms, ~30-80 tokens/turn |
| **SL** | State Layer | Claims with evidence chains, decisions with auto-supersession, open loops with priority. Invariant extraction: LLM primary with regex fallback ("invariant" is an LLM event type) | 500 claims+evidence in 74ms, 10 rapid decision supersessions, loop lifecycle verified |
| **DE** | Delta Engine | Tracks state changes, confidence decay across 4 time windows | Decay formula verified: <7d=1.0, <30d=0.8, <90d=0.5, 90d+=0.3 |
| **AOM** | Attempt & Outcome Memory | Records tool success/failure, learns runbooks and anti-runbooks. Runbook auto-inference from 3+ consecutive successful tool uses | 300 attempts in 16ms, success rate calculation, evidence chains on both runbooks and anti-runbooks |
| **BSG** | Branch & Scope Governance | Speculative branches with policy-validated promotion | Branch create→promote verified, policy thresholds enforced (confidence + evidence count) |
| **EEL** | Evidence Event Log | Append-only audit trail, scope-local sequence ordering, idempotency | 1526 entries logged, scope_seq monotonic, UNIQUE constraint dedup, transaction rollback on crash |
| **CCL** | Context Compiler | ROI-scored capsule compilation within token budgets. CAPSULE_ORDER includes runbook (6) and relation (7). Runbook capsules show success rate. Capability warnings surfaced for unavailable/degraded tools | Lite=110, Standard=190, Premium=280 tokens enforced, 0.2ms/compile |

## What Changes With RSMA

**Without RSMA:** The agent re-derives facts from text, forgets what changed, retries failed approaches, answers from stale context, wastes tokens on broad retrieval dumps.

**With RSMA:** The agent gets a budgeted evidence capsule containing current claims, active decisions, open blockers, failure warnings, and entity context — all scored by relevance, confidence, and freshness.

## Trust-But-Verify

### What the tests cover

| Test Suite | Count | What It Verifies |
|-----------|-------|-----------------|
| ThreadClaw src tests | 89 | RAG pipeline, API routes, parsers, chunking, CLI |
| Memory engine tests | 858 | DAG compaction, memory tools, assembler, expansion, auth, all 10 RSMA layers, stress, failure injection, ontology, mo-store, truth engine, semantic extraction (43 test files) |
| **Total** | **947** | |

### What they do NOT cover

| Gap | Risk | Mitigation |
|-----|------|-----------|
| End-to-end through OpenClaw agent conversation | Low | Live-tested with Copper: cc_claims, cc_decisions, cc_memory, cc_recall all verified |
| Deep extraction with real LLM call | Low | Config gate verified; extraction logic tested with mock; real LLM quality depends on model |
| Awareness note quality (does it actually help?) | Medium | Eval harness records metrics; fire rate 75-94% in live sessions; quality needs human eval |
| cc_recall full delegated expansion | Low | Requires OpenClaw gateway context; lightweight mode auto-activates as fallback |
| Multi-process concurrent writes | Low | WAL mode + busy_timeout + BEGIN IMMEDIATE; edge case under heavy load |
| Clean-machine install on all 3 OS | Medium | CI matrix (ubuntu/windows/macos); tested on 2 machines (Windows) |
| Browser/TUI interaction (visual) | Low | Code audit verified all paths; no automated UI testing |

### Key features added after v0.1.0

| Feature | What It Does |
|---------|-------------|
| Ingest-time extraction | Claims and decisions extracted immediately when user speaks (no /compact needed) |
| cc_recall lightweight mode | Falls back to direct snippets when gateway expansion unavailable |
| Evidence fallback | cc_recall searches claims/decisions when summaries return zero |
| Cold structured archive | Three-tier: hot graph, cold archive.db, optional RAG. Copy-then-delete safety. |
| cc_diagnostics | Full RSMA health check: memory stats, evidence counts, awareness metrics, compiler state, archive stats |
| /analytics/diagnostics | HTTP endpoint for external monitoring (JSON) |
| Search tuning | Configurable rerank threshold, top-K, smart skip, similarity gate, prefix mode, batch size |
| "Has more" indicator | Truncated results signal availability of more data, guide agent to cc_claims/cc_decisions |
| Unified ontology | MemoryObject type with 15 kinds, provenance_links table replacing 7 legacy join tables |
| TruthEngine | 6 reconciliation rules with 5-point correction guard and first-class Conflict objects |
| Smart extraction | LLM-based semantic extraction mode — single structured call understands natural language |
| Fast extraction | Regex-only extraction mode — no LLM, <5ms, default when no model configured |

### Known limits

- In fast mode, entity extraction is regex-based (fast, but misses some entities a language model would catch). Smart mode uses LLM extraction for richer results.
- Context compiler estimates tokens at 4 chars/token (approximation, not exact tokenization)
- Deep extraction requires an LLM and costs tokens — not free
- Branch promotion policies are seeded defaults — may need tuning per deployment
- Awareness notes add ~30-80 tokens/turn to the system prompt (acceptable overhead, but not zero)
- Anti-runbook decay checks `updated_at` rather than individual failure timestamps

## Performance Budget

| Operation | Measured | Target |
|-----------|---------|--------|
| Entity extraction | <0.01ms/chunk | <5ms |
| Claim query | 0.4ms | <10ms |
| Context compilation | 0.2ms | <50ms |
| Timeline query | 0.5ms | <10ms |
| Awareness (total) | ~15ms | <50ms |
| 1000 entity upserts | 56ms | <5000ms |
| 500 claims + evidence | 74ms | <5000ms |

## File Structure

```
memory-engine/src/ontology/           — RSMA unified ontology (new)
  types.ts            — MemoryObject, MemoryKind (15 kinds), SourceKind, ProvenanceLink, RelevanceSignals, TaskMode weights
  canonical.ts        — per-kind canonical key generation (claim::subject::predicate, decision::topic, etc.)
  writer.ts           — regex-based message understanding (fast mode), produces MemoryObjects
  semantic-extractor.ts — LLM-based message understanding (smart mode), single structured LLM call
  truth.ts            — TruthEngine: 6 reconciliation rules, 5-point correction guard, conflict creation
  reader.ts           — unified read layer across graph.db, relevance-to-action ranking
  projector.ts        — provenance_links writer, supersession/conflict/evidence/mention recording
  correction.ts       — signal detection: correction, uncertainty, preference, temporal (regex, <1ms)
  migration.ts        — backfill legacy join tables → provenance_links (idempotent)
  index.ts            — barrel exports (includes normalizePredicate)

memory-engine/src/relations/          — Evidence OS stores + tools
  schema.ts           — 25 migrations, memory_objects + provenance_links + infrastructure tables + _legacy_* renamed tables
  evidence-log.ts     — withWriteTransaction, writeWithIdempotency, logEvidence, nextScopeSeq
  entity-extract.ts   — extractFast (3 strategies: capitalized, terms-list, quoted)
  graph-store.ts      — upsertEntity, insertMention, deleteGraphDataForSource
  awareness.ts        — buildAwarenessNote (graph queries, doc fallback, eval recording)
  confidence.ts       — effectiveConfidence (base * mentions * recencyWeight)
  claim-store.ts      — upsertClaim, supersedeClaim, addClaimEvidence, getActiveClaims
  claim-extract.ts    — extractClaimsFast (tool results, user explicit, doc KV, YAML)
  decision-store.ts   — upsertDecision (auto-supersede), getActiveDecisions
  loop-store.ts       — openLoop, closeLoop, updateLoop, getOpenLoops
  delta-store.ts      — recordStateDelta, getRecentDeltas
  capability-store.ts — upsertCapability, getCapabilities
  invariant-store.ts  — upsertInvariant, getActiveInvariants
  attempt-store.ts    — recordAttempt, getToolSuccessRate
  runbook-store.ts    — upsertRunbook, addRunbookEvidence, inferRunbookFromAttempts
  anti-runbook-store.ts — upsertAntiRunbook, addAntiRunbookEvidence
  promotion.ts        — createBranch, promoteBranch, checkPromotionPolicy
  context-compiler.ts — compileContextCapsules (ROI governor, budget enforcement)
  timeline.ts         — getTimeline, formatTimelineEvent
  snapshot.ts         — getStateAtTime, getEvidenceAtTime
  relation-store.ts   — upsertRelation, getRelationsForEntity
  deep-extract.ts     — extractClaimsDeep (wired), extractRelationsDeep (LLM-powered), recordStateDelta (wired)
  synthesis.ts        — synthesizeScope (LLM-powered evidence summary)
  decay.ts            — applyDecay (runbook staleness, anti-runbook confidence decay)
  terms.ts            — loadTerms (validated, cached 60s)
  eval.ts             — recordAwarenessEvent, getAwarenessStats (ring buffer, percentiles)
  tools.ts            — 9 cc_* evidence tools (cc_memory, cc_claims, cc_decisions, cc_loops, cc_attempts, cc_branch, cc_procedures, cc_synthesize, cc_diagnostics)
  index.ts            — exports
```

## Version History

| Version | Date | What Shipped |
|---------|------|-------------|
| Sprint 1-7 | Pre-2026-03-18 | RAG pipeline, DAG memory engine, multi-agent isolation |
| Sprint 8 | 2026-03-18 | H1: Entity graph, evidence log, awareness, eval harness |
| Sprint 9 | 2026-03-18 | H1: Awareness injection, cc_conflicts tool, entity-boosted search |
| Sprint 10 | 2026-03-18 | H2: Claims, decisions, loops, deltas, capabilities, invariants |
| Sprint 11 | 2026-03-18 | H2: Context compiler, ROI governor, remaining state tools |
| Sprint 12 | 2026-03-18 | H3: Attempts, runbooks, anti-runbooks, branches, promotion, decay |
| Sprint 13 | 2026-03-18 | H3: Leases, coordination |
| Sprint 14 | 2026-03-18 | H4: Timeline, snapshots, runbook evidence |
| Sprint 15 | 2026-03-18 | H5: Deep extraction, relations, synthesis, cc_ask, cc_relate |
| v0.1.0 | 2026-03-18 | RSMA Architecture complete — all 10 layers, 540 tests, 50-run durability |
| v0.2.0 | 2026-03-19 | Sidecar architecture: data consolidation (~/.threadclaw/data/), manifest versioning, threadclaw doctor/upgrade/integrate, managed OpenClaw integration (check-only startup), lock-protected transactional upgrades, backup validation, post-upgrade smoke test, PID-aware stale lock, backup retention, search tuning (rerank threshold/top-K/smart skip, similarity gate, prefix mode, batch size), ingest-time claim+decision extraction (no /compact required), cc_recall lightweight mode with evidence fallback (summaries→claims→decisions→messages), FTS5 OR fallback for long queries, LIKE partial match for claim/decision search, cold structured archive (hot/cold/RAG tiers with copy-then-delete safety, run tracking, restore, auto-trigger at 5000 events, VACUUM), cc_diagnostics observability tool + /analytics/diagnostics HTTP endpoint, "has more" truncation indicator with agent-guided follow-up |
| v0.2.1 | 2026-03-19 | Security hardening: command injection prevention (shell:false everywhere), binary dedup, query DoS protection, regression tests, docs audit |
| v0.3.0 | 2026-03-20 | TUI overhaul (Ink primary, capability detection, live status), spaCy NER integration (/ner endpoint, hybrid entity extraction), recommended install includes OCR + Whisper + NER, RSMA EEL fixes (scope_id propagation, decay evidence logging), awareness cache invalidation, token estimation improvements, port architecture (centralized constants), 1,197 tests passing (643 ThreadClaw + 554 memory-engine) |
| v0.3.1 | 2026-03-22 | RSMA unified ontology: MemoryObject type (13 kinds), provenance_links table (replaces 7 legacy join tables), TruthEngine (6 reconciliation rules, 5-point correction guard), MemoryReader (relevance-to-action ranking), semantic extraction (smart: LLM + fast: regex), historical data migration |
| v0.3.2 | 2026-03-23 | One True Ontology: memory_objects table (migration v16), full data migration (v17), legacy tables renamed to _legacy_* (v18), dual-write bridge removed, mo-store.ts as single CRUD entry point, extraction quality filters (code block stripping, junk claim rejection, confidence floor 0.35), typed interfaces (StructuredClaim/Decision/Loop/Entity), TUI full wipe reset (3 options), timing-safe API key auth, MCP path validation, cross-platform services (Linux systemd --user, macOS launchd, Windows Task Scheduler), 947 tests (89 src + 858 memory-engine) |
