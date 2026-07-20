import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CredentialStatus } from "../contracts/index.ts";

export type ProtectedStorage = { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string };

export class CivitaiCredentialVault {
  public constructor(private readonly path: string, private readonly storage: ProtectedStorage) {}

  public async status(state?: CredentialStatus["state"]): Promise<CredentialStatus> {
    if (!this.storage.isEncryptionAvailable()) return { configured: false, state: "unavailable" };
    try { await readFile(this.path); return { configured: true, state: state ?? "saved" }; }
    catch { return { configured: false, state: "not_configured" }; }
  }

  public async save(apiKey: string): Promise<CredentialStatus> {
    if (!this.storage.isEncryptionAvailable()) return { configured: false, state: "unavailable" };
    const encrypted = this.storage.encryptString(apiKey);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, encrypted.toString("base64"), { encoding: "ascii", mode: 0o600 });
    await rename(temporary, this.path);
    return { configured: true, state: "saved" };
  }

  public async clear(): Promise<CredentialStatus> {
    await rm(this.path, { force: true });
    return this.status();
  }

  public async use<T>(operation: (apiKey: string | undefined) => Promise<T>): Promise<T> {
    let apiKey: string | undefined;
    if (this.storage.isEncryptionAvailable()) {
      try { apiKey = this.storage.decryptString(Buffer.from(await readFile(this.path, "ascii"), "base64")); } catch { apiKey = undefined; }
    }
    return operation(apiKey);
  }
}
