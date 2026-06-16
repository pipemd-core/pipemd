/**
 * ============================================================================
 * FLEET RUNTIME — owns the self model + subscriber + peer-federation store
 * ============================================================================
 *
 * Single instance held by relay.ts (cleared on stopRelay, mirroring the
 * existing module-singleton pattern). Provides:
 *   - start()/stop()         — SSE subscriber lifecycle (B2-1)
 *   - selfMachine()          — self row for GET /fleet (B2-2)
 *   - snapshot()             — self + peer rows combined (B2-2)
 *   - buildSyncPayload()     — outbound federation payload (B2-3)
 *   - importPeer()           — inbound federation merge (B2-3)
 *   - injectEvent()          — TEST-ONLY direct model feed (no SSE hop)
 *
 * Peer rows expire after PEER_FLEET_TTL_MS without a refresh; this rides the
 * relay's existing expiry tick.
 * ============================================================================
 */

import os from "node:os";
import { FleetModel, type EventV2 } from "./fleet-model.js";
import { OpencodeSubscriber } from "./opencode-subscriber.js";
import type {
  FleetMachine,
  FleetProject,
  FleetSyncPayload,
} from "./fleet-schema.js";
import { log, errMsg } from "../logger.js";

/** Peer rows older than this without a refresh are evicted. */
export const PEER_FLEET_TTL_MS = 30_000;

class FleetRuntime {
  private readonly model = new FleetModel();
  private subscriber: OpencodeSubscriber | null = null;
  private peers = new Map<string, { machines: FleetMachine[]; lastSeen: number }>();

  /** Begin observing the local opencode event stream. Idempotent. */
  start(): void {
    if (this.subscriber) return;
    this.subscriber = new OpencodeSubscriber(this.model);
    this.subscriber.start();
    log.info("fleet-runtime: subscriber started");
  }

  /** Stop the subscriber. Does NOT clear the model or peer store. */
  stopSubscriber(): void {
    if (this.subscriber) {
      this.subscriber.stop();
      this.subscriber = null;
    }
  }

  /** Subscriber alive? */
  subscribed(): boolean {
    return this.subscriber !== null;
  }

  /** Local hostname — the `host` of the self row. */
  selfHost(): string {
    return os.hostname();
  }

  /** Build the self FleetMachine row from the current model snapshot. */
  selfMachine(): FleetMachine {
    const projects = this.model.snapshot();
    const lastUpdated = projects.length > 0
      ? projects.reduce((max, p) => (p.lastUpdated > max ? p.lastUpdated : max), projects[0].lastUpdated)
      : new Date(0).toISOString();
    return {
      host: this.selfHost(),
      self: true,
      projects,
      lastUpdated,
    };
  }

  /**
   * Full federated topology for GET /fleet: self row first, then peer rows
   * in insertion order. Peer rows whose host collides with self are dropped
   * (defensive — a misconfigured peer advertising our own hostname).
   */
  snapshot(): FleetMachine[] {
    const out: FleetMachine[] = [this.selfMachine()];
    const selfHost = this.selfHost();
    for (const [, entry] of this.peers) {
      for (const m of entry.machines) {
        if (m.host === selfHost) continue;
        out.push({ ...m, self: false });
      }
    }
    return out;
  }

  /** Outbound federation payload: just our self row(s). */
  buildSyncPayload(): FleetSyncPayload {
    return {
      origin: this.selfHost(),
      machines: [this.selfMachine()],
    };
  }

  /**
   * Inbound federation merge (B2-3). Replaces whatever we previously held
   * from `payload.origin` with the fresh rows. Defensive: re-stamps every
   * row's host to the origin hostname so a peer cannot spoof another
   * machine's identity, and forces self=false.
   */
  importPeer(payload: unknown): { ok: true; count: number } | { ok: false; reason: string } {
    if (!payload || typeof payload !== "object") {
      return { ok: false, reason: "payload not an object" };
    }
    const p = payload as Partial<FleetSyncPayload>;
    if (typeof p.origin !== "string" || p.origin.length === 0) {
      return { ok: false, reason: "missing origin" };
    }
    if (!Array.isArray(p.machines)) {
      return { ok: false, reason: "missing machines array" };
    }
    if (p.origin === this.selfHost()) {
      // Anti-echo: ignore our own payload reflected back.
      return { ok: true, count: 0 };
    }

    const sanitized: FleetMachine[] = [];
    for (const m of p.machines) {
      if (!m || typeof m !== "object") continue;
      const projects = Array.isArray(m.projects) ? m.projects.filter(this.validProject) : [];
      sanitized.push({
        host: p.origin,
        self: false,
        projects,
        lastUpdated: typeof m.lastUpdated === "string" ? m.lastUpdated : new Date().toISOString(),
      });
    }
    this.peers.set(p.origin, { machines: sanitized, lastSeen: Date.now() });
    log.debug(`fleet-runtime: imported ${sanitized.length} machine(s) from peer ${p.origin}`);
    return { ok: true, count: sanitized.length };
  }

  private validProject = (p: unknown): p is FleetProject => {
    if (!p || typeof p !== "object") return false;
    const po = p as Record<string, unknown>;
    return typeof po.dir === "string" && po.dir.length > 0
      && Array.isArray(po.sessions) && Array.isArray(po.ptys) && Array.isArray(po.agents);
  };

  /** Evict peer rows older than TTL. Called from the relay's expiry tick. */
  expirePeers(): number {
    const now = Date.now();
    let evicted = 0;
    for (const [origin, entry] of this.peers) {
      if (now - entry.lastSeen > PEER_FLEET_TTL_MS) {
        this.peers.delete(origin);
        evicted++;
        log.info(`fleet-runtime: expired stale peer ${origin}`);
      }
    }
    return evicted;
  }

  /** Drop all peer rows (e.g. on stopRelay). */
  clearPeers(): void {
    this.peers.clear();
  }

  /** Total peer rows held (for /metrics). */
  peerCount(): number {
    return this.peers.size;
  }

  /**
   * TEST-ONLY: feed an event directly into the model without going through
   * the SSE subscriber. Lets /fleet endpoint tests run without a stub
   * opencode server. Not wired into any production path.
   */
  injectEvent(evt: EventV2 | unknown): void {
    this.model.applyEvent(evt);
  }

  /** Reset everything (model + peers). Called by stopRelay. */
  reset(): void {
    this.stopSubscriber();
    this.model.clear();
    this.peers.clear();
  }
}

/** Module singleton — cleared in stopRelay. */
export const fleetRuntime = new FleetRuntime();
