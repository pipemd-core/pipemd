import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { Command } from "commander";
import chalk from "chalk";
import { readPidFile } from "../core/daemon.js";
import { getPmdVersion } from "../core/version.js";
import { DEFAULT_ACTIVE_RULES } from "../core/injection-types.js";
import { listSessions } from "../core/crew.js";
import { detectHarnesses } from "../core/detectHarness.js";
import { installHooks } from "../core/hooks.js";
import { loadInjectionConfig } from "../core/injection-types.js";
import { PIPEMD_DIR, LIVE_DIR, CONFIG_PATH, TEMPLATE_PATH, SCRIPTS_DIR } from "../core/paths.js";
import { loadConfig, ConfigError } from "../core/daemon-config.js";
import { log, errMsg } from "../core/logger.js";
import { UserError } from "../core/errors.js";

function findScripts(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findScripts(full));
    } else if (entry.isFile() && entry.name.endsWith(".sh")) {
      results.push(full);
    }
  }
  return results;
}

export const doctorCommand = new Command("doctor")
  .description("Check that everything is installed and healthy")
  .action(async () => {
    let hasErrors = false;

    console.log();
    console.log(chalk.bold("PipeMD Health Check"));
    console.log(chalk.dim("─".repeat(40)));
    console.log(chalk.cyan(`  PipeMD version: ${getPmdVersion()}`));

    const nodeVersion = process.versions.node;
    const major = parseInt(nodeVersion.split(".")[0], 10);
    if (major < 18) {
      console.log(chalk.red(`  ✖ Node.js version: ${nodeVersion} (requires >= 18)`));
      hasErrors = true;
    } else {
      console.log(chalk.green(`  ✔ Node.js version: ${nodeVersion}`));
    }

    if (process.platform === "win32") {
      console.log(chalk.yellow(`  ⚠ OS: Windows — Legacy file-watcher mode will be used (no mkfifo)`));
    } else {
      console.log(chalk.green(`  ✔ OS: ${process.platform}`));
    }

    let mkfifoAvailable = false;
    try {
      execSync("which mkfifo", { encoding: "utf-8", stdio: "pipe" });
      mkfifoAvailable = true;
    } catch (err: unknown) { log.debug(`mkfifo check failed: ${errMsg(err)}`); }
    if (mkfifoAvailable) {
      console.log(chalk.green(`  ✔ mkfifo: available`));
    } else if (process.platform !== "win32") {
      console.log(chalk.yellow(`  ⚠ mkfifo: not found — Legacy file-watcher mode will be used`));
    }

    if (!fs.existsSync(CONFIG_PATH)) {
      console.log(chalk.red(`  ✖ Config file missing: ${CONFIG_PATH}`));
      hasErrors = true;
    } else {
      try {
        loadConfig();
        console.log(chalk.green(`  ✔ Config file valid: ${CONFIG_PATH}`));
      } catch (err: unknown) {
        if (err instanceof ConfigError) {
          console.log(chalk.red(`  ✖ ${err.message}`));
        } else {
          console.log(chalk.red(`  ✖ Config file invalid YAML: ${CONFIG_PATH}`));
        }
        hasErrors = true;
      }
    }

    const pid = readPidFile();
    if (!pid) {
      console.log(chalk.yellow(`  ⚠ Daemon: not running (no PID file)`));
    } else {
      try {
        process.kill(pid, 0);
        console.log(chalk.green(`  ✔ Daemon running (PID ${pid})`));
      } catch (err: unknown) {
        log.debug(`check daemon PID ${pid}: ${errMsg(err)}`);
        console.log(chalk.red(`  ✖ Daemon not running (stale PID ${pid})`));
        hasErrors = true;
      }
    }

    if (!fs.existsSync(TEMPLATE_PATH)) {
      console.log(chalk.red(`  ✖ Template file missing: ${TEMPLATE_PATH}`));
      hasErrors = true;
    } else {
      const content = fs.readFileSync(TEMPLATE_PATH, "utf-8");
      if (/<!--\s*pmd:\s*\w+/.test(content)) {
        console.log(chalk.green(`  ✔ Template has pmd tags: ${TEMPLATE_PATH}`));
      } else {
        console.log(chalk.red(`  ✖ Template missing pmd tags: ${TEMPLATE_PATH}`));
        hasErrors = true;
      }
    }

    if (fs.existsSync(SCRIPTS_DIR)) {
      const scriptFiles = findScripts(SCRIPTS_DIR);
      let allExecutable = true;
      const notExecutable: string[] = [];
      for (const sf of scriptFiles) {
        try {
          fs.accessSync(sf, fs.constants.X_OK);
        } catch (err: unknown) {
          log.debug(`check script executable ${sf}: ${errMsg(err)}`);
          notExecutable.push(sf);
          allExecutable = false;
        }
      }
      if (allExecutable && scriptFiles.length > 0) {
        console.log(chalk.green(`  ✔ All ${scriptFiles.length} scripts are executable`));
      } else if (scriptFiles.length === 0) {
        console.log(chalk.yellow(`  ⚠ No scripts found in ${SCRIPTS_DIR}`));
      } else {
        console.log(chalk.yellow(`  ⚠ ${notExecutable.length} script(s) not executable:`));
        for (const sf of notExecutable) {
          console.log(chalk.yellow(`    - ${sf}`));
        }
      }
    } else {
      console.log(chalk.yellow(`  ⚠ Scripts directory missing: ${SCRIPTS_DIR}`));
    }

    if (fs.existsSync(LIVE_DIR)) {
      const entries = fs.readdirSync(LIVE_DIR);
      if (entries.length > 0) {
        console.log(chalk.yellow(`  ⚠ Stale pipes found in ${LIVE_DIR}: ${entries.join(", ")}`));
        console.log(chalk.dim(`    Run 'pmd stop' or 'pmd restart' to clean up`));
      } else {
        console.log(chalk.green(`  ✔ No stale pipes in ${LIVE_DIR}`));
      }
    }

    // ── Crew diagnostics ──
    console.log(chalk.dim("─".repeat(40)));
    console.log(chalk.bold("  Crew Coordination"));

    const hasCrewCommand = (() => {
      try {
        const cfg = loadConfig();
        return !!cfg.commands?.crew;
      } catch (err: unknown) { log.debug(`read crew config: ${errMsg(err)}`); return false; }
    })();

    if (!hasCrewCommand) {
      console.log(chalk.dim("  · Crew not configured (add 'crew' script via pmd refresh)"));
    } else {
      console.log(chalk.green("  ✔ Crew command configured"));

      const crewDir = path.join(PIPEMD_DIR, "crew");
      if (fs.existsSync(crewDir)) {
        const sessions = listSessions();
        if (sessions.length > 0) {
          console.log(chalk.green(`  ✔ ${sessions.length} active crew session(s)`));
          for (const s of sessions) {
            const stale = !s.lastHeartbeat || Date.now() - Date.parse(s.lastHeartbeat) > 90_000;
            const icon = stale ? chalk.yellow("⚠") : chalk.green("✔");
            console.log(`    ${icon} ${s.id} ${s.harness}/${s.role} (claimed: ${s.claimedFiles.length})`);
          }
        } else {
          console.log(chalk.dim("  · No active crew sessions"));
        }
      } else {
        console.log(chalk.dim("  · No crew sessions yet"));
      }

      const detected = detectHarnesses().filter((h) => h.detected);
      const injectionConfig = loadInjectionConfig();
      const delivery = injectionConfig.delivery;
      for (const h of detected) {
        const hookResult = installHooks(h.name, process.cwd(), delivery, true);
        const hookStatus = hookResult.detail?.includes("already installed")
          ? chalk.green("installed")
          : hookResult.detail?.includes("no edit-event")
            ? chalk.dim("instruction-only")
            : hookResult.detail?.includes("needs update")
              ? chalk.yellow("needs update")
              : chalk.yellow("not installed");
        const deliveryLabel = delivery !== "passive"
          ? chalk.dim(` (${delivery}, injection: ${hookResult.injectionMode ?? "off"})`)
          : "";
        console.log(`    ${h.name}: hooks ${hookStatus}${deliveryLabel}`);
        if (hookResult.detail?.includes("needs update")) {
          console.log(chalk.dim(`      → run 'pmd crew install-hooks' or 'pmd init' to update`));
        }
      }
    }

    // ── Resolver health ──
    console.log(chalk.dim("─".repeat(40)));
    console.log(chalk.bold("  Resolver Health"));

    const beforeEditRules = DEFAULT_ACTIVE_RULES.rules["before-edit"] || [];
    if (beforeEditRules.length === 0) {
      console.log(chalk.dim("  · No before-edit rules configured"));
    } else {
      let sampleFile: string | null = null;
      const srcDir = path.join(process.cwd(), "src");
      if (fs.existsSync(srcDir)) {
        const walk = (dir: string): string | null => {
          try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                const found = walk(path.join(dir, entry.name));
                if (found) return found;
              } else if (/\.[tc]sx?$/.test(entry.name)) {
                return path.join(dir, entry.name);
              }
            }
          } catch { /* ignore */ }
          return null;
        };
        sampleFile = walk(srcDir);
      }

      if (!sampleFile) {
        console.log(chalk.dim("  · No .ts/.js source file found in src/ to test resolvers"));
      } else {
        const { RESOLVERS } = await import("../core/injection-engine.js");
        const testConfig = { delivery: "active" as const, rules: {} };
        for (const rule of beforeEditRules) {
          const resolver = (RESOLVERS as Record<string, (ctx: unknown) => Promise<string>>)[rule.source];
          if (!resolver) {
            console.log(chalk.red(`  ✖ ${rule.source}: resolver not registered`));
            continue;
          }
          try {
            const start = Date.now();
            const result = await Promise.race([
              resolver({ trigger: "before-edit", targetFile: sampleFile!, config: testConfig, maxLines: rule["max-lines"] }),
              new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
            ]);
            const elapsed = Date.now() - start;
            if (result.length > 0) {
              console.log(chalk.green(`  ✔ ${rule.source}: ${result.length} bytes (${elapsed}ms)`));
            } else {
              console.log(chalk.yellow(`  ⚠ ${rule.source}: empty for ${path.basename(sampleFile!)}`));
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(chalk.yellow(`  ⚠ ${rule.source}: ${msg}`));
          }
        }
      }
    }

    console.log(chalk.dim("─".repeat(40)));
    if (hasErrors) {
      console.log(chalk.red("  ✖ Some checks failed — see above"));
      console.log();
      throw new UserError("Some health checks failed");
    } else {
      console.log(chalk.green("  ✔ All checks passed"));
    }
    console.log();
  });
