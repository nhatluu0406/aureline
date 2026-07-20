import type { ProcessLogEvent } from "./types.ts";

const REDACTED = "[REDACTED]";
const QUERY_SECRET = /([?&](?:token|api_key|key|secret|password)=)([^&#\s]+)/giu;
const AUTH_BEARER = /(Authorization\s*:\s*(?:Bearer|Basic)\s+)([^\s,;]+)/giu;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/giu;
const API_AUTH = /(--api-auth(?:=|\s+))([^\s"']+)/giu;

export class SecretRedactor {
  readonly #secrets = new Set<string>();

  public constructor(secrets: readonly string[] = []) {
    this.addSecrets(secrets);
  }

  public addSecrets(secrets: readonly string[]): void {
    for (const secret of secrets) {
      if (secret.length > 0) this.#secrets.add(secret);
    }
  }

  public redact(input: string): string {
    let output = input
      .replace(API_AUTH, `$1${REDACTED}`)
      .replace(AUTH_BEARER, `$1${REDACTED}`)
      .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
      .replace(QUERY_SECRET, `$1${REDACTED}`);

    const secrets = [...this.#secrets].sort((left, right) => right.length - left.length);
    for (const secret of secrets) output = output.split(secret).join(REDACTED);
    return output;
  }
}

type LogSubscriber = (event: ProcessLogEvent) => void;

export class StructuredLogBuffer {
  readonly #history: ProcessLogEvent[] = [];
  readonly #subscribers = new Set<LogSubscriber>();
  readonly #partial: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };

  public constructor(
    private readonly limit: number,
    private readonly redactor: SecretRedactor,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("logHistoryLimit must be at least 1");
  }

  public subscribe(subscriber: LogSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  public ingest(stream: "stdout" | "stderr", chunk: Buffer | string): void {
    const combined = this.#partial[stream] + chunk.toString();
    const lines = combined.split(/\r?\n/u);
    this.#partial[stream] = lines.pop() ?? "";
    for (const line of lines) this.emit(stream, stream === "stderr" ? "error" : "info", line);
  }

  public flush(): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const partial = this.#partial[stream];
      if (partial.length > 0) this.emit(stream, stream === "stderr" ? "error" : "info", partial);
      this.#partial[stream] = "";
    }
  }

  public supervisor(level: ProcessLogEvent["level"], message: string): void {
    this.emit("supervisor", level, message);
  }

  public snapshot(): readonly ProcessLogEvent[] {
    return this.#history.map((event) => ({ ...event }));
  }

  private emit(
    stream: ProcessLogEvent["stream"],
    level: ProcessLogEvent["level"],
    message: string,
  ): void {
    const event: ProcessLogEvent = {
      timestamp: new Date().toISOString(),
      stream,
      level,
      message: this.redactor.redact(message),
    };
    this.#history.push(event);
    if (this.#history.length > this.limit) this.#history.splice(0, this.#history.length - this.limit);
    for (const subscriber of this.#subscribers) subscriber(event);
  }
}

export function secretsFromArguments(arguments_: readonly string[]): string[] {
  const found: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index];
    if (value === "--api-auth") {
      const next = arguments_[index + 1];
      if (next !== undefined) found.push(next);
    } else if (value?.startsWith("--api-auth=")) {
      found.push(value.slice("--api-auth=".length));
    }
  }
  return found;
}
