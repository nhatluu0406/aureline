import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { encodeLaunchRequest } from "./protocol.ts";
import type {
  CheckedEvent,
  ClosedEvent,
  ErrorEvent,
  HelperEvent,
  LaunchOptions,
  QueryEvent,
  ReadyEvent,
  TerminatedEvent,
} from "./types.ts";

type EventWaiter = {
  predicate: (event: HelperEvent) => boolean;
  resolve: (event: HelperEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class JobObjectSpikeError extends Error {
  public constructor(
    public readonly stage: string,
    message: string,
    public readonly win32Error?: number,
  ) {
    super(message);
    this.name = "JobObjectSpikeError";
  }

  public toJSON(): object {
    return {
      name: this.name,
      stage: this.stage,
      message: this.message,
      ...(this.win32Error === undefined ? {} : { win32Error: this.win32Error }),
    };
  }
}

function isHelperEvent(value: unknown): value is HelperEvent {
  return typeof value === "object" && value !== null && "event" in value && typeof value.event === "string";
}

async function validateFile(path: string, label: string): Promise<void> {
  try {
    const value = await stat(path);
    if (!value.isFile()) throw new Error("not a file");
    await access(path, constants.X_OK);
  } catch (error: unknown) {
    throw new JobObjectSpikeError("validation", `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function validateDirectory(path: string): Promise<void> {
  try {
    const value = await stat(path);
    if (!value.isDirectory()) throw new Error("not a directory");
  } catch (error: unknown) {
    throw new JobObjectSpikeError("validation", `cwd is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class OwnedJobProcess {
  readonly #events: HelperEvent[] = [];
  readonly #waiters = new Set<EventWaiter>();
  readonly #exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #stdoutRemainder = "";
  #stderrTail = "";
  #ready: ReadyEvent | null = null;

  private constructor(
    private readonly helper: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
  ) {
    this.#exitPromise = new Promise((resolve) => {
      helper.once("exit", (code, signal) => resolve({ code, signal: signal as NodeJS.Signals | null }));
    });
  }

  public static async launch(options: LaunchOptions): Promise<OwnedJobProcess> {
    if (process.platform !== "win32") throw new JobObjectSpikeError("platform", "Windows is required");
    await validateFile(options.helperPath, "helperPath");
    await validateFile(options.request.executable, "executable");
    await validateDirectory(options.request.cwd);

    const helper = spawn(options.helperPath, [], {
      cwd: options.request.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await Promise.race([
      once(helper, "spawn"),
      once(helper, "error").then(([error]) => { throw error; }),
    ]);

    const instance = new OwnedJobProcess(helper, options.timeoutMs ?? 3_000);
    instance.attachStreams();
    helper.stdin.write(encodeLaunchRequest(options.request, options.failureStage));
    let first: HelperEvent;
    try {
      first = await instance.waitForEvent((event) => event.event === "ready" || event.event === "error");
    } catch (error: unknown) {
      helper.stdin.end();
      if (helper.exitCode === null && helper.signalCode === null) helper.kill();
      await instance.#exitPromise;
      throw error;
    }
    if (first.event === "error") {
      helper.stdin.end();
      await instance.#exitPromise;
      throw instance.errorFromEvent(first);
    }
    if (first.event !== "ready") {
      helper.stdin.end();
      await instance.#exitPromise;
      throw new JobObjectSpikeError("protocol", `Unexpected launch event: ${first.event}`);
    }
    instance.#ready = first;
    return instance;
  }

  public get ready(): ReadyEvent {
    if (this.#ready === null) throw new JobObjectSpikeError("invalid_state", "Owned process is not ready");
    return this.#ready;
  }

  public get ownerPid(): number {
    return this.ready.ownerPid;
  }

  public get pid(): number {
    return this.ready.pid;
  }

  public async query(): Promise<QueryEvent> {
    return await this.command("QUERY", "query");
  }

  public async isProcessInOwnedJob(pid: number): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 0) throw new RangeError("pid must be a positive integer");
    const event = await this.command(`CHECK ${pid}`, "checked") as CheckedEvent;
    return event.inJob;
  }

  public async closeOwnership(): Promise<ClosedEvent> {
    return await this.command("CLOSE", "closed");
  }

  public async terminate(exitCode = 220): Promise<TerminatedEvent> {
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 0xffff_ffff) {
      throw new RangeError("exitCode must be a uint32");
    }
    return await this.command(`TERMINATE ${exitCode}`, "terminated");
  }

  public async exitHelper(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.helper.exitCode === null && this.helper.signalCode === null) {
      this.helper.stdin.write("EXIT\n");
      this.helper.stdin.end();
    }
    return await this.#exitPromise;
  }

  public async crashOwner(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.helper.exitCode === null && this.helper.signalCode === null) this.helper.kill();
    return await this.#exitPromise;
  }

  public async defensiveDispose(): Promise<void> {
    if (this.helper.exitCode !== null || this.helper.signalCode !== null) return;
    try {
      await this.terminate(229);
    } catch {
      this.helper.kill();
    }
    this.helper.stdin.end();
    await Promise.race([this.#exitPromise, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    if (this.helper.exitCode === null && this.helper.signalCode === null) this.helper.kill();
  }

  private attachStreams(): void {
    this.helper.stdout.on("data", (chunk: Buffer) => {
      const lines = (this.#stdoutRemainder + chunk.toString("utf8")).split(/\r?\n/u);
      this.#stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isHelperEvent(parsed)) throw new Error("missing event discriminator");
          this.publish(parsed);
        } catch (error: unknown) {
          this.rejectAll(new JobObjectSpikeError("protocol", `Invalid helper event: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    });
    this.helper.stderr.on("data", (chunk: Buffer) => {
      this.#stderrTail = (this.#stderrTail + chunk.toString("utf8")).slice(-4_096);
    });
    this.helper.once("exit", (code) => {
      this.rejectAll(new JobObjectSpikeError("helper_exit", `Helper exited with code ${String(code)}${this.#stderrTail.length === 0 ? "" : `: ${this.#stderrTail}`}`));
    });
  }

  private async command<T extends HelperEvent["event"]>(command: string, expected: T): Promise<Extract<HelperEvent, { event: T }>> {
    if (this.helper.exitCode !== null || this.helper.signalCode !== null) {
      throw new JobObjectSpikeError("helper_exit", "Helper is no longer running");
    }
    const pending = this.waitForEvent((event) => event.event === expected || event.event === "error");
    this.helper.stdin.write(`${command}\n`);
    const event = await pending;
    if (event.event === "error") throw this.errorFromEvent(event);
    return event as Extract<HelperEvent, { event: T }>;
  }

  private async waitForEvent(predicate: (event: HelperEvent) => boolean): Promise<HelperEvent> {
    const existingIndex = this.#events.findIndex(predicate);
    if (existingIndex >= 0) return this.#events.splice(existingIndex, 1)[0]!;
    return await new Promise<HelperEvent>((resolve, reject) => {
      const waiter: EventWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new JobObjectSpikeError("timeout", `Helper response timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  private publish(event: HelperEvent): void {
    for (const waiter of this.#waiters) {
      if (!waiter.predicate(event)) continue;
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve(event);
      return;
    }
    this.#events.push(event);
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }

  private errorFromEvent(event: ErrorEvent): JobObjectSpikeError {
    return new JobObjectSpikeError(event.stage, event.message, event.win32Error);
  }
}
