import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CleanupOutcome, GracefulTerminator, ProcessTreeController } from "./types.ts";

async function collectCommand(command: string, arguments_: readonly string[]): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, arguments_, { shell: false, windowsHide: true });
    let output = "";
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-4_096);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => resolve({ code: null, output: error.message }));
    child.once("close", (code) => resolve({ code, output }));
  });
}

export class WindowsTaskkillProcessTreeController implements ProcessTreeController {
  public async terminateOwnedTree(pid: number): Promise<CleanupOutcome> {
    const result = await collectCommand("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    return {
      attempted: true,
      succeeded: result.code === 0,
      method: "taskkill-pid-tree",
      ...(result.output.length > 0 ? { diagnostic: result.output.trim() } : {}),
    };
  }
}

export class PosixProcessGroupController implements ProcessTreeController {
  public async terminateOwnedTree(pid: number): Promise<CleanupOutcome> {
    try {
      process.kill(-pid, "SIGKILL");
      return { attempted: true, succeeded: true, method: "posix-process-group-sigkill" };
    } catch (error: unknown) {
      return {
        attempted: true,
        succeeded: false,
        method: "posix-process-group-sigkill",
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function createDefaultProcessTreeController(): ProcessTreeController {
  return process.platform === "win32"
    ? new WindowsTaskkillProcessTreeController()
    : new PosixProcessGroupController();
}

export const defaultGracefulTerminator: GracefulTerminator = async (
  child: ChildProcessWithoutNullStreams,
): Promise<boolean> => {
  if (process.platform === "win32") {
    // Node maps signals to process termination on Windows; it cannot send a reliable
    // CTRL_CLOSE/CTRL_BREAK event to an arbitrary child without native assistance.
    return false;
  }
  return child.kill("SIGTERM");
};
