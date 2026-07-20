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
  forgeBaseUrl: z.string().max(240),
  studio: z.object({
    prompt: z.string().max(4_000),
    negativePrompt: z.string().max(4_000),
    width: z.number().int().min(256).max(2_048),
    height: z.number().int().min(256).max(2_048),
    steps: z.number().int().min(1).max(150),
    cfgScale: z.number().min(1).max(30),
    seed: z.number().int().min(-1).max(2_147_483_647),
    sampler: z.string().min(1).max(120),
  }),
});
export type DesktopSettings = z.infer<typeof settingsSchema>;

export const settingsPatchSchema = settingsSchema.omit({ schemaVersion: true }).partial().strict();

export type AppInfo = { version: string; platform: NodeJS.Platform; packaged: boolean };
export type RuntimeSummary = { configured: boolean; runtimeId: string | null; forgeCommit: string | null; description: string };

export const forgeConnectionRequestSchema = z.object({ baseUrl: z.string().min(1).max(240) }).strict();
export const forgeConnectionResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), message: z.string().max(240) }),
  z.object({ ok: z.literal(false), message: z.string().max(500) }),
]);
export type ForgeConnectionResult = z.infer<typeof forgeConnectionResultSchema>;

export const generationRequestSchema = settingsSchema.shape.studio.extend({
  baseUrl: z.string().min(1).max(240),
}).strict();
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export const generationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), image: z.string().startsWith("data:image/"), seed: z.number().int().nullable() }),
  z.object({ ok: z.literal(false), message: z.string().max(500) }),
]);
export type GenerationResult = z.infer<typeof generationResultSchema>;

export type AurelineApi = {
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
  forge: {
    testConnection(baseUrl: string): Promise<ForgeConnectionResult>;
    generate(request: GenerationRequest): Promise<GenerationResult>;
  };
};

export const IPC = {
  appInfo: "aureline:app:get-info", window: "aureline:app:window",
  engineState: "aureline:engine:get-state", engineStart: "aureline:engine:start", engineStop: "aureline:engine:stop", engineRestart: "aureline:engine:restart", engineEvent: "aureline:engine:event",
  logsGet: "aureline:logs:get", logEvent: "aureline:logs:event",
  classicShow: "aureline:classic:show", classicHide: "aureline:classic:hide", classicReload: "aureline:classic:reload",
  settingsGet: "aureline:settings:get", settingsUpdate: "aureline:settings:update", runtimeSummary: "aureline:runtime:get-summary",
  forgeTestConnection: "aureline:forge:test-connection", forgeGenerate: "aureline:forge:generate",
} as const;
