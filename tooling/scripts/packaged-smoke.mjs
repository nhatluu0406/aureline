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
assert(!packagedFiles.some(value=>value.toLowerCase().includes(".reference")||value.toLowerCase().includes(".env")||value.toLowerCase().includes(".aureline.part")||(/(^|\/)(models?|embeddings)(\/|$)/i.test(value)&&/\.(safetensors|ckpt|pt|pth|bin)$/i.test(value))||value.endsWith("Aureline.exe")||value.endsWith("Forge Desktop.exe")),"Packaged shell contains a forbidden reference, environment, model, partial, or executable name");
const environment={...process.env,AURELINE_USER_DATA:userData,AURELINE_PACKAGED_SMOKE_FIXTURE:"enabled"};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.AURELINE_RUNTIME_MANIFEST;
const app=await electron.launch({executablePath:executable,env:environment});
try{
  const page=await app.firstWindow();
  await page.setViewportSize({width:1366,height:768});
  await page.getByRole("heading",{name:"New image"}).waitFor();
  await page.getByRole("button",{name:"Generate"}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Generate"}).isDisabled(),true);
  await page.getByRole("button",{name:"Models"}).click();
  await page.getByRole("heading",{name:"Models"}).waitFor();
  await page.getByText("No downloads yet").waitFor();
  await page.getByText("Your library is ready").waitFor();
  await page.getByRole("textbox",{name:"Civitai URL"}).fill("https://civitai.com.evil.example/models/1");
  await page.getByRole("button",{name:"Resolve"}).click();
  await page.getByText(/Only civitai\.com and civitai\.red links are supported/).waitFor();
  await page.getByRole("textbox",{name:"Civitai URL"}).fill("https://civitai.com/models/2147483000");
  await page.getByRole("button",{name:"Resolve"}).click();
  await page.getByRole("heading",{name:"Aureline Smoke Model"}).waitFor();
  await page.getByRole("button",{name:/Download 20 B/}).click();
  await page.locator(".download-item").getByText("completed",{exact:false}).waitFor({timeout:10_000});
  await page.locator(".library-card").getByText("Aureline Smoke Model").waitFor();
  await page.getByRole("button",{name:"Use in Studio"}).first().click();
  await page.getByRole("heading",{name:"New image"}).waitFor();
  await page.getByRole("button",{name:"Models"}).click();
  await page.getByRole("heading",{name:"Models"}).waitFor();
  if(process.env.AURELINE_LIVE_MODEL_URL){
    await page.getByRole("textbox",{name:"Civitai URL"}).fill(process.env.AURELINE_LIVE_MODEL_URL);
    await page.getByRole("button",{name:"Resolve"}).click();
    await page.locator(".remote-card").waitFor({timeout:20_000});
    await page.getByRole("button",{name:/Download/}).waitFor();
    await page.locator(".remote-preview img").waitFor({timeout:20_000});
  }
  if(process.env.AURELINE_MODELS_SCREENSHOT)await page.screenshot({path:resolve(process.env.AURELINE_MODELS_SCREENSHOT),fullPage:true});
  await page.getByRole("button",{name:"Settings"}).click();
  await page.getByRole("heading",{name:"Settings"}).waitFor();
  await page.getByRole("heading",{name:"Civitai connection"}).waitFor();
  assert.equal(await page.getByText("No credential stored").isVisible(),true);
  await page.getByRole("button",{name:"Test connection"}).click();
  await page.getByText(/Could not reach the local Forge API|did not respond in time/).waitFor({timeout:15_000});
  await page.getByRole("button",{name:"Test connection"}).waitFor({state:"visible"});
  if(process.env.AURELINE_LIGHT_MODELS_SCREENSHOT){
    await page.getByRole("button",{name:"light"}).click();
    await page.getByRole("button",{name:"Done"}).click();
    await page.getByRole("button",{name:"Models"}).click();
    await page.getByRole("heading",{name:"Models"}).waitFor();
    await page.screenshot({path:resolve(process.env.AURELINE_LIGHT_MODELS_SCREENSHOT),fullPage:true});
    await page.getByRole("button",{name:"Studio"}).click();
  }else await page.getByRole("button",{name:"Done"}).click();
  await page.getByRole("heading",{name:"New image"}).waitFor();
  if(process.env.AURELINE_STUDIO_SCREENSHOT)await page.screenshot({path:resolve(process.env.AURELINE_STUDIO_SCREENSHOT),fullPage:true});
}finally{await app.close();await rm(userData,{recursive:true,force:true})}
console.log("Packaged Studio smoke PASS");
