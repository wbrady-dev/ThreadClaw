import prompts from "prompts";
import { t } from "./theme.js";
import { getTerminalCapabilities } from "./capabilities.js";

export interface MenuItem {
  label: string;
  value: string;
  color?: (s: string) => string;
  description?: string;
  disabled?: boolean;
}

/**
 * Select menu with a capability-aware fallback.
 * Rich terminals keep the custom raw-mode UI, while limited terminals
 * still use arrow-key navigation through prompts' select UI.
 */
export function selectMenu(items: MenuItem[]): Promise<string | null> {
  const activeItems = items.filter((item) => !item.disabled);
  if (activeItems.length === 0) return Promise.resolve(null);

  const caps = getTerminalCapabilities();
  if (!caps.rawMode || !caps.ansi || caps.plain) {
    return promptPlainMenu(activeItems);
  }

  return new Promise((resolve) => {
    let selected = 0;
    const pointer = ">";
    const detailPrefix = " - ";

    const renderLine = (item: MenuItem, isSelected: boolean): string => {
      const prefix = isSelected ? t.selected(pointer) : " ";
      const color = item.color ?? t.value;
      const text = isSelected ? t.selected(item.label) : color(item.label);
      const detail = isSelected && item.description ? t.dim(`${detailPrefix}${item.description}`) : "";
      return `  ${prefix} ${text}${detail}`;
    };

    const render = () => {
      process.stdout.write(`\x1b[${items.length}A`);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const activeIndex = activeItems.indexOf(item);
        const isSelected = activeIndex === selected;
        process.stdout.write(`\x1b[2K${renderLine(item, isSelected)}\n`);
      }
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const activeIndex = activeItems.indexOf(item);
      const isSelected = activeIndex === selected;
      console.log(renderLine(item, isSelected));
    }

    process.stdout.write("\x1b[?25l");

    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.removeListener("data", onKey);
      process.removeListener("SIGINT", onSigint);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h");
    };

    const onKey = (key: Buffer) => {
      const input = key.toString();
      if (input === "\x1b[A" || input === "k") {
        selected = (selected - 1 + activeItems.length) % activeItems.length;
        render();
      } else if (input === "\x1b[B" || input === "j") {
        selected = (selected + 1) % activeItems.length;
        render();
      } else if (input === "\r" || input === "\n") {
        cleanup();
        resolve(activeItems[selected].value);
      } else if (input === "\x1b" || input === "q") {
        cleanup();
        resolve(null);
      } else if (input === "\x03") {
        cleanup();
        if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
        process.stdin.removeAllListeners("data");
        process.stdin.removeAllListeners("keypress");
        process.stdin.pause();
        process.stdout.write("\x1b[?25h");
        process.exit(0);
      }
    };

    const onSigint = () => {
      cleanup();
      if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("keypress");
      process.stdin.pause();
      process.stdout.write("\x1b[?25h");
      process.exit(0);
    };

    process.on("SIGINT", onSigint);
    process.stdin.on("data", onKey);
  });
}

async function promptPlainMenu(items: MenuItem[]): Promise<string | null> {
  const promptConfig: any = {
    type: "select",
    name: "value",
    message: "Select an option",
    initial: 0,
    choices: items.map((item) => ({
      title: item.label,
      value: item.value,
      description: item.description,
      disabled: item.disabled,
    })),
    instructions: false,
  };

  const result = await prompts(promptConfig, {
    onCancel: () => true,
  });

  return result.value ?? null;
}

