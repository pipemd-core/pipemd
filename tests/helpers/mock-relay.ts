import http from "node:http";

export interface MockRelayConfig {
  token?: string;
  port?: number;
}

export class MockRelay {
  private server: http.Server | null = null;
  private handlers: Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void> = new Map();
  public port: number = 0;
  public requests: Array<{ method: string; url: string; body?: unknown }> = [];

  constructor(private config: MockRelayConfig = {}) {}

  on(method: string, path: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): void {
    this.handlers.set(`${method}:${path}`, handler);
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const urlPath = req.url?.split("?")[0] || "/";
        this.requests.push({ method: req.method || "GET", url: urlPath });

        const key = `${req.method}:${urlPath}`;
        const handler = this.handlers.get(key);
        if (handler) {
          handler(req, res);
          return;
        }

        if (req.method === "GET" && urlPath === "/health") {
          this.json(res, 200, { ok: true, hostname: "mock-relay" });
          return;
        }

        this.json(res, 404, { error: "not found" });
      });

      this.server.listen(this.config.port || 0, "127.0.0.1", () => {
        const addr = this.server!.address();
        this.port = typeof addr === "object" && addr ? addr.port : this.config.port || 0;
        resolve(this.port);
      });

      this.server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
    });
  }

  json(res: http.ServerResponse, code: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  reset(): void {
    this.requests = [];
  }
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
