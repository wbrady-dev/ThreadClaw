#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
INSTALL_START=$(date +%s)
PIP="$SCRIPT_DIR/.venv/bin/pip"
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
if [ "$PYTHON_MINOR" -lt 10 ]; then
  echo "[ERROR] Python 3.$PYTHON_MINOR detected. ThreadClaw requires Python 3.10+."
  exit 1
fi

# ── Step 3: Node.js dependencies ──
if [ ! -f "$SCRIPT_DIR/node_modules/.install-ok" ]; then
  echo ""
  echo "[install] Installing Node.js dependencies..."
  npm install --no-audit --no-fund
  touch "$SCRIPT_DIR/node_modules/.install-ok"
  echo "[OK] Node.js dependencies installed ($(elapsed))"
else
  echo "[OK] Node.js dependencies already present"
fi
export THREADCLAW_SKIP_NODE_INSTALL=1

# ── Step 4: Python virtual environment ──
VENV_PYTHON="$SCRIPT_DIR/.venv/bin/python3"
if [ -f "$VENV_PYTHON" ] && ! "$VENV_PYTHON" -c "import sys" 2>/dev/null; then
  echo "[WARN] Existing venv is broken — recreating..."
  rm -rf "$SCRIPT_DIR/.venv"
fi
if [ ! -f "$VENV_PYTHON" ]; then
  echo ""
  echo "[install] Creating Python virtual environment..."
  $PYTHON_CMD -m venv "$SCRIPT_DIR/.venv"
  echo "[OK] Virtual environment created"
else
  echo "[OK] Python virtual environment already present"
fi

# ── Step 5: Install pinned Python dependencies ──
echo ""
echo "[install] Installing Python dependencies (this may take several minutes)..."
echo "          Full output logged to: $LOG"

# Install PyTorch first (platform-specific)
if ! "$VENV_PYTHON" -c "import torch" 2>/dev/null; then
  echo "[install] Installing PyTorch..."
  set +e
  if [ "$(uname)" = "Darwin" ]; then
    "$PIP" install torch torchvision >> "$LOG" 2>&1
    PIP_RC=$?
  else
    "$PIP" install torch torchvision --index-url https://download.pytorch.org/whl/cu124 >> "$LOG" 2>&1
    PIP_RC=$?
    if [ $PIP_RC -ne 0 ]; then
      echo "[WARN] CUDA install failed, falling back to default PyTorch..."
      "$PIP" install torch torchvision >> "$LOG" 2>&1
      PIP_RC=$?
    fi
  fi
  set -e
  if [ $PIP_RC -ne 0 ]; then
    echo "[ERROR] PyTorch pip install failed (exit $PIP_RC). See $LOG"
    exit 1
  fi
  # Verify import works
  if ! "$VENV_PYTHON" -c "import torch" 2>/dev/null; then
    echo "[ERROR] PyTorch installed but import failed. See $LOG"
    exit 1
  fi
  echo "[OK] PyTorch installed ($(elapsed))"
  # Verify MPS (Apple Silicon GPU) availability on macOS
  if [ "$(uname)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
    if "$VENV_PYTHON" -c "import torch; assert torch.backends.mps.is_available()" 2>/dev/null; then
      echo "[OK] MPS (Apple Silicon GPU) backend available"
    else
      echo "[WARN] MPS backend not available — will use CPU"
    fi
  fi
else
  echo "[OK] PyTorch already installed"
fi

# Install remaining pinned dependencies
set +e
if [ -f "$SCRIPT_DIR/server/requirements-pinned.txt" ]; then
  "$PIP" install -r "$SCRIPT_DIR/server/requirements-pinned.txt" >> "$LOG" 2>&1
  PIP_RC=$?
  if [ $PIP_RC -ne 0 ]; then
    echo "[WARN] Some deps failed (exit $PIP_RC). Installing core individually..."
    "$PIP" install sentence-transformers flask spacy docling >> "$LOG" 2>&1
    PIP_RC=$?
  fi
else
  echo "[install] No pinned requirements found, installing core deps..."
  "$PIP" install sentence-transformers flask spacy docling >> "$LOG" 2>&1
  PIP_RC=$?
fi
set -e

if [ $PIP_RC -ne 0 ]; then
  echo "[ERROR] Python dependency install failed (exit $PIP_RC). See $LOG"
  exit 1
fi

# Validate core imports
IMPORT_FAIL=""
for mod in sentence_transformers flask spacy; do
  if ! "$VENV_PYTHON" -c "import $mod" 2>/dev/null; then
    IMPORT_FAIL="$IMPORT_FAIL $mod"
  fi
done
if [ -n "$IMPORT_FAIL" ]; then
  echo "[ERROR] These Python packages failed to import:$IMPORT_FAIL"
  echo "        Check $LOG for details."
  exit 1
fi
echo "[OK] Python dependencies installed and verified ($(elapsed))"

# ── Step 6: spaCy NER model ──
if ! "$VENV_PYTHON" -c "import spacy; spacy.load('en_core_web_sm')" 2>/dev/null; then
  echo "[install] Downloading spaCy NER model..."
  set +e
  "$VENV_PYTHON" -m spacy download en_core_web_sm >> "$LOG" 2>&1
  SPACY_RC=$?
  set -e
  if [ $SPACY_RC -eq 0 ] && "$VENV_PYTHON" -c "import spacy; spacy.load('en_core_web_sm')" 2>/dev/null; then
    echo "[OK] spaCy NER model installed"
  else
    echo "[WARN] spaCy NER model failed. Entity extraction will use regex fallback."
  fi
else
  echo "[OK] spaCy NER model already present"
fi

# ── Step 7: Memory-engine dependencies ──
if [ ! -d "$SCRIPT_DIR/memory-engine/node_modules/@sinclair/typebox" ]; then
  echo "[install] Installing memory-engine dependencies..."
  set +e
  (cd "$SCRIPT_DIR/memory-engine" && npm install --no-audit --no-fund >> "$LOG" 2>&1)
  ME_RC=$?
  set -e
  if [ $ME_RC -ne 0 ]; then
    echo "[WARN] Memory-engine npm install returned exit $ME_RC. See $LOG"
  fi
  if [ ! -d "$SCRIPT_DIR/memory-engine/node_modules/@sinclair" ]; then
    echo "[ERROR] Memory-engine dependencies incomplete."
    exit 1
  fi
  echo "[OK] Memory-engine dependencies installed ($(elapsed))"
else
  echo "[OK] Memory-engine dependencies already present"
fi

echo ""
echo "[launch] Starting ThreadClaw setup..."
echo ""

# ── Step 8: Launch the Node.js installer ──
set +e
node "$SCRIPT_DIR/bin/threadclaw.mjs" install "$@"
EXIT_CODE=$?
set -e

if [ $EXIT_CODE -eq 0 ]; then
  # ── Smoke test ──
  echo ""
  echo "[install] Running smoke test..."
  set +e
  node "$SCRIPT_DIR/bin/threadclaw.mjs" doctor >/dev/null 2>&1
  DOCTOR_RC=$?
  set -e
  if [ $DOCTOR_RC -eq 0 ]; then
    echo "[OK] Smoke test passed"
  else
    echo "[WARN] Smoke test had issues. Run 'threadclaw doctor' for details."
  fi
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
  echo "  Next steps:"
  echo "    1. Run 'threadclaw doctor' to verify everything"
  echo "    2. Run 'threadclaw start' to launch services"
  echo "    3. Run 'threadclaw tui' to open the dashboard"
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
