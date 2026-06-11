export type TokenProfile = "low" | "medium" | "high" | "xhigh" | "unlimited";

export type PipeMode = "pipe" | "legacy";

export type PmdMode = "agent" | "file";

import type { DeliveryMode as DeliveryModeType } from "./core/injection-types.js";
type DeliveryMode = DeliveryModeType;

export interface PipeConfig {
  version: string;
  output?: string;
  delivery?: DeliveryMode;
  base?: string;
  commands: Record<string, string>;
  commandTimeouts?: Record<string, number>;
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