import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import chalk from "chalk";
import { getTerminalCapabilities } from "../capabilities.js";

const r = chalk.hex("#e72d19");
const w = chalk.bold.white;

export const t = {
  ok: chalk.green,
  warn: chalk.yellow,
  err: chalk.red,
  info: chalk.blue,
  dim: chalk.dim,
  title: chalk.bold.green,
  label: chalk.bold,
  value: chalk.white,
  selected: chalk.green,
  muted: chalk.gray,
};

export function Banner() {
  const caps = getTerminalCapabilities();

  if (!caps.unicode) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>{r("  CLAWCORE")}</Text>
        <Text>{w("  Premium RAG for OpenClaw")}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>{"              "}{r("🦞")} {w("CLAWCORE")} {r("🦞")}</Text>
      <Text>{"          "}{chalk.dim("CRAM So Good It Pinches")}</Text>
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

export function Separator({ width = 36 }: { width?: number }) {
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

export function Menu({ items, onSelect }: { items: MenuItem[]; onSelect: (value: string) => void }) {
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.upArrow || input === "k") setSelected((prev) => (prev - 1 + items.length) % items.length);
    else if (key.downArrow || input === "j") setSelected((prev) => (prev + 1) % items.length);
    else if (key.return) onSelect(items[selected].value);
    else if (input === "q" || key.escape) onSelect("exit");
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
      try { await savedCallback.current(); } finally { running.current = false; }
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
