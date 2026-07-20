import { afterEach,describe,expect,it } from "vitest";
import { spawn,type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { JobHelperClient } from "../packages/process-supervisor/job-helper-client.ts";
let helper:JobHelperClient|null=null,unrelated:ChildProcess|null=null;
const alive=(pid:number):boolean=>{try{process.kill(pid,0);return true}catch{return false}};
const waitDead=async(pid:number):Promise<void>=>{for(let attempt=0;attempt<50;attempt+=1){if(!alive(pid))return;await new Promise(r=>setTimeout(r,50))}throw new Error(`process ${pid} remains alive`)};
afterEach(async()=>{await helper?.dispose().catch(()=>undefined);helper=null;if(unrelated?.pid&&alive(unrelated.pid))unrelated.kill();unrelated=null});
describe.skipIf(process.platform!=="win32")("production Job helper",()=>{it("kills its suspended-assigned child on abrupt owner exit without killing unrelated process",async()=>{const fixture=resolve(import.meta.dirname,"fixtures/owned-worker.mjs"),environment=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));helper=await JobHelperClient.launch({helperPath:resolve(import.meta.dirname,"../native/job-owner/bin/job-owner-helper.exe"),executable:process.execPath,cwd:resolve(import.meta.dirname,".."),args:[fixture],environment,secretFrame:"{}\n"},()=>undefined);expect((await helper.query()).activeProcesses).toBeGreaterThan(0);const ownedPid=helper.ownedPid;unrelated=spawn(process.execPath,[fixture],{shell:false,stdio:["pipe","ignore","ignore"]});unrelated.stdin?.end("{}\n");if(!unrelated.pid)throw new Error("unrelated process missing PID");const unrelatedPid=unrelated.pid;helper.child.kill();await waitDead(ownedPid);expect(alive(unrelatedPid)).toBe(true);helper=null})});
