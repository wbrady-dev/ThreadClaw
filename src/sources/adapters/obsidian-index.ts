/**
 * Obsidian Vault Index — maps note names and aliases to file paths.
 *
 * Per-vault scoped to handle multi-vault setups without name collisions.
 * Built on adapter start, updated incrementally via watcher events.
 * Used by the markdown parser's metadata enrichment to resolve [[wikilinks]].
 */
import { readdirSync, readFileSync } from "fs";
import { resolve, basename, extname, relative } from "path";
import yaml from "js-yaml";
import { logger } from "../../utils/logger.js";

// ── Vault Index ─────────────────────────────────────────────────────

export class ObsidianVaultIndex {
  /** vaultRoot → Map<lowercaseNoteName, absoluteFilePath> */
  private vaults = new Map<string, Map<string, string>>();
  /** vaultRoot → Map<lowercaseAlias, absoluteFilePath> */
  private aliases = new Map<string, Map<string, string>>();

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
            for (const alias of fileAliases) {
              aliasMap.set(alias.toLowerCase(), full);
            }
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
    let noteMap = this.vaults.get(root);
    if (!noteMap) {
      noteMap = new Map();
      this.vaults.set(root, noteMap);
    }
    let aliasMap = this.aliases.get(root);
    if (!aliasMap) {
      aliasMap = new Map();
      this.aliases.set(root, aliasMap);
    }

    const noteName = basename(filePath, ".md").toLowerCase();
    noteMap.set(noteName, resolve(filePath));

    if (noteAliases) {
      for (const alias of noteAliases) {
        aliasMap.set(alias.toLowerCase(), resolve(filePath));
      }
    }
  }

  /** Remove a note from the index (called on watcher file remove). */
  removeNote(vaultRoot: string, filePath: string): void {
    const root = resolve(vaultRoot);
    const noteMap = this.vaults.get(root);
    const aliasMap = this.aliases.get(root);
    const absPath = resolve(filePath);

    if (noteMap) {
      for (const [name, path] of noteMap) {
        if (path === absPath) { noteMap.delete(name); break; }
      }
    }
    if (aliasMap) {
      for (const [alias, path] of aliasMap) {
        if (path === absPath) aliasMap.delete(alias);
      }
    }
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

      const parsed = yaml.load(fmMatch[1]);
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

/** Initialize and return the vault index singleton. */
export function initVaultIndex(): ObsidianVaultIndex {
  if (!instance) instance = new ObsidianVaultIndex();
  return instance;
}

/** Reset (for testing). */
export function _resetVaultIndex(): void {
  instance = null;
}
