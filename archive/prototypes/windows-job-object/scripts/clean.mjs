import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const directory of ["build", "test-artifacts"]) {
  await rm(resolve(root, directory), { recursive: true, force: true });
}
