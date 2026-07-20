import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { WebSocket } from "ws";
import { MainProcessForgeClient, ForgeIdentityError } from "../src/client/forge-client.ts";
import { createLaunchCredentials } from "../src/security/credentials.ts";
import { classicRequestHeaders, EDGE_AUTH_HEADER, SecureForgeProxy } from "../src/proxy/secure-proxy.ts";
import { FakeForgeProcess, isPidAlive, startImpostor } from "./test-helpers.ts";

async function stack() {
  const credentials = createLaunchCredentials();
  const forge = await FakeForgeProcess.start(credentials);
  const proxy = await SecureForgeProxy.start({
    upstreamOrigin: forge.origin,
    edgeToken: credentials.edgeToken,
    backendToken: credentials.backendToken,
    requestTimeoutMs: 250,
    maximumRequestBytes: 4 * 1024 * 1024,
  });
  const client = new MainProcessForgeClient(forge.origin, credentials.backendToken, credentials.instanceId);
  return { credentials, forge, proxy, client };
}

async function dispose(value: Awaited<ReturnType<typeof stack>>): Promise<void> {
  await value.proxy.close().catch(() => undefined);
  await value.forge.stop();
}

function classicFetch(value: Awaited<ReturnType<typeof stack>>, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${value.proxy.address.origin}${path}`, {
    ...init,
    headers: { ...classicRequestHeaders(value.credentials.edgeToken, value.proxy.address.origin), ...Object.fromEntries(new Headers(init.headers)) },
    redirect: init.redirect ?? "manual",
  });
}

async function rawRequest(origin: string, path: string, headers: Record<string, string>): Promise<number> {
  const target = new URL(path, origin);
  return await new Promise<number>((resolveStatus, reject) => {
    const request = httpRequest(target, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolveStatus(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

test("authenticates Studio/backend and Classic/proxy while rejecting missing, wrong, Host, Origin and CSRF", async () => {
  const value = await stack();
  try {
    assert.deepEqual(await (await value.client.request("/api/json")).json(), { ok: true });
    assert.equal((await fetch(`${value.forge.origin}/api/json`)).status, 401);
    assert.equal((await value.client.request("/api/json", { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(`${value.proxy.address.origin}/api/json`)).status, 401);
    assert.equal((await fetch(`${value.proxy.address.origin}/api/json`, { headers: { [EDGE_AUTH_HEADER]: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(`${value.proxy.address.origin}/api/json`, {
      method: "POST",
      headers: { ...classicRequestHeaders(value.credentials.edgeToken), Origin: "https://evil.example", "Content-Type": "application/json" },
      body: "{}",
    })).status, 403);
    assert.equal(await rawRequest(value.proxy.address.origin, "/api/json", {
      ...classicRequestHeaders(value.credentials.edgeToken), Host: "localhost:1",
    }), 421);
    assert.equal(await rawRequest(value.proxy.address.origin, "/api/json", {
      ...classicRequestHeaders(value.credentials.edgeToken), "Sec-Fetch-Site": "cross-site",
    }), 403);
    const identity = await value.client.verifyIdentity();
    assert.equal(identity.instanceId, value.credentials.instanceId);
    assert.equal(identity.enginePid, value.forge.pid);
  } finally { await dispose(value); }
});

test("preserves Classic HTML/static, JSON POST, multipart, download, redirect, cookies and extension routes", async () => {
  const value = await stack();
  try {
    const html = await (await classicFetch(value, "/")).text();
    assert.match(html, /Classic Forge fixture/u);
    assert.equal(/localStorage|sessionStorage|token=/iu.test(html), false);
    assert.match(await (await classicFetch(value, "/static/app.js")).text(), /fakeForgeLoaded/u);
    assert.deepEqual(await (await classicFetch(value, "/api/echo", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "fixture" }),
    })).json(), { body: { prompt: "fixture" } });

    const form = new FormData();
    form.set("file", new Blob([Buffer.from("upload-body")]), "sample.bin");
    const upload = await (await classicFetch(value, "/upload", { method: "POST", body: form })).json() as { bytes: number; contentType: string };
    assert.ok(upload.bytes > "upload-body".length);
    assert.match(upload.contentType, /^multipart\/form-data; boundary=/u);

    assert.deepEqual(new Uint8Array(await (await classicFetch(value, "/download")).arrayBuffer()), new Uint8Array([0, 1, 2, 3, 254, 255]));
    const redirect = await classicFetch(value, "/redirect");
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), `${value.proxy.address.origin}/api/json`);
    const cookie = await classicFetch(value, "/cookie");
    assert.match(cookie.headers.get("set-cookie") ?? "", /HttpOnly/u);
    assert.deepEqual(await (await classicFetch(value, "/extension/nested/route")).json(), { extension: true });
    const inspected = await (await classicFetch(value, "/inspect")).json() as { host: string; origin: string };
    assert.equal(inspected.host, new URL(value.forge.origin).host);
    assert.equal(inspected.origin, "http://forge-desktop.internal");
  } finally { await dispose(value); }
});

test("authorizes WebSocket with the same boundary and rejects unauthorized upgrade", async () => {
  const value = await stack();
  try {
    const authorized = new WebSocket(`${value.proxy.address.origin.replace("http:", "ws:")}/queue/join`, {
      headers: classicRequestHeaders(value.credentials.edgeToken, value.proxy.address.origin),
    });
    await new Promise<void>((resolveOpen, reject) => { authorized.once("open", resolveOpen); authorized.once("error", reject); });
    const echoed = new Promise<string>((resolveMessage) => authorized.once("message", (data) => resolveMessage(data.toString())));
    authorized.send("progress-fixture");
    assert.equal(await echoed, "progress-fixture");
    authorized.close();

    const unauthorized = new WebSocket(`${value.proxy.address.origin.replace("http:", "ws:")}/queue/join`);
    const status = await new Promise<number>((resolveStatus) => {
      unauthorized.once("unexpected-response", (_request, response) => resolveStatus(response.statusCode ?? 0));
      unauthorized.once("error", () => resolveStatus(0));
    });
    assert.equal(status, 401);
    unauthorized.terminate();

    const direct = new WebSocket(`${value.forge.origin.replace("http:", "ws:")}/queue/join`);
    const directStatus = await new Promise<number>((resolveStatus) => {
      direct.once("unexpected-response", (_request, response) => resolveStatus(response.statusCode ?? 0));
      direct.once("error", () => resolveStatus(0));
    });
    assert.equal(directStatus, 401);
    direct.terminate();
  } finally { await dispose(value); }
});

test("streams responses, transfers a moderate large payload and returns structured upstream failure", async () => {
  const value = await stack();
  try {
    assert.equal(await (await classicFetch(value, "/stream")).text(), "one\ntwo\nthree\n");
    assert.equal(await (await classicFetch(value, "/slow-stream")).text(), "data: first\n\ndata: after-idle\n\n");
    const large = Buffer.from(await (await classicFetch(value, "/large")).arrayBuffer());
    assert.equal(large.byteLength, 2 * 1024 * 1024);
    assert.equal(createHash("sha256").update(large).digest("hex"), createHash("sha256").update(Buffer.alloc(2 * 1024 * 1024, 0x5a)).digest("hex"));
    const oversized = await classicFetch(value, "/upload", { method: "POST", body: Buffer.alloc(5 * 1024 * 1024, 0x41) });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "request_too_large" });
    const timedOut = await classicFetch(value, "/delay?ms=400");
    assert.equal(timedOut.status, 504);
    assert.deepEqual(await timedOut.json(), { error: "upstream_timeout" });
    const disconnected = await classicFetch(value, "/disconnect");
    assert.equal(disconnected.status, 502);
    assert.deepEqual(await disconnected.json(), { error: "upstream_unavailable" });
  } finally { await dispose(value); }
});

test("rotates both credentials, rejects stale replay and detects a fake identity", async () => {
  const first = await stack();
  const old = { ...first.credentials };
  await dispose(first);
  const second = await stack();
  try {
    assert.notEqual(second.credentials.edgeToken, old.edgeToken);
    assert.notEqual(second.credentials.backendToken, old.backendToken);
    assert.notEqual(second.credentials.instanceId, old.instanceId);
    assert.equal((await fetch(`${second.proxy.address.origin}/api/json`, { headers: classicRequestHeaders(old.edgeToken) })).status, 401);
    const staleClient = new MainProcessForgeClient(second.forge.origin, old.backendToken, old.instanceId);
    assert.equal((await staleClient.request("/api/json")).status, 401);

    const impostor = await startImpostor();
    try {
      const client = new MainProcessForgeClient(impostor.origin, "irrelevant", second.credentials.instanceId);
      await assert.rejects(client.verifyIdentity(), ForgeIdentityError);
    } finally { await impostor.close(); }
  } finally { await dispose(second); }
});

test("keeps credentials out of argv, URL, logs and serialized diagnostics", async () => {
  const value = await stack();
  try {
    await fetch(`${value.proxy.address.origin}/api/json`, { headers: { Origin: "https://evil.example" } });
    await value.client.request("/debug/argv");
    const argv = await (await value.client.request("/debug/argv")).json() as { argv: string[] };
    const serialized = JSON.stringify({
      argv,
      spawnArguments: value.forge.spawnArguments,
      forgeStdout: value.forge.stdoutLines,
      forgeStderr: value.forge.stderrLines,
      proxyLogs: value.proxy.logs,
      proxyUrl: value.proxy.address.origin,
      backendUrl: value.forge.origin,
    });
    for (const secret of [value.credentials.edgeToken, value.credentials.backendToken]) {
      assert.equal(serialized.includes(secret), false, "credential leaked into diagnostics");
    }
    assert.equal(/[?&](?:token|api_key|key|secret|password)=/iu.test(serialized), false);
  } finally { await dispose(value); }
});

test("shutdown closes proxy listener and fake process", async () => {
  const value = await stack();
  const proxyOrigin = value.proxy.address.origin;
  const pid = value.forge.pid;
  await dispose(value);
  assert.equal(isPidAlive(pid), false);
  await assert.rejects(fetch(`${proxyOrigin}/api/json`));
});
