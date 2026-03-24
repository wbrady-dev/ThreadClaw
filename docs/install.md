# Installation Guide

## Prerequisites

- **Node.js 22+** (with experimental SQLite support)
- **Python 3.10+** (for embedding/reranking model server)
- **GPU recommended** (2-12 GB VRAM depending on model tier)
- **Disk space**: ~2-15 GB for models + data

## Quick Install

### Windows

```bash
git clone https://github.com/wbrady-dev/ThreadClaw.git
cd threadclaw
install.bat
```

### Linux / macOS

```bash
git clone https://github.com/wbrady-dev/ThreadClaw.git
cd threadclaw
chmod +x install.sh
./install.sh
```

### Interactive TUI Installer

```bash
npm install && npx tsx src/tui/index.ts
```

The installer will:
1. Check prerequisites (Node.js, Python, GPU, disk space)
2. Let you choose a model tier (Lite ~2GB, Standard ~4GB, Premium ~12GB)
3. Install dependencies and download models (recommended mode includes OCR via Tesseract, audio transcription via Whisper base, and NER via spaCy)
4. Detect and connect Obsidian vaults
5. Optionally integrate with OpenClaw

## Database Initialization

All databases are created automatically on first run. Schema migrations run idempotently on every startup -- safe to upgrade in place.

- Memory engine: 1 migration (conversation tables)
- Evidence graph: 19 migrations (v1-v9: legacy tables + indexes, v10-v11: provenance_links, v12-v15: canonical key fixes, v16: memory_objects table, v17: data migration, v18: legacy table rename, v19: UNIQUE constraints)

## Cross-Platform Services

ThreadClaw services can be managed as background processes:

- **Windows**: Task Scheduler XML tasks (no admin required)
- **Linux**: systemd --user units (no sudo required)
- **macOS**: launchd user agents
- All platforms use HTTP `/shutdown` endpoint for graceful stop

## Configuration

Copy `.env.example` to `.env` and customize. See [Configuration Guide](configuration.md) for all options.

## Permissions

- **Unix/macOS**: Evidence graph DB set to `chmod 600` (owner-only access)
- **Windows**: Relies on user-profile directory ACLs (default Windows security)

## Verification

```bash
threadclaw status    # Check system health
threadclaw doctor    # Full diagnostic: versions, data, integration, services, skills
threadclaw query "test" --collection default   # Verify search works
```

## Post-Install Commands

| Command | When to Use |
|---------|-------------|
| `threadclaw doctor` | Diagnose installation health — checks versions, data paths, OpenClaw integration, DB integrity |
| `threadclaw upgrade` | Run after updating ThreadClaw code — safely migrates data, schemas, and skills |
| `threadclaw integrate --check` | Verify OpenClaw integration is correct (read-only) |
| `threadclaw integrate --apply` | Re-apply integration if `threadclaw doctor` reports drift |

## Data Locations

All ThreadClaw data is stored under `~/.threadclaw/`:

| Path | Contents |
|------|----------|
| `~/.threadclaw/data/threadclaw.db` | Document store (RAG): documents, chunks, vectors, metadata |
| `~/.threadclaw/data/memory.db` | Conversation memory: messages, summaries, context items |
| `~/.threadclaw/data/graph.db` | Evidence graph: entities, claims, decisions, loops, provenance |
| `~/.threadclaw/relations-terms.json` | User-defined entity terms for graph extraction |
| `~/.threadclaw/manifest.json` | Version tracking |
| `~/.threadclaw/backups/` | Upgrade backups |
| `~/.threadclaw/staging/` | Temporary files during source adapter ingestion |

## Troubleshooting

See [Troubleshooting Guide](troubleshooting.md).
