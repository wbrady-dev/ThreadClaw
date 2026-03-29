import React, { useState, useCallback } from "react";
import { render, Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { readdirSync, existsSync } from "fs";
import { resolve, basename, sep } from "path";
import { homedir, platform } from "os";
import { execSync } from "child_process";
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
  description?: string;
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
      description={options.description}
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

// ── Folder Browser ─────────────────────────────────────────────────

interface FolderBrowserOptions extends BasePromptProps {
  /** Paths already selected as watch paths */
  selected?: string[];
}

export async function promptFolderBrowser(options: FolderBrowserOptions): Promise<string[] | null> {
  return runPrompt<string[] | null>((resolvePrompt) => (
    <FolderBrowserPrompt
      title={options.title}
      message={options.message}
      initialSelected={options.selected ?? []}
      onResolve={resolvePrompt}
    />
  ));
}

/** Detect available drives on Windows, root dirs on Unix. */
function getSystemRoots(): string[] {
  if (platform() === "win32") {
    try {
      const raw = execSync("wmic logicaldisk get name", { stdio: "pipe", timeout: 5000 }).toString();
      const drives = raw.split("\n")
        .map((line) => line.trim())
        .filter((line) => /^[A-Z]:$/.test(line))
        .map((d) => d + "\\");
      if (drives.length > 0) return drives;
    } catch { /* fallback */ }
    // Fallback: common drives
    const fallback: string[] = [];
    for (const letter of "CDEFGHIJ") {
      const drive = `${letter}:\\`;
      if (existsSync(drive)) fallback.push(drive);
    }
    return fallback.length > 0 ? fallback : ["C:\\"];
  }

  // Unix: show home + common roots
  const roots: string[] = [];
  const home = homedir();
  if (existsSync(home)) roots.push(home);
  for (const dir of ["/home", "/Users", "/mnt", "/media", "/opt", "/var"]) {
    if (existsSync(dir)) roots.push(dir);
  }
  return roots.length > 0 ? roots : ["/"];
}

/** List subdirectories of a path, returns [] on error. */
function listSubdirs(dirPath: string): string[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules" && d.name !== "$RECYCLE.BIN" && d.name !== "System Volume Information")
      .map((d) => resolve(dirPath, d.name))
      .sort((a, b) => basename(a).localeCompare(basename(b)));
  } catch {
    return [];
  }
}

interface TreeNode {
  path: string;
  label: string;
  depth: number;
  expanded: boolean;
  selected: boolean;
  hasChildren: boolean;
}

function FolderBrowserPrompt({
  title,
  message,
  initialSelected,
  onResolve,
}: { title: string; message?: string; initialSelected: string[]; onResolve: (paths: string[] | null) => void }) {
  const selectedSet = new Set(initialSelected.map((p) => resolve(p)));

  const buildInitialTree = useCallback((): TreeNode[] => {
    const roots = getSystemRoots();
    const nodes: TreeNode[] = [];
    for (const root of roots) {
      const isSelected = selectedSet.has(resolve(root));
      const children = listSubdirs(root);
      nodes.push({
        path: root,
        label: root,
        depth: 0,
        expanded: false,
        selected: isSelected,
        hasChildren: children.length > 0,
      });
    }
    return nodes;
  }, []);

  const [tree, setTree] = useState<TreeNode[]>(buildInitialTree);
  const [cursor, setCursor] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  const MAX_VISIBLE = 18;

  const toggleExpand = (index: number) => {
    setTree((prev) => {
      const node = prev[index];
      if (!node) return prev;
      const next = [...prev];

      if (node.expanded) {
        // Collapse: remove all children at deeper depth until we hit same or lower depth
        let removeCount = 0;
        for (let i = index + 1; i < next.length; i++) {
          if (next[i].depth <= node.depth) break;
          removeCount++;
        }
        next.splice(index + 1, removeCount);
        next[index] = { ...node, expanded: false };
      } else {
        // Expand: insert children
        const children = listSubdirs(node.path);
        const childNodes: TreeNode[] = children.map((childPath) => ({
          path: childPath,
          label: basename(childPath),
          depth: node.depth + 1,
          expanded: false,
          selected: selectedSet.has(resolve(childPath)),
          hasChildren: listSubdirs(childPath).length > 0,
        }));
        next.splice(index + 1, 0, ...childNodes);
        next[index] = { ...node, expanded: true };
      }
      return next;
    });
  };

  const toggleSelect = (index: number) => {
    setTree((prev) => {
      const node = prev[index];
      if (!node) return prev;
      const next = [...prev];
      const newSelected = !node.selected;
      next[index] = { ...node, selected: newSelected };
      if (newSelected) selectedSet.add(resolve(node.path));
      else selectedSet.delete(resolve(node.path));
      return next;
    });
  };

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setCursor((c) => {
        const next = Math.max(0, c - 1);
        if (next < scrollOffset) setScrollOffset(next);
        return next;
      });
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((c) => {
        const next = Math.min(tree.length - 1, c + 1);
        if (next >= scrollOffset + MAX_VISIBLE) setScrollOffset(next - MAX_VISIBLE + 1);
        return next;
      });
      return;
    }
    // Right arrow or Enter: expand
    if (key.rightArrow || (key.return && tree[cursor]?.hasChildren && !tree[cursor]?.expanded)) {
      if (tree[cursor]?.hasChildren && !tree[cursor]?.expanded) {
        toggleExpand(cursor);
        return;
      }
    }
    // Left arrow: collapse (or go to parent)
    if (key.leftArrow) {
      if (tree[cursor]?.expanded) {
        toggleExpand(cursor);
      } else if (tree[cursor]?.depth > 0) {
        // Navigate to parent
        for (let i = cursor - 1; i >= 0; i--) {
          if (tree[i].depth < tree[cursor].depth) {
            setCursor(i);
            if (i < scrollOffset) setScrollOffset(i);
            break;
          }
        }
      }
      return;
    }
    // Space: toggle selection
    if (input === " ") {
      toggleSelect(cursor);
      return;
    }
    // Enter on "Save": save selected paths
    if (key.return) {
      if (!tree[cursor]?.hasChildren || tree[cursor]?.expanded) {
        toggleSelect(cursor);
      }
      return;
    }
    // S: save
    if (input === "s" || input === "S") {
      const selected = tree.filter((n) => n.selected).map((n) => n.path);
      onResolve(selected);
      return;
    }
    if (key.escape) { onResolve(null); return; }
    if (input === "\u0003") process.exit(0);
  });

  const visibleNodes = tree.slice(scrollOffset, scrollOffset + MAX_VISIBLE);
  const selectedCount = tree.filter((n) => n.selected).length;

  return (
    <Box flexDirection="column">
      <Section title={title} />
      {message && <Text>{"  " + t.dim(message)}</Text>}
      <Text>{"  " + t.dim(`${selectedCount} folder(s) selected`)}</Text>
      <Separator width={64} />
      {visibleNodes.map((node, vi) => {
        const realIndex = scrollOffset + vi;
        const pointer = cursor === realIndex ? t.selected(">") : " ";
        const indent = "  ".repeat(node.depth);
        const expandIcon = node.hasChildren
          ? (node.expanded ? t.dim("v ") : t.dim("> "))
          : "  ";
        const checkbox = node.selected ? t.ok("[x]") : t.dim("[ ]");
        const label = cursor === realIndex ? t.selected(node.label) : t.value(node.label);
        return <Text key={node.path + realIndex}>{"  " + pointer + " " + indent + expandIcon + checkbox + " " + label}</Text>;
      })}
      {tree.length > MAX_VISIBLE && (
        <Text>{"  " + t.dim(`  ... ${tree.length - MAX_VISIBLE} more (scroll with arrow keys)`)}</Text>
      )}
      <Separator width={48} />
      <Text>{"  " + t.ok("[S]") + " Save  " + t.dim("[Space] Toggle  [→] Expand  [←] Collapse  [Esc] Cancel")}</Text>
    </Box>
  );
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
  description,
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
      {description && <Text>{t.dim(`  ${description}`)}</Text>}
      {(message || description) && <Text> </Text>}
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
