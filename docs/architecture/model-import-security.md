# Model import security boundary

The Models vertical slice follows this dependency direction:

```text
renderer → typed preload → Electron main application service
         → Civitai source → download manager → model library → Forge refresh adapter
```

`model-sources/civitai` validates exact HTTPS hosts and external JSON, then emits provider-neutral model/version/file metadata. It never writes files. `download-manager` accepts only selections from a live resolved record, validates every redirect and destination, keeps `.aureline.part` plus a versioned sidecar outside model discovery, supports abort-plus-Range resume, throttles progress, computes streaming SHA-256, and atomically renames without overwrite. `model-library` owns the allowlisted roots, cached discovery index, duplicates, and display-safe locations.

Civitai API keys cross IPC once for save and are encrypted with Electron `safeStorage`. The renderer can query only configured/validation state; no read-back API exists. Keys are not stored in settings, URLs, diagnostics, or logs, and are not forwarded across host redirects. Preview images use a bounded main-process proxy with HTTPS allowlists, content-type/size/time checks, no credential forwarding, and default sensitive-content blur.

Verified destination mappings are checkpoint → `models/Stable-diffusion`, LoRA/LyCORIS → `models/Lora`, VAE → `models/VAE`, and embedding → `embeddings`. ControlNet, upscaler, and unknown types fail closed until a configured runtime confirms a root. Completed checkpoint or LoRA downloads request the corresponding Forge refresh endpoint when the configured API is available; failure leaves the model installed and reports that refresh may still be required.
