#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
INSTALL_START=$(date +%s)

echo ""
echo "  ========================================"
echo "   ThreadClaw - One-Click Installer"
echo "  ========================================"
echo ""

# ── Step 1: Check Node.js ──
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed."
  echo "        Install Node.js 22+ from https://nodejs.org/"
  exit 1
fi

NODE_MAJOR="$(node -e "console.log(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "[ERROR] Node.js $NODE_MAJOR detected. ThreadClaw requires Node.js 22+."
  exit 1
fi
echo "[OK] Node.js $(node --version)"

# ── Pre-flight: internet connectivity ──
if ! curl -sf --connect-timeout 3 https://pypi.org/ >/dev/null 2>&1; then
  echo "[WARN] Cannot reach pypi.org — Python package downloads may fail."
fi

# ── Pre-flight: logs directory ──
mkdir -p "$SCRIPT_DIR/logs"

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

# Check Python version >= 3.10
PYTHON_MINOR="$($PYTHON_CMD -c "import sys; print(sys.version_info.minor)")"
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
  echo "[OK] Node.js dependencies installed"
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

# Install PyTorch first (platform-specific)
if ! "$VENV_PYTHON" -c "import torch" 2>/dev/null; then
  echo "[install] Installing PyTorch..."
  if [ "$(uname)" = "Darwin" ]; then
    "$SCRIPT_DIR/.venv/bin/pip" install torch torchvision 2>&1 | tail -1
  else
    "$SCRIPT_DIR/.venv/bin/pip" install torch torchvision --index-url https://download.pytorch.org/whl/cu124 2>&1 | tail -1 || \
    "$SCRIPT_DIR/.venv/bin/pip" install torch torchvision 2>&1 | tail -1
  fi
  "$VENV_PYTHON" -c "import torch" 2>/dev/null || { echo "[ERROR] PyTorch installation failed."; exit 1; }
  echo "[OK] PyTorch installed"
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
if [ -f "$SCRIPT_DIR/server/requirements-pinned.txt" ]; then
  "$SCRIPT_DIR/.venv/bin/pip" install -r "$SCRIPT_DIR/server/requirements-pinned.txt" 2>&1 | tail -1 || {
    echo "[WARN] Some deps failed. Installing core individually..."
    "$SCRIPT_DIR/.venv/bin/pip" install sentence-transformers flask spacy docling 2>&1 | tail -1
  }
  echo "[OK] Python dependencies installed"
else
  echo "[install] No pinned requirements found, installing core deps..."
  "$SCRIPT_DIR/.venv/bin/pip" install sentence-transformers flask spacy docling
  echo "[OK] Python dependencies installed"
fi

# ── Step 6: spaCy NER model ──
if ! "$VENV_PYTHON" -c "import spacy; spacy.load('en_core_web_sm')" 2>/dev/null; then
  echo "[install] Downloading spaCy NER model..."
  if "$VENV_PYTHON" -m spacy download en_core_web_sm 2>&1 | tail -1; then
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
  (cd "$SCRIPT_DIR/memory-engine" && npm install --no-audit --no-fund 2>&1 | tail -1) || \
    echo "[WARN] Memory-engine npm install returned an error."
  [ -d "$SCRIPT_DIR/memory-engine/node_modules/@sinclair" ] || { echo "[ERROR] Memory-engine dependencies incomplete."; exit 1; }
  echo "[OK] Memory-engine dependencies installed"
else
  echo "[OK] Memory-engine dependencies already present"
fi

echo ""
echo "[launch] Starting ThreadClaw setup..."
echo ""

# ── Step 8: Launch the Node.js installer ──
node "$SCRIPT_DIR/bin/threadclaw.mjs" install "$@"
EXIT_CODE=$?

# ── Step 9: Register global command ──
if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo "[install] Registering threadclaw command..."
  mkdir -p "$HOME/.local/bin"
  if [ -f "$SCRIPT_DIR/bin/threadclaw.mjs" ]; then
    ln -sf "$SCRIPT_DIR/bin/threadclaw.mjs" "$HOME/.local/bin/threadclaw"
    chmod +x "$HOME/.local/bin/threadclaw"
  else
    echo "[WARN] bin/threadclaw.mjs not found — skipping symlink creation"
  fi

  if echo "$PATH" | grep -q ".local/bin"; then
    echo "[OK] threadclaw command registered"
  else
    echo "[OK] threadclaw command registered at ~/.local/bin/threadclaw"
    echo "     Add to PATH: export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi

  # ── Smoke test ──
  echo ""
  echo "[install] Running smoke test..."
  if node "$SCRIPT_DIR/bin/threadclaw.mjs" doctor >/dev/null 2>&1; then
    echo "[OK] Smoke test passed"
  else
    echo "[WARN] Smoke test had issues. Run 'threadclaw doctor' for details."
  fi
fi

INSTALL_END=$(date +%s)
ELAPSED=$(( INSTALL_END - INSTALL_START ))
echo ""
echo "[install] Completed in ${ELAPSED}s"

exit $EXIT_CODE
