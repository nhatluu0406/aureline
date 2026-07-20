import { app, BrowserWindow, ipcMain } from "electron";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { IPC, settingsPatchSchema } from "../../packages/contracts/index.ts";
import { EngineSupervisor } from "../../packages/process-supervisor/engine-supervisor.ts";
import { loadRuntimeManifest, type RuntimeManifest } from "../../packages/runtime-manifest/index.ts";
import { SettingsStore } from "../../packages/settings/settings-store.ts";
import { ClassicViewController } from "./classic-view.ts";

let mainWindow:BrowserWindow|null=null;let engine:EngineSupervisor;let classic:ClassicViewController;let settings:SettingsStore;let quitting=false;
const devServer=process.env.AURELINE_DEV_SERVER_URL;
if(process.env.AURELINE_USER_DATA)app.setPath("userData",resolve(process.env.AURELINE_USER_DATA));
function manifestCandidate():string{if(process.env.AURELINE_RUNTIME_MANIFEST)return resolve(process.env.AURELINE_RUNTIME_MANIFEST);return app.isPackaged?resolve(app.getPath("userData"),"runtime-manifest.json"):resolve(app.getAppPath(),"engine/manifests/runtime-manifest.example.json")}
async function readManifest():Promise<RuntimeManifest|null>{const candidate=manifestCandidate();if(!existsSync(candidate))return null;try{return await loadRuntimeManifest(candidate)}catch{return null}}
function createWindow():BrowserWindow{
  const window=new BrowserWindow({width:1280,height:820,minWidth:980,minHeight:650,show:false,frame:false,titleBarStyle:"hidden",backgroundColor:"#101217",webPreferences:{preload:resolve(app.getAppPath(),"dist/electron/preload.cjs"),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true}});
  window.webContents.setWindowOpenHandler(()=>({action:"deny"}));window.webContents.on("will-navigate",event=>event.preventDefault());window.once("ready-to-show",()=>window.show());
  void window.loadURL(devServer??pathToFileURL(resolve(app.getAppPath(),"dist/renderer/index.html")).toString());
  window.on("close",event=>{if(!quitting){event.preventDefault();void shutdown().finally(()=>{quitting=true;app.quit()})}});return window;
}
function registerIpc():void{
  const handle=(channel:string,handler:(value?:unknown)=>unknown|Promise<unknown>)=>ipcMain.handle(channel,(_event,value)=>handler(value));
  handle(IPC.appInfo,()=>({version:app.getVersion(),platform:process.platform,packaged:app.isPackaged}));
  handle(IPC.window,(value)=>{if(!["minimize","toggle-maximize","close"].includes(String(value)))throw new Error("Invalid window action");if(value==="minimize")mainWindow?.minimize();else if(value==="toggle-maximize")mainWindow?.isMaximized()?mainWindow.unmaximize():mainWindow?.maximize();else mainWindow?.close()});
  handle(IPC.engineState,()=>engine.snapshot);handle(IPC.engineStart,async()=>await engine.start());handle(IPC.engineStop,async()=>{classic.hide();return await engine.stop()});handle(IPC.engineRestart,async()=>{classic.hide();return await engine.restart()});
  handle(IPC.logsGet,()=>engine.logs.snapshot());handle(IPC.classicShow,async()=>{if(!mainWindow)throw new Error("Window unavailable");await classic.show(mainWindow)});handle(IPC.classicHide,()=>classic.hide());handle(IPC.classicReload,async()=>await classic.reload());
  handle(IPC.settingsGet,()=>settings.value);handle(IPC.settingsUpdate,async(value)=>await settings.update(settingsPatchSchema.parse(value)));
  handle(IPC.runtimeSummary,()=>({configured:engine.snapshot.runtimeId!==null,runtimeId:engine.snapshot.runtimeId,forgeCommit:null,description:engine.snapshot.runtimeId===null?"Chưa cấu hình runtime":"Runtime manifest đã được xác minh"}));
}
async function shutdown():Promise<void>{classic?.hide();await engine?.stop().catch(()=>undefined)}

if(!app.requestSingleInstanceLock())app.quit();else{
  app.on("second-instance",()=>{mainWindow?.show();mainWindow?.focus()});
  app.whenReady().then(async()=>{settings=new SettingsStore(resolve(app.getPath("userData"),"settings.json"));await settings.load();engine=new EngineSupervisor(await readManifest(),app.getPath("userData"));classic=new ClassicViewController(engine);registerIpc();engine.subscribe(value=>mainWindow?.webContents.send(IPC.engineEvent,value));engine.logs.subscribe(value=>mainWindow?.webContents.send(IPC.logEvent,value));mainWindow=createWindow();if(settings.value.launchOnStart)void engine.start();});
  app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit()});app.on("before-quit",event=>{if(!quitting){event.preventDefault();void shutdown().finally(()=>{quitting=true;app.quit()})}});
}
