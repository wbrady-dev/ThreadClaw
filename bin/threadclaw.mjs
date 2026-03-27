#!/usr/bin/env node

// Global launcher for ThreadClaw
// Runs the built CLI from dist/. Falls back to tsx + src/ for development.

import { spawn, execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const [major] = process.versions.node.split(".").map(Number);
if (!Number.isFinite(major) || major < 22) {
  console.error(`Error: ThreadClaw requires Node.js >= 22. You have ${process.versions.node}.`);
  console.error("Download the latest from https://nodejs.org/");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const distEntries = [
  resolve(root, "dist", "cli", "threadclaw.js"),
  resolve(root, "dist", "cli", "threadclaw.mjs"),
];
const distEntry = distEntries.find((entry) => existsSync(entry));

if (distEntry) {
  const child = spawn(process.execPath, [distEntry, ...process.argv.slice(2)], {
    cwd: root,
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
} else {
  // Development fallback: use tsx to run TypeScript source directly
  // Prefer the .bin shim (works across tsx versions) over hardcoded internal path
  const tsxBin = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const tsxCliFallback = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
  const tsxCli = existsSync(tsxBin) ? tsxBin : tsxCliFallback;
  const srcEntry = resolve(root, "src", "cli", "threadclaw.ts");

  if (!existsSync(tsxCli)) {
    console.error("Error: dist/ not built and tsx not available.");
    console.error("Run 'npm run build' first, or 'npm install' for development.");
    process.exit(1);
  }

  // If using the .bin shim, spawn it directly; otherwise use node + cli.mjs
  const useShim = tsxCli === tsxBin;
  const child = useShim
    ? spawn(tsxCli, [srcEntry, ...process.argv.slice(2)], { cwd: root, stdio: "inherit", shell: process.platform === "win32" })
    : spawn(process.execPath, [tsxCli, srcEntry, ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
