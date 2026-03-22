---
name: clawcore-evidence
description: ClawCore Evidence OS — structured memory for agents. Use cc_memory to search for anything, cc_diagnostics for health.
---

# ClawCore Evidence OS

ClawCore automatically extracts and tracks structured knowledge from conversations. Claims, decisions, relationships, and awareness notes are created and injected without tool calls.

**Most of CRAM is automatic. You do not need to call tools for it to work.**

## What happens automatically (no tool call needed)
- **Awareness notes** injected into your system prompt every turn — surfaces mismatches, stale references, and entity connections
- **Named entity extraction** via spaCy NER — people, organizations, locations, dates extracted from all ingested content and conversations
- **Claims** extracted from "Remember:" statements, narrative facts, tool results, document headings, YAML frontmatter, and assistant project descriptions
- **Decisions** extracted from "We decided..." and similar patterns (user messages only)
- **Tool outcomes** tracked from every tool execution (success/fail, duration, error)
- **Procedures** learned automatically — success patterns (runbooks) and failure patterns (anti-runbooks)
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
- Shows internal CRAM health: memory stats, evidence counts, awareness metrics, compiler state, capabilities, recent events
- Use `verbose: true` for event timeline and capsule content
- Not for answering user questions

## Specialist Tools (use when cc_memory isn't enough)

| Tool | When to Use |
|------|-------------|
| `cc_claims { "subject": "..." }` | Deep dive into specific claims with evidence chains |
| `cc_decisions { "topic": "..." }` | Decision history with supersession tracking |
| `cc_loops` | Open tasks, questions, and blockers |
| `cc_attempts { "tool_name": "..." }` | Tool outcome history with success rates |
| `cc_procedures { "type": "failure" }` | Learned success and failure patterns (type: "success", "failure", or "all") |
| `cc_branch { "action": "create" }` | Branch management: create, list, discard, or promote speculative branches |
| `cc_grep { "query": "..." }` | Exact text search in conversation history |
| `cc_describe { "summaryId": "..." }` | Inspect a specific summary (cheap, no sub-agent) |
| `cc_recall { "query": "...", "prompt": "..." }` | Deep semantic recall with DAG expansion (slow, ~2 min) |
| `cc_expand { "summaryId": "..." }` | Expand a compacted summary to recover detail |

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
  |
  +-- Need tool history/patterns? --> cc_attempts / cc_procedures
  |
  +-- Debugging/health check? --> cc_diagnostics
```

## Token Cost Guide

| Tool | Cost | Notes |
|------|------|-------|
| cc_memory | ~100-300 tokens | Searches everything automatically |
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
| cc_recall | ~200-500 tokens | Deep recall — slow (~2 min), use sparingly |

## How Awareness Works

Awareness notes are automatically injected into your system prompt. They surface:
- **Mismatches** — when the same entity appears with conflicting context across sources
- **Stale references** — entities you mention that haven't been seen recently
- **Connections** — entities that co-occur in the same documents

Entities are extracted using spaCy NER (people, organizations, locations, dates, events, products) and regex patterns. The entity cache refreshes immediately when new entities are added.

You do not need to call any tool for awareness — it runs every turn automatically.

## Tool Availability

All CRAM tools require Evidence OS to be enabled (`CLAWCORE_MEMORY_RELATIONS_ENABLED=true`).

The 4 core tools (`cc_memory`, `cc_grep`, `cc_describe`, `cc_expand`) are always available regardless of Evidence OS settings.

## Setup

This skill is installed automatically during ClawCore installation.

Evidence OS is configured in the ClawCore TUI under **Configure > Evidence OS**, or in `.env`.
