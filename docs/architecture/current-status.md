# Aureline current status

## Available now

Aureline has a production-oriented Electron foundation and a focused Studio text-to-image happy path. The dark-first shell includes a responsive settings panel, prompt composer, essential generation controls, canvas result area, and explicit empty, running, success, and recoverable failure states. Light and system themes remain available.

Studio can connect to an already-running compatible Forge API on `127.0.0.1` or `localhost`. Connection checks use `/sdapi/v1/samplers`; one-image generation uses `/sdapi/v1/txt2img`. Electron main owns those requests behind typed, runtime-validated preload contracts, so the renderer never calls localhost directly. The Forge URL, prompt, negative prompt, and last generation settings persist in Electron user data.

The existing managed-runtime foundation remains available: validated runtime manifests, the Forge launch adapter, authenticated loopback bridge, bounded logs, Classic compatibility controller, and Windows Job Object ownership. The optional `.reference/` checkout is developer reference only and is not a runtime or build dependency.

The Models workspace now resolves validated `civitai.com` and `civitai.red` model/version links through the public Civitai API, presents normalized metadata, and installs an explicitly selected file into a managed Forge-compatible root. Electron main owns provider access, OS-protected credentials, preview proxying, download lifecycle, disk/path checks, streaming SHA-256 verification, atomic finalization, local indexing, and best-effort Forge checkpoint/LoRA refresh. The renderer receives only typed domain data and display-safe locations.

## Runtime expectations

The Studio happy path expects Forge to be started separately with its normal API enabled and a model available. Aureline defaults to `http://127.0.0.1:7860`, accepts loopback HTTP endpoints only, and does not bundle Forge, Python, models, or generated assets.

## Intentionally out of scope

- Marketplace browsing, providers beyond Civitai, bulk downloads, model conversion, and automatic updates.
- Runtime-confirmed ControlNet/upscaler destinations and full LoRA activation in Studio.
- Batch queues, galleries, image editing, inpainting, ControlNet, LoRA management, and workflow templates.
- GPU/VRAM telemetry and inference compatibility certification.
- Portable runtime materialization, installer, updater, signing, and production release certification.
- A full production brand package; the current Aureline glyph and wordmark are intentionally restrained.

Forge remains an AGPL-3.0 third-party runtime. Aureline-owned source remains MIT-licensed, and the official upstream reference is `lllyasviel/stable-diffusion-webui-forge`.
