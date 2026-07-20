import { randomUUID } from "node:crypto";
import { z } from "zod";
import { civitaiHostSchema, remoteModelSchema, type CivitaiHost, type ModelType, type RemoteModel, type SafeModelError } from "../../contracts/index.ts";

const MAX_URL_LENGTH = 2_048;
const idSchema = z.coerce.number().int().positive();
const fileSchema = z.object({
  id: z.number().int().positive(), name: z.string().min(1).max(1_024), sizeKB: z.number().nonnegative().optional(), type: z.string().optional(), primary: z.boolean().optional(), downloadUrl: z.string().url().optional(),
  metadata: z.object({ fp: z.string().optional(), size: z.string().optional(), format: z.string().optional() }).nullish(),
  hashes: z.object({ SHA256: z.string().optional(), BLAKE3: z.string().optional(), AutoV2: z.string().optional() }).partial().optional(),
}).passthrough();
const imageSchema = z.object({ url: z.string().url(), nsfw: z.union([z.boolean(), z.string(), z.number()]).optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() }).passthrough();
const versionSchema = z.object({
  id: z.number().int().positive(), name: z.string().min(1).max(1_024), modelId: z.number().int().positive().optional(), baseModel: z.string().optional(), createdAt: z.string().optional(),
  files: z.array(fileSchema).default([]), images: z.array(imageSchema).default([]), downloadUrl: z.string().url().optional(),
  model: z.object({ name: z.string(), type: z.string(), nsfw: z.boolean().optional() }).passthrough().optional(),
}).passthrough();
const modelSchema = z.object({
  id: z.number().int().positive(), name: z.string().min(1).max(1_024), description: z.string().nullish(), type: z.string(), nsfw: z.boolean().optional(),
  creator: z.object({ username: z.string().max(240) }).nullish(), modelVersions: z.array(versionSchema).min(1),
}).passthrough();

export type ParsedCivitaiUrl = { host: CivitaiHost; kind: "model" | "download"; modelId?: number; versionId?: number; downloadId?: number };
export type ResolvedCivitaiFile = { resolveId: string; providerHost: CivitaiHost; modelId: number; modelName: string; modelType: ModelType; versionId: number; versionName: string; baseModel?: string; fileId: number; fileName: string; sizeBytes?: number; sha256?: string; downloadUrl: string };
type Fetch = typeof globalThis.fetch;

export class CivitaiError extends Error {
  public constructor(public readonly detail: SafeModelError) { super(detail.message); }
}

export function parseCivitaiUrl(input: string): ParsedCivitaiUrl {
  if (input.length > MAX_URL_LENGTH) throw civitaiError("CIVITAI_URL_INVALID", "The Civitai URL is too long.");
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw civitaiError("CIVITAI_URL_INVALID", "Enter a valid Civitai model URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw civitaiError("CIVITAI_URL_INVALID", "Civitai links must use HTTPS without credentials, custom ports, or fragments.");
  const rawHost = url.hostname.toLowerCase();
  if (/^\[|^\d+(?:\.\d+){3}$/.test(rawHost)) throw civitaiError("CIVITAI_HOST_UNSUPPORTED", "IP addresses are not valid Civitai hosts.");
  const host = rawHost.startsWith("www.") ? rawHost.slice(4) : rawHost;
  const parsedHost = civitaiHostSchema.safeParse(host);
  if (!parsedHost.success) throw civitaiError("CIVITAI_HOST_UNSUPPORTED", "Only civitai.com and civitai.red links are supported.");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "models" && parts[1]) {
    const modelId = idSchema.safeParse(parts[1]);
    if (!modelId.success || parts.length > 3) throw civitaiError("CIVITAI_URL_INVALID", "This model URL does not contain a valid model ID.");
    const versionValue = url.searchParams.get("modelVersionId");
    const version = versionValue === null ? undefined : idSchema.safeParse(versionValue);
    if (version && !version.success) throw civitaiError("CIVITAI_URL_INVALID", "The modelVersionId must be a positive integer.");
    for (const key of url.searchParams.keys()) if (key !== "modelVersionId") throw civitaiError("CIVITAI_URL_INVALID", "This Civitai URL contains unsupported query parameters.");
    return { host: parsedHost.data, kind: "model", modelId: modelId.data, ...(version?.success ? { versionId: version.data } : {}) };
  }
  if (parts[0] === "api" && parts[1] === "download" && parts[2] === "models" && parts[3] && parts.length === 4 && url.search === "") {
    const downloadId = idSchema.safeParse(parts[3]);
    if (!downloadId.success) throw civitaiError("CIVITAI_URL_INVALID", "This direct download URL does not contain a valid ID.");
    return { host: parsedHost.data, kind: "download", downloadId: downloadId.data };
  }
  throw civitaiError("CIVITAI_URL_INVALID", "Use a Civitai model page or /api/download/models/<id> URL.");
}

export class CivitaiSource {
  readonly #resolutions = new Map<string, Map<number, ResolvedCivitaiFile>>();
  readonly #previews = new Map<string, { url: string; sensitive: boolean }>();
  public constructor(private readonly request: Fetch = globalThis.fetch) {}

  public async resolve(input: string, preference: "automatic" | CivitaiHost, apiKey?: string): Promise<RemoteModel> {
    const parsed = parseCivitaiUrl(input);
    const host = preference === "automatic" ? parsed.host : preference;
    let requestedVersionId = parsed.versionId;
    let modelId = parsed.modelId;
    if (parsed.kind === "download") {
      const version = await this.fetchVersion(host, parsed.downloadId!, apiKey);
      modelId = version.modelId;
      requestedVersionId = version.id;
      if (!modelId) throw civitaiError("CIVITAI_RESPONSE_INVALID", "Civitai did not identify the model for this download.");
    }
    const raw = await this.fetchJson(host, `/api/v1/models/${modelId}`, apiKey);
    const model = modelSchema.safeParse(raw);
    if (!model.success) throw civitaiError("CIVITAI_RESPONSE_INVALID", "Civitai returned model metadata Aureline could not validate.");
    if (requestedVersionId && !model.data.modelVersions.some(version => version.id === requestedVersionId)) throw civitaiError("CIVITAI_VERSION_NOT_FOUND", "The requested model version was not found.");
    const resolveId = randomUUID();
    const fileMap = new Map<number, ResolvedCivitaiFile>();
    const type = mapModelType(model.data.type);
    const versions = model.data.modelVersions.map(version => ({
      versionId: version.id, name: cleanText(version.name, 240), ...(version.baseModel ? { baseModel: cleanText(version.baseModel, 120) } : {}),
      ...(version.createdAt && !Number.isNaN(Date.parse(version.createdAt)) ? { publishedAt: new Date(version.createdAt).toISOString() } : {}),
      files: version.files.map(file => {
        const downloadUrl = file.downloadUrl ?? version.downloadUrl ?? `https://${host}/api/download/models/${version.id}`;
        const entry: ResolvedCivitaiFile = { resolveId, providerHost: host, modelId: model.data.id, modelName: cleanText(model.data.name, 240), modelType: type, versionId: version.id, versionName: cleanText(version.name, 240), ...(version.baseModel ? { baseModel: cleanText(version.baseModel, 120) } : {}), fileId: file.id, fileName: sanitizeProviderName(file.name), ...(file.sizeKB !== undefined ? { sizeBytes: Math.round(file.sizeKB * 1024) } : {}), ...(validSha(file.hashes?.SHA256) ? { sha256: file.hashes!.SHA256!.toLowerCase() } : {}), downloadUrl };
        fileMap.set(file.id, entry);
        return { fileId: file.id, name: entry.fileName, ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}), ...(file.metadata?.format ? { format: cleanText(file.metadata.format, 80) } : {}), ...(file.metadata?.fp ? { precision: cleanText(file.metadata.fp, 40) } : {}), ...(file.metadata?.size ? { variant: cleanText(file.metadata.size, 40) } : {}), primary: file.primary === true, ...(file.hashes ? { hashes: { ...(entry.sha256 ? { sha256: entry.sha256 } : {}), ...(file.hashes.BLAKE3 ? { blake3: cleanText(file.hashes.BLAKE3, 128) } : {}), ...(file.hashes.AutoV2 ? { autoV2: cleanText(file.hashes.AutoV2, 64) } : {}) } } : {}) };
      }),
      previews: version.images.slice(0, 12).map(image => { const id = randomUUID(); const sensitive = previewIsSensitive(Boolean(model.data.nsfw), image.nsfw); this.#previews.set(id, { url: image.url, sensitive }); return { id, ...(image.width ? { width: image.width } : {}), ...(image.height ? { height: image.height } : {}), sensitive }; }),
    }));
    this.#resolutions.set(resolveId, fileMap);
    return remoteModelSchema.parse({ resolveId, provider: "civitai", providerHost: host, modelId: model.data.id, name: cleanText(model.data.name, 240), ...(model.data.creator?.username ? { creator: cleanText(model.data.creator.username, 120) } : {}), type, ...(model.data.description ? { descriptionSummary: summarizeHtml(model.data.description) } : {}), sensitive: Boolean(model.data.nsfw), ...(requestedVersionId ? { requestedVersionId } : {}), versions });
  }

  public selection(resolveId: string, fileId: number): ResolvedCivitaiFile | undefined { return this.#resolutions.get(resolveId)?.get(fileId); }
  public preview(previewId: string): { url: string; sensitive: boolean } | undefined { return this.#previews.get(previewId); }

  public async testCredential(host: CivitaiHost, apiKey: string): Promise<void> { await this.fetchJson(host, "/api/v1/models?limit=1", apiKey); }

  private async fetchVersion(host: CivitaiHost, id: number, apiKey?: string): Promise<z.infer<typeof versionSchema>> {
    const result = versionSchema.safeParse(await this.fetchJson(host, `/api/v1/model-versions/${id}`, apiKey));
    if (!result.success) throw civitaiError("CIVITAI_RESPONSE_INVALID", "Civitai returned version metadata Aureline could not validate.");
    return result.data;
  }

  private async fetchJson(host: CivitaiHost, path: string, apiKey?: string): Promise<unknown> {
    let response: Response;
    try { response = await this.request(`https://${host}${path}`, { headers: { accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
    catch { throw civitaiError("CIVITAI_API_UNAVAILABLE", `Could not reach ${host}.`, true); }
    if (response.status === 401 || response.status === 403) throw civitaiError(apiKey ? "CIVITAI_AUTH_INVALID" : "CIVITAI_AUTH_REQUIRED", apiKey ? "The saved Civitai API key was rejected." : "This Civitai resource requires an API key.");
    if (response.status === 404) throw civitaiError("CIVITAI_MODEL_NOT_FOUND", "The requested Civitai model was not found.");
    if (response.status === 429) throw civitaiError("CIVITAI_RATE_LIMITED", "Civitai rate-limited this request. Wait and retry.", true);
    if (!response.ok) throw civitaiError("CIVITAI_API_UNAVAILABLE", `Civitai responded with HTTP ${response.status}.`, response.status >= 500);
    try { return await response.json(); } catch { throw civitaiError("CIVITAI_RESPONSE_INVALID", "Civitai returned invalid JSON."); }
  }
}

export function mapModelType(value: string): ModelType {
  const normalized = value.toLowerCase().replace(/[\s_-]/g, "");
  if (normalized === "checkpoint") return "checkpoint";
  if (normalized === "lora") return "lora";
  if (normalized === "lycoris") return "lycoris";
  if (normalized === "vae") return "vae";
  if (normalized === "textualinversion" || normalized === "embedding") return "embedding";
  if (normalized === "controlnet" || normalized === "poses") return "controlnet";
  if (normalized.includes("upscal")) return "upscaler";
  return "other";
}

export function asSafeModelError(error: unknown): SafeModelError {
  return error instanceof CivitaiError ? error.detail : { code: "CIVITAI_API_UNAVAILABLE", message: "The Civitai request could not be completed.", retryable: true };
}
function civitaiError(code: SafeModelError["code"], message: string, retryable = false): CivitaiError { return new CivitaiError({ code, message, retryable }); }
function validSha(value?: string): boolean { return typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value); }
function cleanText(value: string, max: number): string { return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }
function summarizeHtml(value: string): string { return cleanText(value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">"), 500); }
function sanitizeProviderName(value: string): string { return cleanText(value.replace(/[\\/:*?"<>|]/g, "_").split(/[\\/]/).at(-1) ?? "model.safetensors", 240); }
function previewIsSensitive(modelSensitive: boolean, value: boolean | string | number | undefined): boolean { if (modelSensitive) return true; if (typeof value === "boolean") return value; if (typeof value === "number") return value > 0; if (typeof value === "string") return !["false", "none", "safe", "0"].includes(value.toLowerCase()); return true; }
