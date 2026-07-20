import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const role = argument("--role", "root");
const pidFile = argument("--pid-file");
const helperPath = argument("--helper-path");
const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "process-tree.mjs");

if (pidFile === undefined) throw new Error("--pid-file is required");

function record(value) {
  appendFileSync(pidFile, `${JSON.stringify({ timestamp: new Date().toISOString(), ...value })}\n`, "utf8");
}

function spawnRole(nextRole) {
  const child = spawn(process.execPath, [fixturePath, "--role", nextRole, "--pid-file", pidFile], {
    detached: false,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", (error) => record({ role: `${nextRole}_spawn_error`, message: error.message }));
  return child;
}

record({ role, pid: process.pid, parentPid: process.ppid });

if (role === "root") {
  spawnRole("cooperative_child");
  spawnRole("noncooperative_child");
  if (helperPath !== undefined) {
    record({ role: "breakaway_probe_started", helperPathPresent: true });
    const probe = spawn(helperPath, [
      "--breakaway-probe",
      process.execPath,
      fixturePath,
      "--role", "breakaway_child",
      "--pid-file", pidFile,
    ], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let recorded = false;
    const recordOutput = () => {
      if (recorded) return;
      const line = output.trim().split(/\r?\n/u).find(Boolean);
      if (line === undefined) return;
      try {
        record({ role: "breakaway_probe", ...JSON.parse(line) });
        recorded = true;
      } catch (error) {
        record({ role: "breakaway_probe_parse_error", message: String(error), output });
        recorded = true;
      }
    };
    probe.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      recordOutput();
    });
    probe.once("error", (error) => record({ role: "breakaway_probe_spawn_error", message: error.message }));
    probe.once("close", () => {
      recordOutput();
      if (!recorded) record({ role: "breakaway_probe_empty", output });
    });
  }
} else if (role === "noncooperative_child") {
  spawnRole("grandchild");
}

process.on("SIGTERM", () => {
  if (role === "cooperative_child") process.exit(0);
});

setInterval(() => {}, 1_000);
