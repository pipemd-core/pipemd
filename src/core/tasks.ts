import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWrite } from "./fs-utils.js";
import { resolveActiveSession } from "./crew.js";
import { log, errMsg } from "./logger.js";
import { PIPEMD_DIR } from "./paths.js";

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";
export type TaskPriority = "high" | "medium" | "low";

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: string;
  files?: string[];
  blockedReason?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskFile {
  tasks: Task[];
}

const TASKS_FILE = path.join(PIPEMD_DIR, "tasks.json");

function generateTaskId(): string {
  return "t_" + crypto.randomBytes(4).toString("hex");
}

function ensureTasksDir(): void {
  const dir = path.dirname(TASKS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readTasks(): TaskFile {
  try {
    const raw = fs.readFileSync(TASKS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as TaskFile;
    if (parsed && Array.isArray(parsed.tasks)) return parsed;
  } catch (err: unknown) {
    log.debug(`readTasks failed: ${errMsg(err)}`);
  }
  return { tasks: [] };
}

export function writeTasks(file: TaskFile): void {
  ensureTasksDir();
  atomicWrite(TASKS_FILE, JSON.stringify(file, null, 2) + "\n");
}

export function addTask(opts: {
  title: string;
  description?: string;
  priority?: TaskPriority;
  files?: string[];
}): Task {
  const file = readTasks();
  const now = new Date().toISOString();
  const task: Task = {
    id: generateTaskId(),
    title: opts.title,
    description: opts.description,
    status: "pending",
    priority: opts.priority || "medium",
    files: opts.files,
    createdAt: now,
    updatedAt: now,
  };
  file.tasks.push(task);
  writeTasks(file);
  return task;
}

export function updateTask(
  id: string,
  updates: Partial<Pick<Task, "status" | "assignee" | "note" | "description" | "blockedReason" | "priority" | "files" | "title">>,
): Task | null {
  const file = readTasks();
  const task = file.tasks.find((t) => t.id === id);
  if (!task) return null;

  Object.assign(task, updates, { updatedAt: new Date().toISOString() });
  writeTasks(file);
  return task;
}

export function removeTask(id: string): boolean {
  const file = readTasks();
  const idx = file.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  file.tasks.splice(idx, 1);
  writeTasks(file);
  return true;
}

export function getTasksForSession(sessionId?: string): Task[] {
  const file = readTasks();
  const sid = sessionId || resolveActiveSession()?.id;

  if (!sid) {
    return file.tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  }

  return file.tasks.filter((t) => {
    if (t.assignee === sid) return true;
    if (!t.assignee && (t.status === "pending" || t.status === "in_progress")) return true;
    return false;
  });
}

export function formatTaskBlock(tasks: Task[]): string {
  if (tasks.length === 0) return "";

  const statusIcons: Record<TaskStatus, string> = {
    pending: "○",
    in_progress: "▶",
    completed: "✓",
    blocked: "⏸",
  };

  const lines: string[] = [];

  const inProgress = tasks.filter((t) => t.status === "in_progress");
  const pending = tasks.filter((t) => t.status === "pending");
  const blocked = tasks.filter((t) => t.status === "blocked");

  if (inProgress.length > 0) {
    lines.push("## Active Tasks");
    for (const t of inProgress) {
      lines.push(`${statusIcons[t.status]} [${t.priority}] ${t.title} (${t.id})`);
      if (t.description) lines.push(`  ${t.description}`);
      if (t.files && t.files.length > 0) lines.push(`  files: ${t.files.join(", ")}`);
      if (t.note) lines.push(`  note: ${t.note}`);
    }
  }

  if (blocked.length > 0) {
    lines.push("## Blocked");
    for (const t of blocked) {
      const reason = t.blockedReason ? ` — ${t.blockedReason}` : "";
      lines.push(`${statusIcons[t.status]} [${t.priority}] ${t.title}${reason} (${t.id})`);
    }
  }

  if (pending.length > 0) {
    lines.push("## Pending");
    for (const t of pending.slice(0, 5)) {
      lines.push(`${statusIcons[t.status]} [${t.priority}] ${t.title} (${t.id})`);
    }
    if (pending.length > 5) {
      lines.push(`  ... +${pending.length - 5} more`);
    }
  }

  return lines.join("\n");
}
