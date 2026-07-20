export type OwnedProcessLaunchRequest = {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment?: Readonly<Record<string, string | undefined>>;
};

export type FailureStage = "none" | "assign" | "resume";

export type ReadyEvent = {
  event: "ready";
  ownerPid: number;
  pid: number;
  createdSuspended: true;
  assignedBeforeResume: true;
  resumed: true;
  rootInJob: boolean;
  ownerInOuterJob: boolean;
  limitFlags: number;
  activeProcesses: number;
  totalProcesses: number;
};

export type ErrorEvent = {
  event: "error";
  stage: string;
  win32Error: number;
  message: string;
};

export type QueryEvent = {
  event: "query";
  status: "open" | "closed";
  limitFlags?: number;
  activeProcesses?: number;
  totalProcesses?: number;
};

export type CheckedEvent = { event: "checked"; pid: number; inJob: boolean };
export type ClosedEvent = { event: "closed"; status: "closed" | "already_closed" };
export type TerminatedEvent = { event: "terminated"; status: "terminated" | "already_closed" };
export type SelfJobStateEvent = { event: "self_job_state"; inJob: boolean; pid: number };
export type BreakawayEvent = {
  event: "breakaway";
  succeeded: boolean;
  win32Error?: number;
  pid?: number;
  exitCode?: number;
};

export type HelperEvent =
  | ReadyEvent
  | ErrorEvent
  | QueryEvent
  | CheckedEvent
  | ClosedEvent
  | TerminatedEvent
  | SelfJobStateEvent
  | BreakawayEvent;

export type LaunchOptions = {
  helperPath: string;
  request: OwnedProcessLaunchRequest;
  timeoutMs?: number;
  failureStage?: FailureStage;
};

