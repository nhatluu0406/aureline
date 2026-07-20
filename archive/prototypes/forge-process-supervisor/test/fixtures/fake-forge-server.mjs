import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const mode = argument("--mode", "success");
const port = Number(argument("--port"));
const delayMs = Number(argument("--delay-ms", "0"));
const crashAfterMs = Number(argument("--crash-after-ms", "0"));
const secret = argument("--fixture-secret");
const echoEnvironment = argument("--echo-env");
const spawnChild = process.argv.includes("--spawn-child");
const ignoreShutdown = process.argv.includes("--ignore-shutdown");
let worker = null;

if (secret !== undefined) {
  process.stdout.write("stdout-token-part:");
  setTimeout(() => process.stdout.write(`${secret}\n`), 5);
  process.stderr.write(`Authorization: Bearer ${secret}\n`);
}
if (echoEnvironment !== undefined) {
  process.stderr.write(`environment-value=${process.env[echoEnvironment] ?? "missing"}\n`);
}

if (mode === "crash") {
  process.stderr.write("fixture immediate crash\n");
  process.exit(23);
}

if (spawnChild) {
  const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), "fake-child-worker.mjs");
  worker = spawn(process.execPath, [workerPath], {
    detached: false,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  process.stdout.write(`CHILD_PID=${worker.pid}\n`);
}

const startedAt = Date.now();
const server = createServer((request, response) => {
  if (request.url === "/internal/ping") {
    const ready = mode !== "never-ready" && Date.now() - startedAt >= delayMs;
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ready }));
    return;
  }
  if (request.url === "/shutdown") {
    response.writeHead(202);
    response.end();
    if (!ignoreShutdown) {
      worker?.kill();
      server.close();
      server.closeAllConnections();
      setTimeout(() => process.exit(0), 10);
    }
    return;
  }
  response.writeHead(404);
  response.end();
});

server.on("error", (error) => {
  process.stderr.write(`${error.code ?? "SERVER_ERROR"}: ${error.message}\n`);
  process.exit(error.code === "EADDRINUSE" ? 98 : 1);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`fake Forge listening on 127.0.0.1:${port}\n`);
  if (crashAfterMs > 0) setTimeout(() => process.exit(42), crashAfterMs);
});

process.on("SIGTERM", () => {
  if (!ignoreShutdown) {
    worker?.kill();
    server.close();
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 10);
  }
});
