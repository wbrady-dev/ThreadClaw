#!/bin/bash
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ── Record current commit for rollback ──
OLD_HASH=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

# ── Check for updates ──
echo "[update] Checking for updates..."
git fetch >/dev/null 2>&1
NEW_COMMITS=$(git rev-list HEAD..origin/main --count 2>/dev/null || echo "0")
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
  launchctl stop com.clawcore.rag 2>/dev/null || true
  launchctl stop com.clawcore.models 2>/dev/null || true
else
  systemctl --user stop clawcore-rag 2>/dev/null || true
  systemctl --user stop clawcore-models 2>/dev/null || true
fi

# Wait for ports to close (15s max)
for i in $(seq 1 15); do
  curl -s http://127.0.0.1:8012/health >/dev/null 2>&1 || break
  sleep 1
done

# ── Pull latest ──
echo "[update] Pulling latest from GitHub..."
if ! git pull; then
  echo "[ERROR] git pull failed. Rollback: git reset --hard $OLD_HASH"
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
npm run build || echo "[WARN] Build failed. TUI will use tsx fallback."

# ── Run migrations ──
echo "[update] Running migrations..."
node "$ROOT/bin/clawcore.mjs" upgrade >/dev/null 2>&1 || echo "[WARN] Upgrade had issues. Run 'clawcore doctor' for details."

# ── Restart services ──
echo "[update] Restarting services..."
if [ "$(uname)" = "Darwin" ]; then
  launchctl start com.clawcore.models 2>/dev/null || true
  # Wait for model server health (60s max)
  for i in $(seq 1 30); do
    curl -s http://127.0.0.1:8012/health >/dev/null 2>&1 && break
    sleep 2
  done
  launchctl start com.clawcore.rag 2>/dev/null || true
else
  systemctl --user start clawcore-models 2>/dev/null || true
  for i in $(seq 1 30); do
    curl -s http://127.0.0.1:8012/health >/dev/null 2>&1 && break
    sleep 2
  done
  systemctl --user start clawcore-rag 2>/dev/null || true
fi

# ── Smoke test ──
echo "[update] Running smoke test..."
if node "$ROOT/bin/clawcore.mjs" doctor >/dev/null 2>&1; then
  echo "[OK] Smoke test passed."
else
  echo "[WARN] Smoke test had issues. Run 'clawcore doctor' for details."
fi

echo ""
echo "[OK] ClawCore updated successfully."
