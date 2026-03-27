/**
 * Skill file management — hash-based sync with user modification protection.
 *
 * On install/upgrade:
 *   - Compute SHA-256 of shipped skill files
 *   - Compare with manifest hashes (what we last installed)
 *   - Compare with on-disk hashes (what's actually there)
 *   - If on-disk === manifest hash: safe to overwrite (user didn't modify)
 *   - If on-disk !== manifest hash: user customized, save new as .new, warn
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { sha256 } from "./version.js";

export interface SkillSyncResult {
  name: string;
  action: "updated" | "skipped" | "installed" | "unchanged";
  reason?: string;
}

/** Shipped skill files relative to the skills/ directory in ThreadClaw. */
const SHIPPED_SKILLS = [
  "threadclaw-evidence/SKILL.md",
  "threadclaw-knowledge/SKILL.md",
];

/**
 * Sync shipped skill files to the OpenClaw workspace.
 *
 * @param shippedDir - Path to ThreadClaw's skills/ directory (source)
 * @param workspaceSkillsDir - Path to OpenClaw workspace/skills/ (target)
 * @param manifestHashes - Hashes from the last install (from manifest.skills)
 * @param dryRun - If true, don't write files, just report what would happen
 * @returns Array of sync results + updated manifest hashes
 */
export function syncSkills(
  shippedDir: string,
  workspaceSkillsDir: string,
  manifestHashes: Record<string, string>,
  dryRun = false,
): { results: SkillSyncResult[]; updatedHashes: Record<string, string> } {
  const results: SkillSyncResult[] = [];
  const updatedHashes = { ...manifestHashes };

  for (const relPath of SHIPPED_SKILLS) {
    const shippedPath = resolve(shippedDir, relPath);
    const targetPath = resolve(workspaceSkillsDir, relPath);

    // Skip if shipped file doesn't exist
    if (!existsSync(shippedPath)) {
      results.push({ name: relPath, action: "skipped", reason: "shipped file not found" });
      continue;
    }

    const shippedContent = readFileSync(shippedPath, "utf-8");
    const shippedHash = sha256(shippedContent);

    // Case 1: Target doesn't exist — fresh install
    if (!existsSync(targetPath)) {
      if (!dryRun) {
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, shippedContent);
      }
      updatedHashes[relPath] = shippedHash;
      results.push({ name: relPath, action: "installed" });
      continue;
    }

    // Case 2: Target exists — check if user modified
    const currentContent = readFileSync(targetPath, "utf-8");
    const currentHash = sha256(currentContent);
    const lastInstalledHash = manifestHashes[relPath] ?? "";

    if (currentHash === shippedHash) {
      // Already up to date
      updatedHashes[relPath] = shippedHash;
      results.push({ name: relPath, action: "unchanged" });
      continue;
    }

    if (currentHash === lastInstalledHash || lastInstalledHash === "") {
      // User hasn't modified since last install — safe to overwrite
      if (!dryRun) {
        writeFileSync(targetPath, shippedContent);
      }
      updatedHashes[relPath] = shippedHash;
      results.push({ name: relPath, action: "updated" });
      continue;
    }

    // User has customized — don't overwrite, save .new alongside
    if (!dryRun) {
      writeFileSync(targetPath + ".new", shippedContent);
    }
    updatedHashes[relPath] = lastInstalledHash; // keep old hash (user's version is active)
    results.push({
      name: relPath,
      action: "skipped",
      reason: `user-modified — new version saved as ${relPath}.new`,
    });
  }

  return { results, updatedHashes };
}
