import { getRootDir, startThreadClawApi, startModelServer, stopServices, forceKillByPort, getApiPort, getModelPort } from "./platform.js";
import { clearServiceLogs, readLatestServiceLogLine, type ServiceLogName } from "./service-logs.js";

function safeParseInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MODEL_WAIT_TIMEOUT = safeParseInt(process.env.THREADCLAW_MODEL_TIMEOUT, 180000);
const API_WAIT_TIMEOUT = safeParseInt(process.env.THREADCLAW_API_TIMEOUT, 30000);
const STOP_WAIT_TIMEOUT = safeParseInt(process.env.THREADCLAW_STOP_TIMEOUT, 3000);

export type ServiceAction = "start" | "stop" | "restart" | "stop-models" | "start-models";

export interface ServiceActionOptions {
  root?: string;
  onStatus?: (detail: string) => void;
}

export interface ServiceActionResult {
  success: boolean;
  message: string;
}

export async function performServiceAction(
  action: ServiceAction,
  options: ServiceActionOptions = {},
): Promise<ServiceActionResult> {
  const root = options.root ?? getRootDir();

  // Game mode: stop only model server
  if (action === "stop-models") {
    options.onStatus?.("Stopping model server...");
    await forceKillByPort(getModelPort());
    await waitForPortClosed(getModelPort(), STOP_WAIT_TIMEOUT);
    return { success: true, message: "Model server stopped (VRAM freed)" };
  }

  // Game mode off: start only model server
  if (action === "start-models") {
    options.onStatus?.("Launching model server...");
    const modelResult = startModelServer();
    if (!modelResult.success) {
      return { success: false, message: formatAccessDenied(modelResult.error ?? "Failed to launch model server") };
    }
    const modelWait = await waitForHealthWithLogs(getModelPort(), MODEL_WAIT_TIMEOUT, "models", root, "Waiting for model server...", options.onStatus);
    if (!modelWait.success) return { success: false, message: "Model server failed to start" };
    return { success: true, message: "Model server started" };
  }

  if (action === "stop" || action === "restart") {
    options.onStatus?.("Stopping services...");
    const stopResult = stopServices();
    if (!stopResult.success) {
      return { success: false, message: stopResult.error ?? "Failed to stop services" };
    }

    // Model server may take time to release GPU memory
    options.onStatus?.("Waiting for services to stop...");
    await Promise.all([
      waitForPortClosed(getApiPort(), STOP_WAIT_TIMEOUT),
      waitForPortClosed(getModelPort(), STOP_WAIT_TIMEOUT),
    ]);

    // Verify ports are actually closed — if not, force-kill async
    const { isPortReachable } = await import("./runtime-status.js");
    const [apiStillUp, modelsStillUp] = await Promise.all([
      isPortReachable(getApiPort(), 1000),
      isPortReachable(getModelPort(), 1000),
    ]);
    if (apiStillUp || modelsStillUp) {
      options.onStatus?.("Force-killing remaining processes...");
      // Async force-kill — doesn't block the event loop
      await Promise.all([
        apiStillUp ? forceKillByPort(getApiPort()) : Promise.resolve(),
        modelsStillUp ? forceKillByPort(getModelPort()) : Promise.resolve(),
      ]);
      await sleep(1000);

      const [apiFinal, modelsFinal] = await Promise.all([
        isPortReachable(getApiPort(), 1000),
        isPortReachable(getModelPort(), 1000),
      ]);
      if (apiFinal || modelsFinal) {
        const stuckPorts = [apiFinal && getApiPort(), modelsFinal && getModelPort()].filter(Boolean).join(", ");
        const killHint = process.platform === "win32"
          ? `Open Task Manager and end processes on port(s) ${stuckPorts}, or run: taskkill /F /PID <pid>`
          : `Run: kill -9 $(lsof -ti :${stuckPorts})`;
        return { success: false, message: `Could not stop services on port(s) ${stuckPorts}. ${killHint}. If started from another terminal, close that terminal first.` };
      }
    }

    if (action === "stop") {
      return { success: true, message: "Services stopped" };
    }

    // Brief pause to let ports release before restarting
    await sleep(500);
  }

  // Clear logs on start (not stop) so log viewers see only output from the new
  // session. On stop, logs are preserved for post-mortem debugging.
  clearServiceLogs(root);

  options.onStatus?.("Launching model server...");
  const modelResult = startModelServer();
  if (!modelResult.success) {
    const msg = modelResult.error ?? "Failed to launch model server";
    return { success: false, message: formatAccessDenied(msg) };
  }

  const modelWait = await waitForHealthWithLogs(getModelPort(), MODEL_WAIT_TIMEOUT, "models", root, "Waiting for model server...", options.onStatus);
  if (!modelWait.success) {
    options.onStatus?.("Model server failed — cleaning up...");
    stopServices();
    const msg = "Model server failed to start";
    if (action === "restart") {
      return { success: false, message: `Services stopped but failed to restart: ${msg}. Run 'threadclaw start' to retry.` };
    }
    return { success: false, message: msg };
  }

  options.onStatus?.("Launching ThreadClaw API...");
  const apiResult = startThreadClawApi();
  if (!apiResult.success) {
    options.onStatus?.("API launch failed — cleaning up model server...");
    stopServices();
    const msg = formatAccessDenied(apiResult.error ?? "Failed to launch ThreadClaw API");
    if (action === "restart") {
      return { success: false, message: `Services stopped but failed to restart: ${msg}. Run 'threadclaw start' to retry.` };
    }
    return { success: false, message: `${msg} (model server cleaned up)` };
  }

  const apiWait = await waitForHealthWithLogs(getApiPort(), API_WAIT_TIMEOUT, "threadclaw", root, "Waiting for ThreadClaw API...", options.onStatus);
  if (!apiWait.success) {
    options.onStatus?.("API health check failed — cleaning up...");
    stopServices();
    const msg = "API failed to start (model server cleaned up)";
    if (action === "restart") {
      return { success: false, message: `Services stopped but failed to restart: ${msg}. Run 'threadclaw start' to retry.` };
    }
    return { success: false, message: msg };
  }

  return {
    success: true,
    message: action === "restart" ? "Services restarted" : "Services started",
  };
}

async function waitForHealthWithLogs(
  port: number,
  timeoutMs: number,
  logName: ServiceLogName,
  root: string,
  prefix: string,
  onStatus?: (detail: string) => void,
): Promise<ServiceActionResult> {
  const start = Date.now();
  let lastLine = "";

  while (Date.now() - start < timeoutMs) {
    try {
      // Connection errors (fetch throws) mean "not started yet".
      // A 200 means healthy; other codes (503, etc.) mean the process is up
      // but not yet ready — log the status for debugging but still consider it started.
      const resp = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1200),
      });
      if (resp.status !== 200) {
        onStatus?.(`${prefix} (status ${resp.status}, waiting for healthy...)`);
        await sleep(700);
        continue;
      }
      return { success: true, message: prefix.replace(/^Waiting for /, "").replace(/\.\.\.$/, "") };
    } catch {
      // Connection refused / timeout — server not up yet
    }

    const currentLine = readLatestServiceLogLine(logName, root);
    if (currentLine && currentLine !== lastLine) {
      lastLine = currentLine;
    }

    onStatus?.(lastLine ? `${prefix} ${lastLine}` : prefix);
    await sleep(700);
  }

  return {
    success: false,
    message: lastLine ? `${prefix} ${lastLine}` : `${prefix} timed out`,
  };
}

async function waitForPortClosed(
  port: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      await sleep(200);
    } catch {
      return;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** If the error looks like an access-denied from Task Scheduler, append a helpful hint. */
function formatAccessDenied(msg: string): string {
  if (/access/i.test(msg) && /denied/i.test(msg)) {
    return `${msg}\nTask Scheduler access denied. Try: threadclaw serve (runs in foreground) or restart your terminal.`;
  }
  return msg;
}
