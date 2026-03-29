# ThreadClaw Memory Engine

DAG-based lossless conversation memory for [OpenClaw](https://openclaw.ai), part of the [ThreadClaw](https://github.com/wbrady-dev/ThreadClaw) RSMA system. Replaces OpenClaw's built-in sliding-window compaction with a DAG-based summarization system that preserves every message while keeping active context within model token limits.

Based on the [LCM paper](https://papers.voltropy.com/LCM) from [Voltropy](https://x.com/Voltropy).

## Table of contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Development](#development)
- [License](#license)

## What it does

When a conversation grows beyond the model's context window, OpenClaw normally truncates older messages. ThreadClaw Memory instead:

1. **Persists every message** in a SQLite database, organized by conversation
2. **Summarizes chunks** of older messages into summaries using your configured LLM
3. **Condenses summaries** into higher-level nodes as they accumulate, forming a DAG (directed acyclic graph)
4. **Assembles context** each turn by combining summaries + recent raw messages
5. **Provides tools** (`cc_grep`, `cc_describe`, `cc_expand`, `cc_recall`) so agents can search and recall details from compacted history

Nothing is lost. Raw messages stay in the database. Summaries link back to their source messages. Agents can drill into any summary to recover the original detail.

6. **Smart context injection** — the context compiler scores capsules by `(usefulness x confidence x freshness x scopeFit) / tokenCost` and applies **query-aware relevance boosting**: the last user message is tokenized into keywords, and each capsule's score is multiplied by its keyword overlap (0.2-1.0 range), so the most relevant evidence surfaces first
7. **Epistemic labels** — every capsule carries an epistemic tag: `[FIRM]` (confidence >= 0.9, not contested), `[CONTESTED]` (referenced by an active conflict), or `[PROVISIONAL]` (confidence < 0.5), giving the model calibrated certainty signals
8. **Session briefing** — on session change, a `[Session Briefing]` line is prepended to the system prompt summarizing what changed since the last session (new/superseded decisions, new/superseded claims, flagged claims, conflicts, invariants)
9. **Invariant enforcement at write time** — strict invariants are checked against every incoming write. Forbidden terms are extracted from invariant descriptions via negation patterns (never/do not/must not/avoid/prohibited), cached for 30s, and matched against normalized content (NFKD decomposed, zero-width chars stripped). Violations are returned with the invariant key, severity, and match reason
10. **Deep document extraction** — during document ingest, an LLM extracts factual claims (subject/predicate/objectText/confidence) from each chunk and stores them as provisional claims (confidence capped at 0.4, trust 0.4) via the claim store. Uses a concurrency semaphore (max 2), processes up to 10 chunks per document, and falls back gracefully when no model is available

11. **Extracts structured knowledge** via the RSMA semantic extraction pipeline — claims, decisions, entities, tasks, and corrections are extracted from every message using either **smart** (LLM-based) or **fast** (regex-only) mode
7. **Reconciles new knowledge** via the TruthEngine — supersession, conflict detection, evidence accumulation, and correction handling with a 5-point safety guard
8. **Tracks provenance** via a unified `provenance_links` table — every relationship between knowledge objects is typed (derived_from, supports, contradicts, supersedes, mentioned_in, relates_to, resolved_by)

**It feels like talking to an agent that never forgets. Because it doesn't.**

## Quick start

### Prerequisites

- OpenClaw with plugin context engine support
- Node.js 22+
- An LLM provider configured in OpenClaw (used for summarization)

### Install the plugin

Use OpenClaw's plugin installer (recommended):

```bash
openclaw plugins install threadclaw-memory
```

If you're running from a local OpenClaw checkout, use:

```bash
pnpm openclaw plugins install threadclaw-memory
```

For local plugin development, link your working copy instead of copying files:

```bash
openclaw plugins install --link /path/to/threadclaw/memory-engine
```

The install command records the plugin, enables it, and applies compatible slot selection (including `contextEngine` when applicable).

### Configure OpenClaw

In most cases, no manual JSON edits are needed after `openclaw plugins install`.

If you need to set it manually, ensure the context engine slot points at threadclaw-memory:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "threadclaw-memory"
    }
  }
}
```

Restart OpenClaw after configuration changes.

## Configuration

ThreadClaw Memory is configured through a combination of plugin config and environment variables. Environment variables take precedence for backward compatibility.

### Plugin config

Add a `threadclaw-memory` entry under `plugins.entries` in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "threadclaw-memory": {
        "enabled": true,
        "config": {
          "freshTailCount": 32,
          "contextThreshold": 0.75,
          "incrementalMaxDepth": -1
        }
      }
    }
  }
}
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_ENABLED` | `true` | Enable/disable the plugin |
| `LCM_DATABASE_PATH` | `~/.threadclaw/data/memory.db` | Path to the SQLite database |
| `LCM_CONTEXT_THRESHOLD` | `0.75` | Fraction of context window that triggers compaction (0.0-1.0) |
| `LCM_FRESH_TAIL_COUNT` | `32` | Number of recent messages protected from compaction |
| `LCM_LEAF_MIN_FANOUT` | `8` | Minimum raw messages per leaf summary |
| `LCM_CONDENSED_MIN_FANOUT` | `4` | Minimum summaries per condensed node |
| `LCM_CONDENSED_MIN_FANOUT_HARD` | `2` | Relaxed fanout for forced compaction sweeps |
| `LCM_INCREMENTAL_MAX_DEPTH` | `0` | How deep incremental compaction goes (0 = leaf only, -1 = unlimited) |
| `LCM_LEAF_CHUNK_TOKENS` | `20000` | Max source tokens per leaf compaction chunk |
| `LCM_LEAF_TARGET_TOKENS` | `1200` | Target token count for leaf summaries |
| `LCM_CONDENSED_TARGET_TOKENS` | `2000` | Target token count for condensed summaries |
| `LCM_MAX_EXPAND_TOKENS` | `4000` | Token cap for sub-agent expansion queries |
| `LCM_LARGE_FILE_TOKEN_THRESHOLD` | `25000` | File blocks above this size are intercepted and stored separately |
| `LCM_LARGE_FILE_SUMMARY_PROVIDER` | `""` | Provider override for large-file summarization |
| `LCM_LARGE_FILE_SUMMARY_MODEL` | `""` | Model override for large-file summarization |
| `LCM_SUMMARY_MODEL` | *(from OpenClaw)* | Model for summarization |
| `LCM_SUMMARY_PROVIDER` | *(from OpenClaw)* | Provider used with a bare `LCM_SUMMARY_MODEL` value when you want to override the session provider |
| `LCM_AUTOCOMPACT_DISABLED` | `false` | Disable automatic compaction after turns |
| `LCM_PRUNE_HEARTBEAT_OK` | `false` | Retroactively delete `HEARTBEAT_OK` turn cycles from storage |

### Summary model priority

When choosing which model to use for summarization, ThreadClaw Memory follows this priority order (highest to lowest):

1. Plugin config `summaryModel` (from `plugins.entries.threadclaw-memory.config.summaryModel`)
2. Environment variable `LCM_SUMMARY_MODEL`
3. OpenClaw's `agents.defaults.compaction.model` (if configured)
4. Current session model (inherited from the active conversation)
5. OpenClaw's `agents.defaults.model.primary` (system default)

`summaryProvider` is not an independent selector. It is only used when the chosen `summaryModel` is a bare model name without a provider prefix. If no explicit `summaryProvider` is configured for that level, ThreadClaw Memory falls back to the active session provider hint and emits a warning.

### Recommended starting configuration

```
LCM_FRESH_TAIL_COUNT=32
LCM_INCREMENTAL_MAX_DEPTH=-1
LCM_CONTEXT_THRESHOLD=0.75
```

- **freshTailCount=32** protects the last 32 messages from compaction, giving the model enough recent context for continuity.
- **incrementalMaxDepth=-1** enables unlimited automatic condensation after each compaction pass — the DAG cascades as deep as needed. Set to `0` (default) for leaf-only, or a positive integer for a specific depth cap.
- **contextThreshold=0.75** triggers compaction when context reaches 75% of the model's window, leaving headroom for the model's response.

### OpenClaw session reset settings

ThreadClaw Memory preserves history through compaction, but it does **not** change OpenClaw's core session reset policy. If sessions are resetting sooner than you want, increase OpenClaw's `session.reset.idleMinutes` or use a channel/type-specific override.

```json
{
  "session": {
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    }
  }
}
```

- `session.reset.mode: "idle"` keeps a session alive until the idle window expires.
- `session.reset.idleMinutes` is the actual reset interval in minutes.
- OpenClaw does **not** currently enforce a maximum `idleMinutes`; in source it is validated only as a positive integer.
- If you also use daily reset mode, `idleMinutes` acts as a secondary guard and the session resets when **either** the daily boundary or the idle window is reached first.
- Legacy `session.idleMinutes` still works, but OpenClaw prefers `session.reset.idleMinutes`.

Useful values:

- `1440` = 1 day
- `10080` = 7 days
- `43200` = 30 days
- `525600` = 365 days

For most long-lived setups, a good starting point is:

```json
{
  "session": {
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    }
  }
}
```

## Agent Tools

16 tools registered: 4 core conversation tools + 12 evidence tools.

| Tool | Access | Description |
|------|--------|-------------|
| `cc_grep` | All agents | Full-text/regex search across compacted conversation history |
| `cc_describe` | All agents | Inspect a specific summary or stored file |
| `cc_expand` | Sub-agents only | Low-level DAG expansion |
| `cc_recall` | Main agent | Deep recall with sub-agent DAG expansion |
| `cc_memory` | All agents | Unified smart search across all memory sources |
| `cc_claims` | All agents | Claims with evidence chains |
| `cc_decisions` | All agents | Decision history with supersession |
| `cc_loops` | All agents | Open tasks, questions, dependencies |
| `cc_manage_loop` | All agents | Close, update, or change loop status and priority |
| `cc_attempts` | All agents | Tool outcome history with success rates |
| `cc_branch` | All agents | Speculative branch management |
| `cc_procedures` | All agents | Learned success/failure patterns |
| `cc_conflicts` | All agents | View and resolve contradictions between facts |
| `cc_state` | All agents | Aggregated view of everything known about a subject |
| `cc_timeline` | All agents | How knowledge about a subject evolved over time |
| `cc_diagnostics` | All agents | Internal RSMA health and observability |

Evidence tools require Evidence OS (`THREADCLAW_MEMORY_RELATIONS_ENABLED=true`).

## Documentation

- [Configuration guide](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Agent tools](../docs/tools.md)
- [TUI Reference](docs/tui.md)
- [lcm-tui](tui/README.md)
- [Optional: enable FTS5 for fast full-text search](docs/fts5.md)

## Development

```bash
# Run tests
npx vitest run --dir test

# Type check
npx tsc --noEmit

# Run a specific test file
npx vitest test/engine.test.ts
```

### Project structure

```
index.ts                    # Plugin entry point and registration
src/
  engine.ts                 # ThreadClaw Memory Engine — implements ContextEngine interface
  assembler.ts              # Context assembly (summaries + messages -> model context)
  compaction.ts             # CompactionEngine — leaf passes, condensation, sweeps
  summarize.ts              # Depth-aware prompt generation and LLM summarization
  retrieval.ts              # RetrievalEngine — grep, describe, expand operations
  expansion.ts              # DAG expansion logic for cc_recall
  expansion-auth.ts         # Delegation grants for sub-agent expansion
  expansion-policy.ts       # Depth/token policy for expansion
  large-files.ts            # File interception, storage, and exploration summaries
  integrity.ts              # DAG integrity checks and repair utilities
  transcript-repair.ts      # Tool-use/result pairing sanitization
  types.ts                  # Core type definitions (dependency injection contracts)
  openclaw-bridge.ts        # Bridge utilities
  utils/
    tokens.ts               # Shared token estimation utility
  db/
    config.ts               # Config resolution from env vars
    connection.ts           # SQLite connection management
    migration.ts            # Schema migrations
  store/
    conversation-store.ts   # Message persistence and retrieval
    summary-store.ts        # Summary DAG persistence and context item management
    fts5-sanitize.ts        # FTS5 query sanitization
  ontology/                 # RSMA unified ontology
    types.ts                # MemoryObject, MemoryKind (15 kinds), ProvenanceLink, LinkPredicate, RelevanceSignals
    canonical.ts            # Per-kind canonical key generation for dedup/supersession
    mo-store.ts             # Unified CRUD for memory_objects table (upsert, supersede, query)
    writer.ts               # Fast mode: regex-based message understanding (<5ms)
    semantic-extractor.ts   # Smart mode: LLM-based semantic extraction (code block stripping, confidence floor 0.35)
    direct-llm.ts           # Direct LLM call utilities for semantic extraction
    truth.ts                # TruthEngine: 6 reconciliation rules, 5-point correction guard
    reader.ts               # Unified read layer with relevance-to-action ranking (5 task modes)
    projector.ts            # provenance_links writer, supersession/conflict recording
    correction.ts           # Signal detection: correction, uncertainty, preference, temporal
    migration.ts            # Backfill legacy join tables -> provenance_links
    index.ts                # Barrel exports
  tools/
    lcm-grep-tool.ts        # cc_grep tool implementation
    lcm-describe-tool.ts    # cc_describe tool implementation
    lcm-expand-tool.ts      # cc_expand tool (sub-agent only)
    lcm-expand-query-tool.ts # cc_recall tool (main agent wrapper)
    lcm-conversation-scope.ts # Conversation scoping utilities
    common.ts               # Shared tool utilities
test/                       # Vitest test suite
specs/                      # Design specifications
openclaw.plugin.json        # Plugin manifest with config schema and UI hints
tui/                        # Interactive terminal UI (Go)
```

## License

MIT
