/**
 * Obsidian Vault Index — maps note names and aliases to file paths.
 *
 * Per-vault scoped to handle multi-vault setups without name collisions.
 * Built on adapter start, updated incrementally via watcher events.
 * Used by the markdown parser's metadata enrichment to resolve [[wikilinks]].
 */
import { readdirSync, readFileSync } from "fs";
import { resolve, basename, extname, relative } from "path";
import { load as yamlLoad } from "js-yaml";
import { logger } from "../../utils/logger.js";

// ── Vault Index ─────────────────────────────────────────────────────

export class ObsidianVaultIndex {
  /** vaultRoot → Map<lowercaseNoteName, absoluteFilePath> */
  private vaults = new Map<string, Map<string, string>>();
  /** vaultRoot → Map<lowercaseAlias, absoluteFilePath> */
  private aliases = new Map<string, Map<string, string>>();
  /** Reverse index: absolutePath → { vault, name } for O(1) removal */
  private pathIndex = new Map<string, { vault: string; name: string; aliases: string[] }>();

  /**
   * Build the index for a vault root by walking all .md files.
   * Quick-parses YAML frontmatter for aliases only (no full parse).
   */
  build(vaultRoot: string): void {
    const noteMap = new Map<string, string>();
    const aliasMap = new Map<string, string>();
    const root = resolve(vaultRoot);

    const walk = (dir: string): void => {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const name = entry.name;
          // Skip hidden dirs, .obsidian, .trash, node_modules
          if (name.startsWith(".") || name === "node_modules") continue;
          const full = resolve(dir, name);

          if (entry.isDirectory()) {
            walk(full);
          } else if (extname(name) === ".md") {
            const noteName = basename(name, ".md").toLowerCase();
            noteMap.set(noteName, full);

            // Quick-parse frontmatter for aliases
            const fileAliases = this.quickExtractAliases(full);
            const lcAliases: string[] = [];
            for (const alias of fileAliases) {
              const lc = alias.toLowerCase();
              aliasMap.set(lc, full);
              lcAliases.push(lc);
            }

            // Reverse index for O(1) removal
            this.pathIndex.set(full, { vault: root, name: noteName, aliases: lcAliases });
          }
        }
      } catch {
        // Permission error or symlink loop — skip
      }
    };

    walk(root);
    this.vaults.set(root, noteMap);
    this.aliases.set(root, aliasMap);

    logger.info({ vault: root, notes: noteMap.size, aliases: aliasMap.size }, "Obsidian vault index built");
  }

  /**
   * Resolve a wikilink target to a file path.
   * Checks note names first, then aliases, across all indexed vaults
   * or scoped to a specific vault.
   */
  resolve(wikilink: string, fromVault?: string): string | null {
    const target = wikilink.toLowerCase().trim();
    if (!target) return null;

    const vaultRoots = fromVault ? [resolve(fromVault)] : [...this.vaults.keys()];

    for (const root of vaultRoots) {
      const noteMap = this.vaults.get(root);
      if (noteMap?.has(target)) return noteMap.get(target)!;

      const aliasMap = this.aliases.get(root);
      if (aliasMap?.has(target)) return aliasMap.get(target)!;
    }
    return null;
  }

  /** Add a note to the index (called on watcher file add). */
  addNote(vaultRoot: string, filePath: string, noteAliases?: string[]): void {
    const root = resolve(vaultRoot);
    const absPath = resolve(filePath);
    let noteMap = this.vaults.get(root);
    if (!noteMap) { noteMap = new Map(); this.vaults.set(root, noteMap); }
    let aliasMap = this.aliases.get(root);
    if (!aliasMap) { aliasMap = new Map(); this.aliases.set(root, aliasMap); }

    const noteName = basename(filePath, ".md").toLowerCase();
    noteMap.set(noteName, absPath);

    const lcAliases: string[] = [];
    if (noteAliases) {
      for (const alias of noteAliases) {
        const lc = alias.toLowerCase();
        aliasMap.set(lc, absPath);
        lcAliases.push(lc);
      }
    }

    // Reverse index for O(1) removal
    this.pathIndex.set(absPath, { vault: root, name: noteName, aliases: lcAliases });
  }

  /** Remove a note from the index (called on watcher file remove). O(1). */
  removeNote(_vaultRoot: string, filePath: string): void {
    const absPath = resolve(filePath);
    const entry = this.pathIndex.get(absPath);
    if (!entry) return;

    const noteMap = this.vaults.get(entry.vault);
    if (noteMap) noteMap.delete(entry.name);

    const aliasMap = this.aliases.get(entry.vault);
    if (aliasMap) {
      for (const alias of entry.aliases) aliasMap.delete(alias);
    }

    this.pathIndex.delete(absPath);
  }

  /** Clear all data (called on adapter restart). */
  clear(): void {
    this.vaults.clear();
    this.aliases.clear();
    this.pathIndex.clear();
  }

  /** Get stats for display in TUI. */
  getStats(): { vaults: number; notes: number; aliases: number } {
    let notes = 0;
    let aliases = 0;
    for (const map of this.vaults.values()) notes += map.size;
    for (const map of this.aliases.values()) aliases += map.size;
    return { vaults: this.vaults.size, notes, aliases };
  }

  /** Quick-extract aliases from YAML frontmatter without full file parse. */
  private quickExtractAliases(filePath: string): string[] {
    try {
      const content = readFileSync(filePath, "utf-8");
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      if (!fmMatch) return [];

      const parsed = yamlLoad(fmMatch[1]);
      if (!parsed || typeof parsed !== "object") return [];
      const fm = parsed as Record<string, unknown>;

      if (Array.isArray(fm.aliases)) {
        return fm.aliases.map((a) => String(a).trim()).filter(Boolean);
      }
      if (typeof fm.aliases === "string") {
        return [fm.aliases.trim()].filter(Boolean);
      }
    } catch {
      // Malformed YAML or read error — skip aliases
    }
    return [];
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let instance: ObsidianVaultIndex | null = null;

/** Get the vault index (null if Obsidian adapter not started). */
export function getVaultIndex(): ObsidianVaultIndex | null {
  return instance;
}

/** Initialize and return the vault index singleton. Clears existing data on re-init. */
export function initVaultIndex(): ObsidianVaultIndex {
  if (!instance) {
    instance = new ObsidianVaultIndex();
  } else {
    // Clear stale data from previous adapter run
    instance.clear();
  }
  return instance;
}

/** Reset (for testing). */
export function _resetVaultIndex(): void {
  instance = null;
}
