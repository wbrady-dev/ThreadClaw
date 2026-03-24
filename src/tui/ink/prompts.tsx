import React, { useState } from "react";
import { render, Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { clearScreen } from "../theme.js";
import { Menu, Section, Separator, t, type MenuItem } from "./components.js";

interface BasePromptProps {
  title: string;
  message?: string;
}

interface PromptMenuOptions extends BasePromptProps {
  items: MenuItem[];
}

interface PromptTextOptions extends BasePromptProps {
  label: string;
  initial?: string;
  placeholder?: string;
  mask?: string;
  allowEmpty?: boolean;
  validate?: (value: string) => string | null;
}

interface PromptChecklistItem {
  key: string;
  label: string;
  description?: string;
  checked: boolean;
}

interface PromptChecklistOptions extends BasePromptProps {
  items: PromptChecklistItem[];
  confirmLabel?: string;
}

export async function promptMenu(options: PromptMenuOptions): Promise<string | null> {
  return runPrompt<string | null>((resolvePrompt) => (
    <MenuPrompt
      title={options.title}
      message={options.message}
      items={options.items}
      onResolve={resolvePrompt}
    />
  ));
}

export async function promptConfirm(options: BasePromptProps & { confirmLabel?: string; cancelLabel?: string }): Promise<boolean | null> {
  const value = await promptMenu({
    title: options.title,
    message: options.message,
    items: [
      { label: options.confirmLabel ?? "Confirm", value: "confirm" },
      { label: options.cancelLabel ?? "Cancel", value: "cancel", color: t.dim },
    ],
  });

  if (value == null) return null;
  return value === "confirm";
}

export async function promptText(options: PromptTextOptions): Promise<string | null> {
  return runPrompt<string | null>((resolvePrompt) => (
    <TextPrompt
      title={options.title}
      message={options.message}
      label={options.label}
      initial={options.initial}
      placeholder={options.placeholder}
      mask={options.mask}
      allowEmpty={options.allowEmpty}
      validate={options.validate}
      onResolve={resolvePrompt}
    />
  ));
}

export async function promptChecklist(options: PromptChecklistOptions): Promise<PromptChecklistItem[] | null> {
  return runPrompt<PromptChecklistItem[] | null>((resolvePrompt) => (
    <ChecklistPrompt
      title={options.title}
      message={options.message}
      items={options.items}
      confirmLabel={options.confirmLabel}
      onResolve={resolvePrompt}
    />
  ));
}

function runPrompt<T>(factory: (resolvePrompt: (value: T) => void) => React.ReactElement): Promise<T> {
  return new Promise((resolvePrompt) => {
    clearScreen();

    // Ensure stdin is active before rendering — a previous resetStdin() may have paused it
    process.stdin.resume();
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); } catch {}
    }

    let settled = false;
    let instance: ReturnType<typeof render> | null = null;

    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      try {
        instance?.unmount();
      } catch {}
      // Let Ink finish its async stdin cleanup before resolving
      setTimeout(() => {
        resetPromptStdin();
        resolvePrompt(value);
      }, 150);
    };

    instance = render(factory(finish), { exitOnCtrlC: false });
  });
}

function MenuPrompt({
  title,
  message,
  items,
  onResolve,
}: PromptMenuOptions & { onResolve: (value: string | null) => void }) {
  return (
    <Box flexDirection="column">
      <Section title={title} />
      {message && <Text>{"  " + t.dim(message)}</Text>}
      {message && <Text> </Text>}
      <Menu
        items={items}
        onSelect={(value) => {
          if (value === "exit") onResolve(null);
          else onResolve(value);
        }}
      />
    </Box>
  );
}

function TextPrompt({
  title,
  message,
  label,
  initial,
  placeholder,
  mask,
  allowEmpty,
  validate,
  onResolve,
}: PromptTextOptions & { onResolve: (value: string | null) => void }) {
  const [value, setValue] = useState(initial ?? "");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trySubmit = (nextValue: string) => {
    if (submitted) return;
    if (!allowEmpty && !nextValue.trim()) return;
    if (validate) {
      const err = validate(nextValue);
      if (err) { setError(err); return; }
    }
    setError(null);
    setSubmitted(true);
    onResolve(nextValue);
  };

  useInput((input, key) => {
    if (key.escape) onResolve(null);
    if (key.return) trySubmit(value);
    if (input === "\u0003") process.exit(0);
  });

  return (
    <Box flexDirection="column">
      <Section title={title} />
      {message && <Text>{"  " + t.dim(message)}</Text>}
      {message && <Text> </Text>}
      <Text>{"  " + t.label(label)}</Text>
      <Box marginLeft={2}>
        <Text>{t.ok("> ")}</Text>
        <TextInput
          value={value}
          onChange={(next) => { setError(null); setValue(next); }}
          onSubmit={trySubmit}
          placeholder={placeholder}
          mask={mask}
        />
      </Box>
      {error && <Text>{"  " + t.err(error)}</Text>}
      <Text> </Text>
      <Text>{"  " + t.dim("Enter to save, Esc to cancel")}</Text>
    </Box>
  );
}

function ChecklistPrompt({
  title,
  message,
  items,
  confirmLabel,
  onResolve,
}: PromptChecklistOptions & { onResolve: (items: PromptChecklistItem[] | null) => void }) {
  const [selected, setSelected] = useState(0);
  const [values, setValues] = useState(items);
  const totalRows = values.length + 2;

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setSelected((current) => (current - 1 + totalRows) % totalRows);
      return;
    }
    if (key.downArrow || input === "j") {
      setSelected((current) => (current + 1) % totalRows);
      return;
    }
    if (input === " " && selected < values.length) {
      setValues((current) => current.map((item, index) => (
        index === selected ? { ...item, checked: !item.checked } : item
      )));
      return;
    }
    if (key.return) {
      if (selected === values.length) onResolve(values);
      else if (selected === values.length + 1) onResolve(null);
      else {
        setValues((current) => current.map((item, index) => (
          index === selected ? { ...item, checked: !item.checked } : item
        )));
      }
      return;
    }
    if (key.escape) onResolve(null);
    if (input === "\u0003") process.exit(0);
  });

  return (
    <Box flexDirection="column">
      <Section title={title} />
      {message && <Text>{"  " + t.dim(message)}</Text>}
      {message && <Separator width={64} />}
      {values.map((item, index) => {
        const pointer = selected === index ? t.selected(">") : " ";
        const checkbox = item.checked ? t.ok("[x]") : t.dim("[ ]");
        const label = selected === index ? t.selected(item.label) : t.value(item.label);
        const description = item.description ? t.dim(` - ${item.description}`) : "";
        return <Text key={item.key}>{"  " + pointer + " " + checkbox + " " + label + description}</Text>;
      })}
      <Separator width={48} />
      <Text>{"  " + (selected === values.length ? t.selected(">") : " ") + " " + t.ok(confirmLabel ?? "Save")}</Text>
      <Text>{"  " + (selected === values.length + 1 ? t.selected(">") : " ") + " " + t.dim("Cancel")}</Text>
      <Text> </Text>
      <Text>{"  " + t.dim("Up/down to move, space to toggle, Enter to save")}</Text>
    </Box>
  );
}

function resetPromptStdin(): void {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {}
  }
  process.stdin.removeAllListeners("data");
  process.stdin.removeAllListeners("keypress");
  process.stdin.pause();
}
