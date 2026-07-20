import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MainProcessForgeClient } from "./client/forge-client.ts";
import { SecureForgeProxy, classicRequestHeaders } from "./proxy/secure-proxy.ts";
import { createLaunchCredentials } from "./security/credentials.ts";
import { FakeForgeProcess } from "../test/test-helpers.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const credentials = createLaunchCredentials();
const forge = await FakeForgeProcess.start(credentials);
const proxy = await SecureForgeProxy.start({ upstreamOrigin: forge.origin, edgeToken: credentials.edgeToken, backendToken: credentials.backendToken });
try {
  const client = new MainProcessForgeClient(forge.origin, credentials.backendToken, credentials.instanceId);
  const identity = await client.verifyIdentity();
  const classic = await fetch(proxy.address.origin, { headers: classicRequestHeaders(credentials.edgeToken) });
  const result = {
    identity: { service: identity.service, protocolVersion: identity.protocolVersion, instanceMatches: identity.instanceId === credentials.instanceId },
    classic: { status: classic.status, containsFixture: (await classic.text()).includes("Classic Forge fixture") },
    directWithoutCredential: (await fetch(`${forge.origin}/api/json`)).status,
    secretScan: "passed-in-memory",
  };
  const serialized = JSON.stringify(result, null, 2);
  if ([credentials.edgeToken, credentials.backendToken].some((secret) => serialized.includes(secret))) throw new Error("Demo output contains credential");
  await mkdir(resolve(root, "test-artifacts"), { recursive: true });
  await writeFile(resolve(root, "test-artifacts/demo-result.json"), `${serialized}\n`, "utf8");
  process.stdout.write(`${serialized}\n`);
} finally {
  await proxy.close();
  await forge.stop();
}

