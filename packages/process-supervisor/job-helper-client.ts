import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, stat } from "node:fs/promises";

type HelperEvent = { event: string; [key: string]: unknown };
type LaunchRequest = { helperPath: string; executable: string; cwd: string; args: string[]; environment: Record<string, string>; secretFrame: string };

function field(value: string | Buffer): Buffer {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4); length.writeUInt32LE(data.byteLength); return Buffer.concat([length, data]);
}
function encode(request: LaunchRequest): Buffer {
  const count = (value: number): Buffer => { const data = Buffer.allocUnsafe(4); data.writeUInt32LE(value); return data; };
  const environment = Object.entries(request.environment);
  return Buffer.concat([
    Buffer.from("AUR1JOB1"), count(1), field(request.executable), field(request.cwd), count(request.args.length),
    ...request.args.map(field), count(environment.length), ...environment.flatMap(([key, value]) => [field(key), field(value)]),
    field(request.secretFrame),
  ]);
}

export class JobHelperClient {
  readonly #waiters = new Set<{ predicate: (event: HelperEvent) => boolean; resolve: (event: HelperEvent) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #remainder = "";
  #ownedPid = 0;
  private constructor(readonly child: ChildProcessWithoutNullStreams, private readonly onEvent: (event: HelperEvent) => void) {
    child.stdout.on("data", (chunk: Buffer) => this.ingest(chunk));
    child.stderr.on("data", (chunk: Buffer) => onEvent({ event: "helper_stderr", message: chunk.toString("utf8").slice(0, 4096) }));
    child.once("exit", (code) => this.rejectAll(new Error(`Job helper exited (${String(code)})`)));
  }
  public static async launch(request: LaunchRequest, onEvent: (event: HelperEvent) => void): Promise<JobHelperClient> {
    if (process.platform !== "win32") throw new Error("Windows Job helper requires win32");
    if (!(await stat(request.helperPath)).isFile() || !(await stat(request.executable)).isFile() || !(await stat(request.cwd)).isDirectory()) throw new Error("Invalid helper runtime paths");
    await access(request.helperPath); await access(request.executable);
    const child = spawn(request.helperPath, [], { cwd: request.cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const client = new JobHelperClient(child, onEvent);
    child.stdin.write(encode(request));
    const first = await client.wait((event) => event.event === "ready" || event.event === "error", 15_000);
    if (first.event !== "ready") throw new Error(`Job helper launch failed at ${String(first.stage ?? "unknown")}: ${String(first.message ?? "unknown")}`);
    if (first.createdSuspended !== true || first.assignedBeforeResume !== true || first.killOnClose !== true) throw new Error("Job helper ownership guarantees missing");
    client.#ownedPid = Number(first.pid);
    return client;
  }
  public get ownedPid(): number { if(this.#ownedPid<=0)throw new Error("Owned process PID unavailable");return this.#ownedPid; }
  public async query(): Promise<{ activeProcesses: number }> {
    const pending = this.wait((event) => event.event === "query" || event.event === "error", 3_000); this.child.stdin.write("QUERY\n");
    const event = await pending; if (event.event === "error") throw new Error(String(event.message)); return { activeProcesses: Number(event.activeProcesses) };
  }
  public async terminate(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const pending = this.wait((event) => event.event === "terminated" || event.event === "error", 5_000); this.child.stdin.write("TERMINATE\n");
    const event = await pending; if (event.event === "error") throw new Error(String(event.message));
  }
  public async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const pending = this.wait((event) => event.event === "closed" || event.event === "error", 5_000); this.child.stdin.write("CLOSE\n");
    await pending; this.child.stdin.end();
    await Promise.race([new Promise<void>((resolve) => this.child.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  }
  public async dispose(): Promise<void> {
    try { await this.terminate(); } catch { /* exact owned job fallback below */ }
    try { await this.close(); } catch { if (this.child.exitCode === null) this.child.kill(); }
  }
  private ingest(chunk: Buffer): void {
    const lines = (this.#remainder + chunk.toString("utf8")).split(/\r?\n/u); this.#remainder = lines.pop() ?? "";
    for (const line of lines) { if (!line) continue; try { this.publish(JSON.parse(line) as HelperEvent); } catch { this.onEvent({ event: "protocol_error", message: "Invalid helper output" }); } }
  }
  private publish(event: HelperEvent): void { this.onEvent(event); for (const waiter of this.#waiters) if (waiter.predicate(event)) { clearTimeout(waiter.timer); this.#waiters.delete(waiter); waiter.resolve(event); } }
  private wait(predicate: (event: HelperEvent) => boolean, timeoutMs: number): Promise<HelperEvent> {
    return new Promise((resolve, reject) => { const waiter = { predicate, resolve, reject, timer: setTimeout(() => { this.#waiters.delete(waiter); reject(new Error("Job helper response timeout")); }, timeoutMs) }; this.#waiters.add(waiter); });
  }
  private rejectAll(error: Error): void { for (const waiter of this.#waiters) { clearTimeout(waiter.timer); waiter.reject(error); } this.#waiters.clear(); }
}
