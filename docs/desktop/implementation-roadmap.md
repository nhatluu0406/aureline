# Implementation roadmap

## 1. Nguyên tắc chia milestone

Roadmap giao theo vertical risk nhỏ, không big-bang. Mỗi milestone chỉ bắt đầu khi prerequisite đã integrated vào Git HEAD. Classic fallback có trước Studio generation để luôn có đường dùng Forge. GPU/VRAM gate tách khỏi shell để không chặn development trên máy không có GPU.

```text
M1 Foundation
 ├─ M2 Electron shell ─ M5 Classic mode ─ M6 Studio foundation ─ M7 Generation
 ├─ M3 Process supervisor ────────────────┘                  ├─ M9 VRAM safety
 └─ M4 Portable runtime ─────────────────────────────────────┤
                           M8 GPU telemetry ──────────────────┘
M2+M3+M4+M5+M6+M7+M8+M9 ─ M10 Packaging/release
```

Verification levels:

- **L1 Static:** format/lint/type/schema/diff checks.
- **L2 Unit:** deterministic tests, no real Forge/GPU.
- **L3 Integration:** child/API/fixture hoặc lightweight real startup, không inference.
- **L4 Packaged smoke:** clean Windows VM/unpacked app.
- **L5 GPU lab:** explicit hardware + user-provided model, opt-in.

## M1 — Foundation

**Goal:** Tạo desktop workspace và contracts/tooling tối thiểu, không thay behavior Forge.

**Prerequisite:** ADR-001 accepted; repository clean trừ changes đã biết.

**In scope:**

- scaffold `desktop/` với Electron/React/TypeScript/Vite package boundaries theo ADR;
- package manager/lockfile, strict TypeScript, lint/format/unit runner;
- root scripts không đụng build system Forge hiện tại;
- contracts cho engine state, IPC error, runtime manifest và generation job envelope (chưa có UI);
- `desktop/AGENTS.md`, test fixture conventions, CI path filter;
- dependency/license baseline.

**Out of scope:** real Forge spawn, production UI, updater, inference.

**Deliverables:** compilable workspace; minimal local renderer page; contract package; quality-gate command; architecture link/readme.

**Acceptance criteria:**

- `install --frozen-lockfile`, typecheck, lint và unit test chạy từ clean checkout;
- Electron renderer config có Node integration off/context isolation/sandbox target rõ;
- không có filesystem/process API trong renderer contract;
- build output/cache được ignore; Forge core diff rỗng;
- dependency inventory ghi license/version.

**Suggested owner:** Codex cho scaffold/contracts; Cursor review developer ergonomics.

**Risks:** tool version churn, vô tình xung đột root `package.json`, over-engineering monorepo.

**Verification level:** L1 + L2.

## M2 — Electron shell

**Goal:** Có secure desktop shell mở Studio placeholder và quản lý Classic view placeholder.

**Prerequisite:** M1.

**In scope:**

- Electron main/preload/renderer boot;
- typed IPC registry với sender/payload validation;
- CSP/custom app protocol, navigation/window-open/permission policy;
- window state cơ bản, crash reporting local opt-in/off mặc định;
- `WebContentsView` lifecycle interface dùng test URL/fixture.

**Out of scope:** Forge process, generation, file browser rộng, production visual design.

**Deliverables:** development shell; preload API tối thiểu; security tests; fixture guest view.

**Acceptance criteria:**

- renderer không có Node globals và không import Node module;
- generic IPC/shell/fs/child-process không được expose;
- unapproved navigation/popups/permissions bị block trong automated tests;
- guest view dùng session/preload tách Studio;
- app start/close không để helper process của fixture còn sót.

**Suggested owner:** Codex; Cursor review window/UX states.

**Risks:** Electron version API drift, insecure convenience flags, `WebContentsView` focus/bounds bugs.

**Verification level:** L1 + L2 + L3.

## M3 — Forge process supervisor

**Goal:** Chứng minh và triển khai state machine quản lý Forge child process đáng tin cậy.

**Prerequisite:** M1 contracts. Prototype có thể làm ngay trước M2 để de-risk.

**In scope:**

- spawn args/cwd/env allowlist;
- dynamic port candidate + collision retry;
- first-packet probe và composite readiness: protected identity + runtime-manifest capability probes;
- stdout/stderr capture/redaction/rotation interface;
- interrupt/stop/restart timeout và crash classification;
- fake child/API integration fixture;
- Windows Job Object prototype và real Forge `--ui-debug-mode --api` smoke khi environment cho phép;
- tích hợp direction từ auth/real-Forge spike: outer ASGI guard pre-bind, scoped credential cho exact Gradio `/startup-events` self-call, protected identity và Electron Classic proxy contract.

**Out of scope:** production runtime downloader, inference, VRAM policy, extension manager.

**Deliverables:** `process-supervisor`, `forge-client` protected-readiness subset, local-bridge contract, integration tests và prototype reports.

**Acceptance criteria:**

- state transitions deterministic và invalid transitions reject;
- port collision/process early-exit/readiness timeout có diagnostic rõ;
- stop/restart không double-spawn; restart budget/circuit breaker test được;
- fixture process tree bị cleanup khi app/supervisor đóng;
- real Forge shutdown behavior và `/server-stop` limitation được xác minh hoặc ghi `not run`;
- không có secret trong argv/log fixture; native limitation không bị che giấu.

**Suggested owner:** Codex.

**Risks:** Windows console signal semantics, Job Object native dependency, Forge server stop không exit, token middleware order.

**Verification level:** L2 + L3; optional clean Windows smoke, không inference.

## M4 — Portable runtime

**Goal:** Tạo runtime artifact offline, versioned, relocatable và rollback được.

**Prerequisite:** M3 spawn contract; Python/runtime build experiment approved.

**In scope:**

- runtime manifest/checksum/SBOM schema;
- CI/build recipe materialize CPython 3.10 + dependencies + pinned repos;
- path mapping `data/models/outputs/cache/logs`;
- local install/activate/rollback manager;
- write-audit normal startup và Classic UI debug;
- clean Windows VM verification không có Python/Git/Node/Internet.

**Out of scope:** online production updater, model download, arbitrary extension dependency guarantee.

**Deliverables:** runtime ZIP riêng; manifest; build provenance; activation/rollback tests; write-audit report.

**Acceptance criteria:**

- runtime start offline bằng `--skip-prepare-environment --skip-install`;
- path có space/Unicode và drive relocation pass;
- không gọi pip/Git/network trong normal startup;
- mọi write nằm allowlist hoặc được ghi thành blocker rõ;
- corrupt/incompatible candidate không activate; previous runtime rollback thành công;
- package không có model/secret/dev cache và có license/SBOM.

**Suggested owner:** Codex; human security/license review.

**Risks:** native DLL relocation, Torch package size, auxiliary downloads, extension installer mutation, AGPL/dependency notices.

**Verification level:** L1 + L2 + L3 + L4.

## M5 — Classic Forge mode

**Goal:** Classic Forge hoạt động trong desktop với compatibility và isolation rõ.

**Prerequisite:** M2, M3; M4 cho packaged smoke.

**In scope:**

- `WebContentsView` tới exact authenticated Classic proxy origin sau protected identity readiness;
- Gradio auth/session/WebSocket, downloads, file dialogs, clipboard, drag-drop policy;
- bounds/focus/zoom/theme/loading/error/reconnect states;
- external browser fallback;
- smoke built-in extension tabs và UI reload không inference.

**Out of scope:** Studio generation, sửa Classic CSS/JS, hứa mọi third-party extension compatible.

**Deliverables:** Classic mode navigation; guest security policy; Playwright/manual compatibility matrix.

**Acceptance criteria:**

- chỉ exact `127.0.0.1:<active-proxy-port>` được navigation trong guest; backend port không được expose cho guest;
- guest không có Node/Studio preload; popup/external URL xử lý theo allowlist;
- Gradio assets/WebSocket/auth và ít nhất representative built-in tabs load;
- engine restart chuyển guest qua reconnect state rồi recover;
- `iframe`, BrowserView và insecure webview không được dùng.

**Suggested owner:** Codex implementation; Cursor UX/manual review.

**Risks:** extension popup/download behavior, auth cookie, IME/drag-drop/focus, upstream Gradio markup drift.

**Verification level:** L2 + L3 + L4, no inference.

## M6 — Studio UI foundation

**Goal:** Xây Studio shell chuyên nghiệp với domain/state/error/accessibility foundation, chưa generation thật.

**Prerequisite:** M2; engine state contract từ M3; design direction nếu có.

**In scope:**

- application navigation, engine status, profile selector placeholder;
- design tokens/theme, responsive layout, keyboard/focus/accessibility;
- form primitives, async states, notification/error boundary;
- model/settings discovery bằng fixture/read-only client;
- visual regression baseline.

**Out of scope:** production txt2img/img2img, Figma import nếu chưa có source, GPU automation.

**Deliverables:** Studio layout/component set/story fixtures; accessibility/visual tests.

**Acceptance criteria:**

- loading/empty/error/offline/restarting states có UI;
- keyboard navigation và accessible names pass chosen automated gate;
- renderer chỉ dùng preload contract;
- viewport targets không overflow critical controls;
- visual snapshots stable, dynamic data masked.

**Suggested owner:** Cursor; Codex review IPC/state/tests.

**Risks:** premature design system, mock diverge API, UI state explosion.

**Verification level:** L1 + L2 + L3 visual/accessibility.

## M7 — Generation workflows

**Goal:** Cung cấp từng workflow Studio qua API gốc, bắt đầu với vertical slice nhỏ.

**Prerequisite:** M3, M6; runtime API contract pinned; Classic fallback M5.

**In scope:**

- task đầu tiên chỉ txt2img basic vertical slice; sau đó img2img theo task riêng;
- model/sampler/scheduler discovery, request validation;
- queue concurrency 1, progress/cancel, result metadata/file handoff qua main;
- correlation ID, timeout/error mapping;
- contract tests với fixtures và optional lightweight real API.

**Out of scope:** extension-specific custom controls, mọi script, batch directory, full feature parity, automatic retry.

**Deliverables:** typed generation service; basic Studio workflow; queue/progress/result tests; capability fallback sang Classic.

**Acceptance criteria:**

- request/response validation fail safely; auth không vào renderer;
- không có concurrent job khi queue policy là 1;
- cancel/progress/error/restart states deterministic;
- unsupported capability dẫn user tới Classic, không silently drop field;
- output path do main authorize; renderer không đọc filesystem trực tiếp;
- no-inference tests pass; GPU smoke chỉ khi explicitly scheduled.

**Suggested owner:** Codex cho service/contracts; Cursor cho workflow UI/review.

**Risks:** API script args không stable, output duplication, progress task IDs, model change side effects.

**Verification level:** L2 + L3; L5 cho release candidate slice.

## M8 — GPU telemetry

**Goal:** Hiển thị telemetry đúng nghĩa và map đúng adapter Forge đang dùng.

**Prerequisite:** M3 Forge client; M6 status UI.

**In scope:**

- Forge `/memory` provider;
- NVIDIA NVML hoặc `nvidia-smi` provider theo prototype;
- normalized sample/source/confidence/staleness;
- selected adapter mapping, sampling/backoff, bounded aggregation;
- non-CUDA/unavailable graceful state.

**Out of scope:** profile auto-tuning, AMD/Intel production support nếu chưa có provider, GPU control/overclock.

**Deliverables:** `gpu-monitor`; status panel; fixtures; one-machine validation report.

**Acceptance criteria:**

- không nhầm system used với Torch allocated;
- stale/missing/error metrics không render thành zero;
- selected GPU mapping có evidence hoặc confidence thấp rõ;
- sampling dừng khi app/engine stop và không leak process;
- không bundle/require CUDA Toolkit cho basic app startup.

**Suggested owner:** Codex; Cursor review visualization.

**Risks:** multi-GPU identity, nvidia-smi latency/localization, non-NVIDIA gaps.

**Verification level:** L2 + L3 + targeted L5 telemetry-only.

## M9 — VRAM safety

**Goal:** Áp dụng profile/preflight/recovery có dữ liệu, không thay Forge memory manager.

**Prerequisite:** M7 queue/job lifecycle, M8 telemetry, GPU lab plan approved.

**In scope:**

- Safe/Balanced/Maximum/Custom policy schema;
- conservative resolver, conflict validation, startup restart UX;
- preflight với unknown/calibrated confidence;
- passive calibration store;
- OOM classifier và staged recovery;
- optional one-time retry chỉ sau idempotency decision;
- GPU benchmark skill/report task riêng.

**Out of scope:** exact universal estimator, automatic quality degradation, concurrency >1, replacement of Forge offload.

**Deliverables:** `vram-safety`; profile/preflight UI; recovery state machine; calibration schema/report.

**Acceptance criteria:**

- khi chưa có calibration không bịa estimate/block threshold;
- Forge legacy `--lowvram/--medvram` không được profile dùng;
- conflicting startup flags bị reject; rationale hiển thị/log;
- confirmed OOM không restart loop; max retry/restart budget test được;
- prompts/secrets không nằm calibration log;
- default profile promotion chỉ sau L5 data + review.

**Suggested owner:** Codex; Cursor review warnings/recovery UX; human approve defaults.

**Risks:** false confidence, false warning fatigue, partial outputs, extension GPU allocations, hardware matrix cost.

**Verification level:** L2 + L3 bắt buộc; L5 trước production defaults.

## M10 — Packaging and release

**Goal:** Tạo portable ZIP signed/verified với repeatable release gate và rollback story.

**Prerequisite:** M2–M9 đạt gate tương ứng; security/license review.

**In scope:**

- shell/runtime release assembler, manifests/checksums/SBOM/licenses;
- Windows signing/timestamp pipeline;
- clean VM offline smoke, install/unzip/relocate/update/rollback matrix;
- antivirus false-positive submission playbook;
- release notes, known limitations, source offer/instructions;
- local updater simulation; production network updater vẫn là task riêng nếu chưa approved.

**Out of scope:** bundle model, single EXE, silent background update, public release/publish tự động bởi agent.

**Deliverables:** reproducible portable ZIP; verification manifest/report; release runbook; rollback artifacts.

**Acceptance criteria:**

- clean VM không có Python/Git/Node vẫn start offline;
- signature/hash/license/SBOM/source instruction checks pass;
- ZIP không có model/secret/cache/output/local config;
- shell-only/runtime-only update giữ data/model/output;
- candidate corrupt/fail startup rollback known-good;
- no LAN listener, no remote Electron content, no orphan process sau close;
- exact commands/results và checks not run được ghi trong release report.

**Suggested owner:** Codex cho pipeline/gates; Cursor cho first-run/recovery UX smoke; human giữ signing keys và publish.

**Risks:** artifact size, signing secrets, antivirus, dependency license/source completeness, clean VM variance.

**Verification level:** L1–L4 bắt buộc; L5 cho generation release claim.

## 2. Task kế tiếp được đề xuất

**Forge process supervisor prototype** là task Codex tiếp theo, nhỏ hơn production M3:

- dùng standard library/dependency tối thiểu;
- fake child/API làm đường test bắt buộc;
- optional real Forge `--ui-debug-mode --api` nếu local runtime đáp ứng;
- xác minh explicit port/retry, readiness, captured logs, staged shutdown và process-tree cleanup;
- ghi bằng chứng về `/server-stop`, `/server-kill` và secret-in-argv gap;
- không scaffold UI, không inference, không bridge implementation.

Lý do ưu tiên trước Electron scaffold: khảo sát đã chứng minh process exit/auth/dynamic-port là rủi ro kiến trúc lớn nhất; kết quả prototype sẽ quyết định contract của main process, bridge và portable runtime, tránh khóa scaffold vào assumption sai.
