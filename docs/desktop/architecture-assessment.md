# Khảo sát kiến trúc Forge cho desktop

## 1. Phạm vi và repository state

Khảo sát này dựa trên code tại Git HEAD, không coi README là nguồn duy nhất.

| Thuộc tính | Giá trị |
|---|---|
| Repository | `nhatluu0406/stable-diffusion-webui-forge` |
| Branch | `main` |
| HEAD | `dfdcbab685e57677014f05a3309b48cc87383167` |
| Commit | `Fix SD upscale Batch count (#2950)` |
| Commit time | `2025-06-26T18:53:55+01:00` |
| Trạng thái ban đầu | `?? .env` |

`.env` là thay đổi untracked có sẵn, không thuộc task, không được đọc hoặc sửa. Repository chỉ cấu hình remote `origin`; chưa có remote `upstream` tại thời điểm khảo sát.

## 2. Repository map

| Khu vực | Trách nhiệm thực tế | Mức ổn định khi sync upstream |
|---|---|---|
| `launch.py`, `webui.py`, `webui.bat` | Launcher, environment bootstrap, Gradio/FastAPI lifecycle | Rất dễ conflict; tránh sửa |
| `modules/` | WebUI, API A1111-compatible, settings, extension callbacks, image workflow | Dễ conflict |
| `modules_forge/` | Forge initialization, model selection/UI, main task thread, CUDA allocator helpers | Dễ conflict |
| `backend/` | Diffusion engines, loader/patcher, automatic memory management | Rất dễ conflict và rủi ro generation |
| `extensions-builtin/` | 38 built-in extension tại HEAD, gồm ControlNet, LoRA, IP-Adapter, NeverOOM... | Dễ thay đổi theo Forge |
| `extensions/` | User extension; hiện chỉ có placeholder, bị `.gitignore` | Điểm tích hợp phù hợp cho bridge mỏng |
| `models/` | Các nhóm model mặc định; nội dung model bị ignore | User data, không đóng vào app |
| `scripts/`, `javascript/`, `html/`, `style.css` | Classic UI assets và scripts | Dễ conflict nếu desktop sửa trực tiếp |
| `requirements_versions.txt` | Python dependency pins | Contract của runtime build |
| `package.json` | Chỉ có ESLint cho WebUI JavaScript hiện tại | Không phải desktop build system |

Không có test tree đáng kể được phát hiện bằng truy vấn path `test/tests` ở HEAD này. Không có `venv/`, `repositories/`, `outputs/`, `cache/`, `tmp/`, `config.json` hay `ui-config.json` trong working tree hiện tại.

## 3. Forge startup flow

### 3.1 Windows scripts

1. `webui-user.bat` là file cấu hình người dùng: đặt `PYTHON`, `GIT`, `VENV_DIR`, `COMMANDLINE_ARGS`, rồi gọi `webui.bat`.
2. `webui.bat` nạp `webui.settings.bat` nếu có, mặc định `PYTHON=python`, `VENV_DIR=<repo>/venv`, kiểm tra Python/pip, tạo và activate venv.
3. Script gọi `python launch.py`. File marker `tmp/restart` làm batch loop chạy lại Python; nếu không restart thì script `pause`.
4. Có nhánh optional `accelerate launch`, nhưng không phải đường mặc định.

Desktop production không nên gọi batch file vì `pause`, restart marker và console UX khó kiểm soát. Supervisor nên gọi trực tiếp Python runtime đã đóng gói với `launch.py` hoặc entry tương đương, đặt `cwd` vào Forge runtime root và truyền arguments dạng array.

### 3.2 Python launcher

`launch.py` gọi `modules.launch_utils.prepare_environment()` trừ khi có `--skip-prepare-environment`, sau đó gọi `start()`.

`prepare_environment()` tại HEAD:

- chỉ chấp nhận Python 3.10 trên Windows và ghi rằng code được test với 3.10.6;
- mặc định cài Torch 2.3.1/Torchvision 0.18.1 từ CUDA 12.1 index nếu thiếu;
- kiểm tra CUDA, cài CLIP/OpenCLIP/xformers tùy flag;
- clone ba repo pinned vào `repositories/`: WebUI assets, `huggingface_guess`, BLIP;
- cài `requirements_versions.txt` nếu version chưa khớp;
- chạy `install.py` của extension nếu không có `--skip-install`;
- có thể update extension nếu được yêu cầu.

Vì vậy runtime portable phải được materialize và kiểm thử trong CI/build machine, gồm Python, wheels/site-packages và các repo pinned. First run offline không được phụ thuộc vào pip/Git. Production nên dùng `--skip-prepare-environment --skip-install`; extension install cần một workflow riêng, có kiểm soát và rollback, không âm thầm mutate runtime đang chạy.

### 3.3 WebUI và main thread

`launch_utils.start()` import `webui`, gọi `webui.webui()` hoặc `webui.api_only()`, rồi đi vào `modules_forge.main_thread.loop()`.

`webui.py` thực hiện Forge initialization và module initialization trước khi tạo server. Web UI worker:

1. chạy extension `before_ui` callbacks;
2. tạo `gr.Blocks` qua `modules.ui.create_ui()`;
3. bật Gradio queue với concurrency limit 64 trừ `--no-gradio-queue`;
4. gọi `shared.demo.launch(..., prevent_thread_lock=True)`;
5. bỏ `CORSMiddleware` rất mở do Gradio thêm, rồi cấu hình middleware của WebUI;
6. gắn progress API, UI internal API, `/sdapi/v1/*` nếu `--api`, extra-network pages và `app_started` callbacks;
7. chờ lệnh reload/stop trong daemon thread.

`modules_forge.main_thread.loop()` là vòng lặp vô hạn, xử lý hàng đợi tác vụ chính tuần tự. Điều này thuận lợi cho mặc định một generation job ở desktop nhưng không thay thế queue/policy của desktop.

## 4. API, Gradio, host và port

### 4.1 API hiện có

`modules/api/api.py` cung cấp các API cần cho Studio ban đầu:

- generation: `txt2img`, `img2img`, extras;
- control: progress, interrupt, skip;
- settings và discovery: options, cmd flags, samplers, schedulers, models, modules, upscalers, scripts, extensions;
- memory: `/sdapi/v1/memory`;
- model lifecycle: unload/reload checkpoint;
- optional process endpoints: server kill/restart/stop khi có `--api-server-stop`.

Classic Web UI còn có `/internal/ping`, `/internal/progress`, pending tasks, quick settings và startup profile. `/docs` được Gradio app expose khi chạy Web UI. API-only dùng FastAPI/Uvicorn và mặc định port 7861.

### 4.2 Bind và readiness

`initialize_util.gradio_server_name()` trả về `cmd_opts.server_name` nếu có, `0.0.0.0` nếu `--listen`, còn mặc định trả `None` để Gradio chọn local host. Desktop phải truyền `--server-name 127.0.0.1`, tuyệt đối không truyền `--listen`, `--share` hoặc ngrok. Lưu ý code coi bất kỳ `--server-name` nào là “non-local” và sẽ disable extension management access trừ khi bật cờ insecure; đây là side effect cần test, không nên giải quyết bằng cờ insecure mặc định.

Dynamic port khả thi bằng cách chọn một port loopback trống, truyền `--port <n>`, theo dõi bind failure và retry với port khác. Đây có race giữa lúc release probe socket và lúc Gradio bind; không được coi “find free port” là reservation. `port=0` chưa được chứng minh: API-only chuyển giá trị falsy về 7861, do đó không dùng cho thiết kế hiện tại.

Readiness nên là state machine:

1. process đã spawn và chưa exit;
2. TCP loopback accept;
3. `GET /internal/ping` trả 2xx cho Web UI, hoặc endpoint API xác định như `GET /sdapi/v1/cmd-flags` trả hợp lệ khi `--api`;
4. optional kiểm tra contract/version trước khi báo Ready.

Không chỉ parse dòng `Startup time`, vì extension có thể in log tương tự và stdout format không phải API contract.

### 4.3 Authentication

- `--gradio-auth`/`--gradio-auth-path` bảo vệ Classic UI.
- `--api-auth user:password` dùng HTTP Basic cho các route được `Api.add_api_route()` đăng ký.
- Internal UI routes không đi qua `Api.add_api_route()`; không được suy diễn rằng `--api-auth` bảo vệ toàn bộ FastAPI app.

Random local token là cần thiết để giảm rủi ro process khác trên máy gọi API. Tuy nhiên API hiện chỉ nhận secret qua `--api-auth`; `launch_utils.start()` in toàn bộ `sys.argv`, và command line cũng có thể bị process inspection đọc. Vì vậy không đạt yêu cầu “không log secret”. Prototype phải xác minh bridge extension cực mỏng nhận token qua inherited environment hoặc ACL-protected file, gắn middleware đúng thời điểm và không làm hỏng Gradio/WebSocket. Trước prototype không tuyên bố native auth đã đủ.

Studio renderer không nên gọi localhost trực tiếp. Luồng đề xuất là renderer → typed preload IPC → main-process Forge client → loopback API; token chỉ ở main process.

## 5. CLI flags liên quan

Các cờ dưới đây tồn tại trong `modules/cmd_args.py` hoặc `backend/args.py` tại HEAD. Một số cờ legacy vẫn parse nhưng Forge có thể bỏ qua/chặn.

| Nhóm | Cờ đáng chú ý | Kết luận |
|---|---|---|
| API/UI | `--api`, `--nowebui`, `--api-server-stop`, `--no-gradio-queue`, `--ui-debug-mode` | Hybrid cần Web UI + `--api`; API-only không cung cấp Classic fallback |
| Host/port | `--listen`, `--server-name`, `--port`, `--subpath`, `--share`, ngrok, TLS, CORS | Desktop ép loopback, không share/LAN |
| Auth | `--api-auth`, `--gradio-auth`, `--gradio-auth-path` | Hai miền auth khác nhau; token CLI có leak risk |
| Paths/model | `--data-dir`, `--models-dir`, `--ckpt`, `--ckpt-dir`, `--vae-dir`, `--text-encoder-dir`, `--embeddings-dir`, `--config` | Đủ để tách runtime khỏi user data/model |
| Loading | `--no-download-sd-model`, `--do-not-download-clip`, `--skip-load-model-at-start` | Cờ cuối chỉ được khai báo, không tìm thấy consumer ngoài parser tại HEAD; không dựa vào nó |
| VRAM legacy | `--lowvram`, `--medvram`, `--medvram-sdxl` | `initialize_forge()` báo đã removed; không dùng cho profile mới |
| VRAM Forge | `--always-gpu`, `--always-high-vram`, `--always-normal-vram`, `--always-low-vram`, `--always-no-vram`, `--always-cpu`, `--always-offload-from-vram` | Có thật nhưng cần benchmark trước khi tự động chọn |
| Allocator/offload | `--cuda-malloc`, `--cuda-stream`, `--pin-shared-memory`, `--vae-in-cpu` | Tác động compatibility/performance; opt-in sau calibration |
| Precision | `--all-in-fp32/fp16`, UNet fp16/bf16/fp8, VAE fp16/fp32/bf16, CLIP fp8/fp16/fp32, `--precision`, `--no-half`, `--no-half-vae`, attention flags | Không thay tự động chỉ từ tổng VRAM |
| Device | `--gpu-device-id`, `--device-id`, `--use-cpu`, `--use-ipex`, `--directml` | Backend không chỉ NVIDIA; telemetry phải degrade gracefully |
| Safety | `--disable-safe-unpickle`, `--allow-code`, extension access flags | Desktop không bật các cờ giảm an toàn mặc định |

## 6. GPU/VRAM modules

Forge đã chịu trách nhiệm chính:

- `backend/memory_management.py`: GPU backend detection, `VRAMState`, total/free memory, automatic model load/offload, inference reserve, cache cleanup, unload-all, dtype capability;
- `backend/stream.py`: CUDA stream behavior;
- `backend/loader.py`, `backend/patcher/*`, `backend/diffusion_engine/*`: model loading/patching và placement;
- `modules_forge/initialization.py`: device selection, allocator setup, warm-up allocation, Hugging Face cache env;
- `modules_forge/cuda_malloc.py`: kiểm tra blacklist trước cudaMallocAsync;
- `modules/devices.py`: adapter và `torch_gc()`;
- `modules/sd_models.py`/`modules_forge/main_entry.py`: model discovery, lazy Forge model reload và checkpoint selection;
- `/sdapi/v1/memory`: RAM RSS và CUDA system/allocated/reserved/active/inactive cùng `num_alloc_retries`, `num_ooms`.

API memory chỉ có CUDA path và metric của device hiện hành; Intel XPU, DirectML, multi-GPU và per-process attribution chưa đủ. Desktop có thể dùng external telemetry (NVML/nvidia-smi khi hiện diện) như nguồn bổ sung, nhưng không được coi đó là dependency bắt buộc hoặc thay quyết định placement của Forge.

## 7. Extension integration

Extension được tìm từ `<data-dir>/extensions` và built-in từ runtime `extensions-builtin`. Các hook chính:

- `preload.py` có thể thêm CLI arguments trước parse cuối;
- `install.py` chạy trong environment preparation;
- `scripts/*.py` và các callback `on_before_ui`, `on_ui_tabs`, `on_ui_settings`, `on_app_started`;
- `on_app_started(demo, app)` nhận Gradio Blocks và FastAPI app, phù hợp để thêm route/middleware nhỏ;
- metadata/callback ordering hỗ trợ dependency giữa extension.

Bridge chỉ nên tồn tại nếu prototype chứng minh API thiếu contract tối thiểu (ví dụ secure local auth/health/version). Không đưa generation logic, process supervision, settings desktop hoặc VRAM policy vào extension.

## 8. Data, cache, configuration và logs

Mặc định `--data-dir` là repository root. Từ đó Forge suy ra:

- models: `<data-dir>/models`, có thể override `--models-dir`;
- outputs: `<data-dir>/outputs/*`;
- extensions: `<data-dir>/extensions`;
- embeddings: `<data-dir>/embeddings`;
- settings: `<data-dir>/config.json`, `ui-config.json`, `styles.csv`, `params.txt`;
- saved-image log: `<data-dir>/log/images/log.csv` khi option tương ứng bật;
- Hugging Face caches: `modules_forge/shared.py` xác định Forge diffusers dir và initialization đặt các `HF_*CACHE` env nếu chưa có;
- Gradio theme cache hiện dùng `<script-path>/tmp/gradio_themes`;
- console là log vận hành chính; không có thư mục `logs/` chuẩn ở HEAD.

Portable supervisor phải truyền path tuyệt đối, tạo writable directories trước spawn và capture stdout/stderr có rotation/redaction. Một số write vẫn bám `script_path` (`tmp`, `config_states`, theme cache, restart marker), nên runtime không thể thực sự read-only trước khi có prototype/path audit đầy đủ.

## 9. Process lifecycle

Chạy Forge như Python child process là phù hợp: biên crash/restart rõ, không nhúng CPython/CUDA vào Electron, giữ launcher và extension compatibility. Supervisor phải quản lý state `Stopped → Starting → Ready → Busy/Recovering → Stopping → Failed`.

Shutdown theo thứ tự:

1. nếu đang generate, gọi interrupt và chờ grace period;
2. không dựa vào `/server-stop`: endpoint đặt lệnh đóng Gradio worker nhưng `main_thread.loop()` vẫn vô hạn;
3. `/server-kill` gọi `os._exit(0)` và có thể dùng như graceful-enough process exit sau khi request đã hoàn tất, nhưng cần prototype và không dùng cho dữ liệu đang ghi;
4. gửi console control/terminate có timeout;
5. cuối cùng terminate toàn process tree.

Windows không tự giết child processes khi parent bị terminate. Forge startup có thể tạo pip/Git processes; extension là code tùy ý và có thể spawn process riêng. Production nên dùng Windows Job Object với kill-on-close, đồng thời ghi nhận trường hợp process cố break away. Không dùng `taskkill` theo tên process.

Restart của desktop nên do supervisor spawn lại, không dùng `tmp/restart` + batch loop. Cờ `--api-server-stop` mở cả kill/restart route nên chỉ bật khi auth toàn app đã được chứng minh.

## 10. Classic Forge trong desktop shell

Classic UI cần được giữ nguyên để extension và advanced workflow tiếp tục hoạt động. Đề xuất dùng một `WebContentsView` riêng, session partition riêng, `nodeIntegration: false`, `contextIsolation: true`, sandbox bật, chặn navigation/window-open ngoài allowlist loopback. `BrowserView` đã deprecated; Electron cũng khuyến cáo tránh `<webview>` khi có thể.

Các lựa chọn và rủi ro:

| Cách nhúng | Rủi ro/kết luận |
|---|---|
| `iframe` trong Studio renderer | Same-origin/CSP/cookie/auth, focus, downloads và extension popup khó kiểm soát; không có process isolation rõ. Không chọn mặc định |
| `BrowserView` | Deprecated từ Electron 29/30; không dùng cho code mới |
| `WebContentsView` | Phù hợp nhất cho guest Classic; phải tự quản bounds, focus, download, permissions, navigation và lifecycle |
| `<webview>` | Electron không khuyến cáo; thêm guest/preload complexity |
| Child `BrowserWindow` | Fallback tốt nếu WebContentsView gặp lỗi IME/drag-drop/popup; UX ít liền mạch hơn |
| Browser ngoài | Recovery fallback an toàn, nhưng không phải trải nghiệm chính |

Classic content và extension là trusted-local-but-extensible, không được trao preload API của Studio. Mọi link ngoài phải được validate và mở bằng browser hệ thống chỉ sau allowlist/scheme check.

## 11. Điểm tích hợp ít conflict

1. Thêm top-level `desktop/` độc lập và workspace/build riêng.
2. Dùng CLI/path/env hiện có thay vì sửa defaults Forge.
3. Gọi API gốc qua main-process client có contract tests.
4. Dùng user extension directory cho bridge cực mỏng, versioned cùng desktop runtime nếu thực sự cần.
5. Capture process logs và external GPU telemetry ngoài Forge.
6. Giữ Classic UI nguyên bản trong isolated web contents.

Các vùng conflict cao: `launch.py`, `webui.py`, `modules/cmd_args.py`, `modules/api/api.py`, `backend/memory_management.py`, `modules_forge/initialization.py`, global CSS/JS và built-in extensions. Không đặt desktop code hoặc patch thường xuyên vào các vùng này.

## 12. License và portable distribution

Root license là GNU AGPL-3.0. Phân phối binary portable của fork cần kèm license, notices, Corresponding Source và cách nhận source tương ứng; extension/model/dependency có license riêng phải inventory. Đây là lưu ý kỹ thuật, không phải tư vấn pháp lý.

Python, Electron/Chromium/Node, Torch/CUDA-related binaries, FFmpeg nếu có, wheels, bundled repositories và built-in extensions đều cần SBOM/license notices. Không bundle model vì kích thước, license và provenance khác nhau. Không giả định CUDA Toolkit có thể redistribute chỉ vì driver tồn tại; release pipeline phải audit từng binary.

CPython embeddable distribution là tối giản và tài liệu chính thức nói pip management không được support như full install. Vì Forge có native wheels và dependency phức tạp, build phải vendor một runtime đã materialize/test, không chạy pip bootstrap trên máy người dùng.

## 13. Đánh giá MCP/tooling

| Tool | Quyết định | Lợi ích cụ thể |
|---|---|---|
| GitHub MCP | Có, optional | Đọc upstream issue/commit/PR và kiểm tra sync; local Git vẫn là source of truth cho code |
| Playwright CLI | Có, mặc định cho test | Dễ chạy trong CI, lưu trace/screenshot, ít coupling agent |
| Playwright MCP | Optional | Hữu ích cho exploratory UI/debug tương tác; không thay test code versioned |
| Figma MCP | Chỉ khi có Figma source | Lấy token/layout/assets có chủ đích; không cần ở foundation |
| Filesystem MCP | Không cần | Agent đã có filesystem/terminal trong workspace; thêm quyền mà không thêm giá trị |
| Memory MCP | Chưa dùng | ADR và docs versioned trong repo đáng tin hơn “memory” ngoài Git |
| Documentation MCP | Có chọn lọc | Tra official Electron/Forge/Playwright API biến động; không dùng thay code inspection |

## 14. Key findings

1. Electron + child Python phù hợp với boundary thật của Forge; embedded Python làm tăng crash/security/ABI coupling không cần thiết.
2. Hybrid là lựa chọn duy nhất vừa có Studio UX vừa giữ extension compatibility mà không rewrite Forge.
3. API gốc đủ cho generation/discovery/progress/memory ban đầu, chưa đủ để khẳng định secure token và process shutdown.
4. Forge đã có automatic VRAM management; desktop chỉ nên telemetry, preflight, profile, queue và recovery.
5. `--data-dir`/`--models-dir` cho phép tách runtime và dữ liệu, nhưng còn write vào `script_path` cần audit/prototype.
6. Runtime production phải prebuilt/offline; launcher hiện tại có thể pip/Git/install extension và không phù hợp làm first-run installer.
7. Classic UI nên dùng isolated `WebContentsView`, không dùng BrowserView và không cấp Studio preload.

## 15. Unknowns cần prototype

- Startup/shutdown thật trên Windows GPU machine, exit code và thời gian cleanup sau interrupt/OOM.
- Contract của Gradio 4.40.0 với explicit dynamic port, WebSocket, auth và `WebContentsView`.
- Bridge middleware nhận secret ngoài CLI, bảo vệ cả `/sdapi`, `/internal`, docs và Gradio mà không phá assets/WebSocket.
- Chính xác các write vào runtime root trong normal generation, extension install và UI reload.
- Process tree thực tế và compatibility của Windows Job Object với Python, Git, extension subprocess.
- External GPU telemetry cho NVIDIA/Intel/AMD, multi-GPU mapping với Forge selected device.
- Baseline VRAM theo model family/resolution trên hardware thật; chưa được phép suy ra threshold production.
- License/SBOM đầy đủ của mọi wheel, repository và built-in extension trong runtime release.

## Nguồn ngoài đã dùng để kiểm chứng quyết định desktop

- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron: Migrating from BrowserView to WebContentsView](https://www.electronjs.org/blog/migrate-to-webcontentsview)
- [Tauri Windows installer và WebView2 modes](https://v2.tauri.app/distribute/windows-installer/)
- [Python 3.10 trên Windows và embeddable package](https://docs.python.org/3.10/using/windows.html)
- [Microsoft Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

