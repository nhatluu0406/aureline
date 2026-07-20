import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { findCandidatePort } from "../src/port-allocation.ts";
import { ForgeProcessSupervisor } from "../src/supervisor.ts";
import type { SupervisorConfiguration } from "../src/types.ts";

export const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const fakeServerPath = resolve(prototypeRoot, "test/fixtures/fake-forge-server.mjs");
export const fakeWorkerPath = resolve(prototypeRoot, "test/fixtures/fake-child-worker.mjs");

export function configuration(
  fixtureArguments: readonly string[] = ["--mode", "success"],
  overrides: Partial<SupervisorConfiguration> = {},
): SupervisorConfiguration {
  return {
    executable: process.execPath,
    workingDirectory: prototypeRoot,
    arguments: [fakeServerPath, ...fixtureArguments],
    readiness: {
      path: "/internal/ping",
      expectedStatusCodes: [200],
      requestTimeoutMs: 100,
      initialRetryDelayMs: 20,
      maximumRetryDelayMs: 50,
      backoffFactor: 1.4,
    },
    startupTimeoutMs: 1_200,
    shutdownTimeoutMs: 1_200,
    cooperativeShutdown: { path: "/shutdown", waitMs: 300 },
    maximumPortAttempts: 2,
    logHistoryLimit: 100,
    ...overrides,
  };
}

export async function occupiedServer(port = 0): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(418);
    response.end();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test server address");
  return { server, port: address.port };
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

export function spawnUnrelatedWorker(): ChildProcess {
  return spawn(process.execPath, [fakeWorkerPath], {
    detached: false,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForPidExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await delay(25);
  }
  return !isPidAlive(pid);
}

export async function safeStop(supervisor: ForgeProcessSupervisor): Promise<void> {
  await supervisor.stop().catch(() => undefined);
}

export { findCandidatePort, ForgeProcessSupervisor };
