#!/usr/bin/env node

import { existsSync } from "fs";
import { resolve } from "path";
import { t } from "./theme.js";
import { detectTerminalCapabilities, setTerminalCapabilities } from "./capabilities.js";
import { getRootDir, readConfig } from "./platform.js";

async function launchTui(): Promise<void> {
  const capabilities = detectTerminalCapabilities();
  setTerminalCapabilities(capabilities);
  const installed = Boolean(readConfig()) || existsSync(resolve(getRootDir(), "node_modules"));

  if (!installed && capabilities.rich) {
    const { runInkInstall } = await import("./ink/install-actions.js");
    const completed = await runInkInstall();
    if (!completed) return;
  }

  if (!readConfig() && !existsSync(resolve(getRootDir(), "node_modules"))) {
    const { runInstall } = await import("./screens/install.js");
    await runInstall();
    if (!readConfig() && !existsSync(resolve(getRootDir(), "node_modules"))) {
      return;
    }
  }

  const { launchInkTui } = await import("./ink/app.js");
  await launchInkTui();
}

launchTui().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : "";
  console.error(t.err(`\nFatal error: ${message}\n`));
  if (stack) console.error(t.dim(stack));
  console.error(t.dim("\nIf this is a fresh install, try running: npm install && npx tsx src/tui/index.ts"));
  // Keep terminal open briefly so user can read the error
  setTimeout(() => process.exit(1), 5000);
});
