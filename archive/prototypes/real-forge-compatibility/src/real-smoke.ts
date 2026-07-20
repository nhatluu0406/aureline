import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import {
  BACKEND_AUTH_HEADER,
  SecureForgeProxy,
  classicRequestHeaders,
} from "../../secure-forge-bridge/src/proxy/secure-proxy.ts";
import { verifyIdentityPayload, type RealForgeIdentity } from "./identity.ts";

const LOOPBACK = "127.0.0.1";
const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(prototypeRoot, "../../..");
const pythonExecutable = resolve(prototypeRoot, ".runtime/python-3.10.11/python.exe");
const adapterPath = resolve(prototypeRoot, "adapter/secure_launcher.py");
const extensionSource = resolve(prototypeRoot, "fixtures/test-extension");
const smokeRoot = resolve(prototypeRoot, ".smoke/active");
const artifactsRoot = resolve(prototypeRoot, "test-artifacts");
const BACKEND_ORIGIN = "http://forge-desktop.internal";

type Launch = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  origin: string;
  backendToken: string;
  edgeToken: string;
  instanceId: string;
  generation: number;
  logs: string[];
  spawnAt: number;
  firstObservedAt: number;
  firstUnauthorizedStatus: number;
  identityReadyAt: number;
  applicationReadyAt: number;
  identity: RealForgeIdentity;
  argv: string[];
  startupLogs: string;
};

type SmokeSummary = {
  environment: Record<string, unknown>;
  launches: Array<Record<string, unknown>>;
  checks: string[];
  routeInventory: Record<string, unknown>;
};

function mark(summary: SmokeSummary, check: string): void {
  summary.checks.push(check);
  process.stdout.write(`CHECK ${check}\n`);
  appendFileSync(resolve(artifactsRoot, "progress.log"), `${new Date().toISOString()} ${check}\n`, "utf8");
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function auth(value: string): string {
  return `Bearer ${value}`;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host: LOOPBACK, port: 0, exclusive: true }, resolvePromise);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
  return address.port;
}

async function writeIsolatedConfig(dataRoot: string): Promise<void> {
  const builtins = await readdir(resolve(repoRoot, "extensions-builtin"), { withFileTypes: true });
  await writeFile(resolve(dataRoot, "config.json"), JSON.stringify({
    disabled_extensions: builtins.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    disable_all_extensions: "none",
    auto_launch_browser: "None",
    clean_temp_dir_at_start: false,
  }), "utf8");
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = resolve(root, entry.name);
    return entry.isDirectory() ? await filesUnder(path) : [path];
  }))).flat();
}

async function launchForge(generation: number): Promise<Launch> {
  const dataRoot = resolve(smokeRoot, `generation-${generation}/data`);
  const modelsRoot = resolve(smokeRoot, `generation-${generation}/models`);
  const outputsRoot = resolve(smokeRoot, `generation-${generation}/outputs`);
  await mkdir(resolve(dataRoot, "extensions/real-forge-smoke"), { recursive: true });
  await mkdir(modelsRoot, { recursive: true });
  await mkdir(outputsRoot, { recursive: true });
  await cp(extensionSource, resolve(dataRoot, "extensions/real-forge-smoke"), { recursive: true });
  assert((await stat(resolve(dataRoot, "extensions/real-forge-smoke/scripts/smoke_extension.py"))).isFile());
  await writeIsolatedConfig(dataRoot);
  const downloadFixture = resolve(dataRoot, "downloads/desktop-smoke.txt");
  await mkdir(dirname(downloadFixture), { recursive: true });
  await writeFile(downloadFixture, "real Forge bounded download fixture\n", "utf8");

  const port = await freePort();
  const backendToken = token();
  const edgeToken = token();
  const instanceId = randomBytes(16).toString("hex");
  const argv = [
    adapterPath,
    "--skip-prepare-environment", "--skip-install", "--skip-version-check", "--skip-torch-cuda-test",
    "--always-cpu", "--ui-debug-mode", "--api", "--no-download-sd-model", "--do-not-download-clip",
    "--server-name", LOOPBACK, "--port", String(port),
    "--data-dir", dataRoot, "--models-dir", modelsRoot,
    "--ckpt-dir", resolve(modelsRoot, "Stable-diffusion"),
    "--gradio-allowed-path", dataRoot,
  ];
  assert(!argv.join(" ").includes(backendToken));
  const child = spawn(pythonExecutable, argv, {
    cwd: repoRoot,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GRADIO_ANALYTICS_ENABLED: "False",
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      HF_DATASETS_OFFLINE: "1",
      PYTHONUNBUFFERED: "1",
    },
  });
  const logs: string[] = [];
  const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    logs.push(`${stream}:${chunk.toString("utf8")}`);
    if (logs.length > 400) logs.splice(0, logs.length - 400);
  };
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
  const spawnAt = Date.now();
  child.stdin.end(`${JSON.stringify({
    frameVersion: 1,
    protocolVersion: 1,
    token: backendToken,
    instanceId,
    expectedHost: `${LOOPBACK}:${port}`,
    launchGeneration: generation,
  })}\n`);

  const origin = `http://${LOOPBACK}:${port}`;
  let firstObservedAt = 0;
  let firstUnauthorizedStatus = 0;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Forge exited during startup (${child.exitCode}): ${logs.join("").slice(-4000)}`);
    try {
      const response = await fetch(origin, { redirect: "manual", signal: AbortSignal.timeout(250) });
      firstObservedAt = Date.now();
      firstUnauthorizedStatus = response.status;
      await response.body?.cancel();
      break;
    } catch {
      await delay(10);
    }
  }
  assert.equal(firstUnauthorizedStatus, 401, "first observable HTTP response must be guarded");

  let identity: RealForgeIdentity | undefined;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Forge exited before identity (${child.exitCode}): ${logs.join("").slice(-4000)}`);
    try {
      const response = await fetch(`${origin}/bridge/identity`, {
        headers: { [BACKEND_AUTH_HEADER]: auth(backendToken) },
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) identity = verifyIdentityPayload(await response.json(), instanceId, generation);
      if (identity !== undefined) break;
    } catch {
      // UI construction continues after the listener exists; keep probing the protected identity.
    }
    await delay(50);
  }
  if (identity === undefined) throw new Error(`protected identity timed out: ${logs.join("").slice(-5000)}`);
  const identityReadyAt = Date.now();
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Forge exited before route readiness (${child.exitCode})`);
    try {
      const response = await fetch(`${origin}/desktop-smoke/extension`, {
        headers: { [BACKEND_AUTH_HEADER]: auth(backendToken) },
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) break;
    } catch {
      // The listener and identity exist before Forge finishes late route callbacks.
    }
    await delay(50);
  }
  const finalProbe = await fetch(`${origin}/desktop-smoke/extension`, { headers: { [BACKEND_AUTH_HEADER]: auth(backendToken) } });
  if (!finalProbe.ok) throw new Error(`protected Forge route readiness timed out with HTTP ${finalProbe.status}: ${logs.join("").slice(-5000)}`);
  await finalProbe.body?.cancel();
  return {
    child, port, origin, backendToken, edgeToken, instanceId, generation, logs, spawnAt,
    firstObservedAt, firstUnauthorizedStatus, identityReadyAt, applicationReadyAt: Date.now(), identity, argv,
    startupLogs: logs.join(""),
  };
}

async function backendFetch(launch: Launch, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(BACKEND_AUTH_HEADER, auth(launch.backendToken));
  return await fetch(new URL(path, launch.origin), { ...init, headers });
}

function proxyHeaders(launch: Launch, proxyOrigin?: string): Record<string, string> {
  return classicRequestHeaders(launch.edgeToken, proxyOrigin);
}

async function customStatus(origin: string, path: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(path, origin);
  return await new Promise<number>((resolvePromise, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", headers }, (response) => {
      response.resume();
      resolvePromise(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.end();
  });
}

async function webSocketEcho(url: string, headers: Record<string, string>): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const socket = new WebSocket(url, { headers });
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error("WebSocket timeout")); }, 5_000);
    socket.once("open", () => socket.send("real-forge"));
    socket.once("message", (value) => { clearTimeout(timeout); resolvePromise(value.toString()); socket.close(); });
    socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

async function readStreamUntil(response: Response, pattern: RegExp, timeoutMs: number): Promise<string> {
  assert(response.body, "stream response body is missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let output = "";
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        delay(remaining).then(() => { throw new Error(`stream timeout; received: ${output.slice(-2000)}`); }),
      ]);
      output += decoder.decode(result.value, { stream: !result.done });
      if (pattern.test(output)) return output;
      if (result.done) break;
    }
    throw new Error(`stream ended before expected event; received: ${output.slice(-2000)}`);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function terminateOwnedProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
  await new Promise<void>((resolvePromise) => killer.once("exit", () => resolvePromise()));
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    delay(10_000).then(() => { throw new Error(`owned Forge process ${child.pid} did not exit`); }),
  ]);
}

async function assertPortClosed(port: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const server = createNetServer();
    try {
      await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen({ host: LOOPBACK, port, exclusive: true }, resolvePromise);
      });
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      return;
    } catch {
      server.close();
      await delay(100);
    }
  }
  throw new Error(`listener remained on ${LOOPBACK}:${port}`);
}

function extractAssetPaths(html: string): { js?: string; css?: string } {
  const urls = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/giu)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined && !/^https?:\/\//iu.test(value));
  const js = urls.find((value) => /\.js(?:\?|$)/u.test(value));
  const css = urls.find((value) => /\.css(?:\?|$)/u.test(value));
  return { ...(js === undefined ? {} : { js }), ...(css === undefined ? {} : { css }) };
}

async function runCompatibilityChecks(launch: Launch, summary: SmokeSummary): Promise<void> {
  const proxy = await SecureForgeProxy.start({
    upstreamOrigin: launch.origin,
    edgeToken: launch.edgeToken,
    backendToken: launch.backendToken,
    requestTimeoutMs: 5_000,
    maximumRequestBytes: 8 * 1024 * 1024,
  });
  const classicHeaders = proxyHeaders(launch);
  const browserHeaders = proxyHeaders(launch, proxy.address.origin);
  try {
    assert.equal((await fetch(launch.origin)).status, 401);
    assert.equal((await fetch(`${launch.origin}/sdapi/v1/cmd-flags`, { headers: { [BACKEND_AUTH_HEADER]: auth("wrong") } })).status, 401);
    assert.equal(await customStatus(launch.origin, "/", { Host: "localhost:7860", [BACKEND_AUTH_HEADER]: auth(launch.backendToken) }), 421);
    assert.equal((await fetch(`${launch.origin}/`, { headers: { Origin: "https://evil.example", [BACKEND_AUTH_HEADER]: auth(launch.backendToken) } })).status, 403);
    assert.equal((await fetch(`${proxy.address.origin}/desktop-smoke/post`, {
      method: "POST", headers: { ...classicHeaders, Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}",
    })).status, 403);
    mark(summary, "direct-auth-host-origin-csrf");

    const root = await fetch(proxy.address.origin, { headers: classicHeaders });
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type") ?? "", /text\/html/u);
    const html = await root.text();
    assert.match(html, /Stable Diffusion|Forge|gradio/iu);
    const assets = extractAssetPaths(html);
    assert(assets.js, "representative JavaScript asset missing from Forge HTML");
    assert(assets.css, "representative CSS asset missing from Forge HTML");
    for (const path of [assets.js, assets.css]) {
      const response = await fetch(new URL(path, proxy.address.origin), { headers: classicHeaders });
      assert.equal(response.status, 200);
      assert((await response.arrayBuffer()).byteLength > 0);
    }
    const reload = await fetch(proxy.address.origin, { headers: classicHeaders });
    assert.equal(reload.status, 200);
    summary.routeInventory.assets = assets;
    mark(summary, "html-static-ui-reload");

    const cmdFlags = await backendFetch(launch, "/sdapi/v1/cmd-flags");
    const cmdFlagsBody = await cmdFlags.text();
    assert.equal(cmdFlags.status, 500);
    assert.match(cmdFlagsBody, /ResponseValidationError/u);
    summary.routeInventory.cmdFlags = { status: cmdFlags.status, finding: "ResponseValidationError" };
    for (const path of ["/sdapi/v1/options", "/sdapi/v1/progress?skip_current_image=true"]) {
      const response = await backendFetch(launch, path);
      const body = await response.text();
      assert.equal(response.status, 200, `${path}: ${body.slice(0, 1000)}`);
      JSON.parse(body);
    }
    const optionsPost = await backendFetch(launch, "/sdapi/v1/options", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(optionsPost.status, 200);
    mark(summary, "safe-forge-api-get-post");

    const extension = await fetch(`${proxy.address.origin}/desktop-smoke/extension`, { headers: classicHeaders });
    assert.deepEqual(await extension.json(), { extension: "real-forge-smoke", registered: true }, launch.startupLogs.slice(-16000));
    assert.equal((await fetch(`${launch.origin}/desktop-smoke/extension`)).status, 401);
    const extensionPost = await fetch(`${proxy.address.origin}/desktop-smoke/post`, {
      method: "POST", headers: { ...browserHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ bounded: true }),
    });
    assert.deepEqual(await extensionPost.json(), { body: { bounded: true } });
    mark(summary, "real-extension-protected");

    const stream = await fetch(`${proxy.address.origin}/desktop-smoke/stream`, { headers: classicHeaders });
    assert.equal(stream.status, 200);
    assert.match(await stream.text(), /real-forge-one[\s\S]*real-forge-two/u);
    mark(summary, "real-extension-stream");

    const gradioConfig = await (await fetch(`${proxy.address.origin}/config`, { headers: classicHeaders })).json() as {
      dependencies?: Array<{ api_name?: string }>;
    };
    const fnIndex = gradioConfig.dependencies?.findIndex((dependency) => dependency.api_name === "desktop_smoke_echo") ?? -1;
    assert(fnIndex >= 0, "real extension Gradio dependency was not present in /config");
    const sessionHash = randomBytes(8).toString("hex");
    const queueJoin = await fetch(`${proxy.address.origin}/queue/join`, {
      method: "POST",
      headers: { ...browserHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ data: ["queue-value"], session_hash: sessionHash, fn_index: fnIndex }),
    });
    assert.equal(queueJoin.status, 200);
    const event = await queueJoin.json() as { event_id?: string };
    assert.equal(typeof event.event_id, "string");
    const queueData = await fetch(`${proxy.address.origin}/queue/data?session_hash=${sessionHash}`, {
      headers: classicHeaders,
      signal: AbortSignal.timeout(20_000),
    });
    const queueText = await readStreamUntil(queueData, /process_completed/u, 20_000);
    assert.match(queueText, /process_completed/u);
    assert.match(queueText, /echo:queue-value/u);
    mark(summary, "fastapi-stream-and-gradio-post-sse-queue");

    const form = new FormData();
    form.append("files", new Blob(["bounded upload\n"], { type: "text/plain" }), "bounded.txt");
    const upload = await fetch(`${proxy.address.origin}/upload`, { method: "POST", headers: classicHeaders, body: form });
    assert.equal(upload.status, 200);
    const uploaded = await upload.json() as string[];
    assert.equal(uploaded.length, 1);
    const uploadedPath = uploaded[0];
    assert(uploadedPath);
    const uploadDownload = await fetch(new URL(`/file=${uploadedPath.replaceAll("\\", "/")}`, proxy.address.origin), { headers: classicHeaders });
    assert.equal(uploadDownload.status, 200);
    assert.equal(await uploadDownload.text(), "bounded upload\n");
    const fixturePath = resolve(smokeRoot, `generation-${launch.generation}/data/downloads/desktop-smoke.txt`).replaceAll("\\", "/");
    const ranged = await fetch(new URL(`/file=${fixturePath}`, proxy.address.origin), { headers: { ...classicHeaders, Range: "bytes=0-3" } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 4);
    mark(summary, "real-gradio-upload-file-download-range");

    const redirect = await fetch(`${proxy.address.origin}/desktop-smoke/redirect`, { headers: classicHeaders, redirect: "manual" });
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.get("location"), "/desktop-smoke/cookie");
    const cookie = await fetch(new URL(redirect.headers.get("location") ?? "/", proxy.address.origin), { headers: classicHeaders });
    assert.match(cookie.headers.get("set-cookie") ?? "", /HttpOnly/iu);
    mark(summary, "redirect-cookie-root-path");

    assert.equal(await webSocketEcho(`${proxy.address.origin.replace("http", "ws")}/desktop-smoke/ws`, classicHeaders), "echo:real-forge");
    await assert.rejects(webSocketEcho(`${launch.origin.replace("http", "ws")}/desktop-smoke/ws`, {}));
    mark(summary, "real-extension-websocket-auth");

    const argvResponse = await backendFetch(launch, "/desktop-smoke/argv");
    const argvPayload = await argvResponse.json() as { argv: string[] };
    const serializedArgv = JSON.stringify(argvPayload.argv);
    assert(!serializedArgv.includes(launch.backendToken));
    assert(!serializedArgv.includes(launch.edgeToken));
    assert(!launch.logs.join("").includes(launch.backendToken));
    assert(!launch.logs.join("").includes(launch.edgeToken));
    assert(!html.includes(launch.backendToken) && !html.includes(launch.edgeToken));
    assert(!proxy.logs.some((event) => JSON.stringify(event).includes(launch.backendToken) || JSON.stringify(event).includes(launch.edgeToken)));
    mark(summary, "secret-argv-url-html-log-scan");

    const abortController = new AbortController();
    const aborted = fetch(`${proxy.address.origin}/desktop-smoke/delayed`, { headers: classicHeaders, signal: abortController.signal });
    setTimeout(() => abortController.abort(), 50);
    await assert.rejects(aborted, { name: "AbortError" });
    mark(summary, "client-abort");

    await terminateOwnedProcess(launch.child);
    const unavailable = await fetch(`${proxy.address.origin}/desktop-smoke/extension`, { headers: classicHeaders });
    assert.equal(unavailable.status, 502);
    mark(summary, "upstream-shutdown-structured-502");
  } finally {
    await proxy.close();
    await terminateOwnedProcess(launch.child);
    await assertPortClosed(launch.port);
    await assertPortClosed(proxy.address.port);
  }
}

async function fakeIdentityCheck(): Promise<void> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolvePromise) => server.listen({ host: LOOPBACK, port: 0 }, resolvePromise));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  try {
    const value: unknown = await (await fetch(`http://${LOOPBACK}:${address.port}`)).json();
    assert.throws(() => verifyIdentityPayload(value, "expected", 1));
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}

async function main(): Promise<void> {
  assert((await stat(pythonExecutable)).isFile(), "materialized Python 3.10 runtime is required");
  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(smokeRoot, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });
  await writeFile(resolve(artifactsRoot, "progress.log"), "", "utf8");
  const summary: SmokeSummary = {
    environment: { platform: process.platform, architecture: process.arch, node: process.version },
    launches: [], checks: [], routeInventory: {},
  };
  let first: Launch | undefined;
  let second: Launch | undefined;
  try {
    first = await launchForge(1);
    summary.launches.push({
      generation: 1, port: first.port, pid: first.identity.enginePid,
      spawnAt: first.spawnAt, listenerFirstObservedAt: first.firstObservedAt,
      firstUnauthorizedStatus: first.firstUnauthorizedStatus, identityReadyAt: first.identityReadyAt,
      applicationReadyAt: first.applicationReadyAt,
    });
    await runCompatibilityChecks(first, summary);

    const secondLaunch = await launchForge(2);
    second = secondLaunch;
    summary.launches.push({
      generation: 2, port: secondLaunch.port, pid: secondLaunch.identity.enginePid,
      spawnAt: secondLaunch.spawnAt, listenerFirstObservedAt: secondLaunch.firstObservedAt,
      firstUnauthorizedStatus: secondLaunch.firstUnauthorizedStatus, identityReadyAt: secondLaunch.identityReadyAt,
      applicationReadyAt: secondLaunch.applicationReadyAt,
    });
    assert.notEqual(secondLaunch.backendToken, first.backendToken);
    const stale = await fetch(`${secondLaunch.origin}/bridge/identity`, { headers: { [BACKEND_AUTH_HEADER]: auth(first.backendToken) } });
    assert.equal(stale.status, 401);
    const wrongInstance = { ...secondLaunch.identity, instanceId: first.instanceId };
    assert.throws(() => verifyIdentityPayload(wrongInstance, secondLaunch.instanceId, 2));
    await fakeIdentityCheck();
    mark(summary, "credential-rotation-stale-token-wrong-and-fake-identity");

    const modelFiles = await filesUnder(resolve(smokeRoot, "generation-1/models"));
    assert.deepEqual(modelFiles, [], "model directories may be created but must contain no downloaded files");
    summary.routeInventory.modelMaterialization = { files: 0, bytes: 0 };
    mark(summary, "no-model-no-generation");
  } finally {
    if (second !== undefined) {
      await terminateOwnedProcess(second.child);
      await assertPortClosed(second.port);
    }
    if (first !== undefined) {
      await terminateOwnedProcess(first.child);
      await assertPortClosed(first.port);
    }
    await writeFile(resolve(artifactsRoot, "real-smoke-result.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await rm(smokeRoot, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ result: "pass", checks: summary.checks.length, launches: summary.launches }, null, 2)}\n`);
}

await main();
