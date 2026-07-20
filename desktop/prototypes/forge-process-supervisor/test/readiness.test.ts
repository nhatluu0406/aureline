import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForHttpReadiness, ReadinessError } from "../src/readiness.ts";
import { closeServer, occupiedServer } from "./test-helpers.ts";

const readinessConfiguration = {
  path: "/internal/ping",
  expectedStatusCodes: [418],
  requestTimeoutMs: 100,
  initialRetryDelayMs: 10,
  maximumRetryDelayMs: 40,
  backoffFactor: 2,
} as const;

test("HTTP readiness accepts only configured status and reports attempts", async () => {
  const fixture = await occupiedServer();
  try {
    const result = await waitForHttpReadiness({
      port: fixture.port,
      configuration: readinessConfiguration,
      overallTimeoutMs: 500,
      processExitSignal: new AbortController().signal,
    });
    assert.equal(result.lastDiagnostic, "HTTP 418");
    assert.equal(result.attempts, 1);
  } finally {
    await closeServer(fixture.server);
  }
});

test("HTTP readiness aborts when the child exit signal fires", async () => {
  const portFixture = await occupiedServer();
  await closeServer(portFixture.server);
  const exit = new AbortController();
  setTimeout(() => exit.abort(), 30);
  await assert.rejects(
    waitForHttpReadiness({
      port: portFixture.port,
      configuration: readinessConfiguration,
      overallTimeoutMs: 1_000,
      processExitSignal: exit.signal,
    }),
    (error: unknown) => error instanceof ReadinessError && error.kind === "process_exited",
  );
});
