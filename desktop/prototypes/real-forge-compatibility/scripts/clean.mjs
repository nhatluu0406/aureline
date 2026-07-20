import { rm } from "node:fs/promises";

await Promise.all([
  rm("dist", { recursive: true, force: true }),
  rm("test-artifacts", { recursive: true, force: true }),
]);
