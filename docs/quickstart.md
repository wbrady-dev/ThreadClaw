# Quick Start

## 1. Install

```bash
git clone https://github.com/openclaw/clawcore.git
cd clawcore && npm install
```

## 2. Start the Service

```bash
clawcore serve    # HTTP API on port 18800
# OR
clawcore          # Interactive TUI
```

## 3. Ingest Documents

```bash
clawcore ingest ./documents/ -r --collection research
```

## 4. Search

```bash
clawcore query "what is VLSM?" --collection research --brief
```

## 5. Connect to OpenClaw

ClawCore integrates with OpenClaw as both a knowledge skill and memory engine plugin. The TUI installer handles this automatically.

## 6. Enable Evidence OS (Optional)

Add to `.env`:

```bash
CLAWCORE_MEMORY_RELATIONS_ENABLED=true
CLAWCORE_MEMORY_RELATIONS_AWARENESS_ENABLED=true
```

This enables:
- Entity extraction from conversations and documents
- Awareness notes injected into agent prompts
- Evidence graph (claims, decisions, loops, etc.)

## 7. Verify Awareness

After a few conversations with entity mentions, check:

```bash
# Via CLI tools (from agent)
cc_state          # View active claims, decisions, open loops
cc_conflicts      # Check for entity mismatches
cc_timeline       # View evidence event log
```

## 8. Inspect State

```bash
cc_claims         # List claims with evidence chain
cc_decisions      # View decision history
cc_loops          # View open tasks and dependencies
cc_invariants     # View durable constraints
cc_capabilities   # View known tools/services
```

## Next Steps

- [Configuration Guide](configuration.md) — Full environment variable reference
- [Tools Reference](tools.md) — All 22 agent tools documented
- [Concepts](concepts.md) — Understanding CRAM, awareness, claims, branches
