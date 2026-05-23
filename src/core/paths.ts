import path from "node:path";
import os from "node:os";

export const PIPEMD_DIR = ".pipemd";
export const HOME_LINK_DIR = path.join(os.homedir(), ".pipemd", "link");

export const LIVE_DIR = path.join(PIPEMD_DIR, "live");
export const PID_FILE = path.join(PIPEMD_DIR, ".daemon.pid");
export const STATUS_FILE = path.join(PIPEMD_DIR, ".status.json");
export const CONFIG_PATH = path.join(PIPEMD_DIR, "config.yml");
export const INJECTION_LOG_DIR = path.join(PIPEMD_DIR, ".injection-log");
export const INJECT_STATS_FILE = path.join(PIPEMD_DIR, ".inject-stats.json");
export const TUI_STATS_FILE = path.join(PIPEMD_DIR, ".tui-stats.json");
export const CREW_DIR = path.join(PIPEMD_DIR, "crew");
export const SCRIPTS_DIR = path.join(PIPEMD_DIR, "scripts");
export const TEMPLATE_PATH = path.join(PIPEMD_DIR, "template.md");
export const PIPES_DIR = path.join(PIPEMD_DIR, "pipes");
export const BASE_PATH = path.join(PIPEMD_DIR, "base.md");
export const BAK_PATH = path.join(PIPEMD_DIR, "context.bak");
export const CONTEXT_FILES = ["AGENTS.md", "AI_CONTEXT.md"];
