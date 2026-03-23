/**
 * Apple Notes Source Adapter (macOS only)
 *
 * Uses AppleScript via osascript to export notes as HTML.
 * Polling-based: checks for changes on a configurable interval.
 *
 * Prerequisites:
 * - macOS only (process.platform === "darwin")
 * - Automation permissions granted in System Settings
 *
 * Read-only: ClawCore never writes to Apple Notes.
 */
import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { ingestFile } from "../../ingest/pipeline.js";
import { logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import { getDb } from "../../storage/index.js";
import { deleteDocument } from "../../storage/collections.js";
import type { SourceAdapter, SourceConfig, SourceStatus, ChangeSet, StagedFile } from "../types.js";

const STAGING_DIR = resolve(homedir(), ".clawcore", "staging", "apple-notes");

interface ManifestEntry {
  noteId: string;
  name: string;
  modificationDate: string;
}

interface AppleNote {
  id: string;
  name: string;
  folder: string;
  modificationDate: string;
  body: string;
}

export class AppleNotesAdapter implements SourceAdapter {
  id = "apple-notes";
  name = "Apple Notes";
  type = "polling" as const;

  private status: SourceStatus = { state: "idle", docCount: 0 };
  private syncTimer: NodeJS.Timeout | null = null;
  private manifest = new Map<string, ManifestEntry>();
  private cfg: SourceConfig | null = null;
  private unavailableReason = "";

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "darwin") {
      this.unavailableReason = "Apple Notes is only available on macOS";
      return false;
    }

    // Test AppleScript access
    try {
      execFileSync("osascript", ["-e", 'tell application "Notes" to count of notes'], {
        stdio: "pipe",
        timeout: 10000,
      });
      return true;
    } catch {
      this.unavailableReason = "Cannot access Notes.app. Grant Automation permissions in System Settings > Privacy & Security.";
      return false;
    }
  }

  availabilityReason(): string {
    return this.unavailableReason;
  }

  defaultConfig(): SourceConfig {
    return {
      enabled: false,
      syncInterval: 600,
      collections: [],
    };
  }

  getStatus(): SourceStatus {
    return { ...this.status };
  }

  async start(cfg: SourceConfig): Promise<void> {
    this.cfg = cfg;

    if (!cfg.enabled || cfg.collections.length === 0) {
      this.status = { state: "disabled", docCount: 0 };
      return;
    }

    logger.warn("Apple Notes manifest is in-memory — full re-sync will occur on restart");

    if (process.platform !== "darwin") {
      this.status = { state: "unavailable", docCount: 0, error: "macOS only" };
      return;
    }

    mkdirSync(STAGING_DIR, { recursive: true });

    // Initial sync
    try {
      await this.sync();
    } catch (err) {
      logger.error({ source: "apple-notes", error: String(err) }, "Initial Apple Notes sync failed");
      this.status = { state: "error", docCount: 0, error: `Initial sync failed: ${err}` };
    }

    // Start polling
    const intervalMs = (cfg.syncInterval || 600) * 1000;
    this.syncTimer = setInterval(() => {
      this.sync().catch((err) => {
        logger.error({ source: "apple-notes", error: String(err) }, "Apple Notes sync failed");
        this.status = { ...this.status, state: "error", error: String(err) };
      });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.status = { state: "idle", docCount: 0 };
  }

  async detectChanges(): Promise<ChangeSet> {
    if (!this.cfg) return { added: [], modified: [], removed: [] };

    const changes: ChangeSet = { added: [], modified: [], removed: [] };
    const allCurrentIds = new Set<string>();

    for (const collCfg of this.cfg.collections) {
      const folderName = collCfg.path;
      const collection = collCfg.collection;

      let notes: AppleNote[];
      try {
        notes = listNotesInFolder(folderName);
      } catch (err) {
        logger.error({ folder: folderName, error: String(err) }, "Failed to list Apple Notes");
        continue;
      }

      for (const note of notes) {
        allCurrentIds.add(note.id);
        const existing = this.manifest.get(note.id);
        if (!existing) {
          changes.added.push({
            sourceId: note.id,
            localPath: "",
            collection,
            tags: ["apple-notes", folderName.toLowerCase().replace(/\s+/g, "-")],
            remoteTimestamp: note.modificationDate,
          });
        } else if (existing.modificationDate !== note.modificationDate) {
          changes.modified.push({
            sourceId: note.id,
            localPath: "",
            collection,
            tags: ["apple-notes", folderName.toLowerCase().replace(/\s+/g, "-")],
            remoteTimestamp: note.modificationDate,
          });
        }
      }
    }

    // Detect removals AFTER iterating all folders to avoid cross-collection false positives
    for (const [noteId] of this.manifest) {
      if (!allCurrentIds.has(noteId)) {
        changes.removed.push(noteId);
      }
    }

    return changes;
  }

  async downloadToStaging(changes: ChangeSet): Promise<StagedFile[]> {
    const staged: StagedFile[] = [];
    const toProcess = [...changes.added, ...changes.modified];

    for (const file of toProcess) {
      try {
        const body = getNoteBody(file.sourceId);
        const outPath = join(STAGING_DIR, `${sanitizeFilename(file.sourceId)}.html`);
        writeFileSync(outPath, body, "utf-8");
        staged.push({ ...file, localPath: outPath });
      } catch (err) {
        logger.error({ noteId: file.sourceId, error: String(err) }, "Failed to export Apple Note");
      }
    }

    return staged;
  }

  cleanup(staged: StagedFile[]): void {
    for (const file of staged) {
      try {
        if (file.localPath && existsSync(file.localPath)) unlinkSync(file.localPath);
      } catch {}
    }
  }

  /** Run a full sync cycle */
  private async sync(): Promise<void> {
    this.status = { ...this.status, state: "syncing" };

    const changes = await this.detectChanges();
    const totalChanges = changes.added.length + changes.modified.length + changes.removed.length;

    if (totalChanges === 0) {
      logger.info({ source: "apple-notes" }, "Apple Notes sync: no changes");
      this.status = {
        ...this.status,
        state: "idle",
        lastSync: new Date(),
        nextSync: new Date(Date.now() + (this.cfg?.syncInterval ?? 600) * 1000),
      };
      return;
    }

    logger.info(
      { source: "apple-notes", added: changes.added.length, modified: changes.modified.length, removed: changes.removed.length },
      "Apple Notes sync: changes detected",
    );

    // Process removals — delete staging files, DB docs, and remove from manifest
    for (const noteId of changes.removed) {
      const stagingPath = join(STAGING_DIR, `${sanitizeFilename(noteId)}.html`);
      try { if (existsSync(stagingPath)) unlinkSync(stagingPath); } catch {}

      // Clean up DB documents/chunks/vectors to prevent orphans
      try {
        const db = getDb(resolve(config.dataDir, "clawcore.db"));
        const doc = db.prepare("SELECT id FROM documents WHERE source_path = ?").get(stagingPath) as { id: string } | undefined;
        if (doc) {
          deleteDocument(db, doc.id);
          logger.info({ source: "apple-notes", noteId, docId: doc.id }, "Deleted orphaned document from DB");
        }
      } catch (dbErr) {
        logger.error({ source: "apple-notes", noteId, error: String(dbErr) }, "Failed to clean up DB on removal");
      }

      this.manifest.delete(noteId);
      logger.info({ source: "apple-notes", noteId }, "Apple Note removed");
    }

    const staged = await this.downloadToStaging(changes);

    let ingested = 0;
    for (const file of staged) {
      try {
        await ingestFile(file.localPath, {
          collection: file.collection,
          tags: file.tags,
        });
        ingested++;

        this.manifest.set(file.sourceId, {
          noteId: file.sourceId,
          name: file.sourceId,
          modificationDate: file.remoteTimestamp ?? new Date().toISOString(),
        });
      } catch (err) {
        logger.error({ file: file.localPath, error: String(err) }, "Failed to ingest Apple Note");
      }
    }

    this.cleanup(staged);

    this.status = {
      state: "idle",
      lastSync: new Date(),
      nextSync: new Date(Date.now() + (this.cfg?.syncInterval ?? 600) * 1000),
      docCount: this.manifest.size,
    };

    logger.info({ source: "apple-notes", ingested, total: this.manifest.size }, "Apple Notes sync complete");
  }
}

// ────────────────────────────────────────────
// AppleScript helpers (macOS only)
// ────────────────────────────────────────────

/** List notes in a folder with metadata */
function listNotesInFolder(folderName: string): AppleNote[] {
  // If folderName is empty, list all notes
  const folderClause = folderName
    ? `of folder "${escapeAppleScript(folderName)}"`
    : "";

  const script = `
    tell application "Notes"
      set noteList to {}
      repeat with n in (every note ${folderClause})
        set noteId to id of n
        set noteName to name of n
        set noteMod to modification date of n as string
        set end of noteList to noteId & "|||" & noteName & "|||" & noteMod
      end repeat
      set AppleScript's text item delimiters to "\\n"
      return noteList as text
    end tell
  `;

  try {
    const out = execFileSync("osascript", ["-e", script], {
      stdio: "pipe",
      timeout: 30000,
    }).toString().trim();

    if (!out) return [];

    return out.split("\n").map((line) => {
      const [id, name, modificationDate] = line.split("|||");
      return { id: id ?? "", name: name ?? "", folder: folderName, modificationDate: modificationDate ?? "", body: "" };
    }).filter((n) => n.id);
  } catch (err) {
    logger.error({ folder: folderName, error: String(err) }, "AppleScript list failed");
    return [];
  }
}

/** Get the HTML body of a specific note */
function getNoteBody(noteId: string): string {
  const script = `
    tell application "Notes"
      set n to first note whose id is "${escapeAppleScript(noteId)}"
      return body of n
    end tell
  `;

  try {
    return execFileSync("osascript", ["-e", script], {
      stdio: "pipe",
      timeout: 15000,
    }).toString();
  } catch {
    return "";
  }
}

function escapeAppleScript(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

/** List all Notes folders (for TUI browser). macOS only. */
export function listNotesFolders(): { name: string; count: number }[] {
  if (process.platform !== "darwin") return [];

  const script = `
    tell application "Notes"
      set folderList to {}
      repeat with f in every folder
        set folderName to name of f
        set noteCount to count of notes of f
        set end of folderList to folderName & "|||" & noteCount
      end repeat
      set AppleScript's text item delimiters to "\\n"
      return folderList as text
    end tell
  `;

  try {
    const out = execFileSync("osascript", ["-e", script], {
      stdio: "pipe",
      timeout: 15000,
    }).toString().trim();

    if (!out) return [];
    return out.split("\n").map((line) => {
      const [name, count] = line.split("|||");
      return { name: name ?? "", count: parseInt(count) || 0 };
    }).filter((f) => f.name);
  } catch {
    return [];
  }
}
