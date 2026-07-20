import { setTimeout as delay } from "node:timers/promises";
import { LOOPBACK_HOST } from "./port-allocation.ts";
import type { ReadinessConfiguration } from "./types.ts";

export type ReadinessResult = {
  attempts: number;
  elapsedMs: number;
  lastDiagnostic: string;
};

export class ReadinessError extends Error {
  public constructor(
    public readonly kind: "timeout" | "process_exited",
    message: string,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = "ReadinessError";
  }
}

export async function waitForHttpReadiness(options: {
  port: number;
  configuration: ReadinessConfiguration;
  overallTimeoutMs: number;
  processExitSignal: AbortSignal;
}): Promise<ReadinessResult> {
  const { configuration, overallTimeoutMs, port, processExitSignal } = options;
  const expected = new Set(configuration.expectedStatusCodes ?? [200]);
  const startedAt = Date.now();
  let attempts = 0;
  let retryDelay = configuration.initialRetryDelayMs;
  let lastDiagnostic = "No request attempted";

  while (Date.now() - startedAt < overallTimeoutMs) {
    if (processExitSignal.aborted) {
      throw new ReadinessError("process_exited", "Child process exited before readiness", attempts);
    }
    attempts += 1;
    const requestController = new AbortController();
    const requestTimer = setTimeout(() => requestController.abort(), configuration.requestTimeoutMs);
    try {
      const signal = AbortSignal.any([processExitSignal, requestController.signal]);
      const response = await fetch(`http://${LOOPBACK_HOST}:${port}${configuration.path}`, {
        signal,
        ...(configuration.headers === undefined ? {} : { headers: configuration.headers }),
      });
      if (expected.has(response.status)) {
        await response.body?.cancel();
        return { attempts, elapsedMs: Date.now() - startedAt, lastDiagnostic: `HTTP ${response.status}` };
      }
      lastDiagnostic = `HTTP ${response.status}`;
      await response.body?.cancel();
    } catch (error: unknown) {
      if (processExitSignal.aborted) {
        throw new ReadinessError("process_exited", "Child process exited before readiness", attempts);
      }
      lastDiagnostic = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(requestTimer);
    }

    const remaining = overallTimeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    try {
      await delay(Math.min(retryDelay, remaining), undefined, { signal: processExitSignal });
    } catch {
      throw new ReadinessError("process_exited", "Child process exited before readiness", attempts);
    }
    retryDelay = Math.min(
      configuration.maximumRetryDelayMs,
      Math.max(1, Math.round(retryDelay * configuration.backoffFactor)),
    );
  }

  throw new ReadinessError(
    "timeout",
    `Readiness timed out after ${overallTimeoutMs}ms; last diagnostic: ${lastDiagnostic}`,
    attempts,
  );
}
