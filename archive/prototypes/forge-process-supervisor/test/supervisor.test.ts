import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SupervisorError } from "../src/supervisor.ts";
import {
  closeServer,
  configuration,
  findCandidatePort,
  ForgeProcessSupervisor,
  isPidAlive,
  occupiedServer,
  safeStop,
  spawnUnrelatedWorker,
  waitForPidExit,
} from "./test-helpers.ts";

test("starts successfully and reaches HTTP readiness", async () => {
  const supervisor = new ForgeProcessSupervisor(configuration());
  try {
    const result = await supervisor.start();
    assert.equal(result.state, "ready");
    assert.equal(result.retryCount, 0);
    assert.equal(supervisor.state, "ready");
  } finally {
    await safeStop(supervisor);
  }
});

test("waits for delayed readiness", async () => {
  const supervisor = new ForgeProcessSupervisor(configuration(["--mode", "success", "--delay-ms", "180"]));
  try {
    const result = await supervisor.start();
    assert.ok(result.elapsedMs >= 150);
  } finally {
    await safeStop(supervisor);
  }
});

test("classifies readiness timeout and cleans its child", async () => {
  const supervisor = new ForgeProcessSupervisor(configuration(["--mode", "never-ready"], { startupTimeoutMs: 250 }));
  await assert.rejects(
    supervisor.start(),
    (error: unknown) => error instanceof SupervisorError && error.result?.reason === "readiness_timeout",
  );
  assert.equal(supervisor.state, "failed");
  await safeStop(supervisor);
});

test("classifies immediate child crash separately from launch validation", async () => {
  const crashed = new ForgeProcessSupervisor(configuration(["--mode", "crash"]));
  await assert.rejects(
    crashed.start(),
    (error: unknown) => error instanceof SupervisorError
      && error.code === "startup_failed"
      && error.result?.reason === "process_exited"
      && error.result.exitCode === 23,
  );

  const invalid = new ForgeProcessSupervisor(configuration([], { executable: "Z:\\missing\\secret-tool.exe", secretValues: ["secret-tool"] }));
  await assert.rejects(
    invalid.start(),
    (error: unknown) => error instanceof SupervisorError
      && error.code === "validation_error"
      && !JSON.stringify(error).includes("secret-tool"),
  );
});

test("publishes a structured process_exited result when a ready child crashes", async () => {
  const supervisor = new ForgeProcessSupervisor(configuration([
    "--mode", "success",
    "--crash-after-ms", "250",
  ]));
  await supervisor.start();
  const result = await supervisor.waitForTermination();
  assert.equal(result.reason, "process_exited");
  assert.equal(result.exitCode, 42);
  assert.equal(result.state, "failed");
  assert.equal(supervisor.state, "failed");
});

test("retries a collided explicit port and then becomes ready", async () => {
  const collision = await occupiedServer();
  const nextPort = await findCandidatePort();
  const candidates = [collision.port, nextPort];
  const supervisor = new ForgeProcessSupervisor(configuration([], {
    portProvider: async () => {
      const value = candidates.shift();
      if (value === undefined) throw new Error("port provider exhausted");
      return value;
    },
    maximumPortAttempts: 2,
  }));
  try {
    const result = await supervisor.start();
    assert.equal(result.port, nextPort);
    assert.equal(result.retryCount, 1);
  } finally {
    await safeStop(supervisor);
    await closeServer(collision.server);
  }
});

test("port collision retry budget is bounded", async () => {
  const collision = await occupiedServer();
  let calls = 0;
  const supervisor = new ForgeProcessSupervisor(configuration([], {
    portProvider: async () => {
      calls += 1;
      return collision.port;
    },
    maximumPortAttempts: 2,
  }));
  try {
    await assert.rejects(supervisor.start(), SupervisorError);
    assert.equal(calls, 2);
  } finally {
    await safeStop(supervisor);
    await closeServer(collision.server);
  }
});

test("redacts every configured secret before events, diagnostics, errors, and serialization", async () => {
  const secrets = ["fixture-secret-value", "user:api-auth-value", "environment-secret-value"];
  const supervisor = new ForgeProcessSupervisor(configuration([
    "--mode", "success",
    "--fixture-secret", secrets[0]!,
    "--api-auth", secrets[1]!,
    "--echo-env", "FORGE_PROTOTYPE_SECRET",
  ], {
    environment: { FORGE_PROTOTYPE_SECRET: secrets[2] },
    secretEnvironmentKeys: ["FORGE_PROTOTYPE_SECRET"],
    secretValues: [secrets[0]!],
  }));
  const observed: string[] = [];
  supervisor.subscribe((event) => observed.push(event.message));
  await supervisor.start();
  const result = await supervisor.stop();
  const serialized = JSON.stringify({ observed, result });
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, `secret leaked: ${secret}`);
  assert.match(serialized, /\[REDACTED\]/u);
  assert.ok(result.logs.some((event) => event.stream === "stdout"));
  assert.ok(result.logs.some((event) => event.stream === "stderr"));
});

test("requested cooperative shutdown exits without forced cleanup and stop is idempotent", async () => {
  const supervisor = new ForgeProcessSupervisor(configuration());
  await supervisor.start();
  const first = await supervisor.stop();
  const second = await supervisor.stop();
  assert.equal(first.reason, "requested");
  assert.equal(first.cleanup.attempted, false);
  assert.deepEqual(second, first);
  assert.equal(supervisor.state, "stopped");
});

test("forced shutdown cleans an owned child tree and does not kill an unrelated process", async () => {
  const unrelated = spawnUnrelatedWorker();
  await once(unrelated, "spawn");
  assert.ok(unrelated.pid !== undefined);
  const supervisor = new ForgeProcessSupervisor(configuration([
    "--mode", "success",
    "--spawn-child",
    "--ignore-shutdown",
  ], {
    shutdownTimeoutMs: 1_500,
    cooperativeShutdown: { path: "/shutdown", waitMs: 100 },
  }));
  try {
    await supervisor.start();
    const childLine = supervisor.logs.find((event) => event.message.startsWith("CHILD_PID="));
    assert.ok(childLine !== undefined);
    const ownedChildPid = Number(childLine.message.slice("CHILD_PID=".length));
    assert.equal(isPidAlive(ownedChildPid), true);

    const result = await supervisor.stop();
    assert.equal(result.reason, "forced_termination");
    assert.equal(result.cleanup.succeeded, true, JSON.stringify(result.cleanup));
    assert.equal(await waitForPidExit(ownedChildPid), true);
    assert.equal(isPidAlive(unrelated.pid!), true);
  } finally {
    await safeStop(supervisor);
    if (unrelated.pid !== undefined && isPidAlive(unrelated.pid)) unrelated.kill("SIGKILL");
    if (unrelated.exitCode === null) {
      await Promise.race([once(unrelated, "exit").catch(() => undefined), delay(1_000)]);
    }
  }
});

test("rejects start while already ready", async () => {
  const supervisor = new ForgeProcessSupervisor(configuration());
  try {
    await supervisor.start();
    await assert.rejects(
      supervisor.start(),
      (error: unknown) => error instanceof SupervisorError && error.code === "invalid_state",
    );
  } finally {
    await safeStop(supervisor);
  }
});
