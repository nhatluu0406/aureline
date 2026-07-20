# Forge Process Supervisor prototype

## 1. Mục tiêu prototype

Prototype này kiểm chứng boundary mà Electron main process có thể dùng để quản lý Forge như một Python child process độc lập. Nó tập trung vào state, explicit loopback port, HTTP readiness, structured/redacted logs, crash classification và staged shutdown. Prototype không phải production package, không import Electron, không chạy GPU/model/inference và không sửa Forge core.

Code Forge tại HEAD cho phép gọi trực tiếp `<python> launch.py <args...>`: `launch.py` gọi `prepare_environment()` rồi `modules.launch_utils.start()`, còn `start()` gọi Web UI/API worker trước khi vào `modules_forge.main_thread.loop()`. Production runtime đã materialize sẽ truyền `--skip-prepare-environment --skip-install`; prototype không copy launcher và luôn dùng executable + argument array với `shell: false`.

## 2. Kiến trúc

```text
ForgeProcessSupervisor
  ├─ port-allocation       candidate loopback port, không giả vờ reservation
  ├─ readiness             HTTP status probe + per-request/overall timeout
  ├─ log-redaction         line buffering, bounded history, subscriber, redact-first
  ├─ process-tree          PID-owned cleanup abstraction
  └─ fake Forge fixture    HTTP child process, không có Forge/Torch/GPU
```

`types.ts` là contract thử nghiệm có thể chuyển thành `desktop/packages/process-supervisor`; `supervisor.ts` điều phối nhưng không chứa Forge generation logic. `index.ts` chỉ là fake demo.

Dependencies runtime là Node built-ins. Hai dev dependencies được khóa chính xác: `typescript@5.9.3` để strict typecheck và `@types/node@24.10.1` cho Node API types. Không có test framework ngoài `node:test`.

## 3. State machine

```text
idle ──start──> starting ──spawn──> waiting_for_readiness ──HTTP ready──> ready
                    │                       │                              │
                    └────failure────────────┴────────failure──────────────> failed
                                            │
                                            └─collision cleanup─> starting (bounded)

ready/starting/waiting ──stop/cleanup──> stopping ──> stopped | failed
stopped/failed ──explicit start──> starting
```

Transition ngoài allowlist ném `SupervisorError("invalid_state")`. Không dùng các boolean `isStarted/isReady/isStopping`. `stop()` ở `stopped` hoặc `failed` trả lại structured result trước đó; nhiều caller cùng stop nhận cùng in-flight promise.

## 4. Launch flow

Supervisor nhận executable, working directory, base arguments, environment overrides, readiness/startup/shutdown configuration và strategy inject được. Trước spawn, nó xác minh executable là file có thể execute và working directory là directory. `--listen` và `--share` bị từ chối; host của probe luôn là `127.0.0.1`.

Mỗi attempt:

1. lấy một candidate port;
2. thêm `portArguments(port)` vào argument array;
3. gọi `spawn()` với `shell: false`, `cwd` rõ ràng và stdio pipes;
4. phân biệt validation/launch error với child đã spawn rồi exit;
5. chuyển sang HTTP readiness;
6. chỉ công bố `ready` sau response status đúng contract.

Environment không bao giờ được log. Startup diagnostic có argument list đã redaction; production nên giảm tiếp path exposure theo diagnostics policy.

## 5. Readiness flow

Probe không coi TCP accept là đủ. Nó gọi HTTP endpoint cấu hình được, kiểm tra status code allowlist, timeout từng request, overall startup timeout và bounded exponential backoff. Abort signal của child exit hủy fetch/sleep ngay, nên immediate crash không bị báo nhầm thành timeout.

Với Forge Web UI hiện tại, lựa chọn tốt nhất là `GET /internal/ping` (`modules/ui.py`). Khi chạy API-only, dùng endpoint API có contract như `GET /sdapi/v1/cmd-flags`; endpoint phải được runtime manifest/capability test pin. Prototype không thêm bridge health endpoint.

## 6. Port retry

`findCandidatePort()` bind tạm `127.0.0.1:0`, lấy port rồi đóng socket trước khi spawn. Đây chỉ là candidate selection, không loại bỏ TOCTOU race. Nếu child log/diagnostic có `EADDRINUSE`, `address already in use` hoặc Windows socket collision tương đương, supervisor cleanup attempt, chọn candidate khác và retry tối đa `maximumPortAttempts`. Readiness timeout không có collision evidence không tự retry vô hạn.

Fake test giữ candidate đầu bằng server khác, làm fixture fail bind, sau đó xác minh attempt thứ hai ready. Một test khác chứng minh provider chỉ được gọi đúng retry budget.

## 7. Logging và redaction

Mọi event có schema:

```ts
type ProcessLogEvent = {
  timestamp: string;
  stream: "stdout" | "stderr" | "supervisor";
  level: "debug" | "info" | "warn" | "error";
  message: string;
};
```

Buffer giữ chunk dở theo từng stream, phát event theo dòng, flush tail khi child exit và chỉ giữ `logHistoryLimit` event mới nhất. Redaction xảy ra trước khi lưu hoặc gọi subscriber.

Các pattern được che: configured secret; value của `--api-auth`; Bearer/Basic authorization header; Basic credentials trong URL; secret environment value được đánh dấu; query parameter `token`, `api_key`, `key`, `secret`, `password`. Không log raw environment. Test serialize cả observed events và final result để chứng minh fixture secret không còn xuất hiện.

Redaction là defense-in-depth, không phải secret vault: secret biến đổi/encode, extension custom format hoặc binary output vẫn cần policy bổ sung. Không truyền secret qua CLI trong production chỉ vì log đã redact.

## 8. Shutdown stages

### Stage A — cooperative HTTP

Nếu cấu hình, supervisor gọi callback endpoint và chờ bounded time. Với Forge, `/sdapi/v1/server-stop` có ích để yêu cầu Gradio worker dừng nhưng code hiện tại chỉ đặt `shared.state.server_command = "stop"`; `modules_forge.main_thread.loop()` vẫn là vòng lặp riêng. Vì vậy endpoint này không được coi là full-process exit contract. `/server-kill` dùng `os._exit(0)` mạnh hơn nhưng không phải graceful transaction boundary và chỉ tồn tại khi bật `--api-server-stop`.

### Stage B — graceful process request

Trên POSIX prototype gửi `SIGTERM` cho process group owner. Trên Windows, Node `child.kill()` không cung cấp một console control event có semantics tương đương Unix một cách đáng tin cậy; implementation mặc định không giả vờ Stage B thành công và ghi warning. Một native helper có thể bổ sung control event sau khi xác minh console/process-group compatibility của packaged runtime.

### Stage C — process-tree termination

Windows fallback chạy `taskkill.exe` bằng argument array `[/PID, <owned-pid>, /T, /F]`, không shell và không kill theo tên. POSIX fallback dùng process group riêng. Structured result phân biệt `requested` và `forced_termination`, kèm exit code/signal, elapsed time, active port, retry count, cleanup outcome và bounded logs.

Sau khi `ready`, caller có thể giữ `waitForTermination()` để nhận ngay structured `process_exited` result nếu child crash; không cần poll nhiều boolean hoặc nuốt exit event.

## 9. Process-tree cleanup

`ProcessTreeController` cô lập ownership strategy khỏi state machine. Integration test cho fake parent spawn một worker cố sống, buộc Stage C và xác minh cả hai PID đã chết. Một worker khác không thuộc tree vẫn sống sau cleanup, chứng minh implementation không quét/kill `python.exe` hoặc `node.exe` theo tên.

`taskkill` là prototype fallback, không phải guarantee khi desktop bị crash/power loss hoặc không có quyền gọi tool. Trong sandbox hạn chế, command có thể trả `Access denied`; integration gate process-tree phải chạy trong Windows test environment cho phép quản lý chính process do test spawn.

## 10. Khuyến nghị Windows Job Object

Spike tại `../windows-job-object/` đã kiểm chứng `CREATE_SUSPENDED → AssignProcessToJobObject → ResumeThread`, descendant/grandchild inheritance, nested Job trong runner hiện tại và cleanup khi đóng/crash owner. Quyết định production là signed Rust helper giữ Job handle; Electron main giao tiếp qua private pipe. Job ownership vì vậy phải thay launch seam, không chỉ thay `terminateOwnedTree(pid)` sau khi Node đã spawn. Breakaway flags không được bật mặc định; explicit `CREATE_BREAKAWAY_FROM_JOB` trong fixture vẫn không thoát immediate Job khi Job không cho breakaway. [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [limit flags](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information).

Node/Electron không có Job Object API built-in trong child-process contract, nên cần một N-API addon hoặc helper executable nhỏ. Native addon phải build/rebuild đúng Electron ABI, làm tăng matrix x64/arm64, signing, antivirus và update burden; Electron mô tả rõ native modules thường cần rebuild theo Electron version. [Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules).

N-API vẫn khả thi về kỹ thuật nhưng native crash sẽ làm crash Electron main và kéo theo Electron ABI/prebuild/package matrix. Helper cô lập native failure, test độc lập và đã chứng minh kill-on-close; binary release phải được CI prebuild/sign cho x64/arm64. Forge/extension subprocess thực và packaged Electron vẫn là unknown, không được suy diễn từ fake fixture.

## 11. Authentication findings

Prototype cho phép launch có hoặc không có auth và chứng minh redaction, nhưng không chốt `--api-auth` production. CLI credential vẫn hiện trong process command line và Forge launcher có thể in `sys.argv`; API auth cũng không đồng nghĩa bảo vệ mọi internal Gradio route.

Đánh giá hướng tương lai:

- random loopback port không auth: đơn giản nhưng process/browser context khác trên máy vẫn có thể gọi; chỉ phù hợp development/risk-accepted mode;
- environment-based middleware: tránh argv/log, nhưng environment cùng-user vẫn không phải secret boundary tuyệt đối và Forge cần middleware hook;
- ACL-protected token file: tốt cho handoff/rotation hơn plaintext CLI, nhưng vẫn cần middleware đọc file và xóa/rotate an toàn;
- thin bridge extension: phù hợp để thêm whole-app token middleware, health/version và shutdown contract nhỏ; phải pin runtime và test Gradio/WebSocket/Classic;
- Electron main proxy: nên là đường duy nhất cho Studio renderer, giữ token khỏi renderer; chưa đủ cho Classic UI vốn tải trực tiếp loopback origin.

Kết luận hiện tại: Studio đi qua Electron main proxy; secure local auth cần spike riêng, nhiều khả năng là bridge cực mỏng nhận per-launch credential qua environment hoặc ACL file. Không bật `--api-server-stop` production trước khi bảo vệ toàn app được chứng minh.

## 12. Cách chạy test

Yêu cầu Node 24+; không cần Python/GPU/model:

```powershell
cd desktop/prototypes/forge-process-supervisor
npm install --ignore-scripts
npm run typecheck
npm test
```

`npm test` chạy tuần tự để các test port/process ownership deterministic. Trên managed sandbox, test Stage C có thể cần chạy ngoài sandbox do `taskkill` bị policy chặn. Test không cần admin trên Windows bình thường nếu supervisor và child cùng user, nhưng policy doanh nghiệp có thể khác.

## 13. Cách chạy fake demo

```powershell
cd desktop/prototypes/forge-process-supervisor
npm run demo
```

Demo spawn `process.execPath` với argument array, đợi `/internal/ping`, in JSON log events đã chuẩn hóa, POST `/shutdown`, rồi in structured result. Đây không phải CLI production.

## 14. Optional real Forge smoke

Không chạy trong task này. Máy khảo sát có Node `24.11.0` nhưng Python mặc định `3.12.10`; không có `venv/` hoặc `repositories/` đã materialize. Forge Windows code yêu cầu Python 3.10 và normal bootstrap có thể cài Torch/dependencies/clone repositories. Chạy smoke sẽ vi phạm giới hạn không tải dependency lớn và có thể mutate user data. Code inspection vẫn xác nhận launcher nhận direct Python argument array, nhưng lifecycle thực với Gradio/extensions/CUDA chưa được test bằng prototype này.

Khi runtime portable sẵn sàng, smoke riêng nên dùng temporary `--data-dir`, explicit `--server-name 127.0.0.1`, explicit port, `--ui-debug-mode --api --no-download-sd-model --skip-prepare-environment --skip-install`, không `--listen`/`--share`, và tuyệt đối không inference.

## 15. Known limitations

- Fake process chứng minh supervisor mechanics, không chứng minh Forge/Gradio startup latency hay extension subprocess behavior.
- Candidate port có TOCTOU race; retry giảm tác động, không tạo reservation.
- Collision classifier dựa diagnostic strings; production nên thêm exit metadata/capability evidence và localized Windows cases.
- HTTP status readiness chưa validate response schema/runtime version.
- Windows Stage B chưa có native console control event.
- `taskkill` không bảo vệ sudden Electron crash và có thể bị endpoint security chặn.
- Redaction không nhận biết mọi encoding/custom secret format.
- Prototype merge toàn bộ inherited environment để giữ fixture đơn giản; production phải dùng explicit environment allowlist và cache/path contract.
- Không có restart circuit breaker/restart API; task này chỉ kiểm chứng one-start lifecycle và bounded port retry.

## 16. Productionization path

1. Chuyển contracts/state machine sang `desktop/packages/process-supervisor` và log storage sang `log-service`.
2. Thay raw configuration bằng runtime manifest + explicit environment allowlist/path resolver.
3. Thêm Job Object implementation sau native spike; giữ `ProcessTreeController` làm seam test.
4. Đưa HTTP calls vào `forge-client`, validate response schema/capability/runtime identity.
5. Thêm lifecycle event contract qua typed Electron main/preload IPC; renderer không nhận PID, filesystem, environment hoặc auth.
6. Thêm restart budget/circuit breaker, app quit hooks và crash recovery marker.
7. Chạy packaged Windows integration và real Forge no-model smoke trong temporary data root.

## 17. Quyết định chưa chốt

- Framed stdout/stderr relay và heartbeat policy chính xác giữa Electron main với signed Job helper.
- Secure middleware nhận secret từ environment hay ACL-protected file.
- Readiness capability/version schema tối thiểu cho Web UI và API-only.
- Endpoint cooperative nào đủ an toàn sau khi generation/output đang active.
- Environment allowlist chính xác của portable Forge/Torch/extensions.
- Budget startup/readiness/shutdown theo phần cứng và extension thực.
