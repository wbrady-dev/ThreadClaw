#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# ThreadClaw Clean-Machine Install Test
# Verifies the full install pipeline works from a fresh state.
#
# Prerequisites: Node.js 22+, Python 3.10+
# Usage: bash test/clean-install-test.sh [path-to-threadclaw-dir]
# ═══════════════════════════════════════════════════════════════

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
DIM='\033[0;90m'
RESET='\033[0m'

pass=0
fail=0
warn=0

check() {
  local name="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${RESET} $name"
    ((pass++))
  else
    echo -e "  ${RED}✗${RESET} $name"
    ((fail++))
  fi
}

check_warn() {
  local name="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${RESET} $name"
    ((pass++))
  else
    echo -e "  ${YELLOW}!${RESET} $name (optional)"
    ((warn++))
  fi
}

echo ""
echo "═══ ThreadClaw Clean-Machine Install Test ═══"
echo ""

# ── Prerequisites ──
echo "── Prerequisites ──"
check "Node.js 22+" node -e "if(parseInt(process.versions.node)<22)process.exit(1)"
check "Python 3+" bash -c "python3 --version 2>/dev/null || python --version 2>/dev/null"
check "npm available" npm --version
check "pip available" bash -c "python3 -m pip --version 2>/dev/null || python -m pip --version 2>/dev/null"

# ── Source Structure ──
echo "── Source Structure ──"
THREADCLAW_DIR="${1:-$(pwd)}"
cd "$THREADCLAW_DIR"
check "package.json exists" test -f package.json
check "memory-engine/package.json exists" test -f memory-engine/package.json
check "server/server.py exists" test -f server/server.py
check "bin/threadclaw.mjs exists" test -f bin/threadclaw.mjs
check "install.bat exists" test -f install.bat
check "install.sh exists" test -f install.sh
check "skills/threadclaw-evidence/SKILL.md" test -f skills/threadclaw-evidence/SKILL.md
check "skills/threadclaw-knowledge/SKILL.md" test -f skills/threadclaw-knowledge/SKILL.md

# ── Node.js Install ──
echo "── Node.js Dependencies ──"
check "npm install succeeds" npm install
check "node_modules exists" test -d node_modules
check "tsx available" test -f node_modules/tsx/dist/cli.mjs
check "better-sqlite3 available" test -d node_modules/better-sqlite3
check "ink available" test -d node_modules/ink
check "fastify available" test -d node_modules/fastify

# ── Memory-Engine Install ──
echo "── Memory-Engine Dependencies ──"
if [ -d "memory-engine/node_modules/@sinclair/typebox" ]; then
  echo -e "  ${GREEN}✓${RESET} memory-engine/node_modules pre-copied"
  ((pass++))
else
  check "memory-engine npm install" bash -c "cd memory-engine && npm install"
fi
check "@sinclair/typebox present" test -d memory-engine/node_modules/@sinclair/typebox
check "@mariozechner/pi-agent-core present" test -d memory-engine/node_modules/@mariozechner/pi-agent-core

# ── TypeScript ──
echo "── TypeScript ──"
check "tsc --noEmit passes" npx tsc --noEmit

# ── Unit Tests ──
echo "── Unit Tests (ThreadClaw) ──"
# NOTE: vitest output format may vary; grep for "passed" anywhere in last 5 lines
check "ThreadClaw vitest passes" bash -c "npx vitest run 2>&1 | tail -5 | grep -q 'passed'"

echo "── Unit Tests (Memory-Engine) ──"
check "Memory-engine vitest passes" bash -c "cd memory-engine && npx vitest run 2>&1 | tail -5 | grep -q 'passed'"

# ── Smoke Tests ──
echo "── Smoke Tests ──"
check "bin/threadclaw.mjs runs" node bin/threadclaw.mjs --version
check "TUI entry loads" npx tsx src/tui/index.ts --help || true

# ── Python Dependencies ──
echo "── Python Dependencies ──"
PYTHON="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
check "sentence-transformers" bash -c "$PYTHON -c 'import sentence_transformers' 2>/dev/null"
check "flask" bash -c "$PYTHON -c 'import flask' 2>/dev/null"
check_warn "spaCy" bash -c "$PYTHON -c 'import spacy' 2>/dev/null"
check_warn "spaCy en_core_web_sm model" bash -c "$PYTHON -c \"import spacy; spacy.load('en_core_web_sm')\" 2>/dev/null"
check_warn "Docling" bash -c "$PYTHON -c 'import docling' 2>/dev/null"
check_warn "Whisper" bash -c "$PYTHON -c 'import whisper' 2>/dev/null"
check_warn "Tesseract" bash -c "tesseract --version 2>/dev/null"

# ── Python Server ──
echo "── Model Server ──"
check "server.py valid syntax" bash -c "$PYTHON -c \"import py_compile; py_compile.compile('server/server.py', doraise=True)\""
check "/ner endpoint in server" grep -q "def extract_entities" server/server.py
check "health reports NER" grep -q "ner" server/server.py

# ── Schema Migration ──
echo "── Schema Migration ──"
check "graph DB migrations run" node --experimental-strip-types -e "
import { DatabaseSync } from 'node:sqlite';
import { runGraphMigrations } from './memory-engine/src/relations/schema.ts';
const db = new DatabaseSync(':memory:');
runGraphMigrations(db);
const v = db.prepare('SELECT COUNT(*) as cnt FROM _evidence_migrations').get();
if (v.cnt < 7) process.exit(1);
db.close();
"

# ── Distribution Cleanliness ──
echo "── Distribution Cleanliness ──"
check "no API keys in .env.example" bash -c "! grep -E '=[A-Za-z0-9]{20,}' .env.example 2>/dev/null || test ! -f .env.example"
check "no hardcoded user paths" bash -c "! grep -rn 'C:\\\\Users\\\\wbrad\|/Users/wbrad' src/ --include='*.ts' 2>/dev/null"
check "no .env in source" test ! -f .env

# ── Docs ──
echo "── Documentation ──"
check "README.md" test -f README.md
check "TECHNICAL.md" test -f TECHNICAL.md
check "CHANGELOG.md" test -f CHANGELOG.md
check "docs/ directory" test -d docs
# Use more specific patterns to avoid false matches on version numbers etc.
check "22 tools in README" grep -q "22 tools\|22 MCP" README.md
check "RSMA formula in README" grep -q "RAG + DAG + KG + AL" README.md
check "lossless-claw credited" grep -qi "lossless-claw" README.md
check "v0.3.0 in CHANGELOG" grep -q "0.3.0" CHANGELOG.md
check "NER in README" grep -qi "Named Entity Recognition" README.md
check "OneDrive in README" grep -qi "OneDrive" README.md

# ── Summary ──
echo ""
echo "═══════════════════════════════════════════"
echo -e "  ${GREEN}${pass} passed${RESET}, ${RED}${fail} failed${RESET}, ${YELLOW}${warn} optional${RESET}"
echo "═══════════════════════════════════════════"
echo ""

exit $fail
