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
    selectedModelId: z.string().uuid().nullable(),
  }),
  models: z.object({
    preferredCivitaiHost: z.enum(["automatic", "civitai.com", "civitai.red"]),
    downloadConcurrency: z.number().int().min(1).max(2),
    keepPartialDownloads: z.boolean(),
    previewSensitivity: z.enum(["blur", "show"]),
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
  selectedModelId: z.string().uuid().nullable().optional(),
}).strict();
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export const generationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), image: z.string().startsWith("data:image/"), seed: z.number().int().nullable() }),
  z.object({ ok: z.literal(false), message: z.string().max(500) }),
]);
export type GenerationResult = z.infer<typeof generationResultSchema>;

export const modelTypes = ["checkpoint", "lora", "lycoris", "vae", "embedding", "controlnet", "upscaler", "other"] as const;
export const modelTypeSchema = z.enum(modelTypes);
export type ModelType = z.infer<typeof modelTypeSchema>;
export const civitaiHosts = ["civitai.com", "civitai.red"] as const;
export const civitaiHostSchema = z.enum(civitaiHosts);
export type CivitaiHost = z.infer<typeof civitaiHostSchema>;

export const remoteModelFileSchema = z.object({
  fileId: z.number().int().positive(), name: z.string().min(1).max(240), sizeBytes: z.number().int().nonnegative().optional(),
  format: z.string().max(80).optional(), precision: z.string().max(40).optional(), variant: z.string().max(40).optional(), primary: z.boolean(),
  hashes: z.object({ sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(), blake3: z.string().max(128).optional(), autoV2: z.string().max(64).optional() }).optional(),
}).strict();
export const remotePreviewSchema = z.object({ id: z.string().uuid(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), sensitive: z.boolean() }).strict();
export const remoteModelVersionSchema = z.object({
  versionId: z.number().int().positive(), name: z.string().min(1).max(240), baseModel: z.string().max(120).optional(), publishedAt: z.string().datetime().optional(),
  files: z.array(remoteModelFileSchema).max(100), previews: z.array(remotePreviewSchema).max(12),
}).strict();
export const remoteModelSchema = z.object({
  resolveId: z.string().uuid(), provider: z.literal("civitai"), providerHost: civitaiHostSchema, modelId: z.number().int().positive(),
  name: z.string().min(1).max(240), creator: z.string().max(120).optional(), type: modelTypeSchema,
  descriptionSummary: z.string().max(500).optional(), sensitive: z.boolean(), requestedVersionId: z.number().int().positive().optional(),
  versions: z.array(remoteModelVersionSchema).min(1).max(100),
}).strict();
export type RemoteModel = z.infer<typeof remoteModelSchema>;

export const modelErrorCodes = [
  "CIVITAI_URL_INVALID", "CIVITAI_HOST_UNSUPPORTED", "CIVITAI_MODEL_NOT_FOUND", "CIVITAI_VERSION_NOT_FOUND", "CIVITAI_AUTH_REQUIRED", "CIVITAI_AUTH_INVALID", "CIVITAI_RATE_LIMITED", "CIVITAI_API_UNAVAILABLE", "CIVITAI_RESPONSE_INVALID",
  "DOWNLOAD_DESTINATION_INVALID", "DOWNLOAD_DISK_SPACE_LOW", "DOWNLOAD_ALREADY_EXISTS", "DOWNLOAD_RANGE_UNSUPPORTED", "DOWNLOAD_FAILED", "DOWNLOAD_CANCELLED", "DOWNLOAD_HASH_MISMATCH", "MODEL_TYPE_UNSUPPORTED", "MODEL_INSTALL_FAILED", "MODEL_REFRESH_FAILED",
] as const;
export const modelErrorCodeSchema = z.enum(modelErrorCodes);
export const safeModelErrorSchema = z.object({ code: modelErrorCodeSchema, message: z.string().min(1).max(500), retryable: z.boolean() }).strict();
export type SafeModelError = z.infer<typeof safeModelErrorSchema>;
export const resolveCivitaiRequestSchema = z.object({ url: z.string().min(1).max(2_048), preferredHost: z.enum(["automatic", ...civitaiHosts]) }).strict();
export const resolveCivitaiResultSchema = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), model: remoteModelSchema }), z.object({ ok: z.literal(false), error: safeModelErrorSchema })]);
export type ResolveCivitaiResult = z.infer<typeof resolveCivitaiResultSchema>;

export const credentialStatusSchema = z.object({ configured: z.boolean(), state: z.enum(["not_configured", "saved", "valid", "invalid", "unavailable"]) }).strict();
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;
export const credentialSaveSchema = z.object({ apiKey: z.string().trim().min(8).max(512) }).strict();
export const credentialTestResultSchema = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), status: credentialStatusSchema }), z.object({ ok: z.literal(false), status: credentialStatusSchema, error: safeModelErrorSchema })]);

export const modelRootSchema = z.object({ id: z.string().min(1).max(40), type: modelTypeSchema, label: z.string().max(120), location: z.string().max(240), available: z.boolean() }).strict();
export type ModelRoot = z.infer<typeof modelRootSchema>;
export const downloadPreflightSchema = z.object({ destination: modelRootSchema, expectedBytes: z.number().int().nonnegative().optional(), freeBytes: z.number().int().nonnegative(), sufficient: z.boolean(), warning: z.string().max(300).optional() }).strict();
export const downloadSelectionSchema = z.object({ resolveId: z.string().uuid(), versionId: z.number().int().positive(), fileId: z.number().int().positive(), destinationId: z.string().min(1).max(40) }).strict();

export const downloadStates = ["queued", "preflighting", "downloading", "paused", "verifying", "installing", "completed", "failed", "cancelled"] as const;
export const downloadStateSchema = z.enum(downloadStates);
export const downloadRecordSchema = z.object({
  id: z.string().uuid(), state: downloadStateSchema, fileName: z.string().max(240), modelName: z.string().max(240), versionName: z.string().max(240),
  receivedBytes: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative().optional(), bytesPerSecond: z.number().nonnegative().optional(), etaSeconds: z.number().nonnegative().optional(),
  destination: z.string().max(240), error: safeModelErrorSchema.optional(), canPause: z.boolean(), canResume: z.boolean(), canRetry: z.boolean(), installedModelId: z.string().uuid().optional(),
  engineRefresh: z.enum(["not_needed", "pending", "refreshed", "required"]).optional(),
}).strict();
export type DownloadRecord = z.infer<typeof downloadRecordSchema>;
export const downloadListSchema = z.array(downloadRecordSchema).max(200);
export const downloadStartResultSchema = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), download: downloadRecordSchema }), z.object({ ok: z.literal(false), error: safeModelErrorSchema })]);
export const downloadActionSchema = z.object({ downloadId: z.string().uuid() }).strict();
export const downloadCancelSchema = downloadActionSchema.extend({ deletePartial: z.boolean() }).strict();

export const installedModelSchema = z.object({
  id: z.string().uuid(), type: modelTypeSchema, name: z.string().max(240), fileName: z.string().max(240), sizeBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.enum(["civitai", "local"]), providerModelId: z.number().int().positive().optional(), providerVersionId: z.number().int().positive().optional(), providerFileId: z.number().int().positive().optional(),
  baseModel: z.string().max(120).optional(), installedAt: z.string().datetime(), location: z.string().max(240), duplicate: z.boolean(),
}).strict();
export type InstalledModel = z.infer<typeof installedModelSchema>;
export const installedModelListSchema = z.array(installedModelSchema).max(10_000);
export const modelLibraryQuerySchema = z.object({ search: z.string().max(120).default(""), type: modelTypeSchema.optional() }).strict();
export const modelIdSchema = z.object({ modelId: z.string().uuid() }).strict();
export const previewRequestSchema = z.object({ previewId: z.string().uuid() }).strict();
export const previewResultSchema = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), dataUrl: z.string().startsWith("data:image/") }), z.object({ ok: z.literal(false), error: safeModelErrorSchema })]);

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
  models: {
    resolveCivitaiUrl(url: string, preferredHost: DesktopSettings["models"]["preferredCivitaiHost"]): Promise<ResolveCivitaiResult>;
    getCredentialStatus(): Promise<CredentialStatus>; saveCredential(apiKey: string): Promise<CredentialStatus>; clearCredential(): Promise<CredentialStatus>; testCredential(): Promise<z.infer<typeof credentialTestResultSchema>>;
    getRoots(): Promise<ModelRoot[]>; preflight(selection: z.infer<typeof downloadSelectionSchema>): Promise<z.infer<typeof downloadPreflightSchema>>;
    startDownload(selection: z.infer<typeof downloadSelectionSchema>): Promise<z.infer<typeof downloadStartResultSchema>>; listDownloads(): Promise<DownloadRecord[]>;
    pauseDownload(downloadId: string): Promise<DownloadRecord>; resumeDownload(downloadId: string): Promise<DownloadRecord>; cancelDownload(downloadId: string, deletePartial: boolean): Promise<DownloadRecord>; retryDownload(downloadId: string): Promise<DownloadRecord>;
    subscribeDownloads(callback: (download: DownloadRecord) => void): () => void;
    listLibrary(search?: string, type?: ModelType): Promise<InstalledModel[]>; refreshLibrary(): Promise<InstalledModel[]>; revealModel(modelId: string): Promise<void>; useInStudio(modelId: string): Promise<void>;
    getPreview(previewId: string): Promise<z.infer<typeof previewResultSchema>>;
  };
};

export const IPC = {
  appInfo: "aureline:app:get-info", window: "aureline:app:window",
  engineState: "aureline:engine:get-state", engineStart: "aureline:engine:start", engineStop: "aureline:engine:stop", engineRestart: "aureline:engine:restart", engineEvent: "aureline:engine:event",
  logsGet: "aureline:logs:get", logEvent: "aureline:logs:event",
  classicShow: "aureline:classic:show", classicHide: "aureline:classic:hide", classicReload: "aureline:classic:reload",
  settingsGet: "aureline:settings:get", settingsUpdate: "aureline:settings:update", runtimeSummary: "aureline:runtime:get-summary",
  forgeTestConnection: "aureline:forge:test-connection", forgeGenerate: "aureline:forge:generate",
  modelsResolveCivitai: "aureline:models:resolve-civitai", modelsCredentialStatus: "aureline:models:credential-status", modelsCredentialSave: "aureline:models:credential-save", modelsCredentialClear: "aureline:models:credential-clear", modelsCredentialTest: "aureline:models:credential-test",
  modelsRoots: "aureline:models:roots", modelsPreflight: "aureline:models:preflight", modelsDownloadStart: "aureline:models:download-start", modelsDownloads: "aureline:models:downloads", modelsDownloadPause: "aureline:models:download-pause", modelsDownloadResume: "aureline:models:download-resume", modelsDownloadCancel: "aureline:models:download-cancel", modelsDownloadRetry: "aureline:models:download-retry", modelsDownloadEvent: "aureline:models:download-event",
  modelsLibrary: "aureline:models:library", modelsLibraryRefresh: "aureline:models:library-refresh", modelsReveal: "aureline:models:reveal", modelsUseInStudio: "aureline:models:use-in-studio", modelsPreview: "aureline:models:preview",
} as const;
