import { session, WebContentsView, type BrowserWindow } from "electron";
import { randomBytes } from "node:crypto";
import { BACKEND_AUTH_HEADER, EDGE_AUTH_HEADER, INTERNAL_ORIGIN } from "../../packages/local-bridge/secure-proxy.ts";
import type { EngineSupervisor } from "../../packages/process-supervisor/engine-supervisor.ts";

export class ClassicViewController {
  #view: WebContentsView | null = null;
  #window: BrowserWindow | null = null;
  public constructor(private readonly engine: EngineSupervisor) {}
  public async show(window: BrowserWindow): Promise<void> {
    const origin=this.engine.classicOrigin,edgeToken=this.engine.classicEdgeToken,backendOrigin=this.engine.protectedBackendOrigin,backendToken=this.engine.protectedBackendToken;if(origin===null||edgeToken===null||backendOrigin===null||backendToken===null)throw new Error("Classic Forge requires a ready engine");
    if(this.#view!==null){this.layout();return}
    const partition=`forge-classic-${randomBytes(8).toString("hex")}`;const isolated=session.fromPartition(partition,{cache:true});
    isolated.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    isolated.on("will-download",(event)=>event.preventDefault());
    const proxyWebSocketOrigin=origin.replace("http://","ws://"),backendWebSocketOrigin=backendOrigin.replace("http://","ws://");
    isolated.webRequest.onBeforeSendHeaders({urls:[`${origin}/*`,`${proxyWebSocketOrigin}/*`,`${backendOrigin}/*`,`${backendWebSocketOrigin}/*`]},(details,callback)=>{
      const headers={...details.requestHeaders};
      if(details.url.startsWith(`${origin}/`)||details.url.startsWith(`${proxyWebSocketOrigin}/`))headers[EDGE_AUTH_HEADER]=`Bearer ${edgeToken}`;
      else{headers[BACKEND_AUTH_HEADER]=`Bearer ${backendToken}`;headers.Origin=INTERNAL_ORIGIN;}
      callback({requestHeaders:headers});
    });
    const view=new WebContentsView({webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,webSecurity:true,partition}});this.#view=view;this.#window=window;
    view.webContents.setWindowOpenHandler(()=>({action:"deny"}));
    view.webContents.on("will-navigate",(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault()});
    view.webContents.on("will-redirect",(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault()});
    view.webContents.on("context-menu",event=>event.preventDefault());
    view.webContents.on("render-process-gone",()=>this.engine.logs.push("app","error","Classic Forge renderer đã dừng."));
    window.contentView.addChildView(view);window.on("resize",this.layout);this.layout();await view.webContents.loadURL(origin);
  }
  public async reload():Promise<void>{if(this.#view===null)throw new Error("Classic view is not attached");this.#view.webContents.reload()}
  public hide():void{if(this.#view&&this.#window)this.#window.contentView.removeChildView(this.#view);this.#view?.webContents.close();this.#view=null;this.#window=null}
  public layout=():void=>{if(!this.#view||!this.#window)return;const size=this.#window.getContentSize(),width=size[0]??980,height=size[1]??650;this.#view.setBounds({x:240,y:112,width:Math.max(320,width-240),height:Math.max(240,height-112)})}
  public async inspectStorage():Promise<{url:string;local:string[];session:string[];indexedDb:string[]}>{if(!this.#view)throw new Error("Classic view missing");return await this.#view.webContents.executeJavaScript(`(async()=>({url:location.href,local:Object.values(localStorage),session:Object.values(sessionStorage),indexedDb:(await indexedDB.databases()).map(v=>v.name||'')}))()`,true) as {url:string;local:string[];session:string[];indexedDb:string[]}}
}
