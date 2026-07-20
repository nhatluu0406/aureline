import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { settingsPatchSchema, settingsSchema, type DesktopSettings } from "../contracts/index.ts";

const defaults: DesktopSettings = {
  schemaVersion: 1,
  theme: "dark",
  launchOnStart: false,
  closeBehavior: "stop-and-quit",
  logLevel: "info",
  forgeBaseUrl: "http://127.0.0.1:7860",
  studio: { prompt: "", negativePrompt: "", width: 1024, height: 1024, steps: 20, cfgScale: 7, seed: -1, sampler: "Euler a" },
};

export class SettingsStore {
  #value: DesktopSettings = defaults;
  public constructor(private readonly path: string) {}
  public get value(): DesktopSettings { return { ...this.#value }; }
  public async load(): Promise<DesktopSettings> {
    try { this.#value = settingsSchema.parse({ ...defaults, ...JSON.parse(await readFile(this.path, "utf8")) }); }
    catch { this.#value = defaults; }
    return this.value;
  }
  public async update(patch: unknown): Promise<DesktopSettings> {
    this.#value = settingsSchema.parse({ ...this.#value, ...settingsPatchSchema.parse(patch) });
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
    return this.value;
  }
}
