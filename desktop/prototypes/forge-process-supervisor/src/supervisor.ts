import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { SecretRedactor, StructuredLogBuffer, secretsFromArguments } from "./log-redaction.ts";
import { findCandidatePort, isPortCollisionDiagnostic, LOOPBACK_HOST } from "./port-allocation.ts";
import { defaultGracefulTerminator, createDefaultProcessTreeController } from "./process-tree.ts";
import { ReadinessError, waitForHttpReadiness } from "./readiness.ts";
import type {
  CleanupOutcome,
  ExitInfo,
  ProcessLogEvent,
  StartResult,
  SupervisorConfiguration,
  SupervisorResult,
  SupervisorState,
  SupervisorStopReason,
} from "./types.ts";

const NO_CLEANUP: CleanupOutcome = { attempted: false, succeeded: true, method: "not-required" };

const TRANSITIONS: Readonly<Record<SupervisorState, readonly SupervisorState[]>> = {
  idle: ["starting", "stopped"],
  starting: ["waiting_for_readiness", "stopping", "failed"],
  waiting_for_readiness: ["ready", "stopping", "failed"],
  ready: ["stopping", "failed"],
  stopping: ["starting", "stopped", "failed"],
  stopped: ["starting"],
  failed: ["starting"],
};

type SupervisorErrorCode =
  | "invalid_state"
  | "validation_error"
  | "launch_error"
  | "startup_failed"
  | "readiness_timeout";

export class SupervisorError extends Error {
  public constructor(
    public readonly code: SupervisorErrorCode,
    message: string,
    public readonly result?: SupervisorResult,
  ) {
    super(message);
    this.name = "SupervisorError";
  }

  public toJSON(): object {
    return { name: this.name, code: this.code, message: this.message, result: this.result };
  }
}

type Attempt = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  exitController: AbortController;
  exitPromise: Promise<ExitInfo>;
  pid: number;
};

function makeExitPromise(
  child: ChildProcessWithoutNullStreams,
  controller: AbortController,
  onExit: (info: ExitInfo) => void,
): Promise<ExitInfo> {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => {
      const info: ExitInfo = { code, signal: signal as NodeJS.Signals | null };
      controller.abort();
      onExit(info);
      resolve(info);
    });
  });
}

async function waitBounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) return null;
  const marker = Symbol("timeout");
  const value = await Promise.race([promise, delay(timeoutMs, marker)]);
  return value === marker ? null : value;
}

export class ForgeProcessSupervisor {
  #state: SupervisorState = "idle";
  #attempt: Attempt | null = null;
  #startedAt = 0;
  #retryCount = 0;
  #lastPort: number | null = null;
  #lastExitInfo: ExitInfo | null = null;
  #intentionalShutdown = false;
  #stopPromise: Promise<SupervisorResult> | null = null;
  #lastResult: SupervisorResult | null = null;
  readonly #terminationSubscribers = new Set<(result: SupervisorResult) => void>();
  readonly #redactor: SecretRedactor;
  readonly #logs: StructuredLogBuffer;

  public constructor(private readonly configuration: SupervisorConfiguration) {
    const environmentSecrets = (configuration.secretEnvironmentKeys ?? [])
      .map((key) => configuration.environment?.[key])
      .filter((value): value is string => value !== undefined);
    this.#redactor = new SecretRedactor([
      ...(configuration.secretValues ?? []),
      ...environmentSecrets,
      ...secretsFromArguments(configuration.arguments),
    ]);
    this.#logs = new StructuredLogBuffer(configuration.logHistoryLimit ?? 200, this.#redactor);
  }

  public get state(): SupervisorState {
    return this.#state;
  }

  public get logs(): readonly ProcessLogEvent[] {
    return this.#logs.snapshot();
  }

  public subscribe(subscriber: (event: ProcessLogEvent) => void): () => void {
    return this.#logs.subscribe(subscriber);
  }

  public async waitForTermination(): Promise<SupervisorResult> {
    if (this.#lastResult !== null) return this.#lastResult;
    return await new Promise<SupervisorResult>((resolve) => this.#terminationSubscribers.add(resolve));
  }

  public async start(): Promise<StartResult> {
    if (!["idle", "stopped", "failed"].includes(this.#state)) {
      throw new SupervisorError("invalid_state", `Cannot start supervisor from state ${this.#state}`);
    }
    await this.validateConfiguration();
    this.#startedAt = Date.now();
    this.#retryCount = 0;
    this.#lastPort = null;
    this.#lastExitInfo = null;
    this.#intentionalShutdown = false;
    this.#lastResult = null;
    this.transition("starting");

    const maximumAttempts = this.configuration.maximumPortAttempts ?? 3;
    if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1) {
      return await this.failStart("validation_error", "maximumPortAttempts must be at least 1", "startup_failed");
    }

    for (let attemptNumber = 1; attemptNumber <= maximumAttempts; attemptNumber += 1) {
      const port = await (this.configuration.portProvider ?? findCandidatePort)();
      this.#lastPort = port;
      try {
        this.#attempt = await this.launchAttempt(port);
      } catch (error: unknown) {
        const diagnostic = this.safeError(error);
        return await this.failStart("launch_error", `Could not launch child: ${diagnostic}`, "startup_failed");
      }

      this.transition("waiting_for_readiness");
      try {
        await waitForHttpReadiness({
          port,
          configuration: this.configuration.readiness,
          overallTimeoutMs: this.configuration.startupTimeoutMs,
          processExitSignal: this.#attempt.exitController.signal,
        });
        this.transition("ready");
        this.#logs.supervisor("info", `Forge-compatible child is ready on ${LOOPBACK_HOST}:${port}`);
        return { state: "ready", port, retryCount: this.#retryCount, elapsedMs: Date.now() - this.#startedAt };
      } catch (error: unknown) {
        const readinessError = error instanceof ReadinessError ? error : null;
        const diagnostic = this.safeError(error);
        const collision = isPortCollisionDiagnostic(
          `${diagnostic}\n${this.#logs.snapshot().map((event) => event.message).join("\n")}`,
        );
        await this.cleanupFailedAttempt();
        if (collision && attemptNumber < maximumAttempts) {
          this.#retryCount += 1;
          this.#logs.supervisor("warn", `Port ${port} collision detected; retry ${this.#retryCount}/${maximumAttempts - 1}`);
          this.transition("starting");
          continue;
        }
        const reason: SupervisorStopReason = readinessError?.kind === "timeout"
          ? "readiness_timeout"
          : readinessError?.kind === "process_exited"
            ? "process_exited"
            : "startup_failed";
        const code: SupervisorErrorCode = reason === "readiness_timeout" ? "readiness_timeout" : "startup_failed";
        return await this.failStart(code, diagnostic, reason);
      }
    }

    return await this.failStart("startup_failed", "Port retry budget exhausted", "startup_failed");
  }

  public async stop(): Promise<SupervisorResult> {
    if (this.#stopPromise !== null) return await this.#stopPromise;
    if ((this.#state === "stopped" || this.#state === "failed") && this.#lastResult !== null) {
      return this.#lastResult;
    }
    if (this.#state === "idle") {
      this.transition("stopped");
      const result = this.makeResult("requested", NO_CLEANUP);
      this.publishResult(result);
      return result;
    }
    this.#stopPromise = this.performStop();
    try {
      return await this.#stopPromise;
    } finally {
      this.#stopPromise = null;
    }
  }

  private async performStop(): Promise<SupervisorResult> {
    this.#intentionalShutdown = true;
    this.transition("stopping");
    const attempt = this.#attempt;
    if (attempt === null) {
      this.transition("stopped");
      const result = this.makeResult("requested", NO_CLEANUP);
      this.publishResult(result);
      return result;
    }

    const deadline = Date.now() + this.configuration.shutdownTimeoutMs;
    if (this.configuration.cooperativeShutdown !== undefined) {
      await this.requestCooperativeShutdown(attempt.port);
      const configuredWait = this.configuration.cooperativeShutdown.waitMs
        ?? Math.floor(this.configuration.shutdownTimeoutMs / 2);
      const exited = await waitBounded(attempt.exitPromise, Math.min(configuredWait, deadline - Date.now()));
      if (exited !== null) return this.completeRequestedStop(exited, NO_CLEANUP);
    }

    const gracefulTerminator = this.configuration.gracefulTerminator ?? defaultGracefulTerminator;
    const gracefulSent = await gracefulTerminator(attempt.child).catch((error: unknown) => {
      this.#logs.supervisor("warn", `Graceful termination request failed: ${this.safeError(error)}`);
      return false;
    });
    if (!gracefulSent && process.platform === "win32") {
      this.#logs.supervisor("warn", "No reliable native-free Windows console control event is available; escalating to owned-tree cleanup");
    }
    if (gracefulSent) {
      const exited = await waitBounded(attempt.exitPromise, Math.max(0, deadline - Date.now()));
      if (exited !== null) return this.completeRequestedStop(exited, NO_CLEANUP);
    }

    const controller = this.configuration.processTreeController ?? createDefaultProcessTreeController();
    const cleanup = await controller.terminateOwnedTree(attempt.pid);
    this.#logs.supervisor(cleanup.succeeded ? "warn" : "error", `Process-tree cleanup via ${cleanup.method}: ${cleanup.succeeded ? "succeeded" : "failed"}`);
    const exited = await waitBounded(attempt.exitPromise, Math.max(250, deadline - Date.now()));
    const result = this.makeResult("forced_termination", cleanup, exited ?? undefined);
    this.#attempt = null;
    this.transition(cleanup.succeeded && exited !== null ? "stopped" : "failed");
    const finalResult = { ...result, state: this.#state };
    this.publishResult(finalResult);
    return finalResult;
  }

  private async validateConfiguration(): Promise<void> {
    try {
      const executableStat = await stat(this.configuration.executable);
      if (!executableStat.isFile()) throw new Error("executable is not a file");
      await access(this.configuration.executable, constants.X_OK);
      const directoryStat = await stat(this.configuration.workingDirectory);
      if (!directoryStat.isDirectory()) throw new Error("workingDirectory is not a directory");
    } catch (error: unknown) {
      throw new SupervisorError("validation_error", this.safeError(error));
    }
    if (this.configuration.arguments.includes("--listen") || this.configuration.arguments.includes("--share")) {
      throw new SupervisorError("validation_error", "Prototype refuses --listen and --share; loopback-only is required");
    }
    for (const value of [this.configuration.startupTimeoutMs, this.configuration.shutdownTimeoutMs]) {
      if (!Number.isFinite(value) || value <= 0) throw new SupervisorError("validation_error", "Timeouts must be positive");
    }
  }

  private async launchAttempt(port: number): Promise<Attempt> {
    const portArguments = this.configuration.portArguments?.(port) ?? ["--port", String(port)];
    const arguments_ = [...this.configuration.arguments, ...portArguments];
    this.#redactor.addSecrets(secretsFromArguments(arguments_));
    this.#logs.supervisor("info", `Launching executable=${this.configuration.executable} cwd=${this.configuration.workingDirectory} args=${JSON.stringify(arguments_.map((value) => this.#redactor.redact(value)))}`);

    const child = spawn(this.configuration.executable, arguments_, {
      cwd: this.configuration.workingDirectory,
      env: { ...process.env, ...this.configuration.environment },
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => this.#logs.ingest("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => this.#logs.ingest("stderr", chunk));

    const exitController = new AbortController();
    const exitPromise = makeExitPromise(child, exitController, (info) => this.onChildExit(child, info));

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (child.pid === undefined) throw new Error("Spawn succeeded without a child PID");
    return { child, port, exitController, exitPromise, pid: child.pid };
  }

  private onChildExit(child: ChildProcessWithoutNullStreams, info: ExitInfo): void {
    this.#lastExitInfo = info;
    this.#logs.flush();
    this.#logs.supervisor("info", `Child exited code=${String(info.code)} signal=${String(info.signal)}`);
    if (this.#attempt?.child !== child || this.#intentionalShutdown) return;
    if (this.#state === "ready") {
      this.transition("failed");
      this.publishResult(this.makeResult("process_exited", NO_CLEANUP, info));
    }
  }

  private async requestCooperativeShutdown(port: number): Promise<void> {
    const shutdown = this.configuration.cooperativeShutdown;
    if (shutdown === undefined) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(1_000, this.configuration.shutdownTimeoutMs));
    try {
      const response = await fetch(`http://${LOOPBACK_HOST}:${port}${shutdown.path}`, {
        method: shutdown.method ?? "POST",
        signal: controller.signal,
        ...(shutdown.headers === undefined ? {} : { headers: shutdown.headers }),
      });
      await response.body?.cancel();
      this.#logs.supervisor(response.ok ? "info" : "warn", `Cooperative shutdown returned HTTP ${response.status}`);
    } catch (error: unknown) {
      this.#logs.supervisor("warn", `Cooperative shutdown failed: ${this.safeError(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async cleanupFailedAttempt(): Promise<void> {
    const attempt = this.#attempt;
    if (attempt === null) return;
    this.#intentionalShutdown = true;
    this.transition("stopping");
    if (attempt.exitController.signal.aborted) {
      await attempt.exitPromise;
    } else {
      const controller = this.configuration.processTreeController ?? createDefaultProcessTreeController();
      await controller.terminateOwnedTree(attempt.pid);
      await waitBounded(attempt.exitPromise, this.configuration.shutdownTimeoutMs);
    }
    this.#attempt = null;
    this.#intentionalShutdown = false;
  }

  private completeRequestedStop(info: ExitInfo, cleanup: CleanupOutcome): SupervisorResult {
    this.transition("stopped");
    const result = this.makeResult("requested", cleanup, info);
    this.#attempt = null;
    this.publishResult(result);
    return result;
  }

  private async failStart(
    code: SupervisorErrorCode,
    diagnostic: string,
    reason: SupervisorStopReason,
  ): Promise<never> {
    if (this.#state === "stopping") this.transition("failed");
    else if (this.#state !== "failed") this.transition("failed");
    const result = this.makeResult(reason, NO_CLEANUP, undefined, diagnostic);
    this.publishResult(result);
    throw new SupervisorError(code, this.#redactor.redact(diagnostic), result);
  }

  private publishResult(result: SupervisorResult): void {
    this.#lastResult = result;
    for (const subscriber of this.#terminationSubscribers) subscriber(result);
    this.#terminationSubscribers.clear();
  }

  private makeResult(
    reason: SupervisorStopReason,
    cleanup: CleanupOutcome,
    exit?: ExitInfo,
    diagnostic?: string,
  ): SupervisorResult {
    return {
      reason,
      state: this.#state,
      exitCode: (exit ?? this.#lastExitInfo)?.code ?? null,
      signal: (exit ?? this.#lastExitInfo)?.signal ?? null,
      elapsedMs: this.#startedAt === 0 ? 0 : Date.now() - this.#startedAt,
      port: this.#attempt?.port ?? this.#lastPort,
      retryCount: this.#retryCount,
      cleanup,
      logs: this.#logs.snapshot(),
      ...(diagnostic === undefined ? {} : { diagnostic: this.#redactor.redact(diagnostic) }),
    };
  }

  private transition(next: SupervisorState): void {
    if (!TRANSITIONS[this.#state].includes(next)) {
      throw new SupervisorError("invalid_state", `Invalid supervisor transition ${this.#state} -> ${next}`);
    }
    this.#state = next;
  }

  private safeError(error: unknown): string {
    return this.#redactor.redact(error instanceof Error ? error.message : String(error));
  }
}
