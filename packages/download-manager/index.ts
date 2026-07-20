import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { downloadRecordSchema, modelTypeSchema, type DownloadRecord, type SafeModelError } from "../contracts/index.ts";
import { ModelLibrary, ModelLibraryError, sanitizeModelFileName } from "../model-library/index.ts";
import type { ResolvedCivitaiFile } from "../model-sources/civitai/index.ts";

type Fetch = typeof globalThis.fetch;
type Internal = { public: DownloadRecord; source: ResolvedCivitaiFile; rootId: string; finalPath: string; partialPath: string; sidecarPath: string; apiKey?: string; controller: AbortController | undefined; intent: "pause" | "cancel" | undefined; deletePartial?: boolean; attempts: number };
type PersistedSidecar = { schemaVersion: 1; provider: "civitai"; providerHost: string; modelId: number; versionId: number; fileId: number; fileName: string; expectedBytes?: number; sha256?: string; receivedBytes: number; downloadUrl: string };

export class DownloadManager {
  readonly #downloads = new Map<string, Internal>();
  readonly #listeners = new Set<(record: DownloadRecord) => void>();
  #persisting = Promise.resolve();
  public constructor(private readonly library: ModelLibrary, private readonly request: Fetch = globalThis.fetch, private readonly allowPrivateFixture = false, private readonly statePath?: string) {}
  public async load(): Promise<void> {
    if (!this.statePath) return;
    try {
      const value = JSON.parse(await readFile(this.statePath, "utf8")) as { schemaVersion: number; items: Array<Omit<Internal, "controller" | "intent" | "apiKey">> };
      if (value.schemaVersion !== 1 || !Array.isArray(value.items)) return;
      for (const raw of value.items) {
        const publicRecord = downloadRecordSchema.parse(raw.public); const interrupted = ["queued", "preflighting", "downloading", "verifying", "installing"].includes(publicRecord.state);
        const source = validatePersistedSource(raw.source); const rootPath = this.library.rootPath(raw.rootId, source.modelType); const fileName = sanitizeModelFileName(publicRecord.fileName); const finalPath = join(rootPath, fileName); const partialPath = `${finalPath}.aureline.part`; const sidecarPath = `${partialPath}.aureline.json`;
        const sidecar = await readSidecar(sidecarPath); const partial = await partialSize(partialPath);
        if (sidecar?.downloadUrl) source.downloadUrl = safePersistedUrl(sidecar.downloadUrl);
        const next = interrupted ? downloadRecordSchema.parse({ ...publicRecord, state: partial > 0 && sidecar ? "paused" : "failed", receivedBytes: partial, error: { code: "DOWNLOAD_FAILED", message: partial > 0 && sidecar ? "Download was interrupted and can be resumed." : "Download was interrupted before resumable data was saved.", retryable: partial === 0 }, canPause: false, canResume: partial > 0 && Boolean(sidecar), canRetry: partial === 0 }) : publicRecord;
        this.#downloads.set(next.id, { ...raw, public: next, source, finalPath, partialPath, sidecarPath, controller: undefined, intent: undefined, attempts: 0 });
      }
    } catch { this.#downloads.clear(); }
  }
  public subscribe(listener: (record: DownloadRecord) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  public list(): DownloadRecord[] { return [...this.#downloads.values()].map(value => value.public); }
  public setEngineRefresh(id: string, engineRefresh: NonNullable<DownloadRecord["engineRefresh"]>): void { const item = this.require(id); this.set(item, { engineRefresh }); }

  public async start(source: ResolvedCivitaiFile, rootId: string, apiKey?: string): Promise<DownloadRecord> {
    const destination = this.library.rootPath(rootId, source.modelType); await mkdir(destination, { recursive: true });
    const fileName = sanitizeModelFileName(source.fileName); const finalPath = join(destination, fileName); const partialPath = `${finalPath}.aureline.part`; const sidecarPath = `${partialPath}.aureline.json`;
    try { await stat(finalPath); throw downloadError("DOWNLOAD_ALREADY_EXISTS", "A model with this filename already exists."); } catch (error) { if (error instanceof DownloadManagerError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const id = randomUUID();
    const publicRecord = downloadRecordSchema.parse({ id, state: "queued", fileName, modelName: source.modelName, versionName: source.versionName, receivedBytes: 0, ...(source.sizeBytes !== undefined ? { totalBytes: source.sizeBytes } : {}), destination: this.library.roots().find(root => root.id === rootId)?.location ?? "Aureline models", canPause: false, canResume: false, canRetry: false });
    const internal: Internal = { public: publicRecord, source, rootId, finalPath, partialPath, sidecarPath, ...(apiKey ? { apiKey } : {}), controller: undefined, intent: undefined, attempts: 0 };
    this.#downloads.set(id, internal); this.emit(internal); void this.run(internal); return publicRecord;
  }

  public pause(id: string): DownloadRecord { const item = this.require(id); if (item.public.state !== "downloading") return item.public; item.intent = "pause"; item.controller?.abort(); return item.public; }
  public resume(id: string, apiKey?: string): DownloadRecord { const item = this.require(id); if (item.public.state !== "paused" && !(item.public.state === "cancelled" && item.public.canResume)) return item.public; item.intent = undefined; if (apiKey) item.apiKey = apiKey; void this.run(item); return item.public; }
  public cancel(id: string, deletePartial: boolean): DownloadRecord { const item = this.require(id); if (["completed", "cancelled"].includes(item.public.state)) return item.public; item.intent = "cancel"; item.deletePartial = deletePartial; item.controller?.abort(); if (!item.controller) void this.finishCancel(item); return item.public; }
  public retry(id: string): DownloadRecord { const item = this.require(id); if (item.public.state !== "failed") return item.public; item.intent = undefined; item.attempts = 0; if (item.public.error?.code === "DOWNLOAD_HASH_MISMATCH") void Promise.all([rm(item.partialPath, { force: true }), rm(item.sidecarPath, { force: true })]).then(() => this.run(item)); else void this.run(item); return item.public; }

  private require(id: string): Internal { const item = this.#downloads.get(id); if (!item) throw downloadError("DOWNLOAD_FAILED", "Download record was not found."); return item; }
  private set(item: Internal, patch: Partial<DownloadRecord>): void { item.public = downloadRecordSchema.parse({ ...item.public, ...patch }); this.emit(item); }
  private emit(item: Internal): void { for (const listener of this.#listeners) listener(item.public); this.queuePersist(); }
  private queuePersist(): void { if (!this.statePath) return; this.#persisting = this.#persisting.then(async () => { await mkdir(dirname(this.statePath!), { recursive: true }); const temporary = `${this.statePath}.tmp`; const items = [...this.#downloads.values()].map(({ controller: _controller, intent: _intent, apiKey: _apiKey, ...item }) => ({ ...item, source: { ...item.source, downloadUrl: safePersistedUrl(item.source.downloadUrl).toString() } })); await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, items }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, this.statePath!); }).catch(() => undefined); }

  private async run(item: Internal): Promise<void> {
    try {
      this.set(item, { state: "preflighting", error: undefined, canPause: false, canResume: false, canRetry: false });
      const preflight = await this.library.preflight(item.rootId, item.source.sizeBytes); if (!preflight.sufficient) throw downloadError("DOWNLOAD_DISK_SPACE_LOW", preflight.warning ?? "Not enough free disk space.");
      let offset = await partialSize(item.partialPath); const prior = await readSidecar(item.sidecarPath);
      if (offset > 0 && (!prior || prior.fileId !== item.source.fileId || prior.versionId !== item.source.versionId || prior.providerHost !== item.source.providerHost)) throw downloadError("DOWNLOAD_FAILED", "The partial download does not match this model file.");
      item.controller = new AbortController(); const startedAt = Date.now(); let lastEmit = 0; let received = offset;
      this.set(item, { state: "downloading", receivedBytes: offset, canPause: true, canResume: false, canRetry: false });
      const response = await this.fetchDownload(item, offset);
      if (offset > 0 && response.status === 200) { await rm(item.partialPath, { force: true }); offset = 0; received = 0; }
      else if (offset > 0) validateContentRange(response.headers.get("content-range"), offset);
      if (!response.body) throw downloadError("DOWNLOAD_FAILED", "The download response did not contain a file body.", true);
      const contentLength = parseLength(response.headers.get("content-length")); const totalBytes = response.status === 206 && contentLength !== undefined ? offset + contentLength : contentLength ?? item.source.sizeBytes;
      const sidecar: PersistedSidecar = { schemaVersion: 1, provider: "civitai", providerHost: item.source.providerHost, modelId: item.source.modelId, versionId: item.source.versionId, fileId: item.source.fileId, fileName: item.public.fileName, ...(item.source.sizeBytes !== undefined ? { expectedBytes: item.source.sizeBytes } : {}), ...(item.source.sha256 ? { sha256: item.source.sha256 } : {}), receivedBytes: offset, downloadUrl: safePersistedUrl(item.source.downloadUrl) };
      await writeSidecar(item.sidecarPath, sidecar);
      const file = await open(item.partialPath, offset > 0 ? "a" : "w", 0o600);
      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read(); if (done) break; await file.write(value); received += value.byteLength;
          const now = Date.now(); if (now - lastEmit >= 250) { const elapsed = Math.max(1, now - startedAt) / 1_000; const speed = Math.max(0, (received - offset) / elapsed); this.set(item, { receivedBytes: received, ...(totalBytes !== undefined ? { totalBytes } : {}), bytesPerSecond: speed, ...(totalBytes !== undefined && speed > 0 ? { etaSeconds: Math.max(0, (totalBytes - received) / speed) } : {}) }); lastEmit = now; }
        }
        await file.sync();
      } finally { await file.close(); }
      if (item.intent === "pause" || item.intent === "cancel") throw new DOMException("Aborted", "AbortError");
      this.set(item, { state: "verifying", receivedBytes: received, ...(totalBytes !== undefined ? { totalBytes } : {}), canPause: false });
      if (item.source.sizeBytes !== undefined && received !== item.source.sizeBytes) throw downloadError("DOWNLOAD_FAILED", `Downloaded size did not match the expected ${item.source.sizeBytes} bytes.`, true);
      const sha256 = await hashFile(item.partialPath); if (item.source.sha256 && sha256 !== item.source.sha256.toLowerCase()) throw downloadError("DOWNLOAD_HASH_MISMATCH", "SHA-256 verification failed. The partial file was not installed.", true);
      this.set(item, { state: "installing" });
      try { await stat(item.finalPath); throw downloadError("DOWNLOAD_ALREADY_EXISTS", "A model appeared at the destination before installation."); } catch (error) { if (error instanceof DownloadManagerError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(item.partialPath, item.finalPath); await rm(item.sidecarPath, { force: true });
      const installed = await this.library.register(item.finalPath, { type: item.source.modelType, name: item.source.modelName, fileName: basename(item.finalPath), sizeBytes: received, sha256, source: "civitai", providerModelId: item.source.modelId, providerVersionId: item.source.versionId, providerFileId: item.source.fileId, ...(item.source.baseModel ? { baseModel: item.source.baseModel } : {}) });
      this.set(item, { state: "completed", receivedBytes: received, installedModelId: installed.id, canPause: false, canResume: false, canRetry: false, bytesPerSecond: undefined, etaSeconds: undefined });
    } catch (error) {
      if (item.intent === "pause") { await updateSidecarProgress(item.sidecarPath, await partialSize(item.partialPath)); item.intent = undefined; this.set(item, { state: "paused", canPause: false, canResume: true, canRetry: false, bytesPerSecond: undefined, etaSeconds: undefined }); return; }
      if (item.intent === "cancel") { await this.finishCancel(item); return; }
      const detail = asDownloadError(error); this.set(item, { state: "failed", error: detail, canPause: false, canResume: false, canRetry: detail.retryable, bytesPerSecond: undefined, etaSeconds: undefined });
    } finally { item.controller = undefined; }
  }

  private async finishCancel(item: Internal): Promise<void> { if (item.deletePartial) { await rm(item.partialPath, { force: true }); await rm(item.sidecarPath, { force: true }); } else await updateSidecarProgress(item.sidecarPath, await partialSize(item.partialPath)); this.set(item, { state: "cancelled", error: { code: "DOWNLOAD_CANCELLED", message: item.deletePartial ? "Download cancelled and partial data removed." : "Download cancelled; partial data was kept for resume.", retryable: false }, canPause: false, canResume: !item.deletePartial, canRetry: false, bytesPerSecond: undefined, etaSeconds: undefined }); }

  private async fetchDownload(item: Internal, offset: number): Promise<Response> {
    let current = validateDownloadUrl(item.source.downloadUrl); let redirects = 0;
    while (true) {
      await assertPublicNetworkDestination(current, this.allowPrivateFixture);
      const sameProvider = current.hostname.toLowerCase().replace(/^www\./, "") === item.source.providerHost;
      let response: Response;
      try { response = await this.request(current, { headers: { ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}), ...(sameProvider && item.apiKey ? { Authorization: `Bearer ${item.apiKey}` } : {}) }, redirect: "manual", signal: item.controller!.signal }); }
      catch (error) { if ((error as Error).name === "AbortError") throw error; if (item.attempts++ < 2) { await retryDelay(250 * 2 ** item.attempts, item.controller!.signal); continue; } throw downloadError("DOWNLOAD_FAILED", "The model download connection failed after bounded retries.", true); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (++redirects > 5) throw downloadError("DOWNLOAD_FAILED", "The model download exceeded the redirect limit.");
        const location = response.headers.get("location"); if (!location) throw downloadError("DOWNLOAD_FAILED", "The model download redirect had no destination.");
        current = validateDownloadUrl(new URL(location, current).toString()); continue;
      }
      if (response.status === 401 || response.status === 403) throw downloadError(item.apiKey ? "CIVITAI_AUTH_INVALID" : "CIVITAI_AUTH_REQUIRED", item.apiKey ? "The saved Civitai API key was rejected." : "This model file requires a Civitai API key.");
      if (response.status === 429 && item.attempts++ < 2) { await retryDelay(retryAfterMs(response.headers.get("retry-after")) ?? 250 * 2 ** item.attempts, item.controller!.signal); continue; }
      if (response.status >= 500 && item.attempts++ < 2) { await retryDelay(250 * 2 ** item.attempts, item.controller!.signal); continue; }
      if (response.status === 429) throw downloadError("CIVITAI_RATE_LIMITED", "Civitai rate-limited the download after bounded retries.", true);
      if (offset > 0 && response.status !== 206 && response.status !== 200) throw downloadError("DOWNLOAD_RANGE_UNSUPPORTED", "The server could not resume this download.", true);
      if (!response.ok) throw downloadError("DOWNLOAD_FAILED", `The model download failed with HTTP ${response.status}.`, response.status >= 500);
      item.attempts = 0; return response;
    }
  }
}

export class DownloadManagerError extends Error { public constructor(public readonly detail: SafeModelError) { super(detail.message); } }
export function asDownloadError(error: unknown): SafeModelError { return error instanceof DownloadManagerError || error instanceof ModelLibraryError ? error.detail : { code: "DOWNLOAD_FAILED", message: "The model download failed.", retryable: true }; }
function downloadError(code: SafeModelError["code"], message: string, retryable = false): DownloadManagerError { return new DownloadManagerError({ code, message, retryable }); }
function parseLength(value: string | null): number | undefined { if (!value || !/^\d+$/.test(value)) return undefined; const number = Number(value); return Number.isSafeInteger(number) ? number : undefined; }
function validateContentRange(value: string | null, offset: number): void { const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value ?? ""); if (!match || Number(match[1]) !== offset) throw downloadError("DOWNLOAD_RANGE_UNSUPPORTED", "The server returned an invalid resume range.", true); }
async function partialSize(path: string): Promise<number> { try { return (await stat(path)).size; } catch { return 0; } }
async function hashFile(path: string): Promise<string> { const hash = createHash("sha256"); await new Promise<void>((resolvePromise, reject) => { const stream = createReadStream(path); stream.on("data", value => hash.update(value)); stream.on("error", reject); stream.on("end", resolvePromise); }); return hash.digest("hex"); }
async function readSidecar(path: string): Promise<PersistedSidecar | undefined> { try { const value = JSON.parse(await readFile(path, "utf8")) as PersistedSidecar; return value.schemaVersion === 1 ? value : undefined; } catch { return undefined; } }
async function writeSidecar(path: string, value: PersistedSidecar): Promise<void> { const temporary = `${path}.tmp`; const file = await open(temporary, "w", 0o600); try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); } await rename(temporary, path); }
async function updateSidecarProgress(path: string, receivedBytes: number): Promise<void> { const value = await readSidecar(path); if (value) await writeSidecar(path, { ...value, receivedBytes }); }
function safePersistedUrl(input: string): string { const url = validateDownloadUrl(input); if ([...url.searchParams.keys()].some(key => /token|key|signature|authorization/i.test(key))) throw downloadError("DOWNLOAD_FAILED", "A credential-bearing download URL cannot be persisted."); return url.toString(); }
export function validateDownloadUrl(input: string): URL { let url: URL; try { url = new URL(input); } catch { throw downloadError("DOWNLOAD_FAILED", "Civitai returned an invalid download URL."); } if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw downloadError("DOWNLOAD_FAILED", "The download URL failed security validation."); const host = url.hostname.toLowerCase(); const allowed = host === "civitai.com" || host === "civitai.red" || host.endsWith(".civitai.com") || host.endsWith(".civitai.red") || host.endsWith(".civitai-delivery-worker-prod.workers.dev") || host.endsWith(".r2.cloudflarestorage.com"); if (!allowed) throw downloadError("DOWNLOAD_FAILED", "Civitai redirected to an unapproved download host."); return url; }
export async function assertPublicNetworkDestination(url: URL, allowPrivate = false): Promise<void> { if (allowPrivate) return; const addresses = await lookup(url.hostname, { all: true, verbatim: true }); if (addresses.length === 0 || addresses.some(value => isPrivateAddress(value.address))) throw downloadError("DOWNLOAD_FAILED", "The download destination resolved to a private or local network."); }
function isPrivateAddress(address: string): boolean { const value = address.toLowerCase(); if (value === "::1" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true; const parts = value.split(".").map(Number); if (parts.length !== 4) return false; return parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168) || parts[0] === 0; }
function validatePersistedSource(value: unknown): ResolvedCivitaiFile { const source = value as Partial<ResolvedCivitaiFile>; if (source.providerHost !== "civitai.com" && source.providerHost !== "civitai.red") throw new Error("invalid provider"); for (const id of [source.modelId, source.versionId, source.fileId]) if (!Number.isInteger(id) || Number(id) <= 0) throw new Error("invalid id"); const modelType = modelTypeSchema.parse(source.modelType); const downloadUrl = safePersistedUrl(String(source.downloadUrl)); return { resolveId: String(source.resolveId), providerHost: source.providerHost, modelId: source.modelId!, modelName: String(source.modelName).slice(0, 240), modelType, versionId: source.versionId!, versionName: String(source.versionName).slice(0, 240), ...(source.baseModel ? { baseModel: String(source.baseModel).slice(0, 120) } : {}), fileId: source.fileId!, fileName: sanitizeModelFileName(String(source.fileName)), ...(Number.isSafeInteger(source.sizeBytes) && Number(source.sizeBytes) >= 0 ? { sizeBytes: source.sizeBytes } : {}), ...(typeof source.sha256 === "string" && /^[a-f0-9]{64}$/i.test(source.sha256) ? { sha256: source.sha256.toLowerCase() } : {}), downloadUrl }; }
function retryAfterMs(value: string | null): number | undefined { if (!value) return undefined; if (/^\d+$/.test(value)) return Math.min(30_000, Number(value) * 1_000); const date = Date.parse(value); return Number.isNaN(date) ? undefined : Math.min(30_000, Math.max(0, date - Date.now())); }
async function retryDelay(ms: number, signal: AbortSignal): Promise<void> { await new Promise<void>((resolvePromise, reject) => { const timer = setTimeout(resolvePromise, Math.min(ms, 30_000)); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true }); }); }
