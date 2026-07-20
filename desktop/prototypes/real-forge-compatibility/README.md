# Bounded Real-Forge Compatibility Smoke

## 1. Mục tiêu

Spike này kiểm chứng Decision C trên Forge/FastAPI/Gradio thật tại Git HEAD `9717fdf5fbd8192a8fe2ef0ff5f673b1c620ace3`, không dùng model, GPU workload hay generation. Boundary được kiểm tra là launcher adapter cài outer ASGI guard trước bind, Studio-like client gọi backend có auth, và Classic-like client gọi qua reverse proxy có edge auth.

Đây là prototype có phạm vi hẹp, không phải production bridge, Electron shell hay portable runtime hoàn chỉnh.

## 2. Environment thực tế

- Windows x64, Node `24.11.0`.
- CPython `3.10.11` repo-local.
- Torch `2.3.1+cpu`, Torchvision `0.18.1+cpu`.
- Gradio `4.40.0`, FastAPI `0.104.1`, Uvicorn `0.51.0`.
- Forge chạy từ root repository hiện tại; server bind explicit `127.0.0.1`.
- Test chạy ngoài managed sandbox vì cần bind loopback và cleanup exact process tree bằng `taskkill /PID ... /T /F`.

Kết quả này chưa chứng minh packaged Electron, Chromium `webRequest`, GPU runtime hay Forge extension bên thứ ba.

## 3. Runtime materialization

CPython installer chính thức `python-3.10.11-amd64.exe` được tải từ `python.org`; SHA-256 đã xác minh là `D8DEDE5005564B408BA50317108B765ED9C3C510342A598F9FD42681CBE0648B`.

Runtime nằm tại `.runtime/python-3.10.11/`, bị `.gitignore` và không yêu cầu system Python. Forge bootstrap được chạy với `--exit`; nó cài Torch CPU và clone ba repo pinned vào root `repositories/` đã ignore. Lần đầu dừng vì CPython sạch chưa có `packaging`; sau khi cài `packaging==24.2`, bootstrap retry lại bỏ qua requirements dù `requirements_met()` trả false khi kiểm tra riêng. Vì vậy `requirements_versions.txt` được cài trực tiếp vào runtime local. Đây là bootstrap quirk cần ghi nhận, không phải official bootstrap pass hoàn toàn.

Runtime hiện có khoảng 47.341 file/2,78 GB; ba repository pinned khoảng 78 file/8,02 MB. Không commit runtime, installer, cache hay repositories. Runtime được giữ để smoke có thể tái lập; xóa `.runtime/`, `.smoke/` và root `repositories/` sẽ trả repo về trạng thái chưa materialize.

## 4. Forge startup flow

`src/real-smoke.ts` spawn trực tiếp:

```text
python.exe
→ adapter/secure_launcher.py
→ đọc bootstrap frame từ stdin và đóng pipe
→ assert Gradio/Uvicorn seam
→ patch Uvicorn Config + scoped startup-events self-call
→ runpy launch.py
→ webui.webui()
→ Gradio/FastAPI/Uvicorn
```

Adapter không sửa `launch.py`, `webui.py`, `modules/` hoặc `modules_forge/`. Test extension được copy vào isolated `<data-dir>/extensions/real-forge-smoke` và load bằng mechanism extension thật.

## 5. Selected startup flags

Argument array, đã bỏ path động:

```text
--skip-prepare-environment --skip-install --skip-version-check
--skip-torch-cuda-test --always-cpu --ui-debug-mode --api
--no-download-sd-model --do-not-download-clip
--server-name 127.0.0.1 --port <candidate>
--data-dir <isolated-data> --models-dir <isolated-models>
--ckpt-dir <isolated-models/Stable-diffusion>
--gradio-allowed-path <isolated-data>
```

Không dùng `--listen`, `--share`, `--api-auth`, secret argv hoặc browser autolaunch. Config isolated disable toàn bộ built-in extension theo tên nhưng giữ test extension user; điều này giảm startup scope mà vẫn kiểm tra extension loader/callback thật.

## 6. Pre-bind integration seam

Gradio `4.40.0` tạo server tại `gradio.http_server.start_server()` bằng `uvicorn.Config(app=app, ...)`, rồi `Server.run_in_thread()`. Adapter assert version và hai source fragments trước khi patch `uvicorn.Config.__init__`. App được bọc bằng `SecureForgeGuard` ngay khi Config được construct, trước socket bind.

Đây là bounded monkey patch có fail-closed assertion, chưa phải API ổn định. Production runtime manifest phải pin Forge + Gradio + Uvicorn và có contract smoke khi nâng version.

## 7. ASGI guard installation

Guard bao phủ mọi HTTP/WebSocket scope, gồm route Gradio có sẵn và route extension thêm sau bind. Nó yêu cầu:

- exact `Host` là candidate `127.0.0.1:<port>`;
- exact internal Origin khi Origin có mặt;
- browser fetch-site hợp lệ;
- backend Bearer credential ở private header.

Identity route cũng được auth. Thiếu/invalid bootstrap frame, protocol mismatch, Gradio version mismatch, changed source seam hoặc double install đều dừng startup.

## 8. First-packet protection

Runner probe candidate port liên tục từ thời điểm spawn, không chờ startup log. Hai launch cuối cùng ghi nhận:

| Generation | First listener | First HTTP | Identity | Application routes |
|---:|---:|---:|---:|---:|
| 1 | +7.694 s | `401` | +7.703 s | +8.010 s |
| 2 | +7.497 s | `401` | +7.499 s | +7.781 s |

Không quan sát response Forge 200/redirect/static trước guard. Đây là empirical high-frequency probe, không phải chứng minh mọi nanosecond race.

## 9. Secret transport

Smoke dùng anonymous stdin pipe với một JSON frame versioned, tối đa 16 KiB, newline-terminated, đọc đúng một lần và yêu cầu EOF ngay sau frame. Frame chứa backend token, instance ID, exact host, protocol version và launch generation. Parent gọi `stdin.end()` ngay sau write; token không nằm trong argv/environment/file.

Đây chưa phải Rust Job helper integration cuối. Production giữ quyết định: Rust helper tạo/inherit anonymous handle chỉ cho Python launcher, gửi length-bounded frame, đóng handle sau read và không truyền token cho descendant không cần thiết.

## 10. Protected readiness

Real smoke chứng minh identity 200 xuất hiện trước khi Forge hoàn tất late route registration. Vì vậy readiness production phải là composite:

1. protected identity đúng service/protocol/instance/generation/port;
2. protected capability probes của runtime manifest;
3. process vẫn sống và log không có fatal startup evidence.

Identity trả `capabilities.http/websocket` và internal engine PID; PID không được đưa cho renderer. Wrong/stale instance, unsupported protocol, malformed/fake HTTP 200 đều bị validator từ chối.

## 11. Real route inventory

Đã chạy trên app thật:

- `/` HTML;
- local Gradio JS `./assets/index-BYvoOQkn.js`;
- local Gradio CSS `./assets/index-BG5BHdVr.css`;
- `/sdapi/v1/options` GET/empty POST;
- `/sdapi/v1/progress?skip_current_image=true`;
- `/config`, `/queue/join`, `/queue/data`;
- `/upload`, `/file=...` và Range;
- extension HTTP, SSE, redirect, cookie và WebSocket routes.

`/sdapi/v1/cmd-flags` trả 500 `ResponseValidationError`: response schema đòi `port` là string nhưng runtime body có integer. Đây là Forge/API finding thật tại HEAD, không phải proxy/guard failure và không được dùng làm readiness endpoint.

## 12. Gradio queue protocol

Gradio 4.40 dùng browser flow POST `/queue/join` + SSE `/queue/data?session_hash=...`. `fn_index` được lấy từ `/config`; function fixture `desktop_smoke_echo` không chạy inference. SSE được đọc incremental đến `process_completed`, không buffer toàn stream và không chờ socket close.

Finding quan trọng: `Blocks.launch()` tự gọi unauthenticated `GET <local_url>/startup-events` để start queue. Outer guard ban đầu chặn đúng self-call này, khiến queue không process. Adapter hiện inject backend header chỉ khi URL khớp chính xác scheme `http`, expected loopback authority và path `/startup-events`. Route vẫn từ chối caller khác thiếu credential. Seam được source-assert và cần migration production riêng.

## 13. HTML/static compatibility

Root HTML, local JavaScript và CSS load qua proxy với status/content type đúng; root reload lần hai trả 200. Asset check loại URL CDN để không tính network ngoài proxy là PASS. Favicon không được chọn làm gate vì root HTML không cần nó để chứng minh local bundle.

## 14. API compatibility

Studio-like client gọi backend trực tiếp từ main boundary bằng private backend header. `options` GET, empty options POST và progress GET trả JSON 200. Không gọi txt2img/img2img/interrogate/model load. `cmd-flags` 500 được inventory như incompatibility cần client fallback hoặc upstream fix, không sửa Forge core trong spike.

## 15. Upload/download compatibility

Multipart `.txt` nhỏ đi qua proxy tới Gradio `/upload`; returned uploaded path tải lại được qua `/file=...`. Một file fixture trong isolated allowed data root được tải Range `bytes=0-3`, nhận 206 và đúng 4 byte. Proxy stream request/response; test không dùng file lớn hay buffer model.

## 16. SSE/streaming compatibility

FastAPI `StreamingResponse` extension phát hai SSE events qua proxy. Gradio queue SSE phát `process_completed`/`echo:queue-value`. Client abort một delayed response sau 50 ms và proxy hủy upstream request. Không thấy listener bị giữ sau close.

## 17. WebSocket compatibility

Extension thật đăng ký `/desktop-smoke/ws`; authenticated proxy WebSocket echo pass. Direct backend WebSocket không credential bị reject. Gradio queue của version này được kiểm tra bằng SSE, không giả định WebSocket là queue transport.

## 18. Extension compatibility

Fixture dùng `scripts/*.py`, `on_ui_tabs` và `on_app_started` thật. Gradio tab/function dependency xuất hiện trong `/config`; late FastAPI HTTP/SSE/WebSocket routes đều nằm sau outer guard. Điều này chứng minh representative extension mechanism, không chứng minh mọi built-in/third-party extension.

## 19. Classic browser compatibility

Task dùng bounded HTTP/WebSocket Classic fixture với edge-header injection, không tải Playwright Chromium sau khi runtime Python đã materialize 2,78 GB. Fixture xác minh HTML/assets/reload/cookie/redirect/SSE/WebSocket và token không ở URL/HTML.

Chưa có browser thật nên chưa kiểm tra DOM runtime error, service worker, IndexedDB, drag-drop, CSP trong Chromium hoặc Electron `session.webRequest`. Page source fixture không có token; không có renderer/page JavaScript nhận token. Packaged-Electron Classic compatibility vẫn là task riêng.

## 20. Proxy rewrites

Proxy reuse trực tiếp `SecureForgeProxy` từ spike trước. Nó bind loopback dynamic port, strip hop-by-hop/edge/forwarded headers, set controlled backend auth/Host/forwarded headers, rewrite browser Origin sang internal Origin, preserve streaming/multipart/binary, rewrite absolute backend `Location`, strip cookie Domain và proxy WebSocket Upgrade.

Smoke kiểm tra exact Host, unexpected Origin, browser-like CSRF, content type, Range, redirect/cookie, abort và structured 502 khi upstream dừng. Không rewrite body HTML/JS/CSS.

## 21. Shutdown lifecycle

Runner đóng/cancel active client streams, terminate exact Forge PID tree bằng `taskkill.exe /PID <owned-pid> /T /F`, đóng proxy, rồi bind thử lại cả backend/proxy port. Lần test upstream failure cố ý terminate Forge khi proxy còn sống để xác minh proxy trả structured 502; sau đó proxy đóng ngay.

Không kill theo tên `python.exe`. Các lần debug bị host terminate cũng được cleanup defensively bằng exact command-line-owned PID. `.smoke/active` được xóa sau suite; credentials hết hiệu lực cùng process và generation 2 từ chối token generation 1.

## 22. Test results

Final run:

- TypeScript strict typecheck: PASS.
- Node identity tests: 2/2 PASS.
- Python adapter tests: 4/4 PASS.
- Real Forge checks: 14 groups PASS, hai launch generations.
- First observable backend response: 401 ở cả hai launch.
- Recursive isolated model scan: 0 file, 0 byte.
- Secret scan và final process/listener scan phải được chạy trong final validation trước commit; không suy diễn từ smoke nếu command đó chưa chạy.

## 23. Security findings

- Backend chưa từng trả unauthenticated Forge content trong first-packet probes.
- Direct HTTP/WebSocket bypass thiếu/wrong credential bị chặn.
- Unexpected Host trả 421; unexpected Origin/browser-like CSRF trả 403.
- Token không xuất hiện trong argv route, startup log, proxy log, URL/query, HTML hoặc serialized result.
- Fake HTTP 200, wrong/stale instance và old credential bị từ chối.
- `/startup-events` không được allowlist public; credential chỉ được inject cho exact internal self-call.
- Không tuyên bố bảo vệ Administrator, memory-reading malware, injected same-user process hoặc modified binary.

## 24. Upstream conflict assessment

Forge core diff rỗng. Adapter nằm hoàn toàn dưới `desktop/prototypes/`. Rủi ro conflict Git thấp nhưng runtime seam risk trung bình/cao vì phụ thuộc implementation Gradio `Blocks.launch()` và `uvicorn.Config`. Version/source assertions biến drift thành fail-closed startup thay vì silent unauthenticated fallback.

Production nên có adapter compatibility module theo runtime version, không monkey patch rải rác trong Forge core. Mỗi update Forge/Gradio/Uvicorn phải chạy smoke này trong CI Windows.

## 25. Known limitations

- Không chạy packaged Electron, WebContentsView hoặc browser thật.
- Secret transport dùng Node→Python stdin, chưa đi qua signed Rust Job helper/inherited Windows handle.
- Không test GPU, CUDA, model, inference, generation, VRAM hoặc output image.
- Chỉ một controlled user extension; built-in và third-party extensions bị disable.
- API `cmd-flags` đang 500 tại HEAD.
- Không test arbitrary extension absolute URL/CSP/service worker/popup/download manager.
- Uvicorn `0.51.0` không được pin bởi Forge requirements; production manifest phải pin artifact thực tế.
- Process cleanup smoke dùng exact-PID `taskkill` fallback; crash containment production vẫn thuộc Rust Job Object helper.

## 26. Production recommendation

**Decision C được xác nhận, với hai bổ sung bắt buộc:**

1. launcher adapter phải authenticate Gradio exact `/startup-events` self-call hoặc thay bằng một pre-bind integration ổn định tương đương;
2. readiness phải là identity + protected capability probes, không chỉ identity 200.

Security boundary vẫn là outer backend guard; Classic đi qua Electron-main proxy/session injection; Studio renderer chỉ dùng typed IPC. Không dùng `--api-auth`, public startup route hoặc unauthenticated fallback.

## 27. Migration path

- `desktop/packages/process-supervisor`: port/generation lifecycle, stdin→Rust inherited-handle frame, first-packet probe, exact ownership/cleanup.
- `desktop/packages/forge-client`: identity schema, capability probes, safe API contracts và `cmd-flags` degraded capability.
- `desktop/packages/local-bridge`: proxy, edge/backend auth, Host/Origin/CSRF, streaming/WebSocket tests.
- `desktop/runtime/forge-launch-adapter`: Python guard, compatibility assertions và exact Gradio startup self-call authentication.

Không copy nguyên orchestration smoke sang production. Tách contracts nhỏ, thêm manifest compatibility và chạy fixture + real runtime gates.

## 28. Proposed next task

Task tiếp theo duy nhất: **packaged-Electron Classic compatibility spike**. Nó cần tạo một Electron `WebContentsView` tối thiểu với ephemeral partition và `webRequest` header injection, rồi chạy trên proxy/Forge smoke runtime để kiểm tra asset/DOM/SSE/WebSocket, navigation/popup/permission/download policy và browser storage không chứa credential. Không xây Studio UI production trong spike đó.

## Cách chạy

```powershell
cd desktop/prototypes/real-forge-compatibility
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run smoke
npm run secret-scan
```

`npm run smoke` yêu cầu `.runtime/python-3.10.11` đã materialize và Windows cho phép process hiện tại bind `127.0.0.1`/terminate exact child PID. Không tự bootstrap runtime trong test command.
