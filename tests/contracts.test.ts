import { describe, expect, it } from "vitest";
import { engineSnapshotSchema, generationRequestSchema, settingsPatchSchema } from "../packages/contracts/index.ts";
describe("contracts",()=>{
  it("rejects unknown settings and invalid engine state",()=>{expect(()=>settingsPatchSchema.parse({theme:"dark",rawExecutable:"x"})).toThrow();expect(()=>engineSnapshotSchema.parse({state:"running"})).toThrow()});
  it("validates the bounded Studio generation request",()=>{const request={baseUrl:"http://127.0.0.1:7860",prompt:"moonlit glass sculpture",negativePrompt:"",width:1024,height:1024,steps:20,cfgScale:7,seed:-1,sampler:"Euler a"};expect(generationRequestSchema.parse(request)).toMatchObject({steps:20,sampler:"Euler a"});expect(()=>generationRequestSchema.parse({...request,width:8192})).toThrow()});
});
