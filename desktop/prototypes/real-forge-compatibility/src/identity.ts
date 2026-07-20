export type RealForgeIdentity = {
  service: "forge-desktop-bridge";
  protocolVersion: 1;
  instanceId: string;
  launchGeneration: number;
  capabilities: { http: true; websocket: true };
  enginePid: number;
};

export class IdentityVerificationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "IdentityVerificationError";
  }
}

export function verifyIdentityPayload(
  value: unknown,
  expectedInstanceId: string,
  expectedGeneration: number,
): RealForgeIdentity {
  if (typeof value !== "object" || value === null) throw new IdentityVerificationError("identity is not an object");
  const candidate = value as Record<string, unknown>;
  const capabilities = candidate.capabilities;
  if (candidate.service !== "forge-desktop-bridge" || candidate.protocolVersion !== 1) {
    throw new IdentityVerificationError("identity service or protocol is unsupported");
  }
  if (candidate.instanceId !== expectedInstanceId || candidate.launchGeneration !== expectedGeneration) {
    throw new IdentityVerificationError("identity does not match this launch");
  }
  if (typeof candidate.enginePid !== "number" || typeof capabilities !== "object" || capabilities === null
    || (capabilities as Record<string, unknown>).http !== true
    || (capabilities as Record<string, unknown>).websocket !== true) {
    throw new IdentityVerificationError("identity capabilities are malformed");
  }
  return candidate as RealForgeIdentity;
}
