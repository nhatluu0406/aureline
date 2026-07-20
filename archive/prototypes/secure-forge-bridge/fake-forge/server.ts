import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { WebSocketServer } from "ws";
import { constantTimeEqual, matchesBearer } from "../src/security/credentials.ts";
import { BACKEND_AUTH_HEADER, INTERNAL_ORIGIN } from "../src/proxy/secure-proxy.ts";

type Bootstrap = {
  backendToken: string;
  instanceId: string;
};

const LOOPBACK = "127.0.0.1";
const portIndex = process.argv.indexOf("--port");
const requestedPort = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 0;
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) throw new Error("Invalid --port");

const bootstrap = await new Promise<Bootstrap>((resolve, reject) => {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.once("line", (line) => {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null
        || !("backendToken" in value) || typeof value.backendToken !== "string"
        || !("instanceId" in value) || typeof value.instanceId !== "string") {
        throw new Error("Invalid bootstrap object");
      }
      lines.close();
      resolve({ backendToken: value.backendToken, instanceId: value.instanceId });
    } catch (error: unknown) {
      reject(error);
    }
  });
  lines.once("error", reject);
});

const securityEvents: Array<{ code: string; method: string; path: string }> = [];

function recordSecurity(code: string, request: IncomingMessage): void {
  let path = "/invalid";
  try { path = new URL(request.url ?? "/", "http://127.0.0.1").pathname; } catch { /* sanitized fallback */ }
  const event = { code, method: request.method ?? "UNKNOWN", path };
  securityEvents.push(event);
  if (securityEvents.length > 100) securityEvents.shift();
  process.stdout.write(`${JSON.stringify({ event: "security", ...event })}\n`);
}

function authorize(request: IncomingMessage, expectedAuthority: string): { ok: true } | { ok: false; status: number; code: string } {
  if (!constantTimeEqual(request.headers.host, expectedAuthority)) return { ok: false, status: 421, code: "unexpected_host" };
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== INTERNAL_ORIGIN) return { ok: false, status: 403, code: "unexpected_origin" };
  const value = request.headers[BACKEND_AUTH_HEADER];
  const header = Array.isArray(value) ? value[0] : value;
  if (!matchesBearer(header, bootstrap.backendToken)) return { ok: false, status: 401, code: "unauthorized" };
  return { ok: true };
}

function json(response: ServerResponse, status: number, value: object, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.byteLength, ...headers });
  response.end(body);
}

async function readBody(request: IncomingMessage, limit = 20 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > limit) throw new Error("fixture body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

const webSockets = new WebSocketServer({ noServer: true });
const server = createServer(async (request, response) => {
  const address = server.address();
  if (address === null || typeof address === "string") return json(response, 500, { error: "no_address" });
  const authorization = authorize(request, `${LOOPBACK}:${address.port}`);
  if (!authorization.ok) {
    recordSecurity(authorization.code, request);
    return json(response, authorization.status, { error: authorization.code });
  }

  const url = new URL(request.url ?? "/", `http://${LOOPBACK}:${address.port}`);
  if (request.method === "GET" && url.pathname === "/bridge/identity") {
    return json(response, 200, {
      service: "forge-desktop-bridge",
      protocolVersion: 1,
      instanceId: bootstrap.instanceId,
      enginePid: process.pid,
    });
  }
  if (request.method === "GET" && url.pathname === "/") {
    const html = "<!doctype html><link rel=stylesheet href=/static/style.css><main>Classic Forge fixture</main><script src=/static/app.js></script>";
    response.writeHead(200, { "content-type": "text/html", "content-length": Buffer.byteLength(html) });
    return response.end(html);
  }
  if (request.method === "GET" && url.pathname === "/static/app.js") {
    return response.end("globalThis.fakeForgeLoaded = true;");
  }
  if (request.method === "GET" && url.pathname === "/static/style.css") {
    return response.end("main{font-family:sans-serif}");
  }
  if (request.method === "GET" && url.pathname === "/api/json") return json(response, 200, { ok: true });
  if (request.method === "POST" && url.pathname === "/api/echo") {
    const body = await readBody(request);
    return json(response, 200, { body: JSON.parse(body.toString("utf8")) as unknown });
  }
  if (request.method === "POST" && url.pathname === "/upload") {
    const body = await readBody(request);
    return json(response, 200, {
      bytes: body.byteLength,
      contentType: request.headers["content-type"] ?? null,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
  }
  if (request.method === "GET" && url.pathname === "/download") {
    const body = Buffer.from([0, 1, 2, 3, 254, 255]);
    response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=fixture.bin", "content-length": body.byteLength });
    return response.end(body);
  }
  if (request.method === "GET" && url.pathname === "/stream") {
    response.writeHead(200, { "content-type": "text/plain", "transfer-encoding": "chunked" });
    response.write("one\n");
    setTimeout(() => response.write("two\n"), 20);
    return setTimeout(() => response.end("three\n"), 40);
  }
  if (request.method === "GET" && url.pathname === "/slow-stream") {
    response.writeHead(200, { "content-type": "text/event-stream", "transfer-encoding": "chunked" });
    response.write("data: first\n\n");
    return setTimeout(() => response.end("data: after-idle\n\n"), 350);
  }
  if (request.method === "GET" && url.pathname === "/redirect") {
    response.writeHead(302, { location: `http://${LOOPBACK}:${address.port}/api/json` });
    return response.end();
  }
  if (request.method === "GET" && url.pathname === "/cookie") {
    return json(response, 200, { cookie: true }, { "set-cookie": "forge_session=opaque; Path=/; HttpOnly; SameSite=Strict" });
  }
  if (request.method === "GET" && url.pathname === "/extension/nested/route") return json(response, 200, { extension: true });
  if (request.method === "GET" && url.pathname === "/inspect") {
    return json(response, 200, { host: request.headers.host, origin: request.headers.origin ?? null });
  }
  if (request.method === "GET" && url.pathname === "/debug/argv") return json(response, 200, { argv: process.argv });
  if (request.method === "GET" && url.pathname === "/debug/security-log") return json(response, 200, { events: securityEvents });
  if (request.method === "GET" && url.pathname === "/delay") {
    const milliseconds = Math.min(500, Math.max(0, Number(url.searchParams.get("ms") ?? 50)));
    return setTimeout(() => json(response, 200, { delayed: milliseconds }), milliseconds);
  }
  if (request.method === "GET" && url.pathname === "/large") {
    const total = 2 * 1024 * 1024;
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": total });
    const chunk = Buffer.alloc(64 * 1024, 0x5a);
    for (let sent = 0; sent < total; sent += chunk.byteLength) response.write(chunk);
    return response.end();
  }
  if (request.method === "GET" && url.pathname === "/disconnect") {
    request.socket.destroy();
    return;
  }
  if (request.method === "POST" && url.pathname === "/__fixture/shutdown") {
    json(response, 202, { stopping: true });
    return setImmediate(() => {
      for (const client of webSockets.clients) client.terminate();
      server.close(() => process.exit(0));
      server.closeAllConnections();
    });
  }
  return json(response, 404, { error: "not_found" });
});

server.on("upgrade", (request, socket, head) => {
  const address = server.address();
  if (address === null || typeof address === "string") return socket.destroy();
  const authorization = authorize(request, `${LOOPBACK}:${address.port}`);
  if (!authorization.ok) {
    recordSecurity(`websocket_${authorization.code}`, request);
    socket.end(`HTTP/1.1 ${authorization.status} Unauthorized\r\nConnection: close\r\n\r\n`);
    return;
  }
  const url = new URL(request.url ?? "/", `http://${LOOPBACK}:${address.port}`);
  if (url.pathname !== "/queue/join") return socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  webSockets.handleUpgrade(request, socket, head, (client) => {
    client.on("message", (data, binary) => client.send(data, { binary }));
  });
});

server.on("error", (error) => {
  process.stderr.write(`${JSON.stringify({ event: "server_error", code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN" })}\n`);
  process.exit(1);
});

server.listen({ host: LOOPBACK, port: requestedPort, exclusive: true }, () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing address");
  process.stdout.write(`${JSON.stringify({ event: "listening", host: LOOPBACK, port: address.port, pid: process.pid })}\n`);
});
