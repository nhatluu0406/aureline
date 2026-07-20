import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OwnedJobProcess } from "./index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDirectory = resolve(root, "test-artifacts");
const pidFile = resolve(artifactDirectory, `demo-${process.pid}.jsonl`);
await mkdir(artifactDirectory, { recursive: true });

const owned = await OwnedJobProcess.launch({
  helperPath: resolve(root, "build/job-owner-helper.exe"),
  request: {
    executable: process.execPath,
    cwd: root,
    args: [resolve(root, "test/fixtures/process-tree.mjs"), "--role", "root", "--pid-file", pidFile],
  },
});

try {
  process.stdout.write(`${JSON.stringify({ phase: "ready", ...owned.ready })}\n`);
  process.stdout.write(`${JSON.stringify({ phase: "query", result: await owned.query() })}\n`);
  process.stdout.write(`${JSON.stringify({ phase: "close", result: await owned.closeOwnership() })}\n`);
} finally {
  await owned.exitHelper();
  await rm(pidFile, { force: true });
}
