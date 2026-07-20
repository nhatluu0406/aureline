import { describe, expect, it } from "vitest";
import { engineSnapshotSchema, settingsPatchSchema } from "../packages/contracts/index.ts";
describe("contracts",()=>{it("rejects unknown settings and invalid engine state",()=>{expect(()=>settingsPatchSchema.parse({theme:"dark",rawExecutable:"x"})).toThrow();expect(()=>engineSnapshotSchema.parse({state:"running"})).toThrow()})});
