import type { LogEvent } from "../contracts/index.ts";

export class LogBuffer {
  readonly #events: LogEvent[] = [];
  readonly #listeners = new Set<(event: LogEvent) => void>();
  public constructor(private readonly limit = 250, private readonly secrets: string[] = []) {}
  public addSecret(secret: string): void { if (secret.length >= 8) this.secrets.push(secret); }
  public redact(value: string): string {
    return this.secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value)
      .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)\S+/giu, "$1[REDACTED]")
      .replace(/([?&](?:token|api_key|key|secret|password)=)[^&#\s]+/giu, "$1[REDACTED]");
  }
  public push(source: LogEvent["source"], level: LogEvent["level"], message: string): void {
    const event: LogEvent = { timestamp: new Date().toISOString(), source, level, message: this.redact(message).slice(0, 4_096) };
    this.#events.push(event); if (this.#events.length > this.limit) this.#events.splice(0, this.#events.length - this.limit);
    for (const listener of this.#listeners) listener(event);
  }
  public snapshot(): LogEvent[] { return this.#events.map((event) => ({ ...event })); }
  public subscribe(listener: (event: LogEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
}
