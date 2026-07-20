# Application boundary rules

- Keep Electron main, preload, and renderer responsibilities separate.
- Renderer code has no Node, filesystem, process, raw network credential, PID, port, or executable-path access.
- Preload exposes only typed, domain-specific capabilities backed by runtime-validated IPC; never expose `ipcRenderer` or a generic command channel.
- Main owns engine lifecycle, local bridge, settings, logs, and Classic Forge session policy.
- Preserve `contextIsolation`, sandboxing, disabled Node integration, CSP, ephemeral Classic sessions, navigation controls, denied popups/permissions, and explicit download policy.
- UI changes must cover loading, empty, error, success, focus, resize, and both light/dark themes without fake engine state.
- Do not import from `archive/prototypes/`; port only reviewed contracts or seams into production with focused tests.
- Do not import from `.reference/`; production Forge integration is resolved through runtime manifests, materialization, and `engine/` adapters.
