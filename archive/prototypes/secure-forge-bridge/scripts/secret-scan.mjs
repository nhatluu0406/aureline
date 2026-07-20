import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "test-artifacts");
const patterns = [
  /Authorization\s*:\s*(?:Bearer|Basic)\s+\S+/iu,
  /x-forge-(?:desktop|bridge)-authorization/iu,
  /[?&](?:token|api_key|key|secret|password)=/iu,
];
let files = [];
try { files = await readdir(root, { recursive: true, withFileTypes: true }); } catch (error) {
  if (error.code !== "ENOENT") throw error;
}
for (const entry of files) {
  if (!entry.isFile()) continue;
  const path = resolve(entry.parentPath, entry.name);
  const content = await readFile(path, "utf8");
  for (const pattern of patterns) {
    if (pattern.test(content)) throw new Error(`Sensitive pattern found in ${path}: ${pattern.source}`);
  }
}
process.stdout.write(`Secret scan passed for ${files.filter((entry) => entry.isFile()).length} artifact file(s).\n`);

