import assert from "node:assert/strict";
import { test } from "node:test";
import { IdentityVerificationError, verifyIdentityPayload } from "../src/identity.ts";

const valid = {
  service: "forge-desktop-bridge",
  protocolVersion: 1,
  instanceId: "instance-a",
  launchGeneration: 2,
  capabilities: { http: true, websocket: true },
  enginePid: 123,
};

test("accepts the exact launch identity", () => {
  assert.equal(verifyIdentityPayload(valid, "instance-a", 2).enginePid, 123);
});

test("rejects stale, malformed, fake-200, and unsupported identities", () => {
  for (const value of [
    { ...valid, instanceId: "stale" },
    { ...valid, launchGeneration: 1 },
    { ...valid, protocolVersion: 2 },
    { ok: true },
    "not-json-shape",
  ]) {
    assert.throws(() => verifyIdentityPayload(value, "instance-a", 2), IdentityVerificationError);
  }
});
