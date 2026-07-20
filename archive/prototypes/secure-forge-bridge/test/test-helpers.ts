import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { bearerValue } from "../src/security/credentials.ts";
import { BACKEND_AUTH_HEADER } from "../src/proxy/secure-proxy.ts";
import type { LaunchCredentials } from "../src/types.ts";

export const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fakeServerPath = resolve(prototypeRoot, "fake-forge/server.ts");

type ListeningEvent = { event: "listening"; host: string; port: number; pid: number };

export class FakeForgeProcess {
  readonly stdoutLines: string[] = [];
  readonly stderrLines: string[] = [];
  readonly origin: string;
  readonly pid: number;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    listening: ListeningEvent,
    private readonly credentials: LaunchCredentials,
  ) {
    this.origin = `http://127.0.0.1:${listening.port}`;
    this.pid = listening.pid;
  }

  public static async start(credentials: LaunchCredentials): Promise<FakeForgeProcess> {
    const child = spawn(process.execPath, ["--experimental-transform-types", fakeServerPath, "--port", "0"], {
      cwd: prototypeRoot,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    let remainder = "";
    const listeningPromise = new Promise<ListeningEvent>((resolveListening, reject) => {
      const timer = setTimeout(() => reject(new Error("Fake Forge startup timed out")), 3_000);
      child.stdout.on("data", (chunk: Buffer) => {
        const lines = (remainder + chunk.toString("utf8")).split(/\r?\n/u);
        remainder = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          stdoutLines.push(line);
          const event = JSON.parse(line) as { event?: string };
          if (event.event === "listening") {
            clearTimeout(timer);
            resolveListening(event as ListeningEvent);
          }
        }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Fake Forge exited during startup: ${String(code)}`)); });
    });
    child.stderr.on("data", (chunk: Buffer) => stderrLines.push(chunk.toString("utf8")));
    await once(child, "spawn");
    child.stdin.end(`${JSON.stringify({ backendToken: credentials.backendToken, instanceId: credentials.instanceId })}\n`);
    const instance = new FakeForgeProcess(child, await listeningPromise, credentials);
    instance.stdoutLines.push(...stdoutLines);
    instance.stderrLines.push(...stderrLines);
    child.stdout.on("data", () => {
      for (const line of stdoutLines.slice(instance.stdoutLines.length)) instance.stdoutLines.push(line);
    });
    child.stderr.on("data", () => {
      for (const line of stderrLines.slice(instance.stderrLines.length)) instance.stderrLines.push(line);
    });
    return instance;
  }

  public get spawnArguments(): readonly string[] {
    return this.child.spawnargs;
  }

  public async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      await fetch(`${this.origin}/__fixture/shutdown`, {
        method: "POST",
        headers: { [BACKEND_AUTH_HEADER]: bearerValue(this.credentials.backendToken) },
      });
    } catch { /* exact child fallback below */ }
    await Promise.race([once(this.child, "exit"), delay(1_000)]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
      await Promise.race([once(this.child, "exit"), delay(1_000)]);
    }
  }
}

export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function startImpostor(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ service: "not-forge", protocolVersion: 1, instanceId: "wrong", enginePid: 0 }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Impostor address missing");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}

