#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
INSTALL_START=$(date +%s)
LOG="$SCRIPT_DIR/logs/install.log"

echo ""
echo "  ========================================"
echo "   ThreadClaw - One-Click Installer"
echo "  ========================================"
echo ""

# ── Pre-flight: logs directory ──
mkdir -p "$SCRIPT_DIR/logs"
: > "$LOG"

elapsed() {
  local now=$(date +%s)
  echo "$(( now - INSTALL_START ))s elapsed"
}

# ── Step 1: Check Node.js ──
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed."
  echo "        Install Node.js 22+ from https://nodejs.org/"
  exit 1
fi

NODE_MAJOR="$(node -e "console.log(process.versions.node.split('.')[0])")"
if [ -z "$NODE_MAJOR" ]; then
  echo "[ERROR] Could not determine Node.js version."
  exit 1
fi
if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]]; then
  echo "[ERROR] Could not determine Node.js version (got: '$NODE_MAJOR')"
  exit 1
fi
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "[ERROR] Node.js $NODE_MAJOR detected. ThreadClaw requires Node.js 22+."
  exit 1
fi
echo "[OK] Node.js $(node --version)"

# ── Pre-flight: internet connectivity ──
set +e
curl -sf --connect-timeout 3 https://pypi.org/ >/dev/null 2>&1
if [ $? -ne 0 ]; then
  echo "[WARN] Cannot reach pypi.org — Python package downloads may fail."
fi
set -e

# ── Step 2: Check Python ──
PYTHON_CMD=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_CMD="python"
else
  echo "[ERROR] Python is not installed or not on PATH."
  echo "        Install Python 3.10+ and try again."
  exit 1
fi
echo "[OK] $($PYTHON_CMD --version)"

PYTHON_MINOR="$($PYTHON_CMD -c "import sys; print(sys.version_info.minor)")"
if [ -z "$PYTHON_MINOR" ]; then
  echo "[ERROR] Could not determine Python minor version."
  exit 1
fi
if ! [[ "$PYTHON_MINOR" =~ ^[0-9]+$ ]]; then
  echo "[ERROR] Could not determine Python minor version (got: '$PYTHON_MINOR')"
  exit 1
fi
if [ "$PYTHON_MINOR" -lt 10 ]; then
  echo "[ERROR] Python 3.$PYTHON_MINOR detected. ThreadClaw requires Python 3.10+."
  exit 1
fi

# ── Step 3: Node.js dependencies ──
if [ ! -f "$SCRIPT_DIR/node_modules/.install-ok" ]; then
  echo ""
  # NOTE: Using `npm install` instead of `npm ci` because package-lock.json
  # is gitignored for this project. If lockfile is ever committed, switch to
  # `npm ci` for reproducible installs with integrity checking.
  echo "[install] Installing Node.js dependencies..."
  set +e
  npm install --loglevel=http --no-audit --no-fund 2>&1 | tee -a "$LOG"
  NPM_RC=$?
  set -e
  if [ $NPM_RC -ne 0 ]; then
    echo "[ERROR] npm install failed (exit $NPM_RC). See $LOG"
    exit 1
  fi
  touch "$SCRIPT_DIR/node_modules/.install-ok"
  echo "[OK] Node.js dependencies installed ($(elapsed))"
else
  echo "[OK] Node.js dependencies already present"
fi
export THREADCLAW_SKIP_NODE_INSTALL=1

# ── Step 3b: Build TypeScript ──
echo "[install] Building ThreadClaw..."
set +e
npm run build >> "$LOG" 2>&1
BUILD_RC=$?
set -e
if [ $BUILD_RC -ne 0 ]; then
  echo "[WARN] Build failed. Install will continue but may run slower."
else
  echo "[OK] Build complete ($(elapsed))"
fi

# ── Python venv, pip, spaCy, and memory-engine deps are handled by the TUI ──
# The TUI installer creates .venv at the install root (which may differ from
# SCRIPT_DIR) and installs all Python dependencies there. This avoids wasting
# 5-10 minutes installing Python deps at the clone location only to have the
# TUI re-install them at the actual install directory.

echo ""
echo "[launch] Starting ThreadClaw setup..."
echo ""

# ── Step 8: Launch the Node.js installer ──
set +e
node "$SCRIPT_DIR/bin/threadclaw.mjs" install "$@"
EXIT_CODE=$?
set -e

if [ $EXIT_CODE -ne 0 ]; then
  true  # fall through to elapsed time + status below
fi

INSTALL_END=$(date +%s)
ELAPSED=$(( INSTALL_END - INSTALL_START ))
MINS=$(( ELAPSED / 60 ))
SECS=$(( ELAPSED % 60 ))

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "  ========================================"
  echo "   Installation complete! (${MINS}m ${SECS}s)"
  echo "  ========================================"
  echo ""
  echo "  Full install log: $LOG"
else
  echo "  ========================================"
  echo "   Installation failed (exit $EXIT_CODE, ${MINS}m ${SECS}s)"
  echo "  ========================================"
  echo ""
  echo "  Check $LOG for details."
  echo "  Run 'threadclaw doctor' to diagnose issues."
fi

exit $EXIT_CODE
