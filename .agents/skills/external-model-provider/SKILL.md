---
name: external-model-provider
description: Add or review an external AI-model metadata and download provider with strict URL, credential, redirect, filesystem, checksum, and IPC boundaries. Use for provider adapters, model imports, resumable model downloads, preview proxies, or model-library installation flows.
---

# External model provider

1. Validate provider URLs before network access: exact HTTPS hosts, no credentials, ports, fragments, IP literals, lookalikes, or unbounded input.
2. Runtime-validate external JSON and map it to a provider-neutral model/version/file contract. Never expose raw responses.
3. Keep credentials write-only from renderer, encrypt with OS protection, fail closed without encryption, use headers, redact errors/logs, and never forward credentials cross-host.
4. Create downloads only from resolved metadata. Do not expose generic URL/path download IPC.
5. Validate every redirect, resolve DNS, reject private/link-local/loopback destinations, cap redirects, strip authorization on host change, and bound time/size.
6. Use a state machine, throttled progress, abort-plus-Range resume, versioned sidecars, and bounded retry honoring `Retry-After`.
7. Preflight an allowlisted model root, disk reserve, duplicate and path length. Sanitize basenames and keep partials outside model discovery.
8. Stream SHA-256, compare provider SHA-256 when present, fail closed on mismatch, and atomically rename without overwrite.
9. Proxy previews through main with HTTPS host allowlists, image content types, byte/time limits, bounded cache, no credentials, and sensitive-preview blur.
10. Test parser attacks, response drift, credential redaction, redirects/private networks, resume/cancel/hash mismatch, atomic install, IPC validation, and packaged artifact exclusion.

Production dependency direction remains renderer → typed preload → main application service → provider/downloader/library adapters. Renderer never owns network credentials, arbitrary paths, or filesystem writes.
