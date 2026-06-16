/**
 * ============================================================================
 * OPENCODE SSE SUBSCRIBER (B2-1)
 * ============================================================================
 *
 * Opens a long-lived Server-Sent-Events client to the co-located opencode
 * `serve` instance (`http://127.0.0.1:4096/api/event`, Basic auth with user
 * `opencode` + OPENCODE_SERVER_PASSWORD). Parses EventV2 frames and feeds them
 * into a FleetModel. Reconnects with exponential backoff and survives opencode
 * restarts — the relay never crashes because opencode is down.
 *
 * Architecture (REQUIREMENTS.md §0, Option A):
 *   Hermes ──Bearer──> relay:9741 ──localhost──> opencode:4096
 *   The relay is the ONLY network-exposed surface; opencode creds never leave
 *   the box. This subscriber is the localhost hop on the observe side.
 *
 * Dependency note: Node 20 has no built-in EventSource and no `ws`/`eventsource`
 * package is in the tree, so this is a hand-rolled SSE client over node:http.
 * SSE is just a chunked HTTP response with `Content-Type: text/event-stream`
 * and frames delimited by `\n\n` — straightforward to parse incrementally.
 * ============================================================================
 */

import http from "node:http";
import type { FleetModel } from "./fleet-model.js";
import { parseSseChunk } from "./fleet-model.js";
import { log, errMsg } from "../logger.js";

export interface SubscriberConfig {
  /** Base URL of the opencode server (default `http://127.0.0.1:4096`). */
  baseUrl?: string;
  /** Basic-auth user (default `opencode`). */
  user?: string;
  /** Basic-auth password (OPENCODE_SERVER_PASSWORD; default `""`). */
  password?: string;
  /** Initial reconnect backoff in ms (default 1000). */
  initialBackoffMs?: number;
  /** Max reconnect backoff in ms (default 30000). */
  maxBackoffMs?: number;
  /** Request timeout for the initial handshake in ms (default 15000). */
  connectTimeoutMs?: number;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:4096";
const DEFAULT_USER = "opencode";
const DEFAULT_INITIAL_BACKOFF = 1_000;
const DEFAULT_MAX_BACKOFF = 30_000;
const DEFAULT_CONNECT_TIMEOUT = 15_000;

export class OpencodeSubscriber {
  private readonly model: FleetModel;
  private readonly baseUrl: string;
  private readonly basicAuth: string;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly connectTimeoutMs: number;

  private req: http.ClientRequest | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private connected = false;
  private buffer = "";
  private backoff = DEFAULT_INITIAL_BACKOFF;
  private connectAttempts = 0;
  private eventsReceived = 0;

  constructor(model: FleetModel, cfg: SubscriberConfig = {}) {
    this.model = model;
    const password = cfg.password ?? process.env.OPENCODE_SERVER_PASSWORD ?? "";
    const user = cfg.user ?? DEFAULT_USER;
    this.baseUrl = (cfg.baseUrl ?? process.env.OPENCODE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.basicAuth = "Basic " + Buffer.from(`${user}:${password}`, "utf-8").toString("base64");
    this.initialBackoffMs = cfg.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF;
    this.maxBackoffMs = cfg.maxBackoffMs ?? DEFAULT_MAX_BACKOFF;
    this.connectTimeoutMs = cfg.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;
  }

  /** True when the SSE stream is currently connected and draining. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Total parsed event frames applied since construction (for metrics/tests). */
  getEventsReceived(): number {
    return this.eventsReceived;
  }

  /** Number of connect attempts (successes + failures) since start/restart. */
  getConnectAttempts(): number {
    return this.connectAttempts;
  }

  /** Open the SSE stream. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.stopped) return;
    if (this.req) return;
    this.connect();
  }

  /** Permanently stop the subscriber and tear down the connection. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.req) {
      try { this.req.destroy(); } catch { /* ignore */ }
      this.req = null;
    }
    this.connected = false;
    // Do NOT clear the fleet model here — callers may want to read the last
    // snapshot. The relay owns model lifecycle (clears on stopRelay).
  }

  private connect(): void {
    if (this.stopped) return;
    this.connectAttempts++;

    let url: URL;
    try {
      url = new URL("/api/event", this.baseUrl);
    } catch (err: unknown) {
      log.error(`fleet-subscriber: invalid baseUrl ${this.baseUrl}: ${errMsg(err)}`);
      this.scheduleReconnect();
      return;
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 4096,
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Authorization: this.basicAuth,
          "Cache-Control": "no-cache",
        },
        timeout: this.connectTimeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          log.warn(`fleet-subscriber: /api/event responded ${res.statusCode}; will retry`);
          // Drain to free the socket.
          res.resume();
          this.handleDrop();
          return;
        }
        if (!/text\/event-stream/i.test(res.headers["content-type"] || "")) {
          log.warn(`fleet-subscriber: unexpected content-type ${res.headers["content-type"]}; will retry`);
          res.resume();
          this.handleDrop();
          return;
        }

        // Successful handshake — reset backoff.
        this.backoff = this.initialBackoffMs;
        this.connected = true;
        this.req = req;
        log.info(`fleet-subscriber: connected to ${this.baseUrl}/api/event`);

        res.on("data", (chunk: Buffer) => this.onData(chunk));
        res.on("end", () => {
          this.connected = false;
          log.info("fleet-subscriber: stream ended; reconnecting");
          this.handleDrop();
        });
        res.on("error", (err: unknown) => {
          this.connected = false;
          log.warn(`fleet-subscriber: stream error: ${errMsg(err)}`);
          this.handleDrop();
        });
      },
    );

    req.on("error", (err: unknown) => {
      this.connected = false;
      const msg = errMsg(err);
      // ECONNREFUSED is expected when opencode isn't running yet — log at debug.
      if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
        log.debug(`fleet-subscriber: opencode not reachable: ${msg}`);
      } else {
        log.warn(`fleet-subscriber: connect error: ${msg}`);
      }
      this.handleDrop();
    });

    req.on("timeout", () => {
      req.destroy();
      this.connected = false;
      log.debug("fleet-subscriber: connect timeout; retrying");
      this.handleDrop();
    });

    req.end();
    // Track the in-flight request so stop() can tear it down. If the handshake
    // failed we may have already nulled it via handleDrop; that's fine.
    if (!this.req) this.req = req;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    // SSE frames are delimited by a blank line. Process only complete frames;
    // keep the trailing partial in the buffer.
    let sep = -1;
    while ((sep = this.frameBoundary()) !== -1) {
      const frame = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep).replace(/^(\r?\n){1,2}/, "");
      const events = parseSseChunk(frame);
      for (const evt of events) {
        this.model.applyEvent(evt);
        this.eventsReceived++;
      }
    }
  }

  /** Find the end of the next complete frame (index after the delimiter). */
  private frameBoundary(): number {
    const m = /\r?\n\r?\n/.exec(this.buffer);
    return m ? m.index + m[0].length : -1;
  }

  private handleDrop(): void {
    this.connected = false;
    this.req = null;
    this.buffer = "";
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.maxBackoffMs, Math.round(this.backoff * 2));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
