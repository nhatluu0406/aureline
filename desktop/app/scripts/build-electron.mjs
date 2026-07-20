import { build } from "esbuild";
import { resolve } from "node:path";
const root=resolve(import.meta.dirname,"..");
await build({entryPoints:[resolve(root,"electron/main/index.ts")],outfile:resolve(root,"dist/electron/main.cjs"),bundle:true,platform:"node",format:"cjs",target:"node22",external:["electron"],sourcemap:true});
await build({entryPoints:[resolve(root,"electron/preload/index.ts")],outfile:resolve(root,"dist/electron/preload.cjs"),bundle:true,platform:"node",format:"cjs",target:"node22",external:["electron"],sourcemap:true});
