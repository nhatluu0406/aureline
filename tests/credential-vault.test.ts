import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises"; import { tmpdir } from "node:os"; import { resolve } from "node:path";
import { CivitaiCredentialVault, type ProtectedStorage } from "../packages/credentials/civitai-credential-vault.ts";
let root = ""; afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
const storage: ProtectedStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`protected:${value}`), decryptString: value => value.toString().replace("protected:", "") };
describe("CivitaiCredentialVault", () => {
  it("encrypts at rest, never exposes a read method, and clears", async () => { root = await mkdtemp(resolve(tmpdir(), "aureline-vault-")); const path = resolve(root, "civitai.bin"); const vault = new CivitaiCredentialVault(path, storage); expect(await vault.save("super-secret-key")).toEqual({ configured: true, state: "saved" }); expect(await readFile(path, "utf8")).not.toContain("super-secret-key"); await expect(vault.use(async key => key)).resolves.toBe("super-secret-key"); expect("get" in vault).toBe(false); expect(await vault.clear()).toEqual({ configured: false, state: "not_configured" }); });
  it("fails closed when protected storage is unavailable", async () => { root = await mkdtemp(resolve(tmpdir(), "aureline-vault-")); const vault = new CivitaiCredentialVault(resolve(root, "key"), { ...storage, isEncryptionAvailable: () => false }); expect(await vault.save("super-secret-key")).toEqual({ configured: false, state: "unavailable" }); });
});
