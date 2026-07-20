import { _electron as electron } from "playwright";
import { access, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const root=resolve(import.meta.dirname,"../..");
const userData=resolve(root,".local/packaged-smoke");
const unpacked=resolve(root,"release/win-unpacked");
const executable=resolve(unpacked,"aureline.exe");
await rm(userData,{recursive:true,force:true});
await access(executable);
const packagedFiles=(await readdir(unpacked,{recursive:true})).map(value=>String(value).replaceAll("\\","/"));
assert(!packagedFiles.some(value=>value.toLowerCase().includes(".reference")||value.toLowerCase().includes(".env")||value.endsWith("Aureline.exe")||value.endsWith("Forge Desktop.exe")),"Packaged shell contains a forbidden reference, environment file, or executable name");
const environment={...process.env,AURELINE_USER_DATA:userData};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.AURELINE_RUNTIME_MANIFEST;
const app=await electron.launch({executablePath:executable,env:environment});
try{
  const page=await app.firstWindow();
  await page.setViewportSize({width:1366,height:768});
  await page.getByRole("heading",{name:"New image"}).waitFor();
  await page.getByRole("button",{name:"Generate"}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Generate"}).isDisabled(),true);
  await page.getByRole("button",{name:"Settings"}).click();
  await page.getByRole("heading",{name:"Settings"}).waitFor();
  await page.getByRole("button",{name:"Test connection"}).click();
  await page.getByText(/Could not reach the local Forge API|did not respond in time/).waitFor({timeout:15_000});
  await page.getByRole("button",{name:"Test connection"}).waitFor({state:"visible"});
  await page.getByRole("button",{name:"Done"}).click();
  await page.getByRole("heading",{name:"New image"}).waitFor();
  if(process.env.AURELINE_STUDIO_SCREENSHOT)await page.screenshot({path:resolve(process.env.AURELINE_STUDIO_SCREENSHOT),fullPage:true});
}finally{await app.close();await rm(userData,{recursive:true,force:true})}
console.log("Packaged Studio smoke PASS");
