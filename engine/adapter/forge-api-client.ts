import type { GenerationRequest, GenerationResult } from "../../packages/contracts/index.ts";

type Fetch = typeof globalThis.fetch;

export class ForgeApiClient {
  public constructor(private readonly request: Fetch = globalThis.fetch) {}

  public async testConnection(input: string): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    try {
      const baseUrl = normalizeLoopbackUrl(input);
      const response = await this.request(`${baseUrl}/sdapi/v1/samplers`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return { ok: false, message: `Forge responded with HTTP ${response.status}. Confirm that API mode is enabled.` };
      const body: unknown = await response.json();
      if (!Array.isArray(body)) return { ok: false, message: "The server responded, but it is not a compatible Forge API." };
      return { ok: true, message: "Connected to the local Forge API." };
    } catch (error) {
      return { ok: false, message: friendlyError(error) };
    }
  }

  public async generate(input: GenerationRequest, checkpointName?: string): Promise<GenerationResult> {
    try {
      const baseUrl = normalizeLoopbackUrl(input.baseUrl);
      const response = await this.request(`${baseUrl}/sdapi/v1/txt2img`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: input.prompt,
          negative_prompt: input.negativePrompt,
          width: input.width,
          height: input.height,
          steps: input.steps,
          cfg_scale: input.cfgScale,
          seed: input.seed,
          sampler_name: input.sampler,
          batch_size: 1,
          n_iter: 1,
          ...(checkpointName ? { override_settings: { sd_model_checkpoint: checkpointName }, override_settings_restore_afterwards: true } : {}),
        }),
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (!response.ok) return { ok: false, message: `Generation failed with HTTP ${response.status}. Check Forge and retry.` };
      const body = await response.json() as { images?: unknown; info?: unknown };
      const first = Array.isArray(body.images) ? body.images[0] : undefined;
      if (typeof first !== "string" || first.length === 0) return { ok: false, message: "Forge completed without returning an image." };
      let seed: number | null = null;
      if (typeof body.info === "string") {
        try { const info = JSON.parse(body.info) as { seed?: unknown }; if (Number.isInteger(info.seed)) seed = Number(info.seed); } catch { /* Forge info is optional. */ }
      }
      const image = first.startsWith("data:image/") ? first : `data:image/png;base64,${first}`;
      return { ok: true, image, seed };
    } catch (error) {
      return { ok: false, message: friendlyError(error) };
    }
  }

  public async refreshModels(input: string, type: "checkpoint" | "lora"): Promise<boolean> {
    try {
      const baseUrl = normalizeLoopbackUrl(input);
      const response = await this.request(`${baseUrl}/sdapi/v1/${type === "checkpoint" ? "refresh-checkpoints" : "refresh-loras"}`, { method: "POST", signal: AbortSignal.timeout(8_000) });
      return response.ok;
    } catch { return false; }
  }
}

export function normalizeLoopbackUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("Enter a valid local Forge URL, for example http://127.0.0.1:7860."); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) {
    throw new Error("Forge must use an HTTP loopback address (127.0.0.1 or localhost) without credentials.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function friendlyError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("Enter a valid")) return error.message;
  if (error instanceof Error && error.message.startsWith("Forge must")) return error.message;
  if (error instanceof Error && error.name === "TimeoutError") return "Forge did not respond in time. Check that it is running with API access enabled.";
  return "Could not reach the local Forge API. Start Forge, verify the URL, and try again.";
}
