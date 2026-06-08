import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-tasks-test-"));
fs.mkdirSync(path.join(tmpDir, ".pipemd"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, ".pipemd", "crew"), { recursive: true });

const origDir = process.cwd();
process.chdir(tmpDir);

const {
  readTasks,
  writeTasks,
  addTask,
  updateTask,
  removeTask,
  getTasksForSession,
  formatTaskBlock,
} = await import("../src/core/tasks.js");

before(() => {
  const { tasks } = readTasks();
  if (tasks.length > 0) writeTasks({ tasks: [] });
});

after(() => {
  process.chdir(origDir);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("readTasks / writeTasks", () => {
  it("returns empty array when no file exists", () => {
    const { tasks } = readTasks();
    assert.ok(Array.isArray(tasks));
  });

  it("round-trips tasks through file I/O", () => {
    const taskFile = {
      tasks: [
        {
          id: "t_test1",
          title: "Test task",
          status: "pending" as const,
          priority: "medium" as const,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    writeTasks(taskFile);
    const read = readTasks();
    assert.equal(read.tasks.length, 1);
    assert.equal(read.tasks[0].id, "t_test1");
    assert.equal(read.tasks[0].title, "Test task");
    writeTasks({ tasks: [] });
  });
});

describe("addTask", () => {
  after(() => writeTasks({ tasks: [] }));

  it("creates a task with defaults", () => {
    const t = addTask({ title: "Fix auth bug" });
    assert.ok(t.id.startsWith("t_"));
    assert.equal(t.title, "Fix auth bug");
    assert.equal(t.status, "pending");
    assert.equal(t.priority, "medium");
    assert.ok(t.createdAt);
    assert.ok(t.updatedAt);
  });

  it("creates a task with all options", () => {
    const t = addTask({
      title: "Refactor API",
      description: "Break into modules",
      priority: "high",
      files: ["src/api.ts", "src/routes.ts"],
    });
    assert.equal(t.priority, "high");
    assert.equal(t.description, "Break into modules");
    assert.deepEqual(t.files, ["src/api.ts", "src/routes.ts"]);
  });

  it("persists to file", () => {
    addTask({ title: "Persist test" });
    const { tasks } = readTasks();
    assert.ok(tasks.some((t) => t.title === "Persist test"));
  });

  it("generates unique IDs", () => {
    const a = addTask({ title: "A" });
    const b = addTask({ title: "B" });
    assert.notEqual(a.id, b.id);
  });
});

describe("updateTask", () => {
  after(() => writeTasks({ tasks: [] }));

  it("updates status and assignee", () => {
    const t = addTask({ title: "Update test" });
    const updated = updateTask(t.id, { status: "in_progress", assignee: "cr_abc" });
    assert.ok(updated);
    assert.equal(updated!.status, "in_progress");
    assert.equal(updated!.assignee, "cr_abc");
  });

  it("updates note and description", () => {
    const t = addTask({ title: "Note test" });
    const updated = updateTask(t.id, { note: "doing this now", description: "updated desc" });
    assert.ok(updated);
    assert.equal(updated!.note, "doing this now");
    assert.equal(updated!.description, "updated desc");
  });

  it("marks as blocked with reason", () => {
    const t = addTask({ title: "Block test" });
    const updated = updateTask(t.id, { status: "blocked", blockedReason: "waiting on API" });
    assert.ok(updated);
    assert.equal(updated!.status, "blocked");
    assert.equal(updated!.blockedReason, "waiting on API");
  });

  it("returns null for non-existent task", () => {
    const result = updateTask("t_nonexistent", { status: "completed" });
    assert.equal(result, null);
  });

  it("updates timestamp", () => {
    const t = addTask({ title: "Timestamp test" });
    const before = t.updatedAt;
    const updated = updateTask(t.id, { note: "tick" });
    assert.ok(updated);
    assert.ok(updated!.updatedAt >= before);
  });
});

describe("removeTask", () => {
  after(() => writeTasks({ tasks: [] }));

  it("removes an existing task", () => {
    const t = addTask({ title: "Remove me" });
    assert.ok(removeTask(t.id));
    const { tasks } = readTasks();
    assert.ok(!tasks.some((x) => x.id === t.id));
  });

  it("returns false for non-existent task", () => {
    assert.ok(!removeTask("t_nonexistent"));
  });
});

describe("getTasksForSession", () => {
  before(() => writeTasks({ tasks: [] }));
  after(() => writeTasks({ tasks: [] }));

  it("returns pending and in_progress tasks when no session", () => {
    addTask({ title: "Pending task" });
    addTask({ title: "Active task" });
    updateTask(readTasks().tasks.find((t) => t.title === "Active task")!.id, { status: "in_progress" });
    const completed = addTask({ title: "Done task" });
    updateTask(completed.id, { status: "completed" });

    const tasks = getTasksForSession();
    assert.equal(tasks.length, 2);
    assert.ok(!tasks.some((t) => t.status === "completed"));
  });

  it("returns tasks assigned to the given session", () => {
    writeTasks({ tasks: [] });
    const t1 = addTask({ title: "Assigned to me" });
    updateTask(t1.id, { assignee: "cr_mine" });
    addTask({ title: "Assigned to other" });
    updateTask(readTasks().tasks.find((t) => t.title === "Assigned to other")!.id, { assignee: "cr_other" });

    const tasks = getTasksForSession("cr_mine");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, "Assigned to me");
  });

  it("returns unassigned pending tasks plus assigned tasks", () => {
    writeTasks({ tasks: [] });
    const t1 = addTask({ title: "Unassigned pending" });
    const t2 = addTask({ title: "Assigned to me" });
    updateTask(t2.id, { assignee: "cr_combo", status: "in_progress" });

    const tasks = getTasksForSession("cr_combo");
    assert.equal(tasks.length, 2);
  });

  it("excludes tasks assigned to other sessions", () => {
    writeTasks({ tasks: [] });
    addTask({ title: "Other's task" });
    updateTask(readTasks().tasks[0].id, { assignee: "cr_someone_else" });

    const tasks = getTasksForSession("cr_me");
    assert.equal(tasks.length, 0);
  });
});

describe("formatTaskBlock", () => {
  it("returns empty string for empty array", () => {
    assert.equal(formatTaskBlock([]), "");
  });

  it("formats in-progress tasks under Active Tasks heading", () => {
    const tasks = [{
      id: "t_fmt1",
      title: "Fix bug",
      status: "in_progress" as const,
      priority: "high" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }];
    const block = formatTaskBlock(tasks);
    assert.ok(block.includes("Active Tasks"));
    assert.ok(block.includes("Fix bug"));
    assert.ok(block.includes("[high]"));
    assert.ok(block.includes("▶"));
  });

  it("includes note and files when present", () => {
    const tasks = [{
      id: "t_fmt2",
      title: "Refactor",
      description: "Break into modules",
      status: "in_progress" as const,
      priority: "medium" as const,
      files: ["src/a.ts", "src/b.ts"],
      note: "halfway done",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }];
    const block = formatTaskBlock(tasks);
    assert.ok(block.includes("Break into modules"));
    assert.ok(block.includes("src/a.ts"));
    assert.ok(block.includes("halfway done"));
  });

  it("formats blocked tasks with reason", () => {
    const tasks = [{
      id: "t_fmt3",
      title: "Waiting",
      status: "blocked" as const,
      priority: "medium" as const,
      blockedReason: "API down",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }];
    const block = formatTaskBlock(tasks);
    assert.ok(block.includes("Blocked"));
    assert.ok(block.includes("API down"));
    assert.ok(block.includes("⏸"));
  });

  it("formats pending tasks and truncates at 5", () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({
      id: `t_pend_${i}`,
      title: `Task ${i}`,
      status: "pending" as const,
      priority: "medium" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }));
    const block = formatTaskBlock(tasks);
    assert.ok(block.includes("Pending"));
    assert.ok(block.includes("+2 more"));
  });

  it("formats completed tasks with checkmark", () => {
    const tasks = [{
      id: "t_done",
      title: "Finished",
      status: "completed" as const,
      priority: "low" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }];
    const block = formatTaskBlock(tasks);
    assert.equal(block, "");
  });
});
