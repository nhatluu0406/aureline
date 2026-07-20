import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "build/job-owner-helper.exe");
await mkdir(dirname(output), { recursive: true });

const child = spawn("rustc", [
  "--edition", "2021",
  "-C", "opt-level=1",
  "-C", "debuginfo=0",
  "-C", "target-feature=+crt-static",
  "-o", output,
  resolve(root, "helper/job_owner_helper.rs"),
], { cwd: root, shell: false, stdio: "inherit", windowsHide: true });

child.once("error", (error) => {
  process.stderr.write(`Không thể chạy rustc: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  if (code !== 0) process.exitCode = code ?? 1;
});
