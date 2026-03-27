---
name: threadclaw-evidence
description: ThreadClaw Evidence OS — structured memory for agents. Use cc_memory to search for anything, cc_diagnostics for health.
---

# ThreadClaw Evidence OS

ThreadClaw automatically extracts and tracks structured knowledge from conversations. All knowledge is stored as `MemoryObject` instances in the unified `memory_objects` table with 9 agent-facing kinds (claim, decision, entity, loop, attempt, procedure, invariant, relation, conflict). Relations are first-class memory objects (`kind='relation'`) with full lifecycle support (creation, supersession, decay). Cross-object evidence relationships are stored in `provenance_links` with typed predicates (supports, contradicts, supersedes, mentioned_in, resolved_by, derived_from).

**Most of RSMA is automatic. You do not need to call tools for it to work.**

## Extraction Modes

ThreadClaw uses one of two extraction modes (configured via `THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE`):

- **Smart** (default when deep extraction model is configured): LLM-primary semantic extraction. A single structured LLM call understands natural language without magic prefixes — "We're going with Postgres" is understood as a decision, "Actually no" as a correction. Uses the same model as deep extraction. Includes LLM-powered invariant extraction (automatically detects invariants from conversation context).
- **Fast** (default when no model is configured): Regex-only extraction with regex-based invariant detection as fallback, no LLM calls, <5ms. Detects structured patterns like "Remember:", "We decided...", YAML frontmatter, tool results.

Both modes produce `MemoryObject` instances that are reconciled by the TruthEngine. Smart mode extracts more from natural language; fast mode requires more explicit patterns.

Extraction quality is enforced by multiple filters: code block stripping (```blocks removed before LLM extraction), confidence floor (events below 0.35 rejected), and post-extraction junk filters (reject metadata, file paths, URLs, transient noise).

## What happens automatically (no tool call needed)
- **Awareness notes** injected into your system prompt every turn — surfaces mismatches, stale references, entity connections, and **proactive awareness** (top entities surfaced when no specific matches are found)
- **Capability warnings** — unavailable or degraded capabilities are surfaced as warnings in the system prompt
- **Named entity extraction** via spaCy NER — people, organizations, locations, dates extracted from all ingested content and conversations
- **Claims** extracted from natural language (smart mode) or structured patterns like "Remember:" statements, tool results, document headings, YAML frontmatter (fast mode)
- **Decisions** extracted from natural language (smart mode) or "We decided..." patterns (fast mode, user messages only)
- **TruthEngine reconciliation** — new knowledge is automatically reconciled against existing beliefs (supersession, conflict detection, evidence accumulation)
- **Tool outcomes** tracked from every tool execution (success/fail, duration, error)
- **Procedures** learned automatically — success patterns (runbooks) and failure patterns (anti-runbooks). Runbook capsules auto-inferred in CCL after 3+ consecutive successes.
- **Evidence belief propagation** — contradict/support links between claims automatically update confidence (contradictions lower confidence, support raises it)
- **Relation lifecycle** — relations stored as `memory_objects` (kind='relation') with full creation, supersession, and decay (stale after 180 days via `decayRelations`)
- **Context capsules** compiled and injected each turn (top claims, decisions, warnings, constraints) within a token budget
- **Confidence decay** reduces stale evidence over time
- **Evidence archival** when data exceeds 5000 events

## CRITICAL RULES

1. **Do not search for information already in your current context.** The capsule already contains the most important facts.
2. **Use `cc_memory` for any recall question.** It searches everything automatically.
3. **Use one tool call, then at most one follow-up.** Never chain 3+ calls.
4. **Do not loop.** If nothing is found, say so.
5. **Never dump raw tool output.** Summarize in 1-3 sentences.

## Primary Tools (use these)

### cc_memory — Search everything
```json
cc_memory { "query": "what you're looking for" }
cc_memory { "query": "Project Aurora", "scope": "all" }
```
- **This is the main tool.** Use it for any question about facts, decisions, relationships, or past conversations.
- Automatically searches: claims, decisions, relationships, summaries, messages, and documents
- Returns results with source labels (Known Facts, Decisions, Relationships, From Summaries, From Conversation, From Documents)
- Use `"scope": "all"` to search across all conversations (default: current only)
- If results are truncated, follow up with `cc_claims` or `cc_decisions` for complete data.

### cc_diagnostics — System health
```json
cc_diagnostics {}
cc_diagnostics { "verbose": true }
```
- Shows internal RSMA health: memory stats, evidence counts, awareness metrics, compiler state, capabilities, recent events
- Use `verbose: true` for event timeline and capsule content
- Not for answering user questions

### cc_synthesize — Cross-cutting analysis
```json
cc_synthesize { "query": "how do our caching decisions relate to performance issues?" }
```
- Synthesizes insights across multiple knowledge types (claims, decisions, entities, relations)
- Use when a question spans multiple topics or needs cross-referencing
- Returns a narrative synthesis, not raw data

## Specialist Tools (use when cc_memory isn't enough)

| Tool | When to Use |
|------|-------------|
| `cc_claims { "subject": "..." }` | Deep dive into specific claims with evidence chains |
| `cc_decisions { "topic": "..." }` | Decision history with supersession tracking |
| `cc_loops` | Open tasks, questions, and blockers |
| `cc_attempts { "tool_name": "..." }` | Tool outcome history with success rates |
| `cc_procedures { "type": "failure" }` | Learned success and failure patterns (type: "success", "failure", or "all") |
| `cc_branch { "action": "create" }` | Branch management: create, list, discard, or promote speculative branches |
| `cc_grep { "pattern": "..." }` | Exact text/regex search in conversation history |
| `cc_describe { "id": "sum_xxx" }` | Inspect a specific summary or file (cheap, no sub-agent) |
| `cc_recall { "query": "...", "prompt": "..." }` | Deep semantic recall with DAG expansion (slow, ~2 min, spawns sub-agent). Cannot be called from within delegated sessions. |
| `cc_expand { "summaryIds": ["sum_xxx"] }` | Expand one or more compacted summaries to recover detail |

## Decision Tree

```text
User asks something?
  |
  +-- Already in your context? --> USE IT. No tool call.
  |
  +-- Need to recall or find something? --> cc_memory
  |
  +-- cc_memory wasn't enough?
  |     +-- Need exact text? --> cc_grep
  |     +-- Need all claims on a topic? --> cc_claims
  |     +-- Need decision history? --> cc_decisions
  |     +-- Need open tasks/blockers? --> cc_loops
  |     +-- Need to inspect a summary? --> cc_describe
  |     +-- Need to recover compacted detail? --> cc_expand
  |     +-- Need deep multi-step recall with synthesis? --> cc_recall (slow, ~2 min)
  |
  +-- Need tool history/patterns? --> cc_attempts / cc_procedures
  |
  +-- Need cross-cutting synthesis? --> cc_synthesize
  |
  +-- Debugging/health check? --> cc_diagnostics
```

## Token Cost Guide

| Tool | Cost | Notes |
|------|------|-------|
| cc_memory | ~100-300 tokens | Searches everything automatically |
| cc_synthesize | ~200-500 tokens | Cross-cutting analysis and synthesis |
| cc_diagnostics | ~200 tokens | Health check (+verbose for events) |
| cc_claims | ~100 tokens | Specific claims with evidence |
| cc_decisions | ~50 tokens | Decision history |
| cc_loops | ~50 tokens | Open tasks |
| cc_attempts | ~100 tokens | Tool outcome history |
| cc_procedures | ~100 tokens | Success and failure patterns |
| cc_branch | ~50 tokens | Branch management |
| cc_grep | ~50-200 tokens | Exact text search |
| cc_describe | ~50 tokens | Cheap summary inspection |
| cc_expand | ~200 tokens | Summary expansion |
| cc_recall | ~500-2000+ tokens | Deep recall — spawns sub-agent (~2 min), use sparingly |

## How Awareness Works

Awareness notes are automatically injected into your system prompt. They surface:
- **Mismatches** — when the same entity appears with conflicting context across sources
- **Stale references** — entities you mention that haven't been seen recently
- **Connections** — entities that co-occur in the same documents
- **Proactive awareness** — when no specific matches are found, the top relevant entities are surfaced automatically to maintain contextual grounding

Entities are extracted using spaCy NER (people, organizations, locations, dates, events, products) and regex patterns. The entity cache refreshes immediately when new entities are added.

You do not need to call any tool for awareness — it runs every turn automatically.

## Tool Availability

All RSMA tools require Evidence OS to be enabled (`THREADCLAW_MEMORY_RELATIONS_ENABLED=true`).

The 4 core tools (`cc_grep`, `cc_describe`, `cc_expand`, `cc_recall`) are always available regardless of Evidence OS settings. `cc_memory` requires Evidence OS.

The extraction mode is transparent to tools — the same tools work regardless of whether smart or fast extraction is active.

## Setup

This skill is installed automatically during ThreadClaw installation.

Evidence OS is configured in the ThreadClaw TUI under **Configure > Evidence OS**, or in `.env`.
