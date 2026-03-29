import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Menu, Section, Separator, t, useInterval, type MenuItem } from "../components.js";
import { getApiPort, getModelPort, type ServiceStatus } from "../../platform.js";
import { readServiceLogTail } from "../../service-logs.js";
import { checkAutoStartupAsync, isPortReachable } from "../../runtime-status.js";
import { subscribeTasks } from "../../tasks.js";
import * as store from "../../store.js";

/** Color-code a log line based on severity keywords. */
function colorLogLine(line: string): string {
  if (/error/i.test(line)) return t.err(line);
  if (/warn(ing)?/i.test(line)) return t.warn(line);
  return t.dim(line);
}

// Read initial values from shared store (populated by HomeScreen polling)

export function ServicesScreen({
  onBack,
  onAction,
}: {
  onBack: () => void;
  onAction: (action: string) => void;
}) {
  const [tick, setTick] = useState(0);
  const [autoStart, setAutoStart] = useState(store.get<boolean>("autoStart") ?? false);
  const [services, setServices] = useState<ServiceStatus>(store.get<ServiceStatus>("serviceStatus") ?? { models: { running: false }, threadclaw: { running: false } });

  useInterval(() => setTick((value) => value + 1), 3000);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [modelsUp, threadclawUp, autoStartState] = await Promise.all([
        isPortReachable(getModelPort()),
        isPortReachable(getApiPort()),
        checkAutoStartupAsync(),
      ]);

      if (cancelled) return;
      const serviceState: ServiceStatus = {
        models: { running: modelsUp },
        threadclaw: { running: threadclawUp },
      };
      store.set("serviceStatus", serviceState);
      store.set("autoStart", autoStartState);
      setServices(serviceState);
      setAutoStart(autoStartState);
    })();

    return () => { cancelled = true; };
  }, [tick]);

  // Immediately fetch on mount to clear stale caches
  useEffect(() => { setTick((v) => v + 1); }, []);

  useEffect(() => subscribeTasks(() => {
    setTick((value) => value + 1);
  }), []);

  // Read service logs in useEffect to avoid sync I/O in render path
  const [modelLogLines, setModelLogLines] = useState<string[]>([]);
  const [apiLogLines, setApiLogLines] = useState<string[]>([]);
  useEffect(() => {
    try { setModelLogLines(readServiceLogTail("models", 8)); } catch {}
    try { setApiLogLines(readServiceLogTail("threadclaw", 8)); } catch {}
  }, [tick]);

  const gameModeOn = !services.models.running;
  const anyRunning = services.models.running || services.threadclaw.running;

  const items: MenuItem[] = [];
  if (anyRunning) {
    items.push({ label: "Restart services", value: "services-restart" });
    items.push({ label: "Stop services", value: "services-stop" });
    if (services.models.running) {
      items.push({ label: "Game mode on", value: "services-game-on", description: "Stop models and free VRAM" });
    }
  } else {
    items.push({ label: "Start services", value: "services-start" });
  }
  if (gameModeOn) {
    items.push({ label: "Game mode off", value: "services-game-off", description: "Start models again" });
  }

  items.push({
    label: autoStart ? "Disable auto-start" : "Enable auto-start",
    value: autoStart ? "services-auto-off" : "services-auto-on",
  });
  items.push({ label: "Refresh", value: "refresh" });
  items.push({ label: "Back", value: "__back__", color: t.dim });

  return (
    <Box flexDirection="column">
      <Section title="Services" />
      <Text>{"  " + (services.models.running ? t.ok("●") : t.err("○")) + ` Models (port ${getModelPort()})`}</Text>
      <Text>{"  " + (services.threadclaw.running ? t.ok("●") : t.err("○")) + ` ThreadClaw API (port ${getApiPort()})`}</Text>
      <Text>{"  " + t.dim("Auto-start: ") + (autoStart ? t.ok("enabled") : t.dim("disabled"))}</Text>
      <Text>{"  " + t.dim("Game mode: ") + (gameModeOn ? t.warn("on") : t.dim("off"))}</Text>

      <Section title="Recent Model Logs" />
      {modelLogLines.length > 0 ? modelLogLines.map((line, index) => (
        <Text key={`models:${index}`}>{"  " + colorLogLine(line)}</Text>
      )) : (
        <Text>{"  " + t.dim("No model log output yet")}</Text>
      )}

      <Section title="Recent API Logs" />
      {apiLogLines.length > 0 ? apiLogLines.map((line, index) => (
        <Text key={`api:${index}`}>{"  " + colorLogLine(line)}</Text>
      )) : (
        <Text>{"  " + t.dim("No API log output yet")}</Text>
      )}

      <Separator />
      <Menu
        items={items}
        onSelect={(value) => {
          if (value === "__back__") onBack();
          else if (value === "refresh") setTick((v) => v + 1);
          else onAction(value);
        }}
      />
    </Box>
  );
}
