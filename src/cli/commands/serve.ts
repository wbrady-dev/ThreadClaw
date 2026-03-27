import { Command } from "commander";
import { spawn, execFileSync } from "child_process";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import { t } from "../../tui/theme.js";
import { config } from "../../config.js";
import { getApiPort, getModelPort, getPythonCmd, findModelsScript } from "../../tui/platform.js";

/**
 * Run both model server and ThreadClaw RAG API in a single terminal.
 * Shows live status and logs. Ctrl+C stops everything cleanly.
 */
export const serveCommand = new Command("serve")
  .description("Run ThreadClaw services in this terminal (model server + RAG API)")
  .action(async () => {
    const root = config.rootDir;
    const serverScript = findModelsScript(root);

    console.log("");
    console.log(t.ok("  ╔══════════════════════════════════╗"));
    console.log(t.ok("  ║") + t.brand("  T H R E A D C L A W  S E R V E R ") + t.ok("║"));
    console.log(t.ok("  ╚══════════════════════════════════╝"));
    console.log("");

    // Find Python (prefers venv)
    const pythonCmd = getPythonCmd();

    const prefix = {
      models: t.tag("[models]  "),
      tal: t.ok("[threadclaw]"),
      sys: t.dim("[system]  "),
    };

    // Stop any existing services/processes on our ports
    console.log(`${prefix.sys} Checking for existing services...`);

    // Kill anything on our ports (cross-platform)
    for (const port of [getModelPort(), getApiPort()]) {
      try {
        // Try graceful HTTP shutdown first (works on all platforms)
        try {
          await fetch(`http://127.0.0.1:${port}/shutdown`, {
            method: "POST",
            signal: AbortSignal.timeout(2000),
          });
          console.log(`${prefix.sys} ${t.dim(`Sent shutdown to port ${port}`)}`);
        } catch {
          // No server listening or no /shutdown endpoint — fall through to force-kill
        }

        if (process.platform === "win32") {
          const out = execFileSync("netstat", ["-ano"], { stdio: "pipe" }).toString();
          // Use word-boundary regex to avoid false positives (e.g. port 80 matching 8012)
          const portRegex = new RegExp(`:${port}\\s`, "g");
          for (const line of out.split("\n")) {
            if (portRegex.test(line) && line.includes("LISTENING")) {
              const pid = line.trim().split(/\s+/).pop();
              if (pid && pid !== "0" && /^\d+$/.test(pid)) {
                console.log(`${prefix.sys} ${t.warn(`Stopping existing process on port ${port} (PID ${pid})...`)}`);
                try { execFileSync("taskkill", ["/PID", pid, "/F"], { stdio: "pipe" }); } catch {}
              }
            }
          }
        } else {
          const out = execFileSync("lsof", ["-ti", `:${port}`], { stdio: "pipe" }).toString().trim();
          if (out) {
            for (const pid of out.split("\n")) {
              const trimmed = pid.trim();
              if (/^\d+$/.test(trimmed)) {
                console.log(`${prefix.sys} ${t.warn(`Stopping existing process on port ${port} (PID ${trimmed})...`)}`);
                try { process.kill(Number(trimmed), "SIGTERM"); } catch {}
              }
            }
          }
        }
      } catch {}
    }

    // Brief pause for ports to release after killing processes.
    // TODO: Could be replaced with a port-available poll loop for faster startup.
    await new Promise((r) => setTimeout(r, 2000));

    console.log(`${prefix.sys} Starting model server...`);
    console.log(`${prefix.sys} Script: ${serverScript}`);
    console.log("");

    // Start Models
    const modelsProcess = spawn(pythonCmd, [serverScript], {
      cwd: dirname(serverScript),
      stdio: ["ignore", "pipe", "pipe"],
    });

    modelsProcess.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter((l: string) => l.trim())) {
        console.log(`${prefix.models} ${line}`);
      }
    });

    modelsProcess.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter((l: string) => l.trim())) {
        console.log(`${prefix.models} ${t.dim(line)}`);
      }
    });

    // Wait for models to be ready
    console.log(`${prefix.sys} Waiting for models to load...`);
    try {
      await waitForPort(getModelPort(), 120000);
    } catch {
      console.error(`${prefix.sys} ${t.err("✗")} Model server failed to start within 120s`);
      console.error(`${prefix.sys}   Check logs above for errors. Common causes:`);
      console.error(`${prefix.sys}   - Model not downloaded yet (first run takes longer)`);
      console.error(`${prefix.sys}   - Insufficient VRAM/RAM for the selected model`);
      console.error(`${prefix.sys}   - Another process is using port ${getModelPort()}`);
      modelsProcess.kill();
      process.exit(1);
    }
    console.log(`${prefix.sys} ${t.ok("●")} Model server ready on port ${getModelPort()}`);
    console.log("");

    // Start ThreadClaw
    console.log(`${prefix.sys} Starting ThreadClaw RAG API...`);
    const distIndex = resolve(root, "dist", "index.js");
    const tsxCli = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
    const srcEntry = resolve(root, "src", "index.ts");
    // Prefer dist (production), fall back to tsx (development)
    const useBuilt = existsSync(distIndex);
    const entryArgs = useBuilt ? [distIndex] : [tsxCli, srcEntry];

    const talProcess = spawn(process.execPath, entryArgs, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });

    talProcess.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter((l: string) => l.trim())) {
        console.log(`${prefix.tal} ${line}`);
      }
    });

    talProcess.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter((l: string) => l.trim())) {
        console.log(`${prefix.tal} ${t.dim(line)}`);
      }
    });

    try {
      await waitForPort(getApiPort(), 30000);
    } catch {
      console.error(`${prefix.sys} ${t.err("✗")} ThreadClaw API failed to start within 30s`);
      console.error(`${prefix.sys}   Check logs above for errors.`);
      talProcess.kill();
      modelsProcess.kill();
      process.exit(1);
    }
    console.log(`${prefix.sys} ${t.ok("●")} ThreadClaw RAG API ready on port ${getApiPort()}`);
    console.log("");
    console.log(`${prefix.sys} ${t.ok("All services running.")}`);
    console.log(`${prefix.sys} ${t.dim("Press Ctrl+C to stop.")}`);
    console.log("");

    // Track child exit count for clean shutdown
    let exitCount = 0;
    const totalChildren = 2;

    function onChildExit() {
      exitCount++;
      if (exitCount >= totalChildren) {
        process.exit(0);
      }
    }

    // Graceful shutdown — send HTTP /shutdown first (Windows-safe), then kill
    const cleanup = () => {
      console.log("");
      console.log(`${prefix.sys} Shutting down...`);

      // Try graceful HTTP shutdown first (works on Windows where SIGTERM is unreliable)
      const shutdownViaHttp = async (port: number) => {
        try {
          await fetch(`http://127.0.0.1:${port}/shutdown`, {
            method: "POST",
            signal: AbortSignal.timeout(2000),
          });
        } catch {}
      };

      Promise.all([
        shutdownViaHttp(getApiPort()),
        shutdownViaHttp(getModelPort()),
      ]).finally(() => {
        // After HTTP attempt, also send kill signals as fallback
        try { talProcess.kill("SIGTERM"); } catch {}
        try { modelsProcess.kill("SIGTERM"); } catch {}

        // Force-kill after timeout if children haven't exited
        setTimeout(() => {
          try { talProcess.kill("SIGKILL"); } catch {}
          try { modelsProcess.kill("SIGKILL"); } catch {}
          // If children still haven't exited after force-kill, exit anyway
          setTimeout(() => process.exit(0), 1000);
        }, 5000);
      });
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    modelsProcess.on("exit", (code) => {
      console.log(`${prefix.models} ${t.err("Process exited")} (code ${code})`);
      onChildExit();
    });

    talProcess.on("exit", (code) => {
      console.log(`${prefix.tal} ${t.err("Process exited")} (code ${code})`);
      onChildExit();
    });

    // Keep alive
    await new Promise(() => {});
  });

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Service on port ${port} did not become ready within ${Math.round(timeoutMs / 1000)}s`);
}
