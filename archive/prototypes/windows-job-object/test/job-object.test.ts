import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { resolve } from "node:path";
import { JobObjectSpikeError, OwnedJobProcess } from "../src/index.ts";
import {
  breakawayRecord,
  cleanupFixturePids,
  createPidFile,
  fixturePath,
  fixturePids,
  helperPath,
  isPidAlive,
  prototypeRoot,
  readPidRecords,
  removeArtifact,
  spawnUnrelated,
  waitForPidsExit,
  waitForRoles,
} from "./test-helpers.ts";

const KILL_ON_JOB_CLOSE = 0x0000_2000;

function launchRequest(pidFile: string, includeBreakaway = false) {
  return {
    helperPath,
    request: {
      executable: process.execPath,
      cwd: prototypeRoot,
      args: [
        fixturePath,
        "--role", "root",
        "--pid-file", pidFile,
        ...(includeBreakaway ? ["--helper-path", helperPath] : []),
      ],
    },
  } as const;
}

test("creates suspended, assigns before resume, and reports KILL_ON_JOB_CLOSE", async () => {
  const pidFile = await createPidFile("creation-flow");
  const owned = await OwnedJobProcess.launch(launchRequest(pidFile));
  let records = [] as Awaited<ReturnType<typeof readPidRecords>>;
  try {
    records = await waitForRoles(pidFile, ["root", "cooperative_child", "noncooperative_child", "grandchild"]);
    assert.equal(owned.ready.createdSuspended, true);
    assert.equal(owned.ready.assignedBeforeResume, true);
    assert.equal(owned.ready.resumed, true);
    assert.equal(owned.ready.rootInJob, true);
    assert.notEqual(owned.ready.limitFlags & KILL_ON_JOB_CLOSE, 0);
    const query = await owned.query();
    assert.equal(query.status, "open");
    assert.notEqual((query.limitFlags ?? 0) & KILL_ON_JOB_CLOSE, 0);
    for (const pid of fixturePids(records)) assert.equal(await owned.isProcessInOwnedJob(pid), true, `PID ${pid} should be in the owned job`);
  } finally {
    await owned.closeOwnership().catch(() => undefined);
    await owned.exitHelper().catch(() => undefined);
    await cleanupFixturePids(await readPidRecords(pidFile));
    await removeArtifact(pidFile);
  }
});

test("normal handle close kills the tree, is repeatable, and leaves unrelated process alive", async () => {
  const pidFile = await createPidFile("normal-close");
  const unrelatedFile = await createPidFile("unrelated");
  const unrelated = spawnUnrelated(unrelatedFile);
  await once(unrelated, "spawn");
  const owned = await OwnedJobProcess.launch(launchRequest(pidFile));
  try {
    const records = await waitForRoles(pidFile, ["root", "cooperative_child", "noncooperative_child", "grandchild"]);
    const unrelatedRecords = await waitForRoles(unrelatedFile, ["unrelated"]);
    const unrelatedPid = fixturePids(unrelatedRecords)[0]!;
    assert.equal((await owned.closeOwnership()).status, "closed");
    assert.equal((await owned.closeOwnership()).status, "already_closed");
    assert.equal(await waitForPidsExit(fixturePids(records)), true);
    assert.equal(isPidAlive(unrelatedPid), true);
  } finally {
    await owned.exitHelper().catch(() => undefined);
    await cleanupFixturePids(await readPidRecords(pidFile));
    await cleanupFixturePids(await readPidRecords(unrelatedFile));
    await removeArtifact(pidFile);
    await removeArtifact(unrelatedFile);
  }
});

test("TerminateJobObject explicitly kills descendants and has deterministic repeated behavior", async () => {
  const pidFile = await createPidFile("terminate");
  const owned = await OwnedJobProcess.launch(launchRequest(pidFile));
  try {
    const records = await waitForRoles(pidFile, ["root", "cooperative_child", "noncooperative_child", "grandchild"]);
    assert.equal((await owned.terminate(221)).status, "terminated");
    assert.equal((await owned.terminate(222)).status, "terminated");
    assert.equal(await waitForPidsExit(fixturePids(records)), true);
  } finally {
    await owned.defensiveDispose();
    await cleanupFixturePids(await readPidRecords(pidFile));
    await removeArtifact(pidFile);
  }
});

test("abrupt helper termination closes the last job handle and kills the tree", async () => {
  const pidFile = await createPidFile("abrupt-owner");
  const owned = await OwnedJobProcess.launch(launchRequest(pidFile));
  try {
    const records = await waitForRoles(pidFile, ["root", "cooperative_child", "noncooperative_child", "grandchild"]);
    await owned.crashOwner();
    assert.equal(await waitForPidsExit(fixturePids(records)), true);
  } finally {
    await cleanupFixturePids(await readPidRecords(pidFile));
    await removeArtifact(pidFile);
  }
});

test("invalid executable and cwd return structured validation diagnostics", async () => {
  const valid = launchRequest(resolve(prototypeRoot, "unused.jsonl"));
  await assert.rejects(
    OwnedJobProcess.launch({ ...valid, request: { ...valid.request, executable: resolve(prototypeRoot, "missing.exe") } }),
    (error: unknown) => error instanceof JobObjectSpikeError && error.stage === "validation",
  );
  await assert.rejects(
    OwnedJobProcess.launch({ ...valid, request: { ...valid.request, cwd: resolve(prototypeRoot, "missing-directory") } }),
    (error: unknown) => error instanceof JobObjectSpikeError && error.stage === "validation",
  );
});

test("assignment and resume failures return Win32 stage diagnostics without running user code", async () => {
  for (const failureStage of ["assign", "resume"] as const) {
    const pidFile = await createPidFile(`failure-${failureStage}`);
    try {
      await assert.rejects(
        OwnedJobProcess.launch({ ...launchRequest(pidFile), failureStage }),
        (error: unknown) => error instanceof JobObjectSpikeError
          && error.stage === failureStage
          && typeof error.win32Error === "number",
      );
      assert.deepEqual(await readPidRecords(pidFile), []);
    } finally {
      await cleanupFixturePids(await readPidRecords(pidFile));
      await removeArtifact(pidFile);
    }
  }
});

test("CREATE_BREAKAWAY_FROM_JOB has no escape effect when the immediate job disallows breakaway", async () => {
  const pidFile = await createPidFile("breakaway");
  const owned = await OwnedJobProcess.launch(launchRequest(pidFile, true));
  try {
    const records = await waitForRoles(pidFile, ["root", "cooperative_child", "noncooperative_child", "grandchild", "breakaway_probe", "breakaway_child"]);
    const result = breakawayRecord(records);
    assert.ok(result !== undefined);
    assert.equal(result.succeeded, true);
    assert.ok(result.pid !== undefined);
    assert.equal(await owned.isProcessInOwnedJob(result.pid), true);
  } finally {
    await owned.closeOwnership().catch(() => undefined);
    await owned.exitHelper().catch(() => undefined);
    const records = await readPidRecords(pidFile);
    await cleanupFixturePids(records);
    await removeArtifact(pidFile);
  }
});

test("helper can report whether its current host environment uses an outer Job Object", async () => {
  const child = spawn(helperPath, ["--self-job-state"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  const event = JSON.parse(output.trim()) as { event: string; inJob: boolean };
  assert.equal(event.event, "self_job_state");
  assert.equal(typeof event.inJob, "boolean");
});
