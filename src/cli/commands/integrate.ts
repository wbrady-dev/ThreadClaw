/**
 * threadclaw integrate — manage OpenClaw integration.
 *
 * --check: read-only check for drift (default)
 * --apply: re-apply the managed integration block
 */

import { Command } from "commander";
import { resolve } from "path";
import { readFileSync } from "fs";
import { t } from "../../tui/theme.js";
import { getRootDir } from "../../tui/platform.js";
import { checkOpenClawIntegration, applyOpenClawIntegration, findOpenClawConfigPath, computeIntegrationHash } from "../../integration.js";
import { readManifest, writeManifest } from "../../version.js";

export const integrateCommand = new Command("integrate")
  .description("Check or apply OpenClaw integration")
  .option("--apply", "Re-apply the managed integration block")
  .option("--check", "Check for drift without applying (default)")
  .action(async (opts: { apply?: boolean; check?: boolean }) => {
    const rootDir = getRootDir();
    const memoryEnginePath = resolve(rootDir, "memory-engine");

    if (opts.apply) {
      console.log("");
      console.log(t.brand("ThreadClaw Integration — Apply"));
      console.log("");

      try {
        const { applied, changes } = applyOpenClawIntegration(memoryEnginePath);
        if (applied) {
          for (const c of changes) {
            console.log(`  ${t.ok("✓")} ${c}`);
          }

          // Update manifest hash
          const manifest = readManifest();
          const configPath = findOpenClawConfigPath();
          if (configPath) {
            try {
              const oc = JSON.parse(readFileSync(configPath, "utf-8"));
              manifest.integrationHash = computeIntegrationHash(oc);
              writeManifest(manifest);
            } catch (e) {
              console.warn(`  Warning: failed to update manifest hash: ${e}`);
            }
          }

          console.log("");
          console.log(t.ok("  Integration applied."));
        } else {
          console.log(`  ${t.ok("✓")} Integration already correct. No changes needed.`);
        }
      } catch (err) {
        console.error(`  ${t.err("✗")} Apply failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      console.log("");
    } else {
      // Default: check
      console.log("");
      console.log(t.brand("ThreadClaw Integration — Check"));
      console.log("");

      const status = checkOpenClawIntegration(memoryEnginePath);

      if (!status.openclawFound) {
        console.log(`  ${t.warn("⚠")} OpenClaw not detected`);
      } else if (status.ok) {
        console.log(`  ${t.ok("✓")} Integration OK — all managed fields correct`);
      } else {
        console.log(`  ${t.err("✗")} Integration drift detected:`);
        for (const drift of status.drifts) {
          const icon = drift.severity === "error" ? t.err("✗") : t.warn("⚠");
          console.log(`    ${icon} ${drift.field}: expected ${JSON.stringify(drift.expected)}, got ${JSON.stringify(drift.actual)}`);
        }
        console.log("");
        console.log(t.dim("  Run 'threadclaw integrate --apply' to fix."));
      }
      console.log("");
    }
  });
