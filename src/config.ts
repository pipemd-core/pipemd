export type TokenProfile = "low" | "medium" | "high" | "xhigh" | "unlimited";

export const TOKEN_PROFILE_LINES: Record<TokenProfile, number> = {
  low: 200,
  medium: 400,
  high: 800,
  xhigh: 1500,
  unlimited: Infinity,
};

export type PipeMode = "pipe" | "legacy";

export type PmdMode = "agent" | "file";

import type { DeliveryMode as DeliveryModeType } from "./core/injection-types.js";
export type DeliveryMode = DeliveryModeType;

export interface PipeConfig {
  version: string;
  output?: string;
  delivery?: DeliveryMode;
  base?: string;
  commands: Record<string, string>;
  injected: { file: string; watch: boolean }[];
  pipes: { file: string; command?: string; render?: string; mode?: PipeMode }[];
  link?: {
    group?: string;
    relay?: string;
  };
  settings: {
    debounceMs: number;
    reServeDelayMs: number;
    tokenProfile?: TokenProfile;
    crew?: {
      staleMs?: number;
      hotMin?: number;
    };
  };
}

export const PMD_CONTEXT_SEPARATOR = "\n\n---\n\n<!-- pmd-context -->\n";

export const COMMAND_TIMEOUT_MS = 10_000;

export const DEFAULT_RESERVE_DELAY_MS = 1000;

export const DEFAULT_CONFIG: PipeConfig = {
  version: "1.0",
  commands: {
    arch: "bash .pipemd/scripts/architecture/arch.sh",
    compose: "bash .pipemd/scripts/project/compose-md.sh",
    tree: "bash .pipemd/scripts/project/tree.sh",
    "git-status": "bash .pipemd/scripts/git/git-status.sh",
    "diff-stat": "bash .pipemd/scripts/git/diff-stat.sh",
    todos: "bash .pipemd/scripts/project/find-todos.sh",
  },
  injected: [{ file: ".pipemd/template.md", watch: true }],
  pipes: [
    { file: "AGENTS.md", render: ".pipemd/template.md" },
  ],
  settings: {
    debounceMs: 3000,
    reServeDelayMs: DEFAULT_RESERVE_DELAY_MS,
  },
};