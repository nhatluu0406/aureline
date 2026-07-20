import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import type { DesktopErrorCode, EngineSnapshot } from "../contracts/index.ts";
import type { RuntimeManifest } from "../runtime-manifest/index.ts";
import { LocalBridge } from "../local-bridge/secure-proxy.ts";
import { JobHelperClient } from "./job-helper-client.ts";
import { LogBuffer } from "./log-buffer.ts";

const LOOPBACK = "127.0.0.1";
const token = (): string => randomBytes(32).toString("base64url");
async function port(): Promise<number> { const server=createServer();await new Promise<void>((ok,fail)=>server.once("error",fail).listen({host:LOOPBACK,port:0,exclusive:true},ok));const address=server.address();if(address===null||typeof address==="string")throw new Error("Port allocation failed");await new Promise<void>((ok,fail)=>server.close(error=>error?fail(error):ok()));return address.port; }
async function exists(path: string, kind: "file" | "directory"): Promise<void> { const value=await stat(path);if(kind==="file"&&!value.isFile())throw new Error(`${path} is not a file`);if(kind==="directory"&&!value.isDirectory())throw new Error(`${path} is not a directory`); }

export class EngineSupervisor {
  readonly logs = new LogBuffer(250);
  readonly #listeners = new Set<(snapshot: EngineSnapshot) => void>();
  #snapshot: EngineSnapshot;
  #helper: JobHelperClient | null = null;
  #bridge: LocalBridge | null = null;
  #edgeToken: string | null = null;
  #backendToken: string | null = null;
  #generation = 0;
  #poller: NodeJS.Timeout | null = null;
  #operation: Promise<EngineSnapshot> | null = null;
  public constructor(private readonly manifest: RuntimeManifest | null, private readonly dataRoot: string) {
    this.#snapshot = { state: manifest===null?"not_configured":"stopped", phase: manifest===null?"Runtime chưa được cấu hình":"Sẵn sàng khởi động", startedAt:null, uptimeMs:0, readiness:"unknown", backendProtected:false, runtimeId:manifest?.runtimeId??null, error:manifest===null?{code:"RUNTIME_NOT_CONFIGURED",message:"Chưa tìm thấy runtime manifest hợp lệ."}:null };
  }
  public get snapshot(): EngineSnapshot { return { ...this.#snapshot, uptimeMs:this.#snapshot.startedAt===null?0:Date.now()-Date.parse(this.#snapshot.startedAt) }; }
  public get classicOrigin(): string | null { return this.#bridge?.origin??null; }
  public get classicEdgeToken(): string | null { return this.#edgeToken; }
  public get protectedBackendOrigin(): string | null { return this.#backendToken===null?null:this.#backendOrigin; }
  public get protectedBackendToken(): string | null { return this.#backendToken; }
  #backendOrigin: string | null = null;
  public subscribe(listener:(state:EngineSnapshot)=>void):()=>void{this.#listeners.add(listener);return()=>this.#listeners.delete(listener)}
  public async start(): Promise<EngineSnapshot> { if(this.#operation!==null)return this.#operation;if(this.#snapshot.state==="ready")return this.snapshot;this.#operation=this.startInternal();try{return await this.#operation}finally{this.#operation=null} }
  public async stop(): Promise<EngineSnapshot> { if(this.#operation!==null)await this.#operation.catch(()=>undefined);if(this.#snapshot.state==="stopped"||this.#snapshot.state==="not_configured")return this.snapshot;this.#operation=this.stopInternal();try{return await this.#operation}finally{this.#operation=null} }
  public async restart(): Promise<EngineSnapshot> { await this.stop();return await this.start(); }
  private set(patch:Partial<EngineSnapshot>):void{this.#snapshot={...this.#snapshot,...patch};for(const listener of this.#listeners)listener(this.snapshot)}
  private fail(code:DesktopErrorCode,message:string,details?:string):never{this.set({state:"failed",phase:"Không thể khởi động Forge",readiness:"unknown",backendProtected:false,error:{code,message,...(details===undefined?{}:{details})}});this.logs.push("app","error",`${code}: ${message}${details?`: ${details}`:""}`);throw new Error(`${message}${details?`: ${details}`:""}`)}
  private async startInternal():Promise<EngineSnapshot>{
    if(this.manifest===null)return this.fail("RUNTIME_NOT_CONFIGURED","Chưa cấu hình runtime Forge.");
    this.set({state:"starting",phase:"Đang xác minh runtime",readiness:"waiting",error:null});
    try{await Promise.all([exists(this.manifest.pythonExecutable,"file"),exists(this.manifest.helperExecutable,"file"),exists(this.manifest.launcherAdapter,"file"),exists(this.manifest.forgeRoot,"directory")])}catch(error){return this.fail("RUNTIME_INVALID","Runtime manifest trỏ tới đường dẫn không hợp lệ.",error instanceof Error?error.message:String(error))}
    const backendPort=await port();this.#generation+=1;const backendToken=token(),edgeToken=token(),instanceId=randomBytes(16).toString("hex");this.logs.addSecret(backendToken);this.logs.addSecret(edgeToken);
    const engineRoot=resolve(this.dataRoot,"engine");const data=resolve(engineRoot,"data"),models=resolve(engineRoot,"models"),outputs=resolve(engineRoot,"outputs");await Promise.all([mkdir(data,{recursive:true}),mkdir(models,{recursive:true}),mkdir(outputs,{recursive:true})]);
    const builtins=await readdir(resolve(this.manifest.forgeRoot,"extensions-builtin"),{withFileTypes:true}).catch(()=>[]);await writeFile(resolve(data,"config.json"),JSON.stringify({disabled_extensions:builtins.filter(v=>v.isDirectory()).map(v=>v.name),disable_all_extensions:"none",auto_launch_browser:"None",clean_temp_dir_at_start:false}),"utf8");
    const args=[this.manifest.launcherAdapter,"--skip-prepare-environment","--skip-install","--skip-version-check","--skip-torch-cuda-test","--always-cpu","--ui-debug-mode","--api","--no-download-sd-model","--do-not-download-clip","--server-name",LOOPBACK,"--port",String(backendPort),"--data-dir",data,"--models-dir",models,"--ckpt-dir",resolve(models,"Stable-diffusion"),"--gradio-allowed-path",data];
    const frame=`${JSON.stringify({frameVersion:1,protocolVersion:1,token:backendToken,instanceId,expectedHost:`${LOOPBACK}:${backendPort}`,launchGeneration:this.#generation,forgeRoot:this.manifest.forgeRoot})}\n`;
    this.set({phase:"Đang tạo process boundary an toàn"});
    try{this.#helper=await JobHelperClient.launch({helperPath:this.manifest.helperExecutable,executable:this.manifest.pythonExecutable,cwd:this.manifest.forgeRoot,args,environment:{...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined)),GRADIO_ANALYTICS_ENABLED:"False",HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1",HF_DATASETS_OFFLINE:"1",PYTHONUNBUFFERED:"1"},secretFrame:frame},event=>{
      if(event.event==="log")this.logs.push("forge","info",String(event.message??""));else if(event.event==="error"||event.event==="helper_stderr")this.logs.push("helper","error",String(event.message??event.event));
    })}catch(error){return this.fail("HELPER_START_FAILED","Rust Job helper không thể sở hữu Forge.",error instanceof Error?error.message:String(error))}
    this.set({phase:"Đang chờ protected readiness"});const origin=`http://${LOOPBACK}:${backendPort}`;
    try{
      const firstStatus=await this.waitFirstProtectedResponse(origin,60_000);if(firstStatus!==401)throw new Error(`first protected response was ${firstStatus}`);
      const identity=await this.waitIdentity(origin,backendToken,instanceId,this.#generation,150_000);
      if(identity.service!=="aureline-engine-bridge")throw new Error("unexpected service identity");
      await this.waitRoute(origin,backendToken,"/sdapi/v1/options",30_000);
      this.#bridge=await LocalBridge.start(origin,edgeToken,backendToken);this.#edgeToken=edgeToken;this.#backendToken=backendToken;this.#backendOrigin=origin;
    }catch(error){await this.#helper.dispose();this.#helper=null;return this.fail("ENGINE_READINESS_TIMEOUT","Forge không đạt protected readiness.",error instanceof Error?error.message:String(error))}
    this.set({state:"ready",phase:"Forge đã sẵn sàng",startedAt:new Date().toISOString(),readiness:"ready",backendProtected:true,error:null});this.logs.push("app","info","Forge protected backend và Classic bridge đã sẵn sàng.");
    this.#poller=setInterval(()=>void this.pollHealth(),2000);return this.snapshot;
  }
  private async stopInternal():Promise<EngineSnapshot>{this.set({state:"stopping",phase:"Đang đóng Classic bridge"});if(this.#poller){clearInterval(this.#poller);this.#poller=null}try{await this.#bridge?.close()}catch(error){this.logs.push("bridge","warn",`Bridge close: ${String(error)}`)}this.#bridge=null;this.#edgeToken=null;this.#backendToken=null;this.#backendOrigin=null;this.set({phase:"Đang đóng process ownership"});try{await this.#helper?.dispose()}catch(error){this.logs.push("helper","error",`Helper cleanup: ${String(error)}`)}this.#helper=null;this.set({state:"stopped",phase:"Đã dừng",startedAt:null,readiness:"unknown",backendProtected:false,error:null});return this.snapshot}
  private async pollHealth():Promise<void>{try{const query=await this.#helper?.query();if(query&&query.activeProcesses===0){this.set({state:"failed",phase:"Forge đã thoát ngoài dự kiến",readiness:"unknown",backendProtected:false,error:{code:"ENGINE_CRASHED",message:"Forge process đã dừng."}});if(this.#poller)clearInterval(this.#poller)}}catch(error){this.logs.push("helper","warn",`Health poll failed: ${String(error)}`)}}
  private async fetchBounded(origin:string,path:string,tokenValue:string|undefined,timeoutMs:number):Promise<Response>{return await fetch(`${origin}${path}`,{redirect:"manual",signal:AbortSignal.timeout(timeoutMs),headers:tokenValue?{"x-forge-bridge-authorization":`Bearer ${tokenValue}`,Origin:"http://aureline.internal"}:{}})}
  private async waitFirstProtectedResponse(origin:string,timeoutMs:number):Promise<number>{const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if((await this.#helper?.query())?.activeProcesses===0)throw new Error("Forge exited before opening listener");try{return (await this.fetchBounded(origin,"/",undefined,300)).status}catch{}await new Promise(r=>setTimeout(r,100))}throw new Error("listener did not open before timeout")}
  private async waitIdentity(origin:string,tokenValue:string,instanceId:string,generation:number,timeoutMs:number):Promise<Record<string,unknown>>{const deadline=Date.now()+timeoutMs;let last="no response";while(Date.now()<deadline){try{const response=await this.fetchBounded(origin,"/bridge/identity",tokenValue,1500);if(response.ok){const value=await response.json() as Record<string,unknown>;if(value.protocolVersion===1&&value.instanceId===instanceId&&value.launchGeneration===generation)return value;last="identity mismatch"}else last=`HTTP ${response.status}`}catch(error){last=String(error)}await new Promise(r=>setTimeout(r,200))}throw new Error(`identity timeout: ${last}`)}
  private async waitRoute(origin:string,tokenValue:string,path:string,timeoutMs:number):Promise<void>{const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){try{const response=await this.fetchBounded(origin,path,tokenValue,1500);if(response.ok)return}catch{}await new Promise(r=>setTimeout(r,250))}throw new Error(`${path} did not become ready`)}
}
