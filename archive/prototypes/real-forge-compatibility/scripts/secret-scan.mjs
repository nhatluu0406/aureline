import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const forbidden = ["REAL_FORGE_SMOKE_SECRET", "Bearer REAL_FORGE"];
async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]))).flat();
}
const files = await walk("test-artifacts");
for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const value of forbidden) if (content.includes(value)) throw new Error(`secret marker found in ${file}`);
}
process.stdout.write(`secret scan passed (${files.length} artifact files)\n`);
