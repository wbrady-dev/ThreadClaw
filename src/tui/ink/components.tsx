import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import chalk from "chalk";
import { getTerminalCapabilities } from "../capabilities.js";
import { t } from "../theme.js";
import { getAppVersion } from "../../version.js";

const r = t.brandAccent;
const w = chalk.bold.white;

// Re-export t so existing imports from this module keep working.
// The canonical theme definition lives in ../theme.ts — do NOT duplicate here.
export { t };

export function Banner() {
  const caps = getTerminalCapabilities();
  const version = chalk.dim(` v${getAppVersion()}`);

  if (!caps.unicode) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>{r("  THREADCLAW")}{version}</Text>
        <Text>{w("  Premium RAG for OpenClaw")}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>{"              "}{r("🦞")} {w("THREADCLAW")}{version} {r("🦞")}</Text>
      <Text>{"          "}{t.dim("RSMA So Good It Pinches")}</Text>
    </Box>
  );
}

export function Section({ title }: { title: string }) {
  return (
    <Box marginTop={1} marginBottom={1}>
      <Text>{t.title("--- " + title + " ---")}</Text>
    </Box>
  );
}

export function KV({ label, value, indent }: { label: string; value: string; indent?: number }) {
  const pad = indent ? "  ".repeat(indent) : "  ";
  return <Text>{pad}{t.dim(label + ":")} {value}</Text>;
}

export function StatusDot({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  const caps = getTerminalCapabilities();
  const icon = caps.unicode ? (ok ? t.ok("●") : t.err("○")) : (ok ? t.ok("*") : t.err("o"));
  const det = detail ? t.dim(` ${detail}`) : "";
  return <Text>  {icon} {t.label(label)}{det}</Text>;
}

export function Separator({ width: explicitWidth }: { width?: number }) {
  const width = explicitWidth ?? Math.min((process.stdout.columns || 80) - 4, 60);
  return (
    <Box marginTop={1} marginBottom={1}>
      <Text>{t.dim("  " + "-".repeat(width))}</Text>
    </Box>
  );
}

export interface MenuItem {
  label: string;
  value: string;
  description?: string;
  color?: (s: string) => string;
}

export function Menu({ items, onSelect, isRoot = false }: { items: MenuItem[]; onSelect: (value: string) => void; isRoot?: boolean }) {
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.upArrow || input === "k") setSelected((prev) => (prev - 1 + items.length) % items.length);
    else if (key.downArrow || input === "j") setSelected((prev) => (prev + 1) % items.length);
    else if (key.return) onSelect(items[selected].value);
    else if (input === "q") {
      if (isRoot) {
        onSelect("__confirm_exit__");
      } else {
        onSelect("__back__");
      }
    }
    else if (key.escape) onSelect("__back__");
    else if (input === "\u0003") process.exit(0);
  });

  return (
    <Box flexDirection="column">
      {items.map((item, index) => {
        const isSelected = index === selected;
        const prefix = isSelected ? t.selected(">") : " ";
        const color = item.color ?? (isSelected ? t.selected : t.value);
        const description = isSelected && item.description ? t.dim(` - ${item.description}`) : "";
        return (
          <Text key={item.value}>{"  " + prefix + " " + color(item.label) + description}</Text>
        );
      })}
      <Text>{t.dim("  ↑/↓ j/k navigate · Enter select · Esc back · q quit")}</Text>
    </Box>
  );
}

export function Spinner({ label }: { label: string }) {
  const caps = getTerminalCapabilities();
  const frames = caps.unicode ? ["|", "/", "-", "\\"] : [".  ", ".. ", "...", " .."];
  const [frame, setFrame] = useState(0);

  React.useEffect(() => {
    const timer = setInterval(() => setFrame((value) => (value + 1) % frames.length), 120);
    return () => clearInterval(timer);
  }, [frames.length]);

  return <Text>  {t.ok(frames[frame])} {label}</Text>;
}

export function useInterval(callback: () => void, delayMs: number) {
  const savedCallback = React.useRef(callback);
  const running = React.useRef(false);
  savedCallback.current = callback;

  React.useEffect(() => {
    const id = setInterval(async () => {
      if (running.current) return; // prevent overlapping async calls
      running.current = true;
      try { await savedCallback.current(); } catch (e) { /* useInterval: swallowed error to avoid crashing render loop */ } finally { running.current = false; }
    }, delayMs);
    return () => clearInterval(id);
  }, [delayMs]);
}

export function formatAge(date: string | undefined): string {
  if (!date) return "";
  const ms = Date.now() - new Date(date).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}
