import { _electron as electron } from "playwright";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root=resolve(import.meta.dirname,".."),userData=resolve(root,".local/packaged-smoke"),executable=resolve(root,"release/win-unpacked/Forge Desktop.exe");await rm(userData,{recursive:true,force:true});const environment={...process.env,FORGE_DESKTOP_USER_DATA:userData};delete environment.ELECTRON_RUN_AS_NODE;delete environment.FORGE_DESKTOP_RUNTIME_MANIFEST;
const app=await electron.launch({executablePath:executable,env:environment});try{const page=await app.firstWindow();await page.getByText("Forge Desktop",{exact:true}).first().waitFor();await page.getByText("Chưa cấu hình",{exact:true}).first().waitFor();assert.equal(await page.getByRole("button",{name:"Start Forge"}).isDisabled(),true)}finally{await app.close()}console.log("Packaged shell smoke PASS");
