import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type SupervisorState =
  | "idle"
  | "starting"
  | "waiting_for_readiness"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export type SupervisorStopReason =
  | "requested"
  | "startup_failed"
  | "readiness_timeout"
  | "process_exited"
  | "forced_termination";

export type ProcessLogEvent = {
  timestamp: string;
  stream: "stdout" | "stderr" | "supervisor";
  level: "debug" | "info" | "warn" | "error";
  message: string;
};

export type ExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type CleanupOutcome = {
  attempted: boolean;
  succeeded: boolean;
  method: string;
  diagnostic?: string;
};

export type SupervisorResult = {
  reason: SupervisorStopReason;
  state: SupervisorState;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  port: number | null;
  retryCount: number;
  cleanup: CleanupOutcome;
  logs: readonly ProcessLogEvent[];
  diagnostic?: string;
};

export type ReadinessConfiguration = {
  path: string;
  expectedStatusCodes?: readonly number[];
  requestTimeoutMs: number;
  initialRetryDelayMs: number;
  maximumRetryDelayMs: number;
  backoffFactor: number;
  headers?: Readonly<Record<string, string>>;
};

export type CooperativeShutdownConfiguration = {
  path: string;
  method?: "POST" | "GET";
  headers?: Readonly<Record<string, string>>;
  waitMs?: number;
};

export interface ProcessTreeController {
  terminateOwnedTree(pid: number): Promise<CleanupOutcome>;
}

export type GracefulTerminator = (
  child: ChildProcessWithoutNullStreams,
) => Promise<boolean>;

export type PortProvider = () => Promise<number>;

export type SupervisorConfiguration = {
  executable: string;
  workingDirectory: string;
  arguments: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
  secretEnvironmentKeys?: readonly string[];
  secretValues?: readonly string[];
  readiness: ReadinessConfiguration;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  cooperativeShutdown?: CooperativeShutdownConfiguration;
  maximumPortAttempts?: number;
  portProvider?: PortProvider;
  portArguments?: (port: number) => readonly string[];
  logHistoryLimit?: number;
  processTreeController?: ProcessTreeController;
  gracefulTerminator?: GracefulTerminator;
};

export type StartResult = {
  state: "ready";
  port: number;
  retryCount: number;
  elapsedMs: number;
};
