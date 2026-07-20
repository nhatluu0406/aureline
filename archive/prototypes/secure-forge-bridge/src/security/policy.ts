import type { IncomingHttpHeaders } from "node:http";

export type BrowserRequestDecision =
  | { allowed: true }
  | { allowed: false; status: 403 | 421; code: "unexpected_host" | "unexpected_origin" | "cross_site_request" };

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

export function validateBrowserRequest(
  headers: IncomingHttpHeaders,
  expectedAuthority: string,
  expectedOrigin: string,
): BrowserRequestDecision {
  if (firstHeader(headers.host) !== expectedAuthority) {
    return { allowed: false, status: 421, code: "unexpected_host" };
  }
  const origin = firstHeader(headers.origin);
  if (origin !== undefined && origin !== expectedOrigin) {
    return { allowed: false, status: 403, code: "unexpected_origin" };
  }
  const fetchSite = firstHeader(headers["sec-fetch-site"]);
  if (origin === undefined && fetchSite !== undefined && !["same-origin", "none"].includes(fetchSite)) {
    return { allowed: false, status: 403, code: "cross_site_request" };
  }
  return { allowed: true };
}

export function pathWithoutSensitiveQuery(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/invalid-url";
  }
}
