# Aureline repository rules

- Git HEAD and the current working tree are the source of truth. Check the branch and `git status` before each task, and preserve unrelated changes.
- Aureline is an independent product. Forge is a third-party engine/runtime; do not vendor or edit Forge core in this repository. Integrate through `engine/`, manifests, adapters, or narrowly documented patches.
- Keep the dependency direction `app/renderer -> preload contracts -> app/main -> application packages -> engine/native adapters`. Renderer code must not import Node built-ins or call localhost directly.
- IPC must be domain-specific, typed, and runtime-validated. Never expose generic invoke/commands, credentials, PID, backend port, raw executable paths, filesystem, or process access to the renderer.
- Bind managed services only to `127.0.0.1`. Do not enable `--listen`, `--share`, remote access, or wildcard binds by default.
- Keep modules cohesive and small. Do not create empty package hierarchies, add dependencies without review, or copy prototypes wholesale into production.
- Treat `archive/prototypes/` as evidence only. Production source lives in `app/`, `packages/`, `engine/`, and `native/`.
- Maintain high desktop UI quality: explicit loading/empty/error/success states, keyboard focus, resize behavior, light/dark parity, and no fake product data.
- Run focused typecheck, tests, build, smoke, and packaging checks proportional to the change. Never claim PASS for a command that was not run.
- Do not download models, run heavy inference, or silently change Forge generation behavior unless the task explicitly requires it.
- Do not read, source, print, modify, stage, or commit `.env`. Never log secrets.
- Commit or push only when the user explicitly authorizes it for the current task. Report results and limitations honestly.
