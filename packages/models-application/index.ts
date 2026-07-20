import type { DesktopSettings, DownloadRecord, ModelType, ResolveCivitaiResult } from "../contracts/index.ts";
import { ModelLibrary } from "../model-library/index.ts";
import { CivitaiSource, asSafeModelError } from "../model-sources/civitai/index.ts";
import { DownloadManager, asDownloadError, assertPublicNetworkDestination } from "../download-manager/index.ts";
import { CivitaiCredentialVault } from "../credentials/civitai-credential-vault.ts";
import type { SettingsStore } from "../settings/settings-store.ts";
import type { ForgeApiClient } from "../../engine/adapter/forge-api-client.ts";

export class ModelsApplication {
  readonly downloads: DownloadManager;
  readonly #previewCache = new Map<string, string>();
  public constructor(
    readonly source: CivitaiSource,
    readonly library: ModelLibrary,
    readonly vault: CivitaiCredentialVault,
    private readonly settings: SettingsStore,
    private readonly forge: ForgeApiClient,
    private readonly revealFile: (path: string) => void,
    private readonly request: typeof globalThis.fetch = globalThis.fetch,
    downloadStatePath?: string,
  ) {
    this.downloads = new DownloadManager(library, request, false, downloadStatePath);
    this.downloads.subscribe(record => { if (record.state === "completed" && record.engineRefresh === undefined) void this.refreshForge(record); });
  }

  public async initialize(): Promise<void> { await this.library.load(); await this.library.refresh(); await this.downloads.load(); }
  public async resolve(url: string, preferredHost: DesktopSettings["models"]["preferredCivitaiHost"]): Promise<ResolveCivitaiResult> {
    try { return { ok: true, model: await this.vault.use(apiKey => this.source.resolve(url, preferredHost, apiKey)) }; }
    catch (error) { return { ok: false, error: asSafeModelError(error) }; }
  }
  public async preflight(selection: { resolveId: string; versionId: number; fileId: number; destinationId: string }) {
    const source = this.source.selection(selection.resolveId, selection.fileId);
    if (!source || source.versionId !== selection.versionId) throw new Error("Resolved Civitai selection expired or is invalid.");
    return this.library.preflight(selection.destinationId, source.sizeBytes, source.fileName);
  }
  public async start(selection: { resolveId: string; versionId: number; fileId: number; destinationId: string }) {
    try {
      const active = this.downloads.list().filter(record => ["queued", "preflighting", "downloading", "verifying", "installing"].includes(record.state)).length;
      if (active >= this.settings.value.models.downloadConcurrency) return { ok: false as const, error: { code: "DOWNLOAD_FAILED" as const, message: "Download concurrency limit reached. Wait for an active download or pause it.", retryable: true } };
      const source = this.source.selection(selection.resolveId, selection.fileId);
      if (!source || source.versionId !== selection.versionId) return { ok: false as const, error: { code: "DOWNLOAD_FAILED" as const, message: "Resolve the Civitai link again before downloading.", retryable: false } };
      const download = await this.vault.use(apiKey => this.downloads.start(source, selection.destinationId, apiKey));
      return { ok: true as const, download };
    } catch (error) { return { ok: false as const, error: asDownloadError(error) }; }
  }
  public async listLibrary(search = "", type?: ModelType) { return this.library.list(search, type); }
  public async refreshLibrary() { return this.library.refresh(); }
  public reveal(modelId: string): void { const path = this.library.filePath(modelId); if (!path) throw new Error("Model not found"); this.revealFile(path); }
  public async useInStudio(modelId: string): Promise<void> { const model = this.library.get(modelId); if (!model || model.type !== "checkpoint") throw new Error("Only checkpoints can be selected for the current Studio workflow."); await this.settings.update({ studio: { ...this.settings.value.studio, selectedModelId: model.id } }); }
  public selectedCheckpointName(): string | undefined { const id = this.settings.value.studio.selectedModelId; if (!id) return undefined; const model = this.library.get(id); return model?.type === "checkpoint" ? model.fileName : undefined; }

  public async preview(previewId: string) {
    const cached = this.#previewCache.get(previewId); if (cached) return { ok: true as const, dataUrl: cached };
    const preview = this.source.preview(previewId); if (!preview) return { ok: false as const, error: { code: "CIVITAI_RESPONSE_INVALID" as const, message: "Preview is no longer available.", retryable: false } };
    try {
      let url = new URL(preview.url); let response: Response | undefined;
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        validatePreviewUrl(url); await assertPublicNetworkDestination(url); response = await this.request(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
        if (![301, 302, 303, 307, 308].includes(response.status)) break; const location = response.headers.get("location"); if (!location || redirects === 3) throw new Error("redirect"); url = new URL(location, url);
      }
      if (!response) throw new Error("response"); const contentType = response.headers.get("content-type")?.split(";")[0] ?? ""; const length = Number(response.headers.get("content-length") ?? 0);
      if (!response.ok || !["image/jpeg", "image/png", "image/webp"].includes(contentType) || length > 8 * 1024 * 1024) throw new Error("response");
      const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("size");
      const dataUrl = `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`; if (this.#previewCache.size >= 24) this.#previewCache.delete(this.#previewCache.keys().next().value!); this.#previewCache.set(previewId, dataUrl); return { ok: true as const, dataUrl };
    } catch { return { ok: false as const, error: { code: "CIVITAI_API_UNAVAILABLE" as const, message: "Preview could not be loaded safely.", retryable: true } }; }
  }

  private async refreshForge(record: DownloadRecord): Promise<void> {
    if (!record.installedModelId) return; const model = this.library.get(record.installedModelId); if (!model) return;
    if (model.type !== "checkpoint" && model.type !== "lora") { this.downloads.setEngineRefresh(record.id, "not_needed"); return; }
    this.downloads.setEngineRefresh(record.id, "pending"); const refreshed = await this.forge.refreshModels(this.settings.value.forgeBaseUrl, model.type); this.downloads.setEngineRefresh(record.id, refreshed ? "refreshed" : "required");
  }
}
function validatePreviewUrl(url: URL): void { const host = url.hostname.toLowerCase(); if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !(host === "civitai.com" || host.endsWith(".civitai.com") || host === "civitai.red" || host.endsWith(".civitai.red"))) throw new Error("preview host"); }
