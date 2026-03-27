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

    // Track pending ESC to distinguish lone ESC from arrow key sequences
    let escTimer: ReturnType<typeof setTimeout> | null = null;

    const onKey = (key: Buffer) => {
      try {
        const input = key.toString();

        // If we had a pending lone-ESC timer and new data arrived, cancel it —
        // this is part of an arrow key sequence, not a quit gesture.
        if (escTimer !== null) {
          clearTimeout(escTimer);
          escTimer = null;
        }

        if (input === "\x1b[A" || input === "k") {
          // Vim 'k' may conflict with typing if a text field is ever mixed in;
          // kept for power-user convenience in select menus only.
          selected = (selected - 1 + activeItems.length) % activeItems.length;
          render();
        } else if (input === "\x1b[B" || input === "j") {
          // Vim 'j' — same note as 'k' above.
          selected = (selected + 1) % activeItems.length;
          render();
        } else if (input === "\r" || input === "\n") {
          cleanup();
          resolve(activeItems[selected].value);
        } else if (input === "\x1b") {
          // Lone ESC — delay 50ms to ensure it's not the start of an arrow sequence
          escTimer = setTimeout(() => {
            escTimer = null;
            cleanup();
            resolve(null);
          }, 50);
        } else if (input === "q") {
          cleanup();
          resolve(null);
        } else if (input === "\x03") {
          cleanup();
          process.exit(0);
        }
      } catch {
        // Ensure cursor is restored on any unhandled error in key handler
        try { cleanup(); } catch {}
      }
    };

    const onSigint = () => {
      cleanup();
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
    })),
    instructions: false,
  };

  const result = await prompts(promptConfig, {
    onCancel: () => true,
  });

  return result.value ?? null;
}

