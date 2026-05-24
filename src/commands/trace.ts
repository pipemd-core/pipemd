import { Command } from "commander";
import chalk from "chalk";
import { log, errMsg } from "../core/logger.js";
import {
  resolveTraceData,
  resolveLockMap,
  renderTraceTree,
  renderTimeline,
  renderLockMap,
  renderPayloads,
  renderInjectionSummary,
  type TraceData,
} from "../core/trace.js";

type ViewMode = "tree" | "timeline" | "locks" | "payloads" | "inject";

const BOX = {
  tl: "\u2554", tr: "\u2557", bl: "\u255a", br: "\u255d",
  h: "\u2550", v: "\u2551",
  lj: "\u2560", rj: "\u2563",
};

function hline(w: number): string {
  return BOX.h.repeat(w);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function padLine(content: string, width: number): string {
  const visible = stripAnsi(content).length;
  const pad = Math.max(0, width - visible);
  return content + " ".repeat(pad);
}

function topBorder(w: number): string {
  return ` ${BOX.tl}${hline(w - 2)}${BOX.tr}`;
}

function banner(w: number, data: TraceData): string {
  const inner = w - 4;
  const label = chalk.bold("PipeMD Resolution Trace") +
    chalk.dim(` \u00b7 ${data.sessions.length} sessions \u00b7 updating live`);
  return `${BOX.v} ${padLine(label, inner)} ${BOX.v}`;
}

function statusBar(w: number): string {
  const inner = w - 4;
      const keys = "[q] quit  [\u2191\u2193] scroll  [f] locks  [t] timeline  [p] payloads  [i] inject  [r] refresh";
  const dimmed = chalk.dim(keys.length > inner ? keys.slice(0, inner) : keys);
  return `${BOX.v} ${padLine(dimmed, inner)} ${BOX.v}`;
}

function wrapLine(w: number): string {
  return `${BOX.lj}${hline(w - 2)}${BOX.rj}`;
}

function bottomBorder(w: number): string {
  return ` ${BOX.bl}${hline(w - 2)}${BOX.br}`;
}

function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

const trace = new Command("trace")
  .description("Live debugging — crew sessions, injection payloads, file locks")
  .option("--snapshot", "one-shot output (no watch)")
  .option("--json", "structured JSON output")
  .option("--locks", "show file lock map only")
  .option("--timeline", "show injection timeline only")
  .option("--payloads", "show recent injection payloads")
  .option("--inject", "show injection summary (sources, bytes, dedup stats)")
  .option("--max-payloads <n>", "max payloads to show", "20")
  .action(async (opts) => {
    const data = resolveTraceData({ maxPayloads: parseInt(opts.maxPayloads) || 20 });

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (opts.locks) {
      console.log(renderLockMap(resolveLockMap(data.sessions)));
      return;
    }

    if (opts.timeline) {
      console.log(renderTimeline(data.events, data.sessions));
      return;
    }

    if (opts.payloads) {
      console.log(renderPayloads(data.payloads));
      return;
    }

    if (opts.inject) {
      console.log(renderInjectionSummary(data));
      return;
    }

    if (opts.locks) {
      console.log(renderLockMap(resolveLockMap(data.sessions)));
      return;
    }

    if (opts.timeline) {
      console.log(renderTimeline(data.events, data.sessions));
      return;
    }

    if (opts.payloads) {
      console.log(renderPayloads(data.payloads));
      return;
    }

    if (opts.snapshot) {
      console.log(renderTraceTree(data));
      if (data.events.length > 0) {
        console.log("");
        console.log(renderTimeline(data.events, data.sessions));
      }
      return;
    }

    let scrollOffset = 0;
    let viewMode: ViewMode = "tree";
    let running = true;
    let interval: ReturnType<typeof setInterval> | undefined; // eslint-disable-line prefer-const

    const cleanup = () => {
      running = false;
      if (interval) clearInterval(interval);
      process.stdout.write("\x1b[?25h");
      try { process.stdin.setRawMode(false); } catch (err: unknown) { log.debug(`setRawMode(false): ${errMsg(err)}`); }
      process.stdin.pause();
      clearScreen();
    };

    const exitGracefully = () => {
      cleanup();
      process.exit(0);
    };

    process.on("SIGINT", exitGracefully);
    process.on("SIGTERM", exitGracefully);

    process.stdout.write("\x1b[?25l");
    process.stdin.setRawMode(true);
    process.stdin.resume();

    process.stdin.on("data", (buf: Buffer) => {
      const key = buf.toString();
      if (key === "q" || key === "\u0003") {
        exitGracefully();
      } else if (key === "k" || key === "\u001b[A") {
        scrollOffset = Math.max(0, scrollOffset - 1);
        render();
      } else if (key === "j" || key === "\u001b[B") {
        scrollOffset += 1;
        render();
      } else if (key === "f") {
        viewMode = "locks";
        scrollOffset = 0;
        render();
      } else if (key === "t") {
        viewMode = "timeline";
        scrollOffset = 0;
        render();
      } else if (key === "p") {
        viewMode = "payloads";
        scrollOffset = 0;
        render();
      } else if (key === "i") {
        viewMode = "inject";
        scrollOffset = 0;
        render();
      } else if (key === "r") {
        render();
      } else if (key === "\u001b" || key === "g") {
        viewMode = "tree";
        scrollOffset = 0;
        render();
      }
    });

    function render(): void {
      const w = process.stdout.columns || 80;
      const h = process.stdout.rows || 24;
      const data = resolveTraceData({ maxPayloads: parseInt(opts.maxPayloads) || 20 });

      let content: string;
      switch (viewMode) {
        case "locks":
          content = renderLockMap(resolveLockMap(data.sessions));
          break;
        case "timeline":
          content = renderTimeline(data.events, data.sessions);
          break;
        case "payloads":
          content = renderPayloads(data.payloads);
          break;
        case "inject":
          content = renderInjectionSummary(data);
          break;
        default:
          content = renderTraceTree(data);
          break;
      }

      const availableLines = h - 6;
      const allLines = content.split("\n");
      const maxOffset = Math.max(0, allLines.length - availableLines);
      if (scrollOffset > maxOffset) scrollOffset = maxOffset;
      const visible = allLines.slice(scrollOffset, scrollOffset + availableLines);

      const output: string[] = [];
      output.push(topBorder(w));
      output.push(banner(w, data));
      output.push(wrapLine(w));

      for (let i = 0; i < availableLines; i++) {
        const line = visible[i] || "";
        const inner = w - 4;
        const visibleLen = stripAnsi(line).length;
        let truncated = line;
        if (visibleLen > inner) {
          let pos = 0;
          let cutIdx = line.length;
          for (let ci = 0; ci < line.length && pos < inner; ci++) {
            if (line[ci] === "\x1b") {
              const m = line.substring(ci).match(/^\x1b\[[0-9;]*m/);
              if (m) { ci += m[0].length - 1; continue; }
            }
            pos++;
            cutIdx = ci + 1;
          }
          truncated = line.substring(0, cutIdx) + "\x1b[0m";
        }
        output.push(`${BOX.v} ${padLine(truncated, inner)} ${BOX.v}`);
      }

      output.push(wrapLine(w));
      output.push(statusBar(w));
      output.push(bottomBorder(w));

      clearScreen();
      process.stdout.write(output.join("\n") + "\n");
    }

    render();
    interval = setInterval(() => {
      if (running) render();
    }, 2000);
  });

export const traceCommand = trace;
