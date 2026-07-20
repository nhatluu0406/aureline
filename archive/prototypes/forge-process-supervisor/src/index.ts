import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ForgeProcessSupervisor } from "./supervisor.ts";

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supervisor = new ForgeProcessSupervisor({
  executable: process.execPath,
  workingDirectory: prototypeRoot,
  arguments: [resolve(prototypeRoot, "test/fixtures/fake-forge-server.mjs"), "--mode", "success"],
  readiness: {
    path: "/internal/ping",
    expectedStatusCodes: [200],
    requestTimeoutMs: 200,
    initialRetryDelayMs: 25,
    maximumRetryDelayMs: 100,
    backoffFactor: 1.5,
  },
  startupTimeoutMs: 2_000,
  shutdownTimeoutMs: 1_500,
  cooperativeShutdown: { path: "/shutdown", method: "POST", waitMs: 500 },
  maximumPortAttempts: 2,
});

supervisor.subscribe((event) => process.stdout.write(`${JSON.stringify(event)}\n`));

try {
  const started = await supervisor.start();
  process.stdout.write(`${JSON.stringify({ event: "ready", ...started })}\n`);
  const stopped = await supervisor.stop();
  process.stdout.write(`${JSON.stringify({ event: "stopped", result: stopped })}\n`);
} catch (error: unknown) {
  process.stderr.write(`${JSON.stringify(error)}\n`);
  await supervisor.stop().catch(() => undefined);
  process.exitCode = 1;
}
