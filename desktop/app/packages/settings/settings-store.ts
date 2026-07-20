import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { settingsPatchSchema, settingsSchema, type DesktopSettings } from "../contracts/index.ts";

const defaults: DesktopSettings = { schemaVersion: 1, theme: "system", launchOnStart: false, closeBehavior: "stop-and-quit", logLevel: "info" };

export class SettingsStore {
  #value: DesktopSettings = defaults;
  public constructor(private readonly path: string) {}
  public get value(): DesktopSettings { return { ...this.#value }; }
  public async load(): Promise<DesktopSettings> {
    try { this.#value = settingsSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
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
