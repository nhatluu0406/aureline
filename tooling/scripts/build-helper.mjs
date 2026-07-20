import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const root=resolve(import.meta.dirname,"../..");const source=resolve(root,"native/job-owner/job_owner_helper.rs"),output=resolve(root,"native/job-owner/bin/job-owner-helper.exe");await mkdir(resolve(output,".."),{recursive:true});
await new Promise((ok,fail)=>{const child=spawn("rustc",["--edition","2021","-C","opt-level=2","-o",output,source],{cwd:root,shell:false,stdio:"inherit"});child.once("error",fail);child.once("exit",code=>code===0?ok():fail(new Error(`rustc exited ${code}`)))});
