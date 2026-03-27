#!/bin/bash
# ThreadClaw Distribution Builder
# Creates a self-contained distribution archive.
# Run from the threadclaw root directory.

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# NOTE: require() works here because node -e runs in CJS mode by default,
# regardless of "type": "module" in package.json.
VERSION=$(node -e "console.log(require('./package.json').version)")

echo ""
echo "  ========================================"
echo "   ThreadClaw Distribution Builder"
echo "  ========================================"
echo "  Version: $VERSION"
echo ""

# ── Step 1: Build TypeScript ──
echo "[build] Building TypeScript to dist/..."
npx tsup
echo "[OK] dist/ built"

# ── Step 2: Generate pinned Python requirements ──
echo "[build] Generating pinned Python requirements..."
"$ROOT/.venv/bin/pip" freeze > "$ROOT/server/requirements-pinned.txt"
echo "[OK] requirements-pinned.txt generated"

# ── Step 3: Verify node_modules ──
if [ ! -d "$ROOT/node_modules" ]; then
  echo "[ERROR] node_modules missing. Run npm install first."
  exit 1
fi
if [ ! -d "$ROOT/memory-engine/node_modules/@sinclair/typebox" ]; then
  echo "[ERROR] memory-engine/node_modules missing. Run: cd memory-engine && npm install"
  exit 1
fi
echo "[OK] node_modules verified"

# ── Step 4: Detect platform ──
ARCH="$(uname -m)"
case "$(uname)" in
  Darwin) PLATFORM="macos-$ARCH" ;;
  Linux)  PLATFORM="linux-$ARCH" ;;
  *)      PLATFORM="unknown-$ARCH" ;;
esac

DIST_NAME="ThreadClaw-${VERSION}-${PLATFORM}"
DIST_DIR="$ROOT/build/$DIST_NAME"
rm -rf "$ROOT/build"
mkdir -p "$DIST_DIR"

echo "[build] Copying files to $DIST_DIR..."

# Copy everything except exclusions (requires rsync)
if ! command -v rsync >/dev/null 2>&1; then
  echo "[ERROR] rsync is required for build-dist.sh."
  echo "        Install rsync or use build-dist.bat on Windows."
  exit 1
fi
rsync -a \
  --exclude='.git' \
  --exclude='.venv' \
  --exclude='build' \
  --exclude='data' \
  --exclude='logs' \
  --exclude='__pycache__' \
  --exclude='.tui-test-build' \
  --exclude='.env' \
  --exclude='*.db' \
  --exclude='*.db-wal' \
  --exclude='*.db-shm' \
  --exclude='*.pid' \
  --exclude='*.log' \
  --exclude='package-lock.json' \
  "$ROOT/" "$DIST_DIR/"

# Ensure data dir
mkdir -p "$DIST_DIR/data"
touch "$DIST_DIR/data/.gitkeep"

echo "[OK] Files copied"

# ── Step 5: Create archive ──
echo "[build] Creating tar.gz archive..."
TAR_PATH="$ROOT/build/${DIST_NAME}.tar.gz"
cd "$ROOT/build"
tar -czf "$DIST_NAME.tar.gz" "$DIST_NAME"

SIZE=$(du -sh "$TAR_PATH" | cut -f1)

echo ""
echo "  ========================================"
echo "   Distribution built successfully!"
echo "  ========================================"
echo ""
echo "   Archive: $TAR_PATH"
echo "   Size:    $SIZE"
echo ""
echo "   To install: extract, run ./install.sh"
echo ""
