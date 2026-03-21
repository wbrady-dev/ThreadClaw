import ora from "ora";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { banner, section, status, kvLine, t, clearScreen } from "../theme.js";
import {
  checkServices,
  startServices,
  stopServices,
  getPlatform,
  isAdmin,
  getRootDir,
  findOpenClaw,
  installWindowsServices,
  removeWindowsServices,
  installLinuxServices,
  removeLinuxServices,
  installMacServices,
  removeMacServices,
  getApiPort,
  getModelPort,
} from "../platform.js";
import { selectMenu } from "../menu.js";
import { runInstall } from "./install.js";
import { runUninstall } from "./uninstall.js";

export async function manageServices(): Promise<void> {
  while (true) {
    clearScreen();

    const svc = checkServices();
    const root = getRootDir();
    const plat = getPlatform();
    const autoStartEnabled = checkAutoStartup();
    const gameModeOn = !svc.models.running && !svc.clawcore.running;

    console.log(section("Services"));
    console.log(status("Models", svc.models.running, `port ${getModelPort()}`));
    console.log(status("ClawCore RAG API", svc.clawcore.running, `port ${getApiPort()}`));
    console.log(kvLine("Auto-Startup", autoStartEnabled ? t.ok("on") : t.dim("off")));
    console.log(kvLine("Game Mode", gameModeOn ? t.warn("on (VRAM freed)") : t.dim("off")));
    console.log("");

    const items = [];

    if (autoStartEnabled) {
      items.push({ label: "Disable auto-startup", value: "auto-off" });
    } else {
      items.push({ label: "Enable auto-startup", value: "auto-on" });
    }

    if (svc.models.running || svc.clawcore.running) {
      items.push({ label: "Game Mode on (free VRAM)", value: "game-on", color: t.warn });
    } else {
      items.push({ label: "Game Mode off (restart)", value: "game-off", color: t.ok });
    }

    items.push({ label: "Reinstall", value: "install" });
    items.push({ label: "Uninstall", value: "uninstall", color: t.err });
    items.push({ label: "Back", value: "back", color: t.dim });

    const action = await selectMenu(items);
    if (!action || action === "back") return;

    const spinner = ora();

    switch (action) {
      case "auto-on": {
        const root = getRootDir();
        if (plat === "windows") {
          spinner.start("Enabling auto-startup...");
          const r = installWindowsServices(root);
          r.success ? spinner.succeed("Auto-startup enabled.") : spinner.fail(`Failed: ${r.error}`);
        } else if (plat === "linux") {
          if (!isAdmin()) {
            console.log(t.warn("\n  Requires sudo. Run: sudo clawcore"));
            await sleep(1500);
          } else {
            spinner.start("Enabling auto-startup (systemd)...");
            const r = installLinuxServices(root);
            r.success ? spinner.succeed("Auto-startup enabled (systemd).") : spinner.fail(`Failed: ${r.error}`);
          }
        } else if (plat === "mac") {
          spinner.start("Enabling auto-startup (launchd)...");
          const r = installMacServices(root);
          r.success ? spinner.succeed("Auto-startup enabled (launchd).") : spinner.fail(`Failed: ${r.error}`);
        }
        break;
      }

      case "auto-off": {
        if (plat === "windows") {
          spinner.start("Disabling auto-startup...");
          stopServices();
          removeWindowsServices();
          spinner.succeed("Auto-startup disabled.");
        } else if (plat === "linux") {
          if (!isAdmin()) {
            console.log(t.warn("\n  Requires sudo. Run: sudo clawcore"));
            await sleep(1500);
          } else {
            spinner.start("Disabling auto-startup (systemd)...");
            stopServices();
            removeLinuxServices();
            spinner.succeed("Auto-startup disabled.");
          }
        } else if (plat === "mac") {
          spinner.start("Disabling auto-startup (launchd)...");
          stopServices();
          removeMacServices();
          spinner.succeed("Auto-startup disabled.");
        }
        break;
      }

      case "game-on": {
        spinner.start("Game Mode on — stopping models...");
        stopServices();
        // Force kill anything on our ports (catches orphaned processes)
        killPort(getModelPort());
        killPort(getApiPort());
        spinner.succeed("Game Mode on. VRAM freed.");
        break;
      }

      case "game-off": {
        spinner.start("Game Mode off — starting services...");
        const r = startServices();
        if (r.success) {
          spinner.text = "Waiting for model server...";
          await waitForPort(getModelPort(), 120000);
          spinner.text = "Waiting for ClawCore API...";
          await waitForPort(getApiPort(), 30000);
          spinner.succeed("Game Mode off. Services started.");
        } else {
          spinner.fail(`Failed: ${r.error}`);
        }
        break;
      }

      case "install":
        await runInstall();
        return;

      case "uninstall":
        await runUninstall();
        return;
    }
  }
}

// ── Watch Path Checkbox UI ──

interface WatchEntry {
  path: string;
  collection: string;
  enabled: boolean;
}

function getWatchPaths(root: string): WatchEntry[] {
  try {
    const envPath = resolve(root, ".env");
    if (!existsSync(envPath)) return [];
    const env = readFileSync(envPath, "utf-8");
    const raw = env.match(/WATCH_PATHS=(.*)/)?.[1]?.trim();
    if (!raw) return [];

    return raw.split(",").filter(Boolean).map((entry) => {
      const pipeIdx = entry.lastIndexOf("|");
      const path = pipeIdx > 0 ? entry.slice(0, pipeIdx) : entry;
      const collection = pipeIdx > 0 ? entry.slice(pipeIdx + 1) : "default";
      return { path, collection, enabled: true };
    });
  } catch {
    return [];
  }
}

async function configureWatchPaths(root: string): Promise<void> {
  const current = getWatchPaths(root);
  const openclawDir = findOpenClaw();

  // Discover all candidate directories from OpenClaw workspace
  const all = new Map<string, WatchEntry>();

  if (openclawDir) {
    const workspace = resolve(openclawDir, "workspace");

    if (existsSync(workspace)) {
      // Top-level workspace
      all.set(workspace, { path: workspace, collection: "workspace", enabled: false });

      // Scan immediate subdirectories
      try {
        const entries = readdirSync(workspace, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            const subPath = resolve(workspace, entry.name);
            const collName = entry.name;
            all.set(subPath, { path: subPath, collection: collName, enabled: false });

            // One more level deep for skills/*
            if (entry.name === "skills") {
              try {
                const skillEntries = readdirSync(subPath, { withFileTypes: true });
                for (const skill of skillEntries) {
                  if (skill.isDirectory() && !skill.name.startsWith(".")) {
                    const skillPath = resolve(subPath, skill.name);
                    all.set(skillPath, { path: skillPath, collection: `skill-${skill.name}`, enabled: false });
                  }
                }
              } catch {}
            }
          }
        }
      } catch {}
    }

    // Also check for media/inbound, Projects, etc.
    const mediaInbound = resolve(openclawDir, "media", "inbound");
    if (existsSync(mediaInbound)) {
      all.set(mediaInbound, { path: mediaInbound, collection: "inbound", enabled: false });
    }
  }

  // Common user directories
  const home = homedir();
  const commonDirs = [
    { path: resolve(home, "Documents"), collection: "documents" },
    { path: resolve(home, "Downloads"), collection: "downloads" },
    { path: resolve(home, "Desktop"), collection: "desktop" },
  ];
  for (const d of commonDirs) {
    if (existsSync(d.path)) {
      all.set(d.path, { ...d, enabled: false });
    }
  }

  // Merge current config — mark existing as enabled
  for (const c of current) {
    if (all.has(c.path)) {
      all.get(c.path)!.enabled = true;
      all.get(c.path)!.collection = c.collection;
    } else {
      all.set(c.path, { ...c, enabled: true });
    }
  }

  const entries = Array.from(all.values());

  console.log(section("Watch Paths"));
  console.log(t.dim("  Space = toggle, Enter = save, Esc = cancel\n"));

  // Add a special "custom" entry at the end
  const CUSTOM_VALUE = "__custom__";
  const checkboxEntries = [...entries];

  const result = await checkboxMenuWithCustom(checkboxEntries);

  if (!result) return; // cancelled

  const enabled = result.filter((e) => e.enabled);
  const watchValue = enabled.map((e) => `${e.path}|${e.collection}`).join(",");

  const envPath = resolve(root, ".env");
  if (existsSync(envPath)) {
    let env = readFileSync(envPath, "utf-8");
    if (/WATCH_PATHS=/.test(env)) {
      env = env.replace(/WATCH_PATHS=.*/, `WATCH_PATHS=${watchValue}`);
    } else {
      env += `\nWATCH_PATHS=${watchValue}\n`;
    }
    writeFileSync(envPath, env);
  }

  console.log(t.ok(`\n  ${enabled.length} watch paths saved. Restart to apply.`));
  await sleep(500);
}

/**
 * Checkbox menu with a "+ Add custom path" option at the bottom.
 */
function checkboxMenuWithCustom(entries: WatchEntry[]): Promise<WatchEntry[] | null> {
  return new Promise((resolve) => {
    let selected = 0;
    const items = entries.map((e) => ({ ...e }));
    const hasCustomRow = true;
    const totalRows = items.length + (hasCustomRow ? 1 : 0);

    const render = () => {
      process.stdout.write(`\x1b[${totalRows}A`);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const cursor = i === selected ? t.selected("›") : " ";
        const check = item.enabled ? t.ok("[✓]") : t.dim("[ ]");
        const shortPath = shortenPath(item.path);
        const label = i === selected ? t.selected(shortPath) : t.value(shortPath);
        const coll = t.dim(` → ${item.collection}`);
        process.stdout.write(`\x1b[2K  ${cursor} ${check} ${label}${coll}\n`);
      }
      // Custom row
      const customSelected = selected === items.length;
      const cursor = customSelected ? t.selected("›") : " ";
      const label = customSelected ? t.selected("+ Add custom path") : t.info("+ Add custom path");
      process.stdout.write(`\x1b[2K  ${cursor}     ${label}\n`);
    };

    // Initial render
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const cursor = i === selected ? t.selected("›") : " ";
      const check = item.enabled ? t.ok("[✓]") : t.dim("[ ]");
      const shortPath = shortenPath(item.path);
      const label = i === selected ? t.selected(shortPath) : t.value(shortPath);
      const coll = t.dim(` → ${item.collection}`);
      console.log(`  ${cursor} ${check} ${label}${coll}`);
    }
    const customSelected = selected === items.length;
    console.log(`  ${customSelected ? t.selected("›") : " "}     ${t.info("+ Add custom path")}`);

    process.stdout.write("\x1b[?25l");
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    const onKey = async (key: Buffer) => {
      const s = key.toString();
      if (s === "\x1b[A" || s === "k") {
        selected = (selected - 1 + totalRows) % totalRows;
        render();
      } else if (s === "\x1b[B" || s === "j") {
        selected = (selected + 1) % totalRows;
        render();
      } else if (s === " ") {
        if (selected < items.length) {
          items[selected].enabled = !items[selected].enabled;
          render();
        }
      } else if (s === "\r" || s === "\n") {
        if (selected === items.length) {
          // Custom path
          cleanup();
          const prompts = (await import("prompts")).default;
          console.log("");
          let _cancelled = false;
          const _onCancel = () => { _cancelled = true; };
          const { customPath } = await prompts({
            type: "text",
            name: "customPath",
            message: "Directory path",
          }, { onCancel: _onCancel });
          const { customColl } = await prompts({
            type: "text",
            name: "customColl",
            message: "Collection name",
            initial: "custom",
          }, { onCancel: _onCancel });
          if (customPath && customColl) {
            items.push({ path: customPath, collection: customColl, enabled: true });
          }
          resolve(items);
        } else {
          cleanup();
          resolve(items);
        }
      } else if (s === "\x1b" || s === "q") {
        cleanup();
        resolve(null);
      } else if (s === "\x03") {
        cleanup();
        process.exit(0);
      }
    };

    const cleanup = () => {
      process.stdin.removeListener("data", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h");
    };

    process.stdin.on("data", onKey);
  });
}

/**
 * Shorten a path for display — show last 3 parts.
 */
function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  if (parts.length <= 4) return p;
  return "..." + parts.slice(-3).join("/");
}

function killPort(port: number): void {
  const plat = getPlatform();
  try {
    if (plat === "windows") {
      const out = execFileSync("netstat", ["-ano"], { stdio: "pipe" }).toString();
      for (const line of out.split("\n")) {
        if (line.includes(`:${port}`) && line.includes("LISTENING")) {
          const pid = line.trim().split(/\s+/).pop();
          if (pid && pid !== "0" && /^\d+$/.test(pid)) {
            try { execFileSync("taskkill", ["/PID", pid, "/F"], { stdio: "pipe" }); } catch {}
          }
        }
      }
    } else {
      try {
        const out = execFileSync("lsof", ["-ti", `:${port}`], { stdio: "pipe" }).toString().trim();
        if (out) {
          for (const pid of out.split("\n")) {
            const trimmed = pid.trim();
            if (/^\d+$/.test(trimmed)) {
              try { process.kill(Number(trimmed), "SIGKILL"); } catch {}
            }
          }
        }
      } catch {}
    }
  } catch {}
}

function checkAutoStartup(): boolean {
  const plat = getPlatform();
  if (plat === "windows") {
    try {
      execFileSync("schtasks", ["/query", "/tn", "ClawCore_Models"], { stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
  if (plat === "linux") {
    try {
      const out = execFileSync("systemctl", ["is-enabled", "clawcore-models"], { stdio: "pipe" }).toString().trim();
      return out === "enabled";
    } catch {
      return false;
    }
  }
  if (plat === "mac") {
    try {
      const plistPath = resolve(homedir(), "Library", "LaunchAgents", "com.clawcore.models.plist");
      return existsSync(plistPath);
    } catch {
      return false;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
    } catch {}
    await sleep(500);
  }
}
