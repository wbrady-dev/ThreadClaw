// TODO: Migrate TUI tests to vitest for unified test runner and coverage.
// This custom harness exists because Ink components require special rendering
// and the TUI entry point has side effects. Once refactored, these can move
// to test/tui/*.test.ts files.
// TODO: TUI Ink components (screens, widgets) have zero test coverage.
// Add component render tests using ink-testing-library.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runStreamedCommand, sanitizeCommandLine } from "../../src/tui/process.ts";
import { clearServiceLogs, getServiceLogPath, readLatestServiceLogLine, readServiceLogTail } from "../../src/tui/service-logs.ts";
import { formatDoclingDevice, getWatchPaths } from "../../src/tui/screens/configure.ts";
import { readEnvMap, updateEnvValues } from "../../src/tui/env.ts";
import { getNpmCmd, getRootDir, setRootDirOverride } from "../../src/tui/platform.ts";
import { finishTask, getTaskSnapshot, startTask, updateTask } from "../../src/tui/tasks.ts";

let passed = 0;

async function runTest(name: string, testFn: () => void | Promise<void>): Promise<void> {
  try {
    await testFn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

await runTest("sanitizeCommandLine strips ANSI and trims text", () => {
  const input = "\u001b[32m  hello world  \u001b[0m";
  assert.equal(sanitizeCommandLine(input), "hello world");
});

await runTest("runStreamedCommand captures output and emits streamed lines", async () => {
  const streamed: string[] = [];
  const fakeSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;

    queueMicrotask(() => {
      child.stdout.write("ready\n");
      child.stderr.write("warning\n");
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);
    });

    return child;
  })() as unknown as ReturnType<typeof import("node:child_process").spawn>;

  // NOTE: The command/args below are unused because spawnImpl overrides spawning.
  // They are kept for documentation of what the real command would be.
  const result = await runStreamedCommand(
    process.execPath,
    ["-e", "console.log('ready'); console.error('warning');"],
    {
      onLine: (line) => streamed.push(line),
      timeoutMs: 5000,
      spawnImpl: (() => fakeSpawn) as typeof import("node:child_process").spawn,
    },
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /ready/);
  assert.match(result.stderr, /warning/);
  assert.deepEqual(streamed, ["ready", "warning"]);
});

await runTest("service log helpers clear and read log files", () => {
  const root = mkdtempSync(join(tmpdir(), "threadclaw-tui-"));

  clearServiceLogs(root);
  assert.equal(readLatestServiceLogLine("models", root), "");

  const modelsLog = getServiceLogPath("models", root);
  writeFileSync(modelsLog, "booting\nmodel loaded\n");

  assert.equal(readLatestServiceLogLine("models", root), "model loaded");
  assert.deepEqual(readServiceLogTail("models", 2, root), ["booting", "model loaded"]);
});

await runTest("configure helpers summarize parser mode and watch paths", () => {
  const root = mkdtempSync(join(tmpdir(), "threadclaw-config-"));
  writeFileSync(
    join(root, ".env"),
    [
      "WATCH_PATHS=C:\\Docs\\Inbox|default,/tmp/research|notes",
      "WATCH_DEBOUNCE_MS=5000",
    ].join("\n"),
  );

  assert.equal(formatDoclingDevice("gpu"), "Docling (GPU)");
  assert.equal(formatDoclingDevice("off"), "Standard (built-in)");
  assert.deepEqual(getWatchPaths(root), [
    { path: "C:\\Docs\\Inbox", collection: "default" },
    { path: "/tmp/research", collection: "notes" },
  ]);
});

await runTest("env updates preserve existing content and append new keys", () => {
  const root = mkdtempSync(join(tmpdir(), "threadclaw-env-"));
  writeFileSync(
    join(root, ".env"),
    [
      "# ThreadClaw Configuration",
      "QUERY_TOP_K=10",
      "WATCH_DEBOUNCE_MS=3000",
    ].join("\n"),
  );

  updateEnvValues(root, {
    QUERY_TOP_K: "25",
    QUERY_TOKEN_BUDGET: "6000",
  });

  assert.equal(readEnvMap(root).QUERY_TOP_K, "25");
  assert.equal(readEnvMap(root).QUERY_TOKEN_BUDGET, "6000");
  assert.equal(readEnvMap(root).WATCH_DEBOUNCE_MS, "3000");
});

await runTest("root override switches the active TUI root", () => {
  const originalRoot = getRootDir();
  const overriddenRoot = mkdtempSync(join(tmpdir(), "threadclaw-root-"));

  setRootDirOverride(overriddenRoot);
  assert.equal(getRootDir(), overriddenRoot);

  setRootDirOverride(originalRoot);
  assert.equal(getRootDir(), originalRoot);
});

await runTest("npm helper resolves the platform-specific launcher", () => {
  assert.equal(getNpmCmd(), process.platform === "win32" ? "npm.cmd" : "npm");
});

await runTest("terminal task updates do not regress after completion", () => {
  const taskId = `task-${Date.now()}`;
  startTask(taskId, "Install models", "Starting");
  finishTask(taskId, "Complete");
  updateTask(taskId, { state: "running", detail: "Should be ignored" });

  const task = getTaskSnapshot().find((entry) => entry.id === taskId);
  assert.equal(task?.state, "success");
  assert.equal(task?.detail, "Complete");
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} TUI checks passed`);
