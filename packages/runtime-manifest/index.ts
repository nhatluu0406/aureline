import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  schemaVersion: z.literal(1), runtimeId: z.string().min(1), platform: z.literal("win32"),
  architecture: z.enum(["x64", "arm64"]), pythonExecutable: z.string().min(1), forgeRoot: z.string().min(1),
  launcherAdapter: z.string().min(1), helperExecutable: z.string().min(1), forgeCommit: z.string().optional(),
}).strict();
export type RuntimeManifest = z.infer<typeof schema> & { manifestPath: string };

export function resolveManifestPath(value: string, base: string): string {
  return isAbsolute(value) ? value : resolve(base, value);
}
export async function loadRuntimeManifest(path: string): Promise<RuntimeManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const value = schema.parse(parsed);
  const base = resolve(path, "..");
  return {
    ...value,
    pythonExecutable: resolveManifestPath(value.pythonExecutable, base),
    forgeRoot: resolveManifestPath(value.forgeRoot, base),
    launcherAdapter: resolveManifestPath(value.launcherAdapter, base),
    helperExecutable: resolveManifestPath(value.helperExecutable, base),
    manifestPath: path,
  };
}
