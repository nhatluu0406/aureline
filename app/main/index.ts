import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  credentialSaveSchema, downloadActionSchema, downloadCancelSchema, downloadSelectionSchema, forgeConnectionRequestSchema, generationRequestSchema, IPC,
  modelIdSchema, modelLibraryQuerySchema, previewRequestSchema, resolveCivitaiRequestSchema, settingsPatchSchema,
} from "../../packages/contracts/index.ts";
import { ForgeApiClient } from "../../engine/adapter/forge-api-client.ts";
import { CivitaiCredentialVault } from "../../packages/credentials/civitai-credential-vault.ts";
import { ModelLibrary } from "../../packages/model-library/index.ts";
import { CivitaiSource, asSafeModelError } from "../../packages/model-sources/civitai/index.ts";
import { ModelsApplication } from "../../packages/models-application/index.ts";
import { EngineSupervisor } from "../../packages/process-supervisor/engine-supervisor.ts";
import { loadRuntimeManifest, type RuntimeManifest } from "../../packages/runtime-manifest/index.ts";
import { SettingsStore } from "../../packages/settings/settings-store.ts";
import { ClassicViewController } from "./classic-view.ts";

let mainWindow: BrowserWindow | null = null;
let engine: EngineSupervisor;
let classic: ClassicViewController;
let settings: SettingsStore;
let models: ModelsApplication;
let quitting = false;
const forgeApi = new ForgeApiClient();
const devServer = process.env.AURELINE_DEV_SERVER_URL;
if (process.env.AURELINE_USER_DATA) app.setPath("userData", resolve(process.env.AURELINE_USER_DATA));

function manifestCandidate(): string {
  if (process.env.AURELINE_RUNTIME_MANIFEST) return resolve(process.env.AURELINE_RUNTIME_MANIFEST);
  return app.isPackaged ? resolve(app.getPath("userData"), "runtime-manifest.json") : resolve(app.getAppPath(), "engine/manifests/runtime-manifest.example.json");
}
async function readManifest(): Promise<RuntimeManifest | null> { const candidate = manifestCandidate(); if (!existsSync(candidate)) return null; try { return await loadRuntimeManifest(candidate); } catch { return null; } }
function packagedSmokeFetch(userData: string): typeof globalThis.fetch {
  const enabled = app.isPackaged && process.env.AURELINE_PACKAGED_SMOKE_FIXTURE === "enabled" && userData.toLowerCase().endsWith("packaged-smoke"); if (!enabled) return globalThis.fetch;
  const bytes = Buffer.from("aureline-smoke-model"); const sha256 = createHash("sha256").update(bytes).digest("hex");
  return async (input, init) => {
    const url = String(input);
    if (url === "https://civitai.com/api/v1/models/2147483000") return new Response(JSON.stringify({ id: 2147483000, name: "Aureline Smoke Model", description: "Packaged test fixture", type: "Checkpoint", nsfw: false, creator: { username: "Aureline" }, modelVersions: [{ id: 2147483001, modelId: 2147483000, name: "Fixture v1", baseModel: "Test only", files: [{ id: 2147483002, name: "aureline-smoke.safetensors", sizeKB: bytes.byteLength / 1024, primary: true, hashes: { SHA256: sha256 }, metadata: { format: "SafeTensor", size: "pruned", fp: "fp16" } }], images: [], downloadUrl: "https://civitai.com/api/download/models/2147483001" }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "https://civitai.com/api/download/models/2147483001") return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.byteLength), "content-type": "application/octet-stream" } });
    return globalThis.fetch(input, init);
  };
}
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({ width: 1280, height: 820, minWidth: 980, minHeight: 650, show: false, frame: false, titleBarStyle: "hidden", backgroundColor: "#101217", webPreferences: { preload: resolve(app.getAppPath(), "dist/electron/preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" })); window.webContents.on("will-navigate", event => event.preventDefault()); window.once("ready-to-show", () => window.show());
  void window.loadURL(devServer ?? pathToFileURL(resolve(app.getAppPath(), "dist/renderer/index.html")).toString());
  window.on("close", event => { if (!quitting) { event.preventDefault(); void shutdown().finally(() => { quitting = true; app.quit(); }); } }); return window;
}

function registerIpc(): void {
  const handle = (channel: string, handler: (value?: unknown) => unknown | Promise<unknown>) => ipcMain.handle(channel, (event, value) => { if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error("Untrusted IPC sender"); return handler(value); });
  handle(IPC.appInfo, () => ({ version: app.getVersion(), platform: process.platform, packaged: app.isPackaged }));
  handle(IPC.window, value => { if (!["minimize", "toggle-maximize", "close"].includes(String(value))) throw new Error("Invalid window action"); if (value === "minimize") mainWindow?.minimize(); else if (value === "toggle-maximize") mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize(); else mainWindow?.close(); });
  handle(IPC.engineState, () => engine.snapshot); handle(IPC.engineStart, async () => await engine.start()); handle(IPC.engineStop, async () => { classic.hide(); return await engine.stop(); }); handle(IPC.engineRestart, async () => { classic.hide(); return await engine.restart(); });
  handle(IPC.logsGet, () => engine.logs.snapshot()); handle(IPC.classicShow, async () => { if (!mainWindow) throw new Error("Window unavailable"); await classic.show(mainWindow); }); handle(IPC.classicHide, () => classic.hide()); handle(IPC.classicReload, async () => await classic.reload());
  handle(IPC.settingsGet, () => settings.value); handle(IPC.settingsUpdate, async value => await settings.update(settingsPatchSchema.parse(value)));
  handle(IPC.forgeTestConnection, async value => await forgeApi.testConnection(forgeConnectionRequestSchema.parse(value).baseUrl));
  handle(IPC.forgeGenerate, async value => await forgeApi.generate(generationRequestSchema.parse(value), models.selectedCheckpointName()));
  handle(IPC.runtimeSummary, () => ({ configured: engine.snapshot.runtimeId !== null, runtimeId: engine.snapshot.runtimeId, forgeCommit: null, description: engine.snapshot.runtimeId === null ? "Runtime not configured" : "Runtime manifest validated" }));

  handle(IPC.modelsResolveCivitai, async value => { const parsed = resolveCivitaiRequestSchema.parse(value); return await models.resolve(parsed.url, parsed.preferredHost); });
  handle(IPC.modelsCredentialStatus, async () => await models.vault.status());
  handle(IPC.modelsCredentialSave, async value => await models.vault.save(credentialSaveSchema.parse(value).apiKey));
  handle(IPC.modelsCredentialClear, async () => await models.vault.clear());
  handle(IPC.modelsCredentialTest, async () => {
    const status = await models.vault.status(); if (!status.configured) return { ok: false, status, error: { code: "CIVITAI_AUTH_REQUIRED", message: "Save a Civitai API key before testing it.", retryable: false } };
    try { await models.vault.use(async apiKey => { if (!apiKey) throw new Error("missing"); const preferred = settings.value.models.preferredCivitaiHost; await models.source.testCredential(preferred === "automatic" ? "civitai.com" : preferred, apiKey); }); return { ok: true, status: { configured: true, state: "valid" } }; }
    catch (error) { const safe = asSafeModelError(error); const invalid = safe.code === "CIVITAI_AUTH_INVALID" || safe.code === "CIVITAI_AUTH_REQUIRED"; return { ok: false, status: { configured: true, state: invalid ? "invalid" : "unavailable" }, error: safe }; }
  });
  handle(IPC.modelsRoots, () => models.library.roots());
  handle(IPC.modelsPreflight, async value => await models.preflight(downloadSelectionSchema.parse(value)));
  handle(IPC.modelsDownloadStart, async value => await models.start(downloadSelectionSchema.parse(value)));
  handle(IPC.modelsDownloads, () => models.downloads.list());
  handle(IPC.modelsDownloadPause, value => models.downloads.pause(downloadActionSchema.parse(value).downloadId));
  handle(IPC.modelsDownloadResume, value => models.vault.use(apiKey => Promise.resolve(models.downloads.resume(downloadActionSchema.parse(value).downloadId, apiKey))));
  handle(IPC.modelsDownloadCancel, value => { const parsed = downloadCancelSchema.parse(value); return models.downloads.cancel(parsed.downloadId, parsed.deletePartial); });
  handle(IPC.modelsDownloadRetry, value => models.downloads.retry(downloadActionSchema.parse(value).downloadId));
  handle(IPC.modelsLibrary, value => { const parsed = modelLibraryQuerySchema.parse(value); return models.listLibrary(parsed.search, parsed.type); });
  handle(IPC.modelsLibraryRefresh, async () => await models.refreshLibrary());
  handle(IPC.modelsReveal, value => models.reveal(modelIdSchema.parse(value).modelId));
  handle(IPC.modelsUseInStudio, async value => await models.useInStudio(modelIdSchema.parse(value).modelId));
  handle(IPC.modelsPreview, async value => await models.preview(previewRequestSchema.parse(value).previewId));
}

async function shutdown(): Promise<void> { classic?.hide(); await engine?.stop().catch(() => undefined); }

if (!app.requestSingleInstanceLock()) app.quit(); else {
  app.on("second-instance", () => { mainWindow?.show(); mainWindow?.focus(); });
  app.whenReady().then(async () => {
    const userData = app.getPath("userData"); settings = new SettingsStore(resolve(userData, "settings.json")); await settings.load(); engine = new EngineSupervisor(await readManifest(), userData); classic = new ClassicViewController(engine);
    const library = new ModelLibrary(userData, resolve(userData, "model-library", "index.json")); const vault = new CivitaiCredentialVault(resolve(userData, "credentials", "civitai.bin"), safeStorage); const modelFetch = packagedSmokeFetch(userData);
    models = new ModelsApplication(new CivitaiSource(modelFetch), library, vault, settings, forgeApi, path => shell.showItemInFolder(path), modelFetch, resolve(userData, "downloads", "records.json")); await models.initialize(); registerIpc();
    engine.subscribe(value => mainWindow?.webContents.send(IPC.engineEvent, value)); engine.logs.subscribe(value => mainWindow?.webContents.send(IPC.logEvent, value)); models.downloads.subscribe(value => mainWindow?.webContents.send(IPC.modelsDownloadEvent, value));
    mainWindow = createWindow(); if (settings.value.launchOnStart) void engine.start();
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); }); app.on("before-quit", event => { if (!quitting) { event.preventDefault(); void shutdown().finally(() => { quitting = true; app.quit(); }); } });
}
