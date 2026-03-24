#!/bin/bash
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ── Prerequisites ──
command -v git >/dev/null 2>&1 || { echo "[ERROR] git not found"; exit 1; }

# ── Record current version and commit for rollback ──
OLD_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
OLD_HASH=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

# ── Use tracking branch ──
UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || echo "origin/main")

# ── Check for updates ──
echo "[update] Checking for updates..."
git fetch >/dev/null 2>&1
NEW_COMMITS=$(git rev-list HEAD.."$UPSTREAM" --count 2>/dev/null || echo "0")
if [ "$NEW_COMMITS" = "0" ]; then
  echo "[OK] Already up to date."
  exit 0
fi
echo "[update] $NEW_COMMITS new commit(s) available."

# ── Stop services ──
echo "[update] Stopping services..."
curl -s -X POST http://127.0.0.1:18800/shutdown >/dev/null 2>&1 || true
curl -s -X POST http://127.0.0.1:8012/shutdown >/dev/null 2>&1 || true

if [ "$(uname)" = "Darwin" ]; then
  launchctl stop com.threadclaw.rag 2>/dev/null || true
  launchctl stop com.threadclaw.models 2>/dev/null || true
else
  systemctl --user stop threadclaw-rag 2>/dev/null || true
  systemctl --user stop threadclaw-models 2>/dev/null || true
fi

# Wait for ports to close (15s max)
for i in $(seq 1 15); do
  curl -s http://127.0.0.1:8012/health >/dev/null 2>&1 || break
  sleep 1
done

# ── Backup before pull ──
bash "$ROOT/scripts/backup.sh" 2>/dev/null || echo "[WARN] Backup skipped"

# ── Pull latest ──
echo "[update] Pulling latest from GitHub..."
if ! git pull; then
  echo "[ERROR] git pull failed. Auto-rolling back to $OLD_HASH..."
  git reset --hard "$OLD_HASH"
  exit 1
fi

# ── Update Node.js dependencies ──
echo "[update] Updating Node.js dependencies..."
npm install --no-audit --no-fund >/dev/null 2>&1 || echo "[WARN] npm install failed"

# ── Update memory-engine dependencies ──
if [ -f "$ROOT/memory-engine/package.json" ]; then
  echo "[update] Updating memory-engine dependencies..."
  (cd "$ROOT/memory-engine" && npm install --no-audit --no-fund >/dev/null 2>&1) || echo "[WARN] memory-engine npm install failed"
fi

# ── Update Python dependencies ──
VENV_PIP="$ROOT/.venv/bin/pip"
if [ -f "$VENV_PIP" ] && [ -f "$ROOT/server/requirements-pinned.txt" ]; then
  echo "[update] Updating Python dependencies..."
  "$VENV_PIP" install -q -r "$ROOT/server/requirements-pinned.txt" >/dev/null 2>&1 || echo "[WARN] pip install failed"
fi

# ── Rebuild ──
echo "[update] Building..."
npm run build || echo "[WARN] Build failed. Run 'npm run build' manually."

# ── Run migrations ──
echo "[update] Running migrations..."
node "$ROOT/bin/threadclaw.mjs" upgrade || echo "[WARN] Upgrade had issues. Run 'threadclaw doctor' for details."

# ── Restart services ──
echo "[update] Restarting services..."
if [ "$(uname)" = "Darwin" ]; then
  launchctl start com.threadclaw.models 2>/dev/null || true
  # Wait for model server health (60s max) with progress
  for i in $(seq 1 30); do
    curl -s http://127.0.0.1:8012/health >/dev/null 2>&1 && break
    sleep 2
    ELAPSED=$((i * 2))
    if [ $((ELAPSED % 10)) -eq 0 ]; then
      echo "[update] Still waiting for model server... (${ELAPSED}s)"
    fi
  done
  launchctl start com.threadclaw.rag 2>/dev/null || true
else
  systemctl --user start threadclaw-models 2>/dev/null || true
  for i in $(seq 1 30); do
    curl -s http://127.0.0.1:8012/health >/dev/null 2>&1 && break
    sleep 2
    ELAPSED=$((i * 2))
    if [ $((ELAPSED % 10)) -eq 0 ]; then
      echo "[update] Still waiting for model server... (${ELAPSED}s)"
    fi
  done
  systemctl --user start threadclaw-rag 2>/dev/null || true
fi

# ── Smoke test ──
echo "[update] Running smoke test..."
if node "$ROOT/bin/threadclaw.mjs" doctor >/dev/null 2>&1; then
  echo "[OK] Smoke test passed."
else
  echo "[WARN] Smoke test had issues. Run 'threadclaw doctor' for details."
fi

# ── Show update summary ──
NEW_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
echo ""
echo "[OK] ThreadClaw updated successfully."
echo "     Version: $OLD_VERSION -> $NEW_VERSION"
echo ""
echo "  Recent commits:"
git log --oneline -5
