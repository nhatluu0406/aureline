import { afterEach,describe,expect,it } from "vitest";
import { mkdtemp,readFile,rm } from "node:fs/promises";import { tmpdir } from "node:os";import { resolve } from "node:path";
import { SettingsStore } from "../packages/settings/settings-store.ts";
let root="";afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true})});describe("SettingsStore",()=>{it("persists an atomic versioned document",async()=>{root=await mkdtemp(resolve(tmpdir(),"forge-settings-"));const path=resolve(root,"settings.json"),store=new SettingsStore(path);await store.load();await store.update({theme:"dark"});expect(JSON.parse(await readFile(path,"utf8"))).toMatchObject({schemaVersion:1,theme:"dark"})})});
