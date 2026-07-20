import assert from "node:assert/strict";
import { test } from "node:test";
import { SecretRedactor, StructuredLogBuffer, secretsFromArguments } from "../src/log-redaction.ts";

test("redacts configured, argv, authorization, URL and query secrets", () => {
  const secrets = ["configured-secret", ...secretsFromArguments(["--api-auth", "user:cli-secret"])];
  const redactor = new SecretRedactor(secrets);
  const input = [
    "configured-secret",
    "--api-auth user:cli-secret",
    "Authorization: Bearer bearer-secret",
    "Authorization: Basic basic-secret",
    "http://name:url-credential@127.0.0.1/path",
    "?token=t1&api_key=t2&key=t3&secret=t4&password=t5",
  ].join(" ");
  const output = redactor.redact(input);
  for (const secret of ["configured-secret", "user:cli-secret", "bearer-secret", "basic-secret", "url-credential", "t1", "t2", "t3", "t4", "t5"]) {
    assert.equal(output.includes(secret), false, `secret leaked: ${secret}`);
  }
  assert.match(output, /\[REDACTED\]/u);
});

test("buffers split lines, flushes tails, notifies subscribers, and bounds history", () => {
  const logs = new StructuredLogBuffer(3, new SecretRedactor(["split-secret"]));
  const observed: string[] = [];
  const unsubscribe = logs.subscribe((event) => observed.push(event.message));
  logs.ingest("stdout", "first split-");
  logs.ingest("stdout", "secret\nsecond\nthird\n");
  logs.ingest("stderr", "tail split-secret");
  logs.flush();
  unsubscribe();

  assert.deepEqual(observed, ["first [REDACTED]", "second", "third", "tail [REDACTED]"]);
  assert.deepEqual(logs.snapshot().map((event) => event.message), ["second", "third", "tail [REDACTED]"]);
});
