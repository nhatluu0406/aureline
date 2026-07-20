# Aureline

> A premium, local-first AI image creation studio for Windows.

Aureline is designed around refined creative workflows, efficient GPU usage, and a secure modular desktop architecture. It is an independent product that currently uses Stable Diffusion WebUI Forge as a separately managed third-party engine.

## Status

Aureline is in active pre-release development. The desktop includes a usable Studio text-to-image happy path and a production-oriented Civitai model import vertical slice, but it is not yet a portable end-user release.

## Vision

Aureline aims to provide a focused Windows creative environment without requiring users to install Python, Git, or Node.js. The long-term distribution model separates the signed desktop shell, pinned engine runtime, user data, models, and outputs so each can evolve or roll back independently.

## Current capabilities

- Premium dark-first Electron and React shell with Studio and Settings workspaces.
- Typed local Forge connection testing and a real txt2img request flow with result, running, success, and recoverable failure states.
- A Models workspace for validated `civitai.com`/`civitai.red` links, version/file review, disk preflight, resumable verified downloads, and an indexed local library.
- OS-protected, write-only Civitai credential storage; public metadata remains usable without a key when Civitai permits it.
- Light, dark, and system themes.
- Forge engine start, stop, restart, readiness, and bounded redacted logs.
- Windows process-tree ownership through a Rust Job Object helper.
- A pre-bind ASGI guard and authenticated loopback bridge for HTTP, SSE, WebSocket, uploads, and downloads.
- Classic Forge compatibility in an isolated `WebContentsView`.
- No-model real-Forge smoke coverage and a packaged-shell smoke.

## Planned capabilities

- Advanced Studio workflows, queues, image editing, and model controls.
- Additional model providers, marketplace browsing, bulk downloads, and automatic model updates.
- GPU telemetry and calibrated VRAM safety profiles.
- A fully materialized portable Forge runtime.
- Signed release artifacts, rollback, and update workflows.

## Architecture

The renderer uses a small typed preload API and never receives process IDs, ports, engine credentials, filesystem access, or generic IPC. Electron main owns engine lifecycle, the authenticated local bridge, settings, logs, and the isolated Classic Forge view. A signed Rust helper will own the Forge process tree through a Windows Job Object, while Aureline's Python adapter installs the outer ASGI guard before Forge binds its loopback listener.

Forge remains a third-party engine. Aureline does not vendor Forge core at the repository root and does not modify its generation pipeline.

## Repository structure

```text
app/                 Electron main, preload, React renderer, and app resources
packages/            Contracts, model sources/library/downloads, process supervision, settings
engine/              Aureline adapter and external runtime manifests
native/job-owner/    Windows Job Object helper source
tests/               Production unit, integration, and controlled smoke fixtures
tooling/scripts/     Build, development, packaging, and smoke orchestration
docs/                Architecture, decisions, development guides, and product roadmap
archive/prototypes/  Historical technical evidence; never imported by production code
.reference/          Optional ignored upstream Forge checkout for developer reference only
.agents/skills/      Narrow repository workflows and quality gates
```

## Requirements

- Windows x64 for native-helper and Electron smoke tests.
- Node.js 24-compatible runtime and npm for development.
- Rust `rustc` for building the Job Object helper.
- Optional external Python 3.10 + Forge runtime for the real no-model smoke.

End users of a future portable release will not need these developer toolchains.

## Getting started

```powershell
npm install
npm run dev
```

If no valid runtime manifest is configured, Aureline opens safely and reports that the engine runtime is unavailable; it does not download a multi-gigabyte runtime on startup.

## Development

The root package is the developer entry point. See [the development guide](docs/development/development.md) and [current status](docs/architecture/current-status.md) before changing runtime boundaries.

## Testing

```powershell
npm run typecheck
npm test
npm run build
```

`npm run smoke` requires a local runtime manifest. `npm run package:dir` and `npm run smoke:packaged` validate the unpacked Windows shell without bundling Forge or models. See [testing](docs/development/testing.md).

## Building

```powershell
npm run package:dir
```

The current output is an unsigned unpacked shell with `release/win-unpacked/aureline.exe`. The displayed product name remains `Aureline`; this is not a full portable Forge distribution.

## Runtime configuration

Runtime manifests are validated by Aureline and point to an external Python executable, Forge root, launcher adapter, and Job Object helper. Start from [`engine/manifests/runtime-manifest.example.json`](engine/manifests/runtime-manifest.example.json), keep machine-local paths untracked, and set `AURELINE_RUNTIME_MANIFEST` for development or smoke runs when needed.

For the Studio happy path, start a compatible Forge instance with its normal API enabled, open **Settings**, enter its loopback URL (default `http://127.0.0.1:7860`), and test the connection. Studio sends txt2img requests through Electron main; the renderer never contacts localhost directly.

## Civitai model import

Open **Models**, paste a supported HTTPS model link from `civitai.com` or `civitai.red`, then resolve and review the model, version, file, size, and managed destination. Aureline does not auto-start downloads. Transfers use partial files, controlled Range resume, bounded retry, size/SHA-256 verification when provider metadata supplies it, and atomic installation without overwrite.

Public metadata does not require a key when the provider allows it. A key can be saved and tested under **Settings → Civitai connection**; it is encrypted with Electron `safeStorage`, never read back into the renderer, and never stored in settings, URLs, or logs. Checkpoints, LoRA/LyCORIS, VAE, and embeddings have verified Forge-compatible roots. ControlNet, upscalers, and unknown types stay disabled until a runtime confirms their destination.

See [model import development](docs/development/model-import.md), [focused model tests](docs/development/model-import-testing.md), and the [security boundary](docs/architecture/model-import-security.md).

## Local Forge reference

Developers may optionally clone the [official upstream Forge repository](https://github.com/lllyasviel/stable-diffusion-webui-forge) to `.reference/stable-diffusion-webui-forge`. The checkout is local-only, ignored by Git, must not be committed or modified for Aureline work, and is not production source. UI-only work does not require it. Production runtimes are pinned and materialized separately through Aureline runtime manifests and engine tooling.

## Security model

- Engine services bind explicitly to `127.0.0.1`; LAN and share modes are not enabled.
- The renderer cannot call Forge or localhost directly and never receives an authentication token.
- Forge is guarded before bind; Electron main validates a per-launch protected identity.
- Classic Forge uses an ephemeral isolated session with controlled navigation, permissions, downloads, and authorization-header injection.
- Secrets are transferred through an anonymous pipe, redacted from logs, and rotated on engine restart.
- Civitai URLs, API responses, redirects, preview images, destinations, and downloaded hashes are validated in Electron main; renderer IPC cannot supply arbitrary download URLs or filesystem paths.

This boundary reduces ordinary local and browser-origin threats; it is not intended to defend against administrators, same-user malware with process-memory access, or a compromised operating system.

## Third-party engine and licensing

Aureline-owned source is available under the repository's [MIT License](LICENSE). Stable Diffusion WebUI Forge is an AGPL-3.0 third-party engine and is not relicensed as MIT. A distributed engine runtime must preserve its license, notices, Corresponding Source obligations, and the obligations of bundled dependencies. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Roadmap

Studio currently targets one image at a time. Model management, galleries, editing, advanced conditioning, portable runtime bundling, and signed releases remain out of scope. See the [roadmap](docs/product/roadmap.md).

## Contributing

Read [AGENTS.md](AGENTS.md), keep changes inside the established boundaries, add focused tests, and report validation honestly. Architecture decisions belong in `docs/decisions/`.

## License

Aureline-owned source code is licensed under the [MIT License](LICENSE). Third-party components retain their own licenses.

## Acknowledgements

Aureline currently integrates [Stable Diffusion WebUI Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge) as its engine, and builds on Electron, React, Rust, Python, FastAPI, Gradio, and their ecosystems.
