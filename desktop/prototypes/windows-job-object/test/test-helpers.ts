import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const helperPath = resolve(prototypeRoot, "build/job-owner-helper.exe");
export const fixturePath = resolve(prototypeRoot, "test/fixtures/process-tree.mjs");
const artifactsRoot = resolve(prototypeRoot, "test-artifacts");

export type PidRecord = {
  role: string;
  pid?: number;
  parentPid?: number;
  event?: string;
  succeeded?: boolean;
  win32Error?: number;
};

export async function createPidFile(name: string): Promise<string> {
  await mkdir(artifactsRoot, { recursive: true });
  return resolve(artifactsRoot, `${name}-${process.pid}-${Date.now()}.jsonl`);
}

export async function readPidRecords(path: string): Promise<PidRecord[]> {
  try {
    const content = await readFile(path, "utf8");
    return content.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as PidRecord);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function waitForRoles(path: string, roles: readonly string[], timeoutMs = 4_000): Promise<PidRecord[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = await readPidRecords(path);
    if (roles.every((role) => records.some((record) => record.role === role))) return records;
    await delay(25);
  }
  throw new Error(`Timed out waiting for roles: ${roles.join(", ")}`);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForPidsExit(pids: readonly number[], timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isPidAlive(pid))) return true;
    await delay(25);
  }
  return pids.every((pid) => !isPidAlive(pid));
}

export function fixturePids(records: readonly PidRecord[]): number[] {
  return records.flatMap((record) => record.pid === undefined ? [] : [record.pid]);
}

export function spawnUnrelated(pidFile: string): ChildProcess {
  return spawn(process.execPath, [fixturePath, "--role", "unrelated", "--pid-file", pidFile], {
    detached: false,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
}

export async function killExactFixturePid(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) return;
  const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
}

export async function cleanupFixturePids(records: readonly PidRecord[]): Promise<void> {
  for (const pid of fixturePids(records)) await killExactFixturePid(pid);
}

export async function removeArtifact(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function breakawayRecord(records: readonly PidRecord[]): PidRecord | undefined {
  return records.find((record) => record.role === "breakaway_probe");
}
