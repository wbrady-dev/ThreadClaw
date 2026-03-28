/**
 * Plain-text uninstall flow — used by CLI `threadclaw uninstall --plain`.
 * Core logic lives in ../uninstall-helpers.ts.
 */

import prompts from "prompts";
import { section, t, clearScreen } from "../theme.js";
import { performUninstall } from "../uninstall-helpers.js";

export async function runUninstall(): Promise<void> {
  clearScreen();
  console.log(section("Uninstall ThreadClaw"));
  console.log(t.warn("  This will remove ThreadClaw runtime and data:"));
  console.log(t.warn("  • All dependencies (node_modules, .venv, dist)"));
  console.log(t.warn("  • All config (.env, config.json, manifest)"));
  console.log(t.warn("  • All data (databases, evidence graph, backups)"));
  console.log(t.warn("  • Downloaded model cache (~2-6 GB)"));
  console.log(t.warn("  • Global command and PATH entry"));
  console.log(t.warn("  • OpenClaw integration\n"));
  console.log(t.dim("  Source code (git repo) will be preserved. You will be shown"));
  console.log(t.dim("  instructions to remove it after uninstall completes.\n"));

  let cancelled = false;
  const onCancel = () => { cancelled = true; };

  const { confirm } = await prompts({
    type: "confirm",
    name: "confirm",
    message: t.err("Are you sure you want to completely uninstall ThreadClaw?"),
    initial: false,
  }, { onCancel });

  if (!confirm || cancelled) {
    console.log(t.dim("\n  Cancelled.\n"));
    return;
  }

  await performUninstall({ deleteData: true });

  // Wait for user to read
  const { selectMenu } = await import("../menu.js");
  await selectMenu([{ label: "Done", value: "done", color: t.dim }]);
}
