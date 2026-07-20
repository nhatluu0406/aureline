import { bearerValue } from "../security/credentials.ts";
import { BACKEND_AUTH_HEADER } from "../proxy/secure-proxy.ts";
import type { BridgeIdentity } from "../types.ts";

export class ForgeIdentityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ForgeIdentityError";
  }
}

export class MainProcessForgeClient {
  public constructor(
    private readonly backendOrigin: string,
    private readonly backendToken: string,
    private readonly expectedInstanceId: string,
  ) {}

  public async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set(BACKEND_AUTH_HEADER, bearerValue(this.backendToken));
    return await fetch(new URL(path, this.backendOrigin), { ...init, headers });
  }

  public async verifyIdentity(): Promise<BridgeIdentity> {
    const response = await this.request("/bridge/identity", { cache: "no-store" });
    if (!response.ok) throw new ForgeIdentityError(`Identity returned HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!isIdentity(value)) throw new ForgeIdentityError("Identity payload does not match protocol 1");
    if (value.instanceId !== this.expectedInstanceId) throw new ForgeIdentityError("Identity instance does not match this launch");
    return value;
  }
}

function isIdentity(value: unknown): value is BridgeIdentity {
  return typeof value === "object" && value !== null
    && "service" in value && value.service === "forge-desktop-bridge"
    && "protocolVersion" in value && value.protocolVersion === 1
    && "instanceId" in value && typeof value.instanceId === "string"
    && "enginePid" in value && typeof value.enginePid === "number";
}

