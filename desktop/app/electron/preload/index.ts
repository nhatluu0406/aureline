import { contextBridge, ipcRenderer } from "electron";
import { engineSnapshotSchema, IPC, logEventSchema, settingsSchema, type ForgeDesktopApi } from "../../packages/contracts/index.ts";

const api: ForgeDesktopApi = {
  app: { getInfo: async () => await ipcRenderer.invoke(IPC.appInfo), window: async (action) => await ipcRenderer.invoke(IPC.window, action) },
  engine: {
    getState: async () => engineSnapshotSchema.parse(await ipcRenderer.invoke(IPC.engineState)),
    start: async () => engineSnapshotSchema.parse(await ipcRenderer.invoke(IPC.engineStart)),
    stop: async () => engineSnapshotSchema.parse(await ipcRenderer.invoke(IPC.engineStop)),
    restart: async () => engineSnapshotSchema.parse(await ipcRenderer.invoke(IPC.engineRestart)),
    subscribe(callback) { const listener=(_event:Electron.IpcRendererEvent,value:unknown)=>callback(engineSnapshotSchema.parse(value));ipcRenderer.on(IPC.engineEvent,listener);return()=>ipcRenderer.removeListener(IPC.engineEvent,listener); },
  },
  logs: {
    getRecent: async () => (await ipcRenderer.invoke(IPC.logsGet) as unknown[]).map(value=>logEventSchema.parse(value)),
    subscribe(callback) { const listener=(_event:Electron.IpcRendererEvent,value:unknown)=>callback(logEventSchema.parse(value));ipcRenderer.on(IPC.logEvent,listener);return()=>ipcRenderer.removeListener(IPC.logEvent,listener); },
  },
  classic: { show:async()=>await ipcRenderer.invoke(IPC.classicShow),hide:async()=>await ipcRenderer.invoke(IPC.classicHide),reload:async()=>await ipcRenderer.invoke(IPC.classicReload) },
  settings: { get:async()=>settingsSchema.parse(await ipcRenderer.invoke(IPC.settingsGet)),update:async(patch)=>settingsSchema.parse(await ipcRenderer.invoke(IPC.settingsUpdate,patch)) },
  runtime: { getSummary:async()=>await ipcRenderer.invoke(IPC.runtimeSummary) },
};
contextBridge.exposeInMainWorld("forgeDesktop", api);
