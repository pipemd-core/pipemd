/**
 * ============================================================================
 * MINIMAL WEBSOCKET PIPE (RFC 6455) — for the PTY takeover proxy (B2-5)
 * ============================================================================
 *
 * Node 20 has no built-in WebSocket (global landed in Node 21+) and there is
 * no `ws` package in the dependency tree, so this is a hand-rolled RFC 6455
 * implementation scoped to what the PTY proxy needs:
 *
 *   - `upgradeInbound(req, socket, head)` — complete the server-side handshake
 *     for a caller opening a WS to the relay. Returns a WsPeer or null.
 *   - `dialOutbound(url, headers)` — open a client WS to opencode (or a peer
 *     relay). Returns a Promise<WsPeer>.
 *   - `pipe(a, b)` — splice two peers: forward each data frame verbatim to the
 *     other, propagate close frames, and tear both down on either close.
 *
 * PtyProtocol frames are opaque to the relay; we forward text/binary payloads
 * byte-for-byte and propagate close/ping/pong control frames. Client→server
 * frames are unmasked on read and re-masked on write (the relay acts as a
 * client toward opencode and toward peer relays).
 *
 * Scope: single-frame and fragmented messages up to 64-bit length are parsed;
 * per-message-deflate (extensions) is NOT negotiated (PTY traffic is small and
 * latency-sensitive — compression would hurt). Subprotocols are passed through
 * untouched on the outbound dial.
 * ============================================================================
 */

import crypto from "node:crypto";
import net from "node:net";
import http from "node:http";
import { URL } from "node:url";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE_CONT = 0x0;
export const OPCODE_TEXT = 0x1;
export const OPCODE_BINARY = 0x2;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

export interface WsFrame {
  opcode: number;
  fin: boolean;
  payload: Buffer;
}

export interface WsPeerOptions {
  /** True when this peer is the client role (outbound frames must be masked). */
  isClient: boolean;
  /** Bytes already buffered after the handshake (the `head` from an upgrade). */
  initialBytes?: Buffer;
}

export class WsPeer {
  private socket: net.Socket;
  private readonly isClient: boolean;
  private rxBuffer: Buffer = Buffer.alloc(0);
  private fragBuffer: Buffer[] = [];
  private fragOpcode = 0;
  closed = false;

  // Backlog: frames/close emitted before a handler is attached are buffered
  // and flushed on first assignment. This is essential because, e.g., frames
  // coalesced with the WS handshake (opencode's first PtyProtocol output) are
  // parsed synchronously inside dialOutbound's upgrade callback — before the
  // caller's .then() has a chance to attach onFrame via pipe().
  private _onFrame?: (f: WsFrame) => void;
  private _onClose?: (code: number, reason: string) => void;
  private frameBacklog: WsFrame[] = [];
  private closeBacklog: { code: number; reason: string } | null = null;

  /** Emitted for every complete frame (data AND control). */
  get onFrame(): ((f: WsFrame) => void) | undefined { return this._onFrame; }
  set onFrame(fn: ((f: WsFrame) => void) | undefined) {
    this._onFrame = fn;
    if (fn && this.frameBacklog.length > 0) {
      const pending = this.frameBacklog;
      this.frameBacklog = [];
      for (const f of pending) fn(f);
    }
  }
  /** Emitted once with the close code/reason when the peer closes. */
  get onClose(): ((code: number, reason: string) => void) | undefined { return this._onClose; }
  set onClose(fn: ((code: number, reason: string) => void) | undefined) {
    this._onClose = fn;
    if (fn && this.closeBacklog) {
      const c = this.closeBacklog;
      this.closeBacklog = null;
      fn(c.code, c.reason);
    }
  }
  /** Emitted on a fatal socket error. */
  onError?: (err: Error) => void;

  /** Route a parsed frame to the handler, buffering if not yet attached. */
  private emitFrame(f: WsFrame): void {
    if (this._onFrame) this._onFrame(f);
    else this.frameBacklog.push(f);
  }
  /** Route a close to the handler, buffering if not yet attached. */
  private emitClose(code: number, reason: string): void {
    if (this._onClose) this._onClose(code, reason);
    else this.closeBacklog = { code, reason };
  }

  constructor(socket: net.Socket, opts: WsPeerOptions) {
    this.socket = socket;
    this.isClient = opts.isClient;
    socket.on("data", (chunk: Buffer) => this.feed(chunk));
    socket.on("close", () => {
      if (!this.closed) {
        this.closed = true;
        this.emitClose(1005, "");
      }
    });
    socket.on("error", (err: Error) => {
      if (!this.closed) {
        this.closed = true;
        this.onError?.(err);
        this.emitClose(1006, err.message);
      }
    });
    if (opts.initialBytes && opts.initialBytes.length > 0) {
      // Prepend already-buffered bytes (frames coalesced with the handshake).
      // Parsed immediately; if no handler is attached yet the backlog flushes
      // on first onFrame/onClose assignment.
      this.rxBuffer = opts.initialBytes;
      this.feed(Buffer.alloc(0));
    }
  }

  /**
   * Feed received bytes and emit complete frames. Handles partial frames
   * spanning multiple chunks, 7/16/64-bit payload lengths, and client→server
   * masking. Fragmented messages are reassembled before emission (PTY frames
   * are small; this keeps the proxy logic simple).
   */
  private feed(chunk: Buffer): void {
    this.rxBuffer = this.rxBuffer.length === 0 ? chunk : Buffer.concat([this.rxBuffer, chunk]);

    while (this.rxBuffer.length >= 2) {
      const b0 = this.rxBuffer[0];
      const b1 = this.rxBuffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.rxBuffer.length < offset + 2) return;
        len = this.rxBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.rxBuffer.length < offset + 8) return;
        const hi = this.rxBuffer.readUInt32BE(offset);
        const lo = this.rxBuffer.readUInt32BE(offset + 4);
        len = hi * 0x100000000 + lo;
        offset += 8;
      }

      let maskKey: Buffer | null = null;
      if (masked) {
        if (this.rxBuffer.length < offset + 4) return;
        maskKey = this.rxBuffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.rxBuffer.length < offset + len) return; // wait for full payload

      const payload: Buffer = masked && maskKey
        ? unmask(this.rxBuffer.subarray(offset, offset + len), maskKey)
        : Buffer.from(this.rxBuffer.subarray(offset, offset + len));

      // Advance the buffer past this frame.
      this.rxBuffer = this.rxBuffer.subarray(offset + len);

      if (opcode === OPCODE_CLOSE) {
        let code = 1005;
        let reason = "";
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString("utf-8");
        }
        this.closed = true;
        this.emitClose(code, reason);
        try { this.socket.end(); } catch { /* ignore */ }
        return;
      }
      if (opcode === OPCODE_PING) {
        // Echo as pong automatically.
        this.send(payload, OPCODE_PONG);
        continue;
      }
      if (opcode === OPCODE_PONG) {
        continue;
      }

      // Data frames (text/binary/cont).
      if (opcode === OPCODE_CONT) {
        this.fragBuffer.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragBuffer);
          const op = this.fragOpcode;
          this.fragBuffer = [];
          this.fragOpcode = 0;
          this.emitFrame({ opcode: op, fin: true, payload: full });
        }
      } else {
        if (fin) {
          this.emitFrame({ opcode, fin: true, payload });
        } else {
          this.fragBuffer = [payload];
          this.fragOpcode = opcode;
        }
      }
    }
  }

  /**
   * Send a data or control frame. Outbound frames are masked when this peer
   * is the client role (RFC 6455 §5.3).
   */
  send(data: string | Buffer, opcode = OPCODE_TEXT): void {
    if (this.closed) return;
    const payload = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    const frame = encodeFrame(payload, opcode, true, this.isClient);
    try { this.socket.write(frame); } catch { /* ignore */ }
  }

  /** Send a close frame (optional status code + reason) and end the socket. */
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, "utf-8");
    const frame = encodeFrame(payload, OPCODE_CLOSE, true, this.isClient);
    try { this.socket.write(frame); } catch { /* ignore */ }
    this.closed = true;
    try { this.socket.end(); } catch { /* ignore */ }
  }

  /** Force-destroy the underlying socket (e.g. on proxy teardown). */
  destroy(): void {
    this.closed = true;
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}

function unmask(payload: Buffer, mask: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) {
    out[i] = payload[i] ^ mask[i % 4];
  }
  return out;
}
function encodeFrame(payload: Buffer, opcode: number, fin: boolean, masked: boolean): Buffer {
  const len = payload.length;
  let extLenBytes = 0;
  if (len > 65535) extLenBytes = 8;
  else if (len > 125) extLenBytes = 2;
  const maskBytes = masked ? 4 : 0;
  const headerLen = 2 + extLenBytes + maskBytes;
  // Allocate header + payload in one buffer so nothing is dropped on the
  // masked path (the original bug: out was header-only, payload writes went
  // out of bounds and were silently lost).
  const out = Buffer.alloc(headerLen + len);
  out[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);

  let offset = 1;
  if (len > 65535) {
    out[offset] = masked ? 0xff : 0x7f;
    out.writeUInt32BE(Math.floor(len / 0x100000000), offset + 1);
    out.writeUInt32BE(len >>> 0, offset + 5);
    offset += 9;
  } else if (len > 125) {
    out[offset] = masked ? 0xfe : 0x7e;
    out.writeUInt16BE(len, offset + 1);
    offset += 3;
  } else {
    out[offset] = (masked ? 0x80 : 0) | len;
    offset += 1;
  }

  if (masked) {
    const mask = crypto.randomBytes(4);
    mask.copy(out, offset);
    offset += 4;
    for (let i = 0; i < payload.length; i++) {
      out[offset + i] = payload[i] ^ mask[i % 4];
    }
  } else {
    payload.copy(out, offset);
  }
  return out;
}

/**
 * Complete the inbound (caller → relay) WS handshake. Writes the 101 response
 * onto the raw socket and returns a WsPeer in the SERVER role (no masking on
 * outbound). Returns null if the handshake is malformed (caller should close
 * the socket). `head` is the first bytes after the headers already buffered.
 */
export function upgradeInbound(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
): WsPeer | null {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || key.length === 0) {
    socket.destroy();
    return null;
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");

  const lines = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
  ];
  socket.write(lines.join("\r\n") + "\r\n\r\n");

  return new WsPeer(socket, { isClient: false, initialBytes: head });
}

/**
 * Dial an outbound (relay → opencode / peer relay) WS connection. Performs the
 * HTTP upgrade with a fresh Sec-WebSocket-Key. Resolves with a WsPeer in the
 * CLIENT role (outbound frames masked). Rejects on any handshake failure.
 */
export function dialOutbound(
  targetUrl: string,
  extraHeaders: Record<string, string> = {},
): Promise<WsPeer> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(targetUrl);
    } catch (err: unknown) {
      reject(err);
      return;
    }
    const port = url.port ? Number(url.port) : url.protocol === "wss:" ? 443 : 80;
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({
      hostname: url.hostname,
      port,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        ...extraHeaders,
      },
    });

    const cleanup = () => {
      req.removeAllListeners();
    };

    req.on("upgrade", (res, socket, head) => {
      cleanup();
      // RFC 6455 §4.2.2: verify 101 + Sec-WebSocket-Accept.
      const accept = res.headers["sec-websocket-accept"];
      const expected = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
      if (res.statusCode !== 101 || accept !== expected) {
        socket.destroy();
        reject(new Error(`downstream WS handshake failed: ${res.statusCode}`));
        return;
      }
      resolve(new WsPeer(socket, { isClient: true, initialBytes: head }));
    });

    req.on("error", (err) => {
      cleanup();
      reject(err);
    });

    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error("downstream WS dial timeout"));
    });

    req.end();
  });
}

/**
 * Splice two peers into a bidirectional pipe. Each data frame from one side
 * is forwarded to the other (preserving text/binary opcode). Close frames are
 * propagated with the original code/reason. Either side closing tears both
 * down. Returns a handle with a `close()` to force teardown.
 */
export function pipe(a: WsPeer, b: WsPeer): { close: () => void } {
  let torn = false;

  const teardown = (code: number, reason: string) => {
    if (torn) return;
    torn = true;
    // Propagate the close to the other side, then destroy both.
    try { b.close(code, reason); } catch { /* ignore */ }
    try { a.close(code, reason); } catch { /* ignore */ }
    setTimeout(() => { a.destroy(); b.destroy(); }, 50);
  };

  a.onFrame = (f) => {
    if (f.opcode === OPCODE_TEXT || f.opcode === OPCODE_BINARY || f.opcode === OPCODE_CONT) {
      b.send(f.payload, f.opcode);
    }
  };
  b.onFrame = (f) => {
    if (f.opcode === OPCODE_TEXT || f.opcode === OPCODE_BINARY || f.opcode === OPCODE_CONT) {
      a.send(f.payload, f.opcode);
    }
  };
  a.onClose = (code, reason) => teardown(code, reason);
  b.onClose = (code, reason) => teardown(code, reason);
  a.onError = () => teardown(1011, "peer error");
  b.onError = () => teardown(1011, "peer error");

  return {
    close: () => teardown(1000, "relay closing"),
  };
}
