#!/usr/bin/env node

import { existsSync } from "fs";
import { resolve } from "path";
import { t } from "./theme.js";
import { detectTerminalCapabilities, setTerminalCapabilities } from "./capabilities.js";
import { getRootDir, readConfig } from "./platform.js";

async function launchTui(): Promise<void> {
  const capabilities = detectTerminalCapabilities();
  setTerminalCapabilities(capabilities);
  const hasConfig = Boolean(readConfig());
  const hasEnv = existsSync(resolve(getRootDir(), ".env"));
  const hasComplete = existsSync(resolve(getRootDir(), ".install-complete"));
  // If config + .env exist but marker is missing, this is a pre-existing install — auto-create marker
  if (hasConfig && hasEnv && !hasComplete) {
    try { writeFileSync(resolve(getRootDir(), ".install-complete"), new Date().toISOString()); } catch {}
  }
  const installed = hasConfig && hasEnv;

  if (!installed && capabilities.rich) {
    const { runInkInstall } = await import("./ink/install-actions.js");
    const completed = await runInkInstall();
    if (!completed) return;
  }

  if (!readConfig() || !existsSync(resolve(getRootDir(), ".env"))) {
    const { runInstall } = await import("./screens/install.js");
    await runInstall();
    if (!readConfig() || !existsSync(resolve(getRootDir(), ".env"))) {
      console.error("Installation incomplete. Missing .env or config.json.");
      console.error("Run: threadclaw install");
      process.exit(1);
    }
  }

  const { launchInkTui } = await import("./ink/app.js");
  await launchInkTui();
}

launchTui().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : "";
  console.error(t.err(`\nFatal error: ${message}\n`));
  if (process.env.DEBUG && stack) console.error(t.dim(stack));
  if (!process.env.DEBUG) console.error(t.dim("Run with DEBUG=1 for full error details."));
  console.error(t.dim("\nIf this is a fresh install, try running: npm install && npx tsx src/tui/index.ts"));
  // Keep terminal open briefly so user can read the error
  setTimeout(() => process.exit(1), 5000);
});
