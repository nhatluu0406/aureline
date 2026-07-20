import { describe,expect,it } from "vitest";
import { LogBuffer } from "../packages/process-supervisor/log-buffer.ts";
describe("LogBuffer",()=>{it("redacts secrets and stays bounded",()=>{const logs=new LogBuffer(2,["secret-value"]);logs.push("forge","info","token=secret-value");logs.push("app","info","Authorization: Bearer visible");logs.push("app","info","last");expect(logs.snapshot()).toHaveLength(2);expect(JSON.stringify(logs.snapshot())).not.toContain("secret-value");expect(JSON.stringify(logs.snapshot())).not.toContain("visible")})});
