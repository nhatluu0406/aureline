import type { FailureStage, OwnedProcessLaunchRequest } from "./types.ts";

const MAGIC = Buffer.from("FJOBSPK1", "ascii");
const VERSION = 1;
const MAX_STRING_BYTES = 1_048_576;

function uint32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function encodedString(value: string): Buffer[] {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > MAX_STRING_BYTES) throw new RangeError("Protocol string exceeds 1 MiB");
  return [uint32(encoded.byteLength), encoded];
}

function stageCode(stage: FailureStage): number {
  if (stage === "assign") return 1;
  if (stage === "resume") return 2;
  return 0;
}

export function encodeLaunchRequest(
  request: OwnedProcessLaunchRequest,
  failureStage: FailureStage = "none",
): Buffer {
  const environment = Object.entries({ ...process.env, ...request.environment })
    .filter((entry): entry is [string, string] => entry[1] !== undefined);
  const chunks: Buffer[] = [
    MAGIC,
    uint32(VERSION),
    uint32(stageCode(failureStage)),
    ...encodedString(request.executable),
    ...encodedString(request.cwd),
    uint32(request.args.length),
  ];
  for (const argument of request.args) chunks.push(...encodedString(argument));
  chunks.push(uint32(environment.length));
  for (const [key, value] of environment) {
    chunks.push(...encodedString(key), ...encodedString(value));
  }
  return Buffer.concat(chunks);
}

