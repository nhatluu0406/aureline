import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Transform, type Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { bearerValue, matchesBearer } from "../security/credentials.ts";
import { pathWithoutSensitiveQuery, validateBrowserRequest } from "../security/policy.ts";
import type { ProxyAddress, SecurityLogEvent } from "../types.ts";

const LOOPBACK = "127.0.0.1" as const;
const EDGE_AUTH_HEADER = "x-forge-desktop-authorization";
const BACKEND_AUTH_HEADER = "x-forge-bridge-authorization";
const INTERNAL_ORIGIN = "http://forge-desktop.internal";
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

export type SecureProxyOptions = {
  upstreamOrigin: string;
  edgeToken: string;
  backendToken: string;
  maximumRequestBytes?: number;
  requestTimeoutMs?: number;
  logHistoryLimit?: number;
};

function sendJson(response: ServerResponse, status: number, body: object): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": encoded.byteLength,
    "cache-control": "no-store",
  });
  response.end(encoded);
}

function sanitizedRequestHeaders(request: IncomingMessage, upstream: URL, proxyAuthority: string): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name === EDGE_AUTH_HEADER || name === "host"
      || name === "forwarded" || name.startsWith("x-forwarded-")) continue;
    headers[name] = value;
  }
  headers.host = upstream.host;
  headers["x-forwarded-host"] = proxyAuthority;
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-for"] = LOOPBACK;
  headers[BACKEND_AUTH_HEADER] = request.headers[BACKEND_AUTH_HEADER] ?? "";
  return headers;
}

function sanitizedResponseHeaders(headers: IncomingMessage["headers"], upstreamOrigin: string, proxyOrigin: string): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    if (name === "location") {
      const location = Array.isArray(value) ? value[0] : value;
      output.location = location?.startsWith(upstreamOrigin) ? proxyOrigin + location.slice(upstreamOrigin.length) : location;
      continue;
    }
    if (name === "set-cookie") {
      const cookies = Array.isArray(value) ? value : [value];
      output["set-cookie"] = cookies.map((cookie) => cookie.replace(/;\s*Domain=[^;]+/giu, ""));
      continue;
    }
    output[name] = value;
  }
  return output;
}

export class SecureForgeProxy {
  readonly #server = createServer((request, response) => this.handleHttp(request, response));
  readonly #webSocketServer = new WebSocketServer({ noServer: true });
  readonly #sockets = new Set<Socket>();
  readonly #webSockets = new Set<WebSocket>();
  readonly #logs: SecurityLogEvent[] = [];
  readonly #upstream: URL;
  #address: ProxyAddress | null = null;

  private constructor(private readonly options: SecureProxyOptions) {
    this.#upstream = new URL(options.upstreamOrigin);
    if (this.#upstream.protocol !== "http:" || this.#upstream.hostname !== LOOPBACK) {
      throw new Error("Proxy upstream must be explicit http://127.0.0.1");
    }
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
    this.#server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
  }

  public static async start(options: SecureProxyOptions): Promise<SecureForgeProxy> {
    const proxy = new SecureForgeProxy(options);
    await new Promise<void>((resolve, reject) => {
      proxy.#server.once("error", reject);
      proxy.#server.listen({ host: LOOPBACK, port: 0, exclusive: true }, resolve);
    });
    const address = proxy.#server.address();
    if (address === null || typeof address === "string") throw new Error("Proxy address is unavailable");
    proxy.#address = { host: LOOPBACK, port: address.port, origin: `http://${LOOPBACK}:${address.port}` };
    proxy.record("info", "proxy_started");
    return proxy;
  }

  public get address(): ProxyAddress {
    if (this.#address === null) throw new Error("Proxy is not listening");
    return this.#address;
  }

  public get logs(): readonly SecurityLogEvent[] {
    return this.#logs.map((event) => ({ ...event }));
  }

  public async close(): Promise<void> {
    for (const webSocket of this.#webSockets) webSocket.terminate();
    this.#webSockets.clear();
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      if (!this.#server.listening) {
        resolve();
        return;
      }
      this.#server.close((error) => error === undefined ? resolve() : reject(error));
    });
    this.record("info", "proxy_stopped");
  }

  private authorize(request: IncomingMessage): { ok: true } | { ok: false; status: number; code: string } {
    const policy = validateBrowserRequest(request.headers, `${LOOPBACK}:${this.address.port}`, this.address.origin);
    if (!policy.allowed) return { ok: false, status: policy.status, code: policy.code };
    const value = request.headers[EDGE_AUTH_HEADER];
    const header = Array.isArray(value) ? value[0] : value;
    if (!matchesBearer(header, this.options.edgeToken)) return { ok: false, status: 401, code: "unauthorized" };
    return { ok: true };
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const authorization = this.authorize(request);
    const path = pathWithoutSensitiveQuery(request.url);
    if (!authorization.ok) {
      this.record("warn", authorization.code, request.method, path);
      sendJson(response, authorization.status, { error: authorization.code });
      return;
    }
    const contentLength = Number(request.headers["content-length"] ?? 0);
    const maximum = this.options.maximumRequestBytes ?? 16 * 1024 * 1024;
    if (Number.isFinite(contentLength) && contentLength > maximum) {
      this.record("warn", "request_too_large", request.method, path);
      sendJson(response, 413, { error: "request_too_large" });
      return;
    }

    const headers = sanitizedRequestHeaders(request, this.#upstream, `${LOOPBACK}:${this.address.port}`);
    headers[BACKEND_AUTH_HEADER] = bearerValue(this.options.backendToken);
    if (request.headers.origin !== undefined) headers.origin = INTERNAL_ORIGIN;
    const upstreamRequest = httpRequest({
      protocol: this.#upstream.protocol,
      hostname: this.#upstream.hostname,
      port: this.#upstream.port,
      method: request.method,
      path: request.url,
      headers,
      timeout: this.options.requestTimeoutMs ?? 5_000,
    }, (upstreamResponse) => {
      // requestTimeoutMs bounds connection/header readiness. Long-lived SSE or
      // downloads own their lifecycle after headers and must not inherit it.
      upstreamRequest.setTimeout(0);
      upstreamResponse.socket.setTimeout(0);
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        sanitizedResponseHeaders(upstreamResponse.headers, this.#upstream.origin, this.address.origin),
      );
      upstreamResponse.pipe(response);
    });

    let received = 0;
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.byteLength;
        callback(received <= maximum ? null : new Error("request_too_large"), chunk);
      },
    });
    limiter.once("error", (error) => {
      upstreamRequest.destroy(error);
      sendJson(response, 413, { error: "request_too_large" });
    });
    upstreamRequest.once("timeout", () => upstreamRequest.destroy(new Error("upstream_timeout")));
    upstreamRequest.once("error", (error) => {
      const code = error.message === "upstream_timeout" ? "upstream_timeout" : "upstream_unavailable";
      this.record("error", code, request.method, path);
      sendJson(response, code === "upstream_timeout" ? 504 : 502, { error: code });
    });
    request.once("aborted", () => upstreamRequest.destroy(new Error("client_aborted")));
    request.pipe(limiter).pipe(upstreamRequest);
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const authorization = this.authorize(request);
    const path = pathWithoutSensitiveQuery(request.url);
    if (!authorization.ok) {
      this.record("warn", `websocket_${authorization.code}`, "GET", path);
      socket.end(`HTTP/1.1 ${authorization.status} Unauthorized\r\nConnection: close\r\n\r\n`);
      return;
    }
    this.#webSocketServer.handleUpgrade(request, socket, head, (client) => {
      this.#webSockets.add(client);
      client.once("close", () => this.#webSockets.delete(client));
      const requestedProtocols = request.headers["sec-websocket-protocol"]
        ?.split(",").map((value) => value.trim()).filter(Boolean);
      const upstream = new WebSocket(
        `ws://${this.#upstream.host}${request.url ?? "/"}`,
        requestedProtocols,
        { headers: { [BACKEND_AUTH_HEADER]: bearerValue(this.options.backendToken), Origin: INTERNAL_ORIGIN } },
      );
      this.#webSockets.add(upstream);
      const pending: Array<{ data: RawData; binary: boolean }> = [];
      let pendingBytes = 0;
      client.on("message", (data, binary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        else if (upstream.readyState === WebSocket.CONNECTING) {
          const size = Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength;
          if (pending.length >= 64 || pendingBytes + size > 1024 * 1024) {
            client.close(1009, "upstream handshake queue limit");
            upstream.close();
            return;
          }
          pendingBytes += size;
          pending.push({ data, binary });
        }
      });
      upstream.once("open", () => {
        for (const message of pending.splice(0)) upstream.send(message.data, { binary: message.binary });
        pendingBytes = 0;
        upstream.on("message", (data, binary) => client.send(data, { binary }));
      });
      const closePair = (): void => {
        if (client.readyState === WebSocket.OPEN) client.close();
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
      };
      client.once("close", closePair);
      upstream.once("close", closePair);
      upstream.once("error", () => {
        this.record("error", "websocket_upstream_error", "GET", path);
        if (client.readyState === WebSocket.OPEN) client.close(1011, "upstream unavailable");
      });
      upstream.once("close", () => this.#webSockets.delete(upstream));
    });
  }

  private record(level: SecurityLogEvent["level"], code: string, method?: string, path?: string): void {
    this.#logs.push({
      timestamp: new Date().toISOString(),
      component: "proxy",
      level,
      code,
      ...(method === undefined ? {} : { method }),
      ...(path === undefined ? {} : { path }),
    });
    const limit = this.options.logHistoryLimit ?? 200;
    if (this.#logs.length > limit) this.#logs.splice(0, this.#logs.length - limit);
  }
}

export const classicRequestHeaders = (edgeToken: string, origin?: string): Record<string, string> => ({
  [EDGE_AUTH_HEADER]: bearerValue(edgeToken),
  ...(origin === undefined ? {} : { Origin: origin, "Sec-Fetch-Site": "same-origin" }),
});

export { BACKEND_AUTH_HEADER, EDGE_AUTH_HEADER, INTERNAL_ORIGIN };
