import { contextBridge, ipcRenderer } from "electron";
import {
  credentialSaveSchema, credentialStatusSchema, credentialTestResultSchema, downloadActionSchema, downloadCancelSchema, downloadListSchema, downloadPreflightSchema, downloadRecordSchema, downloadSelectionSchema, downloadStartResultSchema,
  engineSnapshotSchema, forgeConnectionResultSchema, generationRequestSchema, generationResultSchema, installedModelListSchema, IPC, logEventSchema, modelIdSchema, modelLibraryQuerySchema, modelRootSchema,
  previewRequestSchema, previewResultSchema, resolveCivitaiRequestSchema, resolveCivitaiResultSchema, settingsSchema, type AurelineApi,
} from "../../packages/contracts/index.ts";

const api: AurelineApi = {
  app: { getInfo: async () => await ipcRenderer.invoke(IPC.appInfo), window: async action => await ipcRenderer.invoke(IPC.window, action) },
  engine: {
    getState: async () => engineSnapshotSchema.parse(await ipcRenderer.invoke(IPC.engineState)), start: async () => engineSnapshotSchema.parse(await ipcRenderer.invoke(IPC.engineStart)), stop: async () => engineSnapshotSchema.parse(await ipcRenderer.invoke(IPC.engineStop)), restart: async () => engineSnapshotSchema.parse(await ipcRenderer.invoke(IPC.engineRestart)),
    subscribe(callback) { const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(engineSnapshotSchema.parse(value)); ipcRenderer.on(IPC.engineEvent, listener); return () => ipcRenderer.removeListener(IPC.engineEvent, listener); },
  },
  logs: { getRecent: async () => (await ipcRenderer.invoke(IPC.logsGet) as unknown[]).map(value => logEventSchema.parse(value)), subscribe(callback) { const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(logEventSchema.parse(value)); ipcRenderer.on(IPC.logEvent, listener); return () => ipcRenderer.removeListener(IPC.logEvent, listener); } },
  classic: { show: async () => await ipcRenderer.invoke(IPC.classicShow), hide: async () => await ipcRenderer.invoke(IPC.classicHide), reload: async () => await ipcRenderer.invoke(IPC.classicReload) },
  settings: { get: async () => settingsSchema.parse(await ipcRenderer.invoke(IPC.settingsGet)), update: async patch => settingsSchema.parse(await ipcRenderer.invoke(IPC.settingsUpdate, patch)) },
  runtime: { getSummary: async () => await ipcRenderer.invoke(IPC.runtimeSummary) },
  forge: { testConnection: async baseUrl => forgeConnectionResultSchema.parse(await ipcRenderer.invoke(IPC.forgeTestConnection, { baseUrl })), generate: async request => generationResultSchema.parse(await ipcRenderer.invoke(IPC.forgeGenerate, generationRequestSchema.parse(request))) },
  models: {
    resolveCivitaiUrl: async (url, preferredHost) => resolveCivitaiResultSchema.parse(await ipcRenderer.invoke(IPC.modelsResolveCivitai, resolveCivitaiRequestSchema.parse({ url, preferredHost }))),
    getCredentialStatus: async () => credentialStatusSchema.parse(await ipcRenderer.invoke(IPC.modelsCredentialStatus)),
    saveCredential: async apiKey => credentialStatusSchema.parse(await ipcRenderer.invoke(IPC.modelsCredentialSave, credentialSaveSchema.parse({ apiKey }))),
    clearCredential: async () => credentialStatusSchema.parse(await ipcRenderer.invoke(IPC.modelsCredentialClear)),
    testCredential: async () => credentialTestResultSchema.parse(await ipcRenderer.invoke(IPC.modelsCredentialTest)),
    getRoots: async () => (await ipcRenderer.invoke(IPC.modelsRoots) as unknown[]).map(value => modelRootSchema.parse(value)),
    preflight: async selection => downloadPreflightSchema.parse(await ipcRenderer.invoke(IPC.modelsPreflight, downloadSelectionSchema.parse(selection))),
    startDownload: async selection => downloadStartResultSchema.parse(await ipcRenderer.invoke(IPC.modelsDownloadStart, downloadSelectionSchema.parse(selection))),
    listDownloads: async () => downloadListSchema.parse(await ipcRenderer.invoke(IPC.modelsDownloads)),
    pauseDownload: async downloadId => downloadRecordSchema.parse(await ipcRenderer.invoke(IPC.modelsDownloadPause, downloadActionSchema.parse({ downloadId }))),
    resumeDownload: async downloadId => downloadRecordSchema.parse(await ipcRenderer.invoke(IPC.modelsDownloadResume, downloadActionSchema.parse({ downloadId }))),
    cancelDownload: async (downloadId, deletePartial) => downloadRecordSchema.parse(await ipcRenderer.invoke(IPC.modelsDownloadCancel, downloadCancelSchema.parse({ downloadId, deletePartial }))),
    retryDownload: async downloadId => downloadRecordSchema.parse(await ipcRenderer.invoke(IPC.modelsDownloadRetry, downloadActionSchema.parse({ downloadId }))),
    subscribeDownloads(callback) { const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(downloadRecordSchema.parse(value)); ipcRenderer.on(IPC.modelsDownloadEvent, listener); return () => ipcRenderer.removeListener(IPC.modelsDownloadEvent, listener); },
    listLibrary: async (search = "", type) => installedModelListSchema.parse(await ipcRenderer.invoke(IPC.modelsLibrary, modelLibraryQuerySchema.parse({ search, ...(type ? { type } : {}) }))),
    refreshLibrary: async () => installedModelListSchema.parse(await ipcRenderer.invoke(IPC.modelsLibraryRefresh)),
    revealModel: async modelId => await ipcRenderer.invoke(IPC.modelsReveal, modelIdSchema.parse({ modelId })),
    useInStudio: async modelId => await ipcRenderer.invoke(IPC.modelsUseInStudio, modelIdSchema.parse({ modelId })),
    getPreview: async previewId => previewResultSchema.parse(await ipcRenderer.invoke(IPC.modelsPreview, previewRequestSchema.parse({ previewId }))),
  },
};
contextBridge.exposeInMainWorld("aureline", api);
