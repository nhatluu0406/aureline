import { z } from "zod";

export const engineStates = ["not_configured", "stopped", "starting", "ready", "stopping", "failed"] as const;
export type EngineStateName = typeof engineStates[number];

export const desktopErrorCodes = [
  "RUNTIME_NOT_CONFIGURED", "RUNTIME_INVALID", "HELPER_START_FAILED", "ENGINE_START_FAILED",
  "ENGINE_READINESS_TIMEOUT", "ENGINE_CRASHED", "BRIDGE_START_FAILED", "CLASSIC_LOAD_FAILED", "ENGINE_STOP_FAILED",
] as const;
export type DesktopErrorCode = typeof desktopErrorCodes[number];

export const engineSnapshotSchema = z.object({
  state: z.enum(engineStates),
  phase: z.string().max(160),
  startedAt: z.string().datetime().nullable(),
  uptimeMs: z.number().int().nonnegative(),
  readiness: z.enum(["unknown", "waiting", "protected", "ready"]),
  backendProtected: z.boolean(),
  runtimeId: z.string().max(120).nullable(),
  error: z.object({ code: z.enum(desktopErrorCodes), message: z.string(), details: z.string().optional() }).nullable(),
});
export type EngineSnapshot = z.infer<typeof engineSnapshotSchema>;

export const logEventSchema = z.object({
  timestamp: z.string().datetime(),
  level: z.enum(["debug", "info", "warn", "error"]),
  source: z.enum(["app", "helper", "forge", "bridge"]),
  message: z.string().max(4_096),
});
export type LogEvent = z.infer<typeof logEventSchema>;

export const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  theme: z.enum(["system", "light", "dark"]),
  launchOnStart: z.boolean(),
  closeBehavior: z.enum(["quit", "stop-and-quit"]),
  logLevel: z.enum(["info", "debug"]),
});
export type DesktopSettings = z.infer<typeof settingsSchema>;

export const settingsPatchSchema = settingsSchema.omit({ schemaVersion: true }).partial().strict();

export type AppInfo = { version: string; platform: NodeJS.Platform; packaged: boolean };
export type RuntimeSummary = { configured: boolean; runtimeId: string | null; forgeCommit: string | null; description: string };

export type ForgeDesktopApi = {
  app: { getInfo(): Promise<AppInfo>; window(action: "minimize" | "toggle-maximize" | "close"): Promise<void> };
  engine: {
    getState(): Promise<EngineSnapshot>;
    start(): Promise<EngineSnapshot>;
    stop(): Promise<EngineSnapshot>;
    restart(): Promise<EngineSnapshot>;
    subscribe(callback: (state: EngineSnapshot) => void): () => void;
  };
  logs: { getRecent(): Promise<LogEvent[]>; subscribe(callback: (event: LogEvent) => void): () => void };
  classic: { show(): Promise<void>; hide(): Promise<void>; reload(): Promise<void> };
  settings: { get(): Promise<DesktopSettings>; update(patch: Partial<Omit<DesktopSettings, "schemaVersion">>): Promise<DesktopSettings> };
  runtime: { getSummary(): Promise<RuntimeSummary> };
};

export const IPC = {
  appInfo: "app:get-info", window: "app:window",
  engineState: "engine:get-state", engineStart: "engine:start", engineStop: "engine:stop", engineRestart: "engine:restart", engineEvent: "engine:event",
  logsGet: "logs:get", logEvent: "logs:event",
  classicShow: "classic:show", classicHide: "classic:hide", classicReload: "classic:reload",
  settingsGet: "settings:get", settingsUpdate: "settings:update", runtimeSummary: "runtime:get-summary",
} as const;
