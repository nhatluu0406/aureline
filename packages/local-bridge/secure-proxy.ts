import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Transform, type Duplex } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";

export const EDGE_AUTH_HEADER = "x-aureline-authorization";
export const BACKEND_AUTH_HEADER = "x-forge-bridge-authorization";
export const INTERNAL_ORIGIN = "http://aureline.internal";
const LOOPBACK = "127.0.0.1";
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const bearer = (token: string): string => `Bearer ${token}`;
function equal(left: string | undefined, right: string): boolean { if (left === undefined) return false; const a=Buffer.from(left),b=Buffer.from(right); return a.length===b.length&&timingSafeEqual(a,b); }
function json(response: ServerResponse, status: number, body: object): void { if(response.headersSent){response.destroy();return}const data=Buffer.from(JSON.stringify(body));response.writeHead(status,{"content-type":"application/json","content-length":data.length,"cache-control":"no-store"});response.end(data); }

export class LocalBridge {
  readonly #server = createServer((request, response) => this.handle(request, response));
  readonly #webSocketServer = new WebSocketServer({ noServer: true });
  readonly #sockets = new Set<Socket>(); readonly #webSockets = new Set<WebSocket>();
  #origin = "";
  private constructor(private readonly upstream: URL, private readonly edgeToken: string, private readonly backendToken: string) {
    if (upstream.protocol !== "http:" || upstream.hostname !== LOOPBACK) throw new Error("Backend must be explicit IPv4 loopback");
    this.#server.on("connection", (socket) => { this.#sockets.add(socket); socket.once("close", () => this.#sockets.delete(socket)); });
    this.#server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
  }
  public static async start(upstreamOrigin: string, edgeToken: string, backendToken: string): Promise<LocalBridge> {
    const bridge = new LocalBridge(new URL(upstreamOrigin), edgeToken, backendToken);
    await new Promise<void>((resolve, reject) => { bridge.#server.once("error", reject); bridge.#server.listen({ host: LOOPBACK, port: 0, exclusive: true }, resolve); });
    const address = bridge.#server.address(); if (address === null || typeof address === "string") throw new Error("Bridge address unavailable"); bridge.#origin=`http://${LOOPBACK}:${address.port}`; return bridge;
  }
  public get origin(): string { return this.#origin; }
  public async close(): Promise<void> { for(const ws of this.#webSockets)ws.terminate();for(const socket of this.#sockets)socket.destroy();await new Promise<void>((resolve,reject)=>this.#server.close((error)=>error?reject(error):resolve())); }
  private authorized(request: IncomingMessage): boolean {
    if (request.headers.host !== new URL(this.#origin).host) return false;
    if (request.headers.origin !== undefined && request.headers.origin !== this.#origin) return false;
    if (request.headers["sec-fetch-site"] === "cross-site") return false;
    const value=request.headers[EDGE_AUTH_HEADER]; return equal(Array.isArray(value)?value[0]:value,bearer(this.edgeToken));
  }
  private headers(request: IncomingMessage): OutgoingHttpHeaders { const output:OutgoingHttpHeaders={};for(const [name,value] of Object.entries(request.headers)){if(value===undefined||HOP.has(name)||name===EDGE_AUTH_HEADER||name==="host"||name==="accept-encoding"||name.startsWith("x-forwarded-"))continue;output[name]=value}output.host=this.upstream.host;output[BACKEND_AUTH_HEADER]=bearer(this.backendToken);if(request.headers.origin!==undefined)output.origin=INTERNAL_ORIGIN;return output; }
  private handle(request: IncomingMessage, response: ServerResponse): void {
    if(!this.authorized(request)){json(response,401,{error:"unauthorized"});return}
    const upstream=httpRequest({hostname:this.upstream.hostname,port:this.upstream.port,method:request.method,path:request.url,headers:this.headers(request),timeout:10_000},(incoming)=>{
      upstream.setTimeout(0);const headers:OutgoingHttpHeaders={};for(const [name,value] of Object.entries(incoming.headers)){if(value!==undefined&&!HOP.has(name))headers[name]=value}
      if(typeof headers.location==="string"&&headers.location.startsWith(this.upstream.origin))headers.location=this.#origin+headers.location.slice(this.upstream.origin.length);
      const contentType=String(headers["content-type"]??"");const length=Number(headers["content-length"]??0);const rewrite=(contentType.includes("text/html")||contentType.includes("application/json"))&&(!Number.isFinite(length)||length<=2*1024*1024);
      if(!rewrite){response.writeHead(incoming.statusCode??502,headers);incoming.pipe(response);return}
      const chunks:Buffer[]=[];let total=0;incoming.on("data",(chunk:Buffer)=>{total+=chunk.length;if(total<=2*1024*1024)chunks.push(chunk);else incoming.destroy(new Error("rewrite_response_too_large"))});incoming.once("end",()=>{const body=Buffer.from(Buffer.concat(chunks).toString("utf8").split(this.upstream.origin).join(this.#origin));delete headers["content-length"];headers["content-length"]=body.length;response.writeHead(incoming.statusCode??502,headers);response.end(body)});incoming.once("error",()=>json(response,502,{error:"upstream_response_error"}));
    });
    let bytes=0;const limiter=new Transform({transform(chunk:Buffer,_encoding,callback){bytes+=chunk.length;callback(bytes<=64*1024*1024?null:new Error("request_too_large"),chunk)}});
    limiter.once("error",()=>{upstream.destroy();json(response,413,{error:"request_too_large"})});upstream.once("timeout",()=>upstream.destroy(new Error("timeout")));upstream.once("error",()=>json(response,502,{error:"upstream_unavailable"}));request.once("aborted",()=>upstream.destroy());request.pipe(limiter).pipe(upstream);
  }
  private upgrade(request:IncomingMessage,socket:Duplex,head:Buffer):void{
    if(!this.authorized(request)){socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");return}
    this.#webSocketServer.handleUpgrade(request,socket,head,(client)=>{this.#webSockets.add(client);const protocols=request.headers["sec-websocket-protocol"]?.split(",").map(v=>v.trim());const upstream=new WebSocket(`ws://${this.upstream.host}${request.url??"/"}`,protocols,{headers:{[BACKEND_AUTH_HEADER]:bearer(this.backendToken),Origin:INTERNAL_ORIGIN}});this.#webSockets.add(upstream);const pending:Array<{data:RawData;binary:boolean}>=[];
      client.on("message",(data,binary)=>upstream.readyState===WebSocket.OPEN?upstream.send(data,{binary}):pending.push({data,binary}));upstream.once("open",()=>{for(const item of pending)upstream.send(item.data,{binary:item.binary});upstream.on("message",(data,binary)=>client.send(data,{binary}))});
      const close=()=>{if(client.readyState===WebSocket.OPEN)client.close();if(upstream.readyState<2)upstream.close()};client.once("close",close);upstream.once("close",close);upstream.once("error",close);client.once("close",()=>this.#webSockets.delete(client));upstream.once("close",()=>this.#webSockets.delete(upstream));});
  }
}
