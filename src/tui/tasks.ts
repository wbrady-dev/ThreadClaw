export type UiTaskState = "running" | "waiting" | "success" | "error" | "info";

export interface UiTask {
  id: string;
  title: string;
  detail: string;
  state: UiTaskState;
  startedAt: number;
  updatedAt: number;
}

const MAX_TASKS = 8;
const TERMINAL_TASK_STATES = new Set<UiTaskState>(["success", "error"]);

let tasks: UiTask[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function upsertTask(task: UiTask): void {
  tasks = [task, ...tasks.filter((existing) => existing.id !== task.id)]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_TASKS);
  emit();
}

export function startTask(id: string, title: string, detail: string): void {
  const now = Date.now();
  upsertTask({
    id,
    title,
    detail,
    state: "running",
    startedAt: now,
    updatedAt: now,
  });
}

export function updateTask(
  id: string,
  patch: Partial<Pick<UiTask, "title" | "detail" | "state">>,
): void {
  const existing = tasks.find((task) => task.id === id);
  if (!existing) return;
  // Silently ignore updates to tasks that have already reached a terminal state
  // (success/error). This is intentional — finishTask calls updateTask, and a
  // task that's already finished should not be mutated.
  if (TERMINAL_TASK_STATES.has(existing.state)) return;

  upsertTask({
    ...existing,
    ...patch,
    updatedAt: Date.now(),
  });
}

// Note: finishTask calls updateTask which will silently no-op if the task is
// already in a terminal state. This is by design — double-finish is harmless.
export function finishTask(id: string, detail: string): void {
  updateTask(id, { state: "success", detail });
}

export function failTask(id: string, detail: string): void {
  updateTask(id, { state: "error", detail });
}

export function getTaskSnapshot(): UiTask[] {
  return tasks;
}

export function subscribeTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
