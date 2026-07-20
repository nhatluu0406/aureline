# ADR-001: Nền tảng Forge Desktop cho Windows portable

- **Status:** Accepted for foundation; amended 2026-07-20 bởi process ownership và local auth spikes
- **Date:** 2026-07-19
- **Decision owners:** Desktop architecture maintainers
- **Code baseline:** `dfdcbab685e57677014f05a3309b48cc87383167`

## Context

Forge hiện là Python application chạy Gradio/FastAPI, có hệ extension sâu và automatic VRAM management. Mục tiêu desktop cần professional Studio UI, portable Windows không yêu cầu cài Python/Git/Node, vẫn giữ extension/advanced feature và vẫn nhận upstream với ít conflict.

Các boundary thực tế từ code:

- launcher/runtime Python là một process boundary tự nhiên;
- Web UI và API cùng nằm trên FastAPI app khi chạy `--api`;
- API đã bao phủ generation, progress, model/options discovery và CUDA memory;
- extension có thể thêm UI, scripts và routes, nên full rewrite không thể tương thích hoàn toàn;
- VRAM placement nằm sâu trong `backend/memory_management.py` và diffusion engine;
- `--data-dir`/`--models-dir` hỗ trợ tách data khỏi runtime;
- shutdown/auth còn khoảng trống cần prototype.

## Decision

### Quyết định chính

1. **Desktop framework:** Electron + React + TypeScript + Vite.
2. **UI strategy:** Hybrid — React Studio cho workflow phổ biến, Classic Forge là fallback đầy đủ.
3. **Repository:** Cùng repository, thêm top-level `desktop/` cô lập; không tách repo ở giai đoạn này.
4. **Engine boundary:** Forge chạy bằng Python child process độc lập; không embedded CPython.
5. **Distribution:** Portable ZIP có nhiều file, không single EXE.
6. **Communication:** Studio renderer dùng typed preload IPC; Electron main sở hữu Forge API client và backend credential.
7. **Classic rendering:** isolated `WebContentsView` dùng authenticated Electron-owned loopback proxy và ephemeral session; child `BrowserWindow`/external browser chỉ là recovery fallback đã đánh giá lại theo auth policy.
8. **Bridge:** local-auth spike đã chứng minh native auth không bao phủ toàn surface. Runtime cần outer ASGI guard cực mỏng được cài pre-bind qua launcher adapter version-pinned; không dựa riêng vào `on_app_started`.
9. **Network:** Forge backend và Classic proxy đều bind explicit `127.0.0.1`, dynamic port, credential riêng mỗi launch; không LAN/share mặc định.
10. **VRAM:** Forge tiếp tục quyết định model placement/offload; desktop orchestration chỉ telemetry, policy trước job, queue và recovery.

### Target source layout

```text
desktop/
  app/
    main/                  # Electron main, lifecycle/composition root
    preload/               # typed, minimal contextBridge
    renderer/              # React Studio UI
  packages/
    contracts/             # IPC/API schemas, domain types, versioned contracts
    forge-client/          # HTTP client, auth, readiness/contract probing
    process-supervisor/    # Forge process state machine và Windows process tree
    gpu-monitor/           # telemetry providers và normalized samples
    vram-safety/           # profiles, preflight, recovery policy
    settings-store/        # schema, migration, atomic persistence
    runtime-manager/       # manifest, paths, activate/rollback runtime
    log-service/           # structured event + stdout/stderr rotation/redaction
  tests/
    contract/
    integration/
    e2e/
  scripts/                 # dev/build/package/verify scripts
  prototypes/              # chỉ experiment nhỏ, không import vào production
```

Không tạo nested `AGENTS.md` cho layout chưa tồn tại. Khi scaffold source thật, tạo `desktop/AGENTS.md`; nested sâu hơn chỉ khi main/renderer/bridge thực sự có quy tắc khác nhau.

### Runtime topology

```text
React renderer (sandboxed, no Node)
          │ typed IPC qua preload allowlist
          ▼
Electron main
      ├─ Forge client ── backend token ──────────────┐
      ├─ Classic proxy ── backend token ─────────────┴─ ASGI guard ── 127.0.0.1:<backend>
      ├─ process supervisor ── Rust Job helper ── Python child (hosts backend)
      ├─ runtime/settings/log manager
      ├─ GPU monitor ── NVML/nvidia-smi/OS provider
      └─ VRAM safety controller

Classic Forge ── isolated WebContentsView ── edge token/session injection ── 127.0.0.1:<proxy>
```

Studio và Classic không chia sẻ preload. Studio không biết filesystem path thật trừ các value đã được main sanitize/authorize.

## Trách nhiệm module

### Electron main process

- composition root và application lifecycle;
- tạo cửa sổ/`WebContentsView`, session, navigation/permission/download policy;
- sở hữu Forge supervisor, API client, settings, log, runtime manager;
- validate sender, channel và payload của mọi IPC;
- serialize generation queue mặc định concurrency 1;
- không chứa chi tiết React rendering hoặc generation algorithm.

### Preload

- expose API nhỏ theo use case: engine state, submit/cancel job, settings, chọn file/folder qua dialog, logs;
- không expose `ipcRenderer`, `fs`, `path`, `child_process`, shell command hay generic invoke;
- type contract dùng chung nhưng runtime validation vẫn ở main;
- không được reuse cho Classic Forge guest.

### Renderer

- React Studio, routing, form state, visualization và accessibility;
- chỉ dùng preload contract;
- không truy cập Node, environment, filesystem, process hoặc Forge token;
- coi mọi response/log/model metadata là untrusted data và render an toàn.

### Process supervisor

- resolve runtime manifest và paths, chọn/retry port, generate credential;
- spawn Python bằng argument array, đặt cwd/env rõ ràng;
- readiness state machine, timeout, crash classification, restart budget;
- graceful interrupt/exit rồi hard terminate process tree theo timeout;
- Windows Job Object kill-on-close sau khi prototype xác nhận compatibility;
- không tự cài dependency hoặc model khi production start.

### Forge API client

- typed HTTP calls, timeout/cancellation, auth, response validation;
- health/readiness và capability negotiation từ OpenAPI/known endpoints;
- map API error thành domain error, không leak credential;
- không tự quyết profile VRAM.

### Local bridge/adapter

- versioned cùng Forge/Gradio runtime compatibility matrix;
- outer ASGI guard phải được cài trước server bind, auth mọi HTTP/WebSocket route và cung cấp protected identity;
- Electron-owned streaming proxy phục vụ riêng Classic session; Studio vẫn đi typed IPC → main client;
- secret đi qua inherited anonymous pipe/handle từ signed Job helper, không argv/URL/log;
- không chứa generation, GPU telemetry hoặc desktop settings;
- có contract tests và fail closed; không tự fallback sang unauthenticated Forge.

### GPU monitor

- provider interface: Forge memory API, NVIDIA NVML/nvidia-smi, và future provider;
- normalize adapter identity, total/used/free, timestamp, source, confidence;
- degrade gracefully khi không có NVIDIA/CUDA;
- không load Torch ở Electron và không điều khiển model placement.

### VRAM safety controller

- resolve profile, margin và calibrated envelope;
- preflight request, cảnh báo/block theo mức confidence;
- queue một job, theo dõi OOM evidence, orchestrate interrupt/unload/restart/retry;
- giữ decision log; không gọi internal Python memory functions trực tiếp.

### Settings store

- desktop settings schema/version/migrations, atomic write và backup;
- tách desktop settings khỏi Forge `config.json`;
- lưu path portable tương đối khi nằm trong portable root, canonical absolute path khi external;
- secret per-launch chỉ giữ memory; persistent secret nếu có phải dùng OS protection, không plain JSON.

### Log service

- capture stdout/stderr theo process instance, structured lifecycle/job events;
- redact credential/path nhạy cảm theo policy, rotation và retention;
- correlation IDs giữa job, API request và engine instance;
- không ghi prompt/image metadata mặc định nếu người dùng chưa opt in.

### Portable runtime manager

- đọc signed/checksummed manifest, verify file integrity và compatibility;
- activate version atomically, giữ previous version, rollback;
- shell/runtime/data lifecycle độc lập;
- giai đoạn đầu chỉ local install/selection; production updater là future work.

### Future updater/runtime version manager

- shell và runtime channel độc lập;
- download staging, checksum/signature, atomic activation và rollback;
- không chạm model/output/user data;
- không tự update khi engine đang chạy.

### Test layers

1. Unit: contracts, reducers, profile/preflight, path resolution, log redaction.
2. Contract: recorded/synthetic Forge API payload và OpenAPI compatibility.
3. Integration: lightweight child fixture, port collision, timeout, crash/restart, atomic settings/runtime activation.
4. Classic smoke: real Forge `--ui-debug-mode` hoặc test fixture khi phù hợp, navigation/WebSocket/auth.
5. E2E: packaged Electron + fixture/Forge smoke bằng Playwright; không inference mặc định.
6. GPU/inference lab: riêng, opt-in, hardware-tagged; không nằm trong quality gate nhẹ.

## Alternatives considered

Điểm 1 là tốt nhất tương đối, 5 là kém nhất. “RAM/VRAM” đánh giá overhead shell; framework không làm giảm VRAM model của Forge.

| Phương án | Dev speed | Complexity | Cursor/Codex | Debug | Portable Windows | Extension compatibility | RAM/VRAM | Security | Upstream | Packaging | Testability | Long-term risk |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Electron + React hybrid | 1 | 2 | 1 | 1 | 2 | 1 | 3 | 2 | 1 | 2 | 1 | 2 |
| Tauri + React hybrid | 3 | 3 | 3 | 3 | 3 | 2 | 1 | 1 | 1 | 3 | 3 | 3 |
| Chỉ bọc Gradio | 1 | 1 | 2 | 1 | 2 | 1 | 2 | 2 | 1 | 2 | 2 | 4 |
| Full React rewrite + API | 4 | 5 | 2 | 2 | 2 | 5 | 2 | 2 | 5 | 2 | 2 | 5 |
| Hybrid React + Classic | 2 | 2 | 1 | 1 | 2 | 1 | 3 | 2 | 1 | 2 | 1 | 1 |

### Electron + React

Ưu điểm: team/tooling TypeScript thống nhất; Chromium behavior đồng nhất; DevTools/Playwright tốt; quản lý subprocess, native window và isolated Classic content trực tiếp; portable unpacked/ZIP rõ. Nhược điểm: package và RAM lớn hơn Tauri, phải patch Electron thường xuyên, main process có quyền cao nên IPC discipline bắt buộc.

Electron được chọn không phải vì Tauri không chạy được Python sidecar, mà vì app này cần debug/contain một Web app Gradio phức tạp, quản lý guest content và dùng TypeScript end-to-end. Tốc độ delivery và compatibility có giá trị lớn hơn chênh lệch shell RAM; VRAM vẫn do Forge chi phối.

### Tauri + React

Ưu điểm: binary/shell footprint nhỏ, capability model tốt, Rust phù hợp native supervisor. Nhược điểm: thêm Rust/MSVC vào dev stack; WebView2 version/deployment tạo thêm biến số offline; debugging Classic Gradio và parity WebView2 khó hơn Chromium bundled; IPC/native integration chia giữa TS/Rust. Có thể revisit nếu đo được Electron RAM/package là blocker thực tế hoặc team có Rust ownership rõ.

### Chỉ bọc Gradio hiện tại

Nhanh nhất và giữ extension, nhưng không đạt Studio UX, typed domain workflows, queue/recovery chuyên nghiệp và security boundary rõ. Có thể là milestone Classic mode, không phải kiến trúc cuối.

### Full React rewrite gọi API

Cho UX sạch nhưng API không phản ánh mọi extension tab/script/custom component. Mỗi upstream/extension thay đổi thành maintenance burden; gần với viết lại Forge UI và vi phạm mục tiêu ít conflict. Bị loại.

### Hybrid React Studio + Classic fallback

Được chọn. Studio chỉ nhận workflow đã có API contract/quality gate; mọi phần chưa được cover vẫn dùng Classic. Phải chấp nhận hai UI surface và test cả hai, nhưng giảm migration risk và cho phép delivery dần.

### Same repo vs separate repo

Cùng repo được chọn để pin chính xác desktop contract với Forge commit/runtime manifest, review thay đổi API cùng consumer và tránh version drift. Desktop nằm top-level riêng, CODEOWNERS/CI paths riêng. Separate repo chỉ revisit nếu release cadence, quyền truy cập hoặc artifact size buộc tách.

### Child process vs embedded Python

Child process được chọn vì isolation crash/CUDA, restart/rollback dễ, giữ extension/launcher semantics. Embedded Python sẽ ghép ABI, GIL, native DLL loading và fatal CUDA state vào Electron process mà không có lợi ích generation rõ.

### Portable ZIP vs single EXE

ZIP được chọn. Runtime Python/Torch/CUDA wheels/Electron/assets là hàng GB tiềm năng; single EXE cần self-extract, chậm startup, tăng antivirus false positive, khó delta update và rollback. Một launcher EXE trong thư mục ZIP là đủ professional mà không giả vờ toàn hệ thống là một file.

## Consequences

### Positive

- Không viết lại Forge và giữ extension fallback.
- Upstream sync chủ yếu không chạm `desktop/`.
- Crash/OOM có process boundary để recover.
- Shell, runtime và data có thể version/update độc lập.
- TypeScript contracts thuận lợi cho Cursor/Codex và test automation.
- Có đường delivery theo milestone thay vì big-bang UI rewrite.

### Negative

- RAM/disk package tăng do Electron + Python/Torch runtime.
- Hai UI surfaces và hai auth/session paths phải test.
- Portable path, runtime mutation và extension dependency là bài toán riêng.
- Cần native Windows process-tree integration hoặc helper nhỏ sau prototype.
- Electron security updates trở thành release responsibility liên tục.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Local API bị process/web page khác gọi | Outer ASGI auth pre-bind, Electron Classic proxy/session injection, per-launch credentials, exact Host/Origin, no CORS broadening |
| Extension guest content thoát sandbox | Separate session/WebContentsView, no preload/Node, allowlist navigation, permission/download handlers |
| Port race/collision | Explicit candidate + spawn probe + retry budget; không coi socket probe là reservation |
| Process con còn sót | Job Object prototype, tracked PID tree, staged shutdown, kill-on-close |
| Runtime bị extension mutate | Versioned runtime, controlled install mode, integrity/dirty marker, rollback |
| Upstream API drift | Runtime manifest pins Forge HEAD; contract/capability tests; Classic fallback |
| OOM retry loop | Tối đa một retry opt-in/eligible, restart budget và circuit breaker |
| Secret lộ qua CLI/log | Không chấp nhận `--api-auth` CLI là giải pháp cuối; bridge/env/file prototype và log redaction |
| Electron overhead | Đo packaged idle/busy RAM; revisit framework theo threshold, không phỏng đoán |

## Revisit conditions

ADR phải được mở lại nếu một trong các điều sau xảy ra:

- prototype không thể nhúng Classic ổn định trong secure `WebContentsView`;
- launcher adapter không thể cài outer ASGI guard ổn định trên Forge/Gradio thật mà không sửa Forge core;
- process supervisor không quản lý được toàn process tree trên Windows mục tiêu;
- Electron idle RAM hoặc package size vượt budget sản phẩm đã được stakeholder chốt và Tauri prototype chứng minh cải thiện đủ lớn;
- Forge upstream thay Gradio/API/process architecture căn bản;
- extension compatibility không còn là yêu cầu;
- team chuyển sang separate release/security ownership khiến monorepo cản trở;
- legal review yêu cầu packaging/source-distribution topology khác.

## References

- Khảo sát code: [architecture-assessment.md](architecture-assessment.md)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron WebContentsView migration](https://www.electronjs.org/blog/migrate-to-webcontentsview)
- [Secure local bridge/auth spike](../../desktop/prototypes/secure-forge-bridge/README.md)
- [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri WebView2 distribution modes](https://v2.tauri.app/distribute/windows-installer/)
