# Troubleshooting

## First Step: Run Doctor

Before debugging manually, run the diagnostic tool:

```bash
threadclaw doctor
```

This checks versions, data integrity, OpenClaw integration, services, skills, and compatibility in one pass. It will tell you exactly what's wrong and how to fix it.

Other useful commands:
- `threadclaw doctor --json` — machine-readable output
- `threadclaw integrate --check` — check OpenClaw integration only
- `threadclaw upgrade` — fix version/migration issues

## Database Issues

### "database is locked"
**Cause**: Multiple processes writing to the same SQLite file simultaneously.
**Fix**: ThreadClaw uses WAL mode with `busy_timeout=5000ms`. If still occurring:
- Ensure only one ThreadClaw process runs per database
- Check for zombie processes: `ps aux | grep threadclaw`
- The evidence graph DB supports concurrent reads via WAL mode

### "no such table" errors
**Cause**: Schema migrations didn't run.
**Fix**: Migrations run automatically on startup. If manual fix needed:
- Delete the database file and restart (data will be lost)
- Or run the migration manually via the engine's `runGraphMigrations()` function

### Database corruption
**Fix**:
```bash
# Memory engine
rm ~/.threadclaw/data/memory.db
# Document store + Evidence graph (consolidated)
rm ~/.threadclaw/data/threadclaw.db
```
All databases rebuild automatically on next startup.

## Evidence Graph Issues

### Awareness notes not appearing
**Check**:
1. `THREADCLAW_MEMORY_RELATIONS_ENABLED=true`
2. `THREADCLAW_MEMORY_RELATIONS_AWARENESS_ENABLED=true`
3. Entities must have `mention_count >= RELATIONS_MIN_MENTIONS` (default: 2)
4. Entity cache rebuilds every 30 seconds — new entities may take up to 30s to appear

### Claims not being extracted
**Check**:
1. `THREADCLAW_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED=true`
2. Claims are extracted from every message (ingest-time, no compaction required)
3. In **fast** extraction mode, only structured signals are detected: "Remember:", heading+bullets, YAML frontmatter, tool results
4. In **smart** extraction mode, natural language claims are also detected (e.g. "The API runs on port 8080")
5. Check extraction mode: `THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE` (default: smart)

### Anti-runbooks not decaying
Decay is applied **lazily** — only when anti-runbooks are queried (via `cc_procedures` tool or context compiler). Decay won't happen until something reads the data.

### Smart extraction not working (falling back to fast mode)
**Check**:
1. `THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED=true` (smart mode requires this)
2. `THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL` is set to a valid model
3. `THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER` is set (anthropic, openai, etc.)
4. `THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE` is not set to `fast`

Smart extraction uses the same model as deep extraction — no extra model to configure. If the LLM call fails, it falls back to fast (regex) extraction silently.

### Extraction mode defaults
- If `EXTRACTION_MODE` is not set and deep extraction is enabled: **smart** mode is used
- If `EXTRACTION_MODE` is not set and deep extraction is disabled: **smart** is still the default in config, but since `useLlm` requires deep extraction to be enabled, it will use regex extraction in practice
- To force regex-only: set `THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE=fast`

## Search Issues

### Zero results
- Check collection exists: `threadclaw collections list`
- Check embedding server is running: `curl http://127.0.0.1:8012/health`
- Try broader query terms

### Low confidence scores
- Enable reranking (enabled by default)
- Try query expansion: `QUERY_EXPANSION_ENABLED=true`
- Entity-boosted search activates for 1-2 word queries when relations are enabled

## Performance

### Slow search
- Check reranker is running locally (not cloud)
- Use `--brief` mode for faster responses
- Entity cache rebuilds every 30s (first awareness query may be slower)

### High memory usage
- Evidence graph entity cache is capped at 5,000 entries
- Awareness eval ring buffer is capped at 2,000 events
- Context compiler uses token budgets (110-280 tokens)

## Reset Options

### Via API (localhost only)
```bash
# KB only (documents + evidence graph)
curl -X POST http://127.0.0.1:18800/reset -H "Content-Type: application/json" -d '{"clearGraph": true}'

# KB + conversation memory
curl -X POST http://127.0.0.1:18800/reset -H "Content-Type: application/json" -d '{"clearGraph": true, "clearMemory": true}'
```

### Via TUI
The TUI provides 3 reset options: KB only, KB + Evidence, and Full wipe.

### Via file deletion
```bash
# Disable evidence OS features (keeps core working)
THREADCLAW_MEMORY_RELATIONS_ENABLED=false

# Delete document store + evidence data (consolidated)
rm ~/.threadclaw/data/threadclaw.db

# Full reset (documents + evidence + conversation memory)
rm ~/.threadclaw/data/memory.db
rm ~/.threadclaw/data/threadclaw.db
```

All databases rebuild automatically on next startup.

## OpenClaw Integration Issues

### "plugins.allow is empty; discovered non-bundled plugins may auto-load"
**Cause**: OpenClaw doesn't have `threadclaw-memory` in its trusted plugin list.
**Fix**: Run `threadclaw integrate --apply` to set `plugins.allow` automatically.

### Evidence tools not showing up (cc_memory, cc_claims, etc.)
**Cause**: The graph database isn't at the expected path, so `graphDb` is null and evidence tools don't register.
**Fix**:
1. Run `threadclaw doctor` to check data paths
2. Run `threadclaw upgrade` to consolidate data to `~/.threadclaw/data/`
3. Restart OpenClaw services

### Integration drift after OpenClaw update
**Cause**: OpenClaw update reset plugin configuration.
**Fix**: Run `threadclaw integrate --check` to see what drifted, then `threadclaw integrate --apply` to fix.
