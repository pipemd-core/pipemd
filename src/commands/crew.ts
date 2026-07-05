// crew.ts — `pmd crew` command surface for multi-harness coordination.

import { Command } from "commander";
import chalk from "chalk";
import fs from "node:fs";
import YAML from "yaml";
import {
  joinSession,
  resolveActiveSession,
  resolveOrJoin,
  writeSessionAtomic,
  deleteSession,
  touchHeartbeat,
  toRepoRelative,
  listSessions,
  reapStaleSessions,
  renderCrewBlock,
  getStatusJson,
  isPipemdProject,
  readSession,
  DEFAULT_STALE_MS,
  type CrewRole,
  type CrewSession,
} from "../core/crew.js";
import { installHooks } from "../core/hooks.js";
import { clearSessionRecords } from "../core/dedup.js";
import { detectHarnesses } from "../core/detectHarness.js";
import { log, errMsg } from "../core/logger.js";
import type { DeliveryMode } from "../core/injection-types.js";

/** Hooks must never break an agent's edit — outside a PipeMD project, no-op. */
function requireProjectOrExit(): boolean {
  if (isPipemdProject()) return true;
  console.error(chalk.dim("pmd crew: not a PipeMD project (run `pmd init` first) — skipped."));
  return false;
}

function readDeliveryFromConfig(): DeliveryMode {
  for (const cfgPath of [".pipemd/injection.yml", ".pipemd/config.yml"]) {
    try {
      const raw = fs.readFileSync(cfgPath, "utf-8");
      const config = YAML.parse(raw) as { delivery?: DeliveryMode };
      const delivery = config.delivery;
      if (delivery === "passive" || delivery === "active" || delivery === "expert") return delivery;
    } catch (err: unknown) { log.debug(`read delivery config: ${errMsg(err)}`); }
  }
  return "passive";
}

function formatCrewHelp(): string {
  const lines: string[] = [];
  const w = (name: string, desc: string) =>
    `  ${chalk.cyan(name.padEnd(14))}${chalk.dim(desc)}`;

  lines.push(chalk.bold("Session:"));
  lines.push(w("join", "Register this agent as a coordinator or worker"));
  lines.push(w("leave", "Deregister this agent from the crew"));
  lines.push(w("heartbeat", "Refresh this agent's liveness timestamp"));
  lines.push("");
  lines.push(chalk.bold("File ownership:"));
  lines.push(w("claim", "Mark files as being worked on by this agent"));
  lines.push(w("release", "Release previously claimed files so others can work on them"));
  lines.push("");
  lines.push(chalk.bold("Communication:"));
  lines.push(w("note", "Post a status message for this agent"));
  lines.push(w("status", "Show all active crew sessions"));
  lines.push("");
  lines.push(chalk.bold("Output:"));
  lines.push(w("export", "Output all active crew sessions as JSON"));
  lines.push(w("render", "Print the crew context block for template rendering"));
  lines.push("");
  lines.push(chalk.bold("Admin:"));
  lines.push(w("install-hooks", "Wire harness hooks so edits self-report to the crew"));
  lines.push(w("reap", "Remove stale sessions (dead process or expired heartbeat)"));
  lines.push(
    chalk.dim(
      `\nRun ${chalk.reset("pmd crew <command> --help")} for usage on any command.`,
    ),
  );
  lines.push("");
  return "\n" + lines.join("\n");
}

const crew = new Command("crew")
  .description("Coordinate multiple AI agents working in parallel")
  .configureHelp({ visibleCommands: () => [] })
  .addHelpText("after", formatCrewHelp());

crew
  .command("join")
  .description("Register this agent as a coordinator or worker")
  .option("--role <role>", "coordinator | worker")
  .option("--coordinator <id>", "coordinator session id (for workers)")
  .option("--harness <name>", "harness name override")
  .option("--label <text>", "human-readable label for this session")
  .option("--sources <list>", "comma-separated list of block sources to receive (e.g. test-failures,git-delta)")
  .action((opts: { role?: string; coordinator?: string; harness?: string; label?: string; sources?: string }) => {
    if (!requireProjectOrExit()) return;
    const role =
      opts.role === "coordinator" || opts.role === "worker" ? (opts.role as CrewRole) : undefined;
    const sources = opts.sources ? opts.sources.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const existingSession = resolveActiveSession();
    const session = joinSession({
      role,
      coordinatorId: opts.coordinator,
      harness: opts.harness,
      label: opts.label,
      sources,
    });
    if (!existingSession) {
      log.info(`Crew: auto-joined ${session.role} ${session.id} (${session.harness})`);
    }
    console.log(
      chalk.green(`✔ Crew ${session.role} registered: ${session.id} (${session.harness})`),
    );
    console.log(chalk.dim(`  Persist this session across calls with:`));
    console.log(`  export PMD_SESSION=${session.id}`);
  });

crew
  .command("claim")
  .description("Mark files as being worked on by this agent")
  .argument("<files...>", "file paths to claim")
  .option("-n, --note <text>", "what you are doing with these files")
  .option("--session <id>", "target a specific crew session id")
  .action((files: string[], opts: { note?: string; session?: string }) => {
    if (!requireProjectOrExit()) return;
    const existingSession = opts.session ? readSession(opts.session) : resolveActiveSession();
    let session: CrewSession;
    if (opts.session && existingSession) {
      session = existingSession;
    } else {
      session = resolveOrJoin();
      if (!existingSession) {
        log.info(`Crew: auto-joined ${session.role} ${session.id} (${session.harness}) for claim`);
      }
    }
    const now = new Date().toISOString();
    for (const f of files) {
      const rel = toRepoRelative(f);
      const existing = session.claimedFiles.find((c) => c.path === rel);
      if (existing) {
        if (opts.note) existing.note = opts.note;
      } else {
        session.claimedFiles.push({ path: rel, claimedAt: now, note: opts.note });
      }
    }
    if (opts.note) session.note = opts.note;
    session.lastHeartbeat = now;
    writeSessionAtomic(session);
    console.log(chalk.green(`✔ ${session.id} claimed: ${files.map(toRepoRelative).join(", ")}`));
  });

crew
  .command("release")
  .description("Release previously claimed files so others can work on them")
  .argument("[files...]", "file paths to release")
  .option("-a, --all", "release every claimed file")
  .option("--session <id>", "target a specific crew session id")
  .action((files: string[], opts: { all?: boolean; session?: string }) => {
    if (!requireProjectOrExit()) return;
    const session = opts.session ? readSession(opts.session) : resolveActiveSession();
    if (!session) {
      console.log(chalk.yellow("⚠ No active crew session."));
      return;
    }
    if (opts.all) {
      session.claimedFiles = [];
    } else {
      const drop = new Set(files.map(toRepoRelative));
      session.claimedFiles = session.claimedFiles.filter((c) => !drop.has(c.path));
    }
    session.lastHeartbeat = new Date().toISOString();
    writeSessionAtomic(session);
    console.log(chalk.green(`✔ ${session.id} released ${opts.all ? "all files" : files.join(", ")}`));
  });

crew
  .command("note")
  .description("Post a status message for this agent")
  .argument("<text...>", "status text")
  .option("--session <id>", "target a specific crew session id")
  .action((text: string[], opts: { session?: string }) => {
    if (!requireProjectOrExit()) return;
    let session: CrewSession;
    const existing = opts.session ? readSession(opts.session) : resolveActiveSession();
    if (opts.session && existing) {
      session = existing;
    } else {
      session = resolveOrJoin();
    }
    session.note = text.join(" ");
    session.lastHeartbeat = new Date().toISOString();
    writeSessionAtomic(session);
    console.log(chalk.green(`✔ ${session.id} note: ${session.note}`));
  });

crew
  .command("heartbeat")
  .description("Refresh this agent's liveness timestamp")
  .option("--session <id>", "target a specific crew session id")
  .action((opts: { session?: string }) => {
    if (!isPipemdProject()) return;
    const session = opts.session ? readSession(opts.session) : resolveActiveSession();
    if (session) touchHeartbeat(session);
  });

crew
  .command("leave")
  .description("Deregister this agent from the crew")
  .option("--session <id>", "target a specific crew session id")
  .action((opts: { session?: string }) => {
    if (!requireProjectOrExit()) return;
    const session = opts.session ? readSession(opts.session) : resolveActiveSession();
    if (!session) {
      console.log(chalk.yellow("⚠ No active crew session."));
      return;
    }
    deleteSession(session.id);
    clearSessionRecords(session.id);
    console.log(chalk.green(`✔ Crew session ${session.id} left.`));
  });

crew
  .command("status")
  .description("Show all active crew sessions")
  .option("--json", "output structured JSON for programmatic consumption")
  .action((opts: { json?: boolean }) => {
    if (!requireProjectOrExit()) return;
    if (opts.json) {
      console.log(JSON.stringify(getStatusJson(), null, 2));
      return;
    }
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.log(chalk.dim("No active crew sessions."));
    }
    console.log(renderCrewBlock({ maxLines: 999 }));
  });

crew
  .command("export")
  .description("Output all active crew sessions as JSON")
  .action(() => {
    if (!requireProjectOrExit()) return;
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.error("No active crew sessions");
      process.exit(1);
    }
    const out = sessions.map((s) => ({
      sessionId: s.id,
      role: s.role,
      harness: s.harness,
      label: s.label ?? null,
      pid: s.pid,
      coordinatorId: s.coordinatorId ?? null,
      claimedFiles: s.claimedFiles.map((c) => ({
        path: c.path,
        claimedAt: c.claimedAt,
      })),
      note: s.note ?? null,
      startedAt: s.startedAt,
      lastHeartbeat: s.lastHeartbeat,
    }));
    console.log(`// Total sessions: ${sessions.length}`);
    console.log(JSON.stringify(out, null, 2));
  });

crew
  .command("render")
  .description("Print the crew context block for template rendering")
  .action(() => {
    const max = parseInt(process.env.PMD_MAX_CREW || "", 10);
    console.log(renderCrewBlock({ maxLines: Number.isNaN(max) ? undefined : max }));
  });

crew
  .command("reap")
  .description("Remove stale sessions (dead process or expired heartbeat)")
  .option("--stale-ms <ms>", "staleness threshold in milliseconds")
  .action((opts: { staleMs?: string }) => {
    if (!requireProjectOrExit()) return;
    const staleMs = parseInt(opts.staleMs || "", 10) || DEFAULT_STALE_MS;
    const reaped = reapStaleSessions(staleMs);
    console.log(
      reaped.length
        ? chalk.green(`✔ Reaped ${reaped.length} stale session(s): ${reaped.join(", ")}`)
        : chalk.dim("No stale sessions."),
    );
  });

crew
  .command("install-hooks")
  .description("Wire harness hooks so edits self-report to the crew")
  .option("--harness <name>", "install for a specific harness only")
  .option("-f, --force", "overwrite even if hooks are already installed")
  .action((opts: { harness?: string; force?: boolean }) => {
    const targets = opts.harness
      ? [opts.harness]
      : detectHarnesses()
          .filter((h) => h.detected)
          .map((h) => h.name);

    if (targets.length === 0) {
      console.log(chalk.yellow("⚠ No harnesses detected. Pass --harness <name>."));
      return;
    }

    const delivery = readDeliveryFromConfig();
    for (const harness of targets) {
      const r = installHooks(harness, process.cwd(), delivery, false, opts.force);
      const icon = r.installed ? chalk.green("✔") : chalk.dim("•");
      console.log(`${icon} ${r.harness}: ${r.detail}`);
    }
  });

export const crewCommand = crew;
