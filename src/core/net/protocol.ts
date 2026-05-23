import type { CrewSession } from "../crew.js";

export const DEFAULT_PORT = 9741;
export const POLL_INTERVAL_MS = 5_000;
export const SESSION_EXPIRY_MS = 15_000;

export interface CrewMessage {
  group: string;
  hostname: string;
  sessions: CrewSession[];
}

export interface SyncMessage {
  hostname: string;
  groups: Record<string, CrewSession[]>;
}

export interface PeerConfig {
  host: string;
  token: string;
}

export interface RelayStatus {
  ok: boolean;
  hostname: string;
  groups: Record<string, { local: number; remote: number }>;
  peers: Array<{ host: string; lastSync: string | null }>;
}
