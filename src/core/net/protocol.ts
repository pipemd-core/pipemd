import type { CrewSession } from "../crew.js";
import type { FleetSyncPayload } from "./fleet-schema.js";

export const DEFAULT_PORT = 9741;
export const POLL_INTERVAL_MS = 5_000;
export const SESSION_EXPIRY_MS = 15_000;

export interface CrewMessage {
  group: string;
  hostname: string;
  sessions: CrewSession[];
  commitSha?: string;
}

export interface BlockPushMessage {
  group: string;
  hostname: string;
  commitSha: string;
  blocks: BlockEntry[];
}

export interface BlockEntry {
  source: string;
  data: string;
  timestamp: number;
  hash: string;
}

interface BlockFetchRequest {
  group: string;
  commitSha: string;
  sources?: string[];
}

interface BlockFetchResponse {
  blocks: BlockEntry[];
  hostname: string;
}

export interface SyncMessage {
  hostname: string;
  groups: Record<string, CrewSession[]>;
  /**
   * B2-3 peer fleet federation. Carries the origin relay's self FleetMachine
   * row(s). Optional for backwards compatibility with Phase-1 peers that
   * don't send it; receivers treat absence as "no fleet data".
   */
  fleet?: FleetSyncPayload;
}

export interface PeerConfig {
  host: string;
  port?: number;
  token: string;
  label?: string;
}

export interface RelayStatus {
  ok: boolean;
  hostname: string;
  groups: Record<string, { local: number; remote: number }>;
  peers: Array<{ host: string; lastSync: string | null }>;
}

export interface WorkspaceContextResponse {
  last_updated: string;
  content: string;
}
