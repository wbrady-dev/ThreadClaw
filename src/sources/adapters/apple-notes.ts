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
 * Read-only: ThreadClaw never writes to Apple Notes.
 */
import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { logger } from "../../utils/logger.js";
import { PollingAdapterBase, type RemoteItem } from "./polling-base.js";
import type { SourceConfig } from "../types.js";

const STAGING_DIR = resolve(homedir(), ".threadclaw", "staging", "apple-notes");

interface AppleNote {
  id: string;
  name: string;
  folder: string;
  modificationDate: string;
  body: string;
}

export class AppleNotesAdapter extends PollingAdapterBase {
  constructor() {
    super({
      id: "apple-notes",
      name: "Apple Notes",
      stagingDir: STAGING_DIR,
      defaultSyncInterval: 600,
    });
  }

  async checkAvailability(): Promise<boolean> {
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

  async initClient(): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("macOS only");
    }
    // No persistent client needed — AppleScript calls are stateless
  }

  defaultConfig(): SourceConfig {
    return {
      enabled: false,
      syncInterval: 600,
      collections: [],
    };
  }

  async listRemoteItems(): Promise<RemoteItem[]> {
    if (!this.cfg) return [];

    const items: RemoteItem[] = [];

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
        items.push({
          id: note.id,
          name: note.name,
          lastModified: note.modificationDate,
          collection,
          tags: ["apple-notes", folderName.toLowerCase().replace(/\s+/g, "-")],
        });
      }
    }

    return items;
  }

  async downloadItem(item: RemoteItem): Promise<string> {
    const body = getNoteBody(item.id);
    const outPath = join(STAGING_DIR, `${sanitizeFilename(item.id)}.html`);
    writeFileSync(outPath, body, "utf-8");
    return outPath;
  }

  protected getStagingPathsForRemoval(id: string, _name: string): string[] {
    return [join(STAGING_DIR, `${sanitizeFilename(id)}.html`)];
  }

  protected getRemovalDbQuery(id: string, _name: string): { sql: string; params: string[] } {
    const stagingPath = join(STAGING_DIR, `${sanitizeFilename(id)}.html`);
    return {
      sql: "SELECT id FROM documents WHERE source_path = ?",
      params: [stagingPath],
    };
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
