# Quick Start

## 1. Install

```bash
git clone https://github.com/wbrady-dev/ThreadClaw.git
cd threadclaw && npm install
```

## 2. Start the Service

```bash
threadclaw serve    # HTTP API on port 18800
# OR
threadclaw          # Interactive TUI
```

## Running Services

`threadclaw serve` starts the ThreadClaw RAG API (and the Python model server if local models are configured):

- **Model server** (embedding + reranking) on port **8012** -- only started when needed; lazy-spawns on first request and shuts down after idle timeout. Skipped entirely if external embedding/reranking endpoints are configured.
- **ThreadClaw API** on port **18800** (default, localhost only)

The command automatically stops any existing processes on those ports before starting. Logs from both services are streamed to the terminal with `[models]` and `[threadclaw]` prefixes.

**Stopping**: Press `Ctrl+C` for graceful shutdown. Both processes receive SIGTERM and are force-killed after 5 seconds if still running. You can also send `POST /shutdown` to the API for programmatic shutdown.

**Background services**: On Windows, ThreadClaw can run as Task Scheduler tasks (no admin required). On Linux, use `systemd --user` units. On macOS, use launchd user agents. All platforms support `POST /shutdown` for graceful stop.

**Health check**: `GET http://127.0.0.1:18800/health` (no auth required).

## 3. Ingest Documents

```bash
threadclaw ingest ./documents/ -r --collection research
```

## 4. Search

```bash
threadclaw query "what is VLSM?" --collection research --brief
```

## 5. Connect to OpenClaw

ThreadClaw integrates with OpenClaw as both a knowledge skill and memory engine plugin. The TUI installer handles this automatically.

## 6. Enable Evidence OS (Optional)

Add to `.env`:

```bash
THREADCLAW_MEMORY_RELATIONS_ENABLED=true
THREADCLAW_MEMORY_RELATIONS_AWARENESS_ENABLED=true
```

This enables:
- Entity extraction from conversations and documents
- Awareness notes injected into agent prompts
- Evidence graph (claims, decisions, loops, etc.)

## 7. Configure Extraction Mode (Optional)

By default, ThreadClaw uses **smart** extraction (LLM-based) when deep extraction is enabled, and **fast** extraction (regex-only) otherwise. To set explicitly:

```bash
# In .env:
THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE=smart   # LLM-based, understands natural language
# or
THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE=fast     # Regex-only, no LLM, <5ms
```

Smart mode uses the same model as deep extraction — no extra model to configure.

## 8. Verify Awareness

After a few conversations with entity mentions, check:

```bash
# Via CLI tools (from agent)
cc_diagnostics    # View RSMA health: memory stats, evidence counts, awareness metrics
cc_memory { "query": "what we discussed" }  # Search everything
```

## 9. Inspect State

```bash
cc_claims         # List claims with evidence chain
cc_decisions      # View decision history
cc_loops          # View open tasks and dependencies
cc_procedures     # View learned success and failure patterns
cc_attempts       # View tool execution history
```

## Next Steps

- [Configuration Guide](configuration.md) — Full environment variable reference
- [Tools Reference](tools.md) — All 12 agent tools documented
- [Concepts](concepts.md) — Understanding RSMA, awareness, claims, branches
