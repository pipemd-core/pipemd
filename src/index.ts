import { Command } from "commander";
import chalk from "chalk";
import { initCommand } from "./commands/init.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { restartCommand } from "./commands/restart.js";
import { statusCommand } from "./commands/status.js";
import { runCommand } from "./commands/run.js";
import { doctorCommand } from "./commands/doctor.js";
import { refreshCommand } from "./commands/refresh.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { crewCommand } from "./commands/crew.js";
import { injectCommand } from "./commands/inject.js";
import { statuslineCommand } from "./commands/statusline.js";
import { traceCommand } from "./commands/trace.js";
import { runDaemon } from "./core/daemon.js";

declare const PKG_VERSION: string;

const program = new Command();

const GROUPS: { title: string; commands: { name: string; desc: string }[] }[] =
  [
    {
      title: "Setup",
      commands: [
        { name: "init", desc: "Configure PipeMD for this project" },
        { name: "doctor", desc: "Check that everything is installed and healthy" },
        { name: "refresh", desc: "Update scripts to latest bundled versions" },
      ],
    },
    {
      title: "Daemon lifecycle",
      commands: [
        { name: "start", desc: "Start the background daemon" },
        { name: "stop", desc: "Stop the background daemon" },
        { name: "restart", desc: "Stop then start the daemon" },
        { name: "status", desc: "Show daemon health and recent logs" },
      ],
    },
    {
      title: "One-shot",
      commands: [
        {
          name: "run",
          desc: "Render context once to stdout or a file (no daemon needed)",
        },
      ],
    },
    {
      title: "Multi-agent",
      commands: [
        {
          name: "crew",
          desc: "Coordinate multiple AI agents working in parallel",
        },
        {
          name: "trace",
          desc: "Live resolution tree — debug crew coordination",
        },
      ],
    },
    {
      title: "Maintenance",
      commands: [
        { name: "uninstall", desc: "Remove PipeMD from this project" },
      ],
    },
  ];

function padRight(s: string, len: number): string {
  return s + " ".repeat(Math.max(0, len - s.length));
}

function formatHelp(): string {
  const lines: string[] = [];
  const maxName = Math.max(
    ...GROUPS.flatMap((g) => g.commands.map((c) => c.name.length)),
  );

  for (const group of GROUPS) {
    lines.push(chalk.bold(group.title + ":"));
    for (const cmd of group.commands) {
      lines.push(
        `  ${chalk.cyan(padRight(cmd.name, maxName))}  ${chalk.dim(cmd.desc)}`,
      );
    }
    lines.push("");
  }

  lines.push(
    chalk.dim(
      `Run ${chalk.reset("pmd <command> --help")} for usage on any command.`,
    ),
  );
  lines.push("");

  return "\n" + lines.join("\n");
}

program
  .name("pmd")
  .description(
    "PipeMD — The Dynamic Context Harness for AI Coding Agents",
  )
  .version(PKG_VERSION as string)
  .configureHelp({ visibleCommands: () => [] })
  .addHelpText("after", formatHelp());

program.addCommand(initCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(restartCommand);
program.addCommand(statusCommand);
program.addCommand(runCommand);
program.addCommand(refreshCommand);
program.addCommand(doctorCommand);
program.addCommand(uninstallCommand);
program.addCommand(crewCommand);
program.addCommand(traceCommand);
program.addCommand(injectCommand, { hidden: true });
program.addCommand(statuslineCommand, { hidden: true });

program
  .command("_daemon", { hidden: true })
  .description("(internal) Run the daemon process")
  .action(() => {
    runDaemon();
  });

program.parse();
