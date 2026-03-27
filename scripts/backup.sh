#!/bin/bash
# ThreadClaw Backup Script
# Creates hot backups of both databases using SQLite VACUUM INTO.
# Safe to run while services are active (WAL mode).
#
# Usage: ./scripts/backup.sh [backup_dir]
# Default: ~/backups/threadclaw/YYYY-MM-DD

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

BACKUP_ROOT="${1:-$HOME/backups/threadclaw}"
BACKUP_DIR="$BACKUP_ROOT/$(date +%Y-%m-%d)"
mkdir -p "$BACKUP_DIR"

echo "ThreadClaw Backup — $(date)"
echo "Destination: $BACKUP_DIR"
echo ""

# Try to read data dir from .env
DATA_DIR=$(grep '^THREADCLAW_DATA_DIR=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"')
[ -z "$DATA_DIR" ] && DATA_DIR="$HOME/.threadclaw/data"
THREADCLAW_DB="$DATA_DIR/threadclaw.db"
MEMORY_DB="$DATA_DIR/memory.db"
GRAPH_DB="$DATA_DIR/graph.db"

# Backup ThreadClaw knowledge DB
if [ -f "$THREADCLAW_DB" ]; then
  echo "  Backing up threadclaw.db..."
  if command -v sqlite3 &>/dev/null; then
    sqlite3 "$THREADCLAW_DB" "VACUUM INTO '$BACKUP_DIR/threadclaw.db'"
  else
    cp "$THREADCLAW_DB" "$BACKUP_DIR/threadclaw.db"
    echo "  (sqlite3 not found — used file copy instead of hot backup)"
  fi
  SIZE=$(du -sh "$BACKUP_DIR/threadclaw.db" | cut -f1)
  echo "  ✓ threadclaw.db ($SIZE)"
else
  echo "  ⚠ threadclaw.db not found at $THREADCLAW_DB"
fi

# Backup Memory DB
if [ -f "$MEMORY_DB" ]; then
  echo "  Backing up memory.db..."
  if command -v sqlite3 &>/dev/null; then
    sqlite3 "$MEMORY_DB" "VACUUM INTO '$BACKUP_DIR/memory.db'"
  else
    cp "$MEMORY_DB" "$BACKUP_DIR/memory.db"
    echo "  (sqlite3 not found — used file copy instead of hot backup)"
  fi
  SIZE=$(du -sh "$BACKUP_DIR/memory.db" | cut -f1)
  echo "  ✓ memory.db ($SIZE)"
else
  echo "  ⚠ memory.db not found at $MEMORY_DB"
fi

# Backup Graph DB
if [ -f "$GRAPH_DB" ]; then
  echo "  Backing up graph.db..."
  if command -v sqlite3 &>/dev/null; then
    sqlite3 "$GRAPH_DB" "VACUUM INTO '$BACKUP_DIR/graph.db'"
  else
    cp "$GRAPH_DB" "$BACKUP_DIR/graph.db"
    echo "  (sqlite3 not found — used file copy instead of hot backup)"
  fi
  SIZE=$(du -sh "$BACKUP_DIR/graph.db" | cut -f1)
  echo "  ✓ graph.db ($SIZE)"
else
  echo "  ⚠ graph.db not found at $GRAPH_DB"
fi

# Prune old backups (keep 30 days)
RETENTION_DAYS=30
if [ -d "$BACKUP_ROOT" ]; then
  OLD=$(find "$BACKUP_ROOT" -maxdepth 1 -type d -mtime +$RETENTION_DAYS 2>/dev/null | wc -l)
  if [ "$OLD" -gt 0 ]; then
    find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +$RETENTION_DAYS -exec rm -rf {} +
    echo "  Pruned $OLD backups older than $RETENTION_DAYS days"
  fi
fi

echo ""
echo "Backup complete."
