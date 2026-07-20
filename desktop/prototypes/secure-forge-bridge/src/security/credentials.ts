import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { LaunchCredentials } from "../types.ts";

export function createLaunchCredentials(): LaunchCredentials {
  return {
    edgeToken: randomBytes(32).toString("base64url"),
    backendToken: randomBytes(32).toString("base64url"),
    instanceId: randomBytes(16).toString("hex"),
  };
}

export function constantTimeEqual(actual: string | undefined, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual ?? "").digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest) && actual !== undefined;
}

export function bearerValue(token: string): string {
  return `Bearer ${token}`;
}

export function matchesBearer(value: string | undefined, token: string): boolean {
  return constantTimeEqual(value, bearerValue(token));
}

