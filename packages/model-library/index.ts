import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import { installedModelListSchema, modelTypes, type InstalledModel, type ModelRoot, type ModelType, type SafeModelError } from "../contracts/index.ts";

const allowedExtensions = new Set([".safetensors", ".ckpt", ".pt", ".pth", ".bin"]);
const internalRecordSchema = z.object({ public: installedModelListSchema.element, filePath: z.string(), modifiedMs: z.number().nonnegative() }).strict();
const indexSchema = z.object({ schemaVersion: z.literal(1), records: z.array(internalRecordSchema) }).strict();
type InternalRecord = z.infer<typeof internalRecordSchema>;

const ROOT_DEFINITIONS: Array<{ id: string; type: ModelType; folder: string; label: string }> = [
  { id: "checkpoints", type: "checkpoint", folder: "models/Stable-diffusion", label: "Checkpoints" },
  { id: "lora", type: "lora", folder: "models/Lora", label: "LoRA" },
  { id: "vae", type: "vae", folder: "models/VAE", label: "VAE" },
  { id: "embeddings", type: "embedding", folder: "embeddings", label: "Embeddings" },
];

export class ModelLibraryError extends Error { public constructor(public readonly detail: SafeModelError) { super(detail.message); } }

export class ModelLibrary {
  #records: InternalRecord[] = [];
  public constructor(private readonly managedDataRoot: string, private readonly indexPath: string) {}

  public async load(): Promise<void> {
    try { this.#records = indexSchema.parse(JSON.parse(await readFile(this.indexPath, "utf8"))).records; }
    catch { this.#records = []; }
  }

  public roots(): ModelRoot[] {
    return [
      ...ROOT_DEFINITIONS.map(root => ({ id: root.id, type: root.type, label: root.label, location: `Aureline data / ${root.folder}`, available: true })),
      ...(["controlnet", "upscaler", "other"] as ModelType[]).map(type => ({ id: `unsupported-${type}`, type, label: typeLabel(type), location: "Runtime root not configured", available: false })),
    ];
  }

  public rootPath(id: string, expectedType?: ModelType): string {
    const root = ROOT_DEFINITIONS.find(value => value.id === id && (!expectedType || value.type === expectedType || (expectedType === "lycoris" && value.id === "lora")));
    if (!root) throw libraryError("DOWNLOAD_DESTINATION_INVALID", "Choose an available Aureline model destination.");
    const candidate = resolve(this.managedDataRoot, root.folder);
    if (!isWithin(candidate, this.managedDataRoot)) throw libraryError("DOWNLOAD_DESTINATION_INVALID", "The model destination is outside the managed data root.");
    return candidate;
  }

  public defaultRoot(type: ModelType): ModelRoot {
    const definition = ROOT_DEFINITIONS.find(root => root.type === type) ?? (type === "lycoris" ? ROOT_DEFINITIONS.find(root => root.id === "lora") : undefined);
    if (!definition) throw libraryError("MODEL_TYPE_UNSUPPORTED", `${typeLabel(type)} needs a runtime-confirmed destination before download.`);
    return this.roots().find(root => root.id === definition.id)!;
  }

  public async preflight(rootId: string, expectedBytes?: number, fileName?: string): Promise<{ destination: ModelRoot; expectedBytes?: number; freeBytes: number; sufficient: boolean; warning?: string }> {
    const root = this.roots().find(value => value.id === rootId && value.available);
    if (!root) throw libraryError("DOWNLOAD_DESTINATION_INVALID", "The selected destination is unavailable.");
    const path = this.rootPath(rootId);
    let conflictWarning: string | undefined;
    if (fileName) {
      const safeName = sanitizeModelFileName(fileName); const finalPath = join(path, safeName); if (finalPath.length > 240) throw libraryError("DOWNLOAD_DESTINATION_INVALID", "The final model path is too long for reliable Windows installation.");
      try { await stat(finalPath); throw libraryError("DOWNLOAD_ALREADY_EXISTS", "A model with this filename already exists."); } catch (error) { if (error instanceof ModelLibraryError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try { await stat(`${finalPath}.aureline.part`); conflictWarning = "A partial download exists; Aureline will validate its identity before resuming."; } catch { /* no partial */ }
    }
    await mkdir(path, { recursive: true });
    const probe = join(path, `.aureline-write-${randomUUID()}.tmp`);
    try { await writeFile(probe, ""); await import("node:fs/promises").then(fs => fs.rm(probe, { force: true })); }
    catch { throw libraryError("DOWNLOAD_DESTINATION_INVALID", "Aureline cannot write to the selected model destination."); }
    const disk = await statfs(path);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    const reserve = 512 * 1024 * 1024;
    const sufficient = expectedBytes === undefined ? freeBytes >= reserve : freeBytes >= expectedBytes + Math.max(reserve, Math.ceil(expectedBytes * 0.05));
    return { destination: root, ...(expectedBytes !== undefined ? { expectedBytes } : {}), freeBytes, sufficient, ...(!sufficient ? { warning: "Not enough free disk space for this model and safety reserve." } : conflictWarning ? { warning: conflictWarning } : expectedBytes === undefined ? { warning: "File size is unknown; Aureline can only enforce the minimum disk reserve." } : {}) };
  }

  public async refresh(): Promise<InstalledModel[]> {
    const cached = new Map(this.#records.map(record => [record.filePath, record]));
    const records: InternalRecord[] = [];
    for (const root of ROOT_DEFINITIONS) {
      const path = this.rootPath(root.id);
      await mkdir(path, { recursive: true });
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.endsWith(".aureline.part") || entry.name.endsWith(".aureline.json") || !allowedExtensions.has(extname(entry.name).toLowerCase())) continue;
        const filePath = join(path, entry.name); const info = await stat(filePath); const prior = cached.get(filePath);
        if (prior && prior.public.sizeBytes === info.size && prior.modifiedMs === info.mtimeMs) { records.push(prior); continue; }
        const sha256 = await hashFile(filePath);
        records.push({ public: { id: prior?.public.id ?? randomUUID(), type: root.type, name: basename(entry.name, extname(entry.name)), fileName: entry.name, sizeBytes: info.size, sha256, source: prior?.public.source ?? "local", installedAt: prior?.public.installedAt ?? new Date().toISOString(), location: `${root.label} / ${entry.name}`, duplicate: false }, filePath, modifiedMs: info.mtimeMs });
      }
    }
    const hashCounts = new Map<string, number>(); for (const record of records) hashCounts.set(record.public.sha256, (hashCounts.get(record.public.sha256) ?? 0) + 1);
    this.#records = records.map(record => ({ ...record, public: { ...record.public, duplicate: (hashCounts.get(record.public.sha256) ?? 0) > 1 } }));
    await this.persist(); return this.list();
  }

  public list(search = "", type?: ModelType): InstalledModel[] {
    const query = search.trim().toLowerCase();
    return this.#records.map(record => record.public).filter(model => (!type || model.type === type) && (!query || `${model.name} ${model.fileName} ${model.baseModel ?? ""}`.toLowerCase().includes(query)));
  }
  public get(id: string): InstalledModel | undefined { return this.#records.find(record => record.public.id === id)?.public; }
  public filePath(id: string): string | undefined { return this.#records.find(record => record.public.id === id)?.filePath; }

  public async register(filePath: string, input: Omit<InstalledModel, "id" | "installedAt" | "location" | "duplicate">): Promise<InstalledModel> {
    const root = ROOT_DEFINITIONS.find(value => isWithin(filePath, this.rootPath(value.id)));
    if (!root) throw libraryError("MODEL_INSTALL_FAILED", "Installed model is outside an Aureline model root.");
    const info = await stat(filePath);
    const publicRecord: InstalledModel = { ...input, id: randomUUID(), installedAt: new Date().toISOString(), location: `${root.label} / ${basename(filePath)}`, duplicate: this.#records.some(record => record.public.sha256 === input.sha256) };
    this.#records.push({ public: publicRecord, filePath, modifiedMs: info.mtimeMs });
    await this.persist(); return publicRecord;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true }); const temporary = `${this.indexPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, records: this.#records }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, this.indexPath);
  }
}

export function sanitizeModelFileName(input: string): string {
  let value = basename(input).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 180);
  const extension = extname(value).toLowerCase();
  if (!allowedExtensions.has(extension)) throw libraryError("DOWNLOAD_DESTINATION_INVALID", "This file does not use a supported model extension.");
  const stem = basename(value, extension); if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) value = `model-${randomUUID().slice(0, 8)}${extension}`;
  return value;
}
export function asLibraryError(error: unknown): SafeModelError { return error instanceof ModelLibraryError ? error.detail : { code: "MODEL_INSTALL_FAILED", message: "The model library operation failed.", retryable: true }; }
function libraryError(code: SafeModelError["code"], message: string): ModelLibraryError { return new ModelLibraryError({ code, message, retryable: false }); }
function isWithin(candidate: string, root: string): boolean { const normalizedRoot = `${resolve(root).toLowerCase()}\\`; return resolve(candidate).toLowerCase().startsWith(normalizedRoot); }
function typeLabel(type: ModelType): string { return type.charAt(0).toUpperCase() + type.slice(1); }
async function hashFile(path: string): Promise<string> { const hash = createHash("sha256"); await new Promise<void>((resolvePromise, reject) => { const stream = createReadStream(path); stream.on("data", chunk => hash.update(chunk)); stream.on("error", reject); stream.on("end", resolvePromise); }); return hash.digest("hex"); }
