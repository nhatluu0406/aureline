# Windows Job Object spike

## 1. Mục tiêu

Spike này kiểm chứng một ownership boundary cho Forge trên Windows: một helper native tạo process ở trạng thái suspended, gán process vào Job Object có `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, rồi mới resume. Helper giữ Job handle suốt vòng đời engine. Code nằm hoàn toàn trong prototype, không import Electron, không chạy Forge/GPU/model và không sửa Forge core.

Kết luận production của spike là **Decision B — dùng signed helper executable làm process owner**. Kết luận dựa trên implementation và crash tests chạy thật trên Windows, không chỉ trên phân tích API.

## 2. Vì sao taskkill chưa đủ

`taskkill.exe /PID <pid> /T /F` có ích như cleanup cuối cùng khi owner vẫn sống và biết PID. Nó không chạy được sau khi Electron main crash, có race với process mới sinh, phụ thuộc endpoint-security policy và chỉ là snapshot traversal chứ không phải ownership kernel object. Supervisor prototype trước đây đã chứng minh fallback này có thể cleanup fake tree, nhưng không bảo vệ abrupt owner exit.

Job Object tạo boundary ở kernel: descendant thông thường kế thừa membership; đóng handle cuối với kill-on-close khiến Windows terminate các member. `taskkill` vẫn nên tồn tại như last resort theo đúng PID đã sở hữu khi Job initialization thất bại trước khi process được chạy, hoặc khi cleanup một artifact test đã ghi nhận rõ. Nó không phải crash guarantee.

## 3. Windows Job Object fundamentals

Helper dùng trực tiếp:

- `CreateJobObjectW` tạo unnamed Job Object private;
- `SetInformationJobObject(JobObjectExtendedLimitInformation)` đặt `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` trong `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`;
- `CreateProcessW(CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT)` tạo root process;
- `AssignProcessToJobObject` trước `ResumeThread`;
- `IsProcessInJob` kiểm tra root/descendant;
- `QueryInformationJobObject` kiểm tra limit flags và accounting;
- `CloseHandle` thực hiện normal ownership close;
- `TerminateJobObject` thực hiện explicit forced termination.

Theo tài liệu Microsoft, Job Object hỗ trợ nested jobs từ Windows 8/Server 2012. Association không thể tự tháo sau khi đã gán; process có thể nằm trong một hierarchy nhiều jobs. `KILL_ON_JOB_CLOSE` ở nested job chỉ terminate process thuộc job đó và child jobs của nó, không terminate process ngoài ownership boundary. Tham khảo [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs) và [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).

## 4. Kiến trúc spike

```text
TypeScript test/Electron-main adapter
  │ stdin: versioned binary launch request + command lines
  │ stdout: JSON event protocol only
  ▼
Rust helper (Job handle owner, sống cùng engine)
  ├─ unnamed Job Object + KILL_ON_JOB_CLOSE
  ├─ suspended root process → assign → resume
  └─ QUERY / CHECK / CLOSE / TERMINATE / EXIT
         │
         └─ Node fixture root → children → grandchild
```

`src/job-owner.ts` là proof-of-concept adapter chỉ dành cho trusted Electron main/process-supervisor code. Request được gửi qua anonymous stdin pipe, không đặt Forge args/environment vào helper command line. Stdout chỉ chứa protocol JSON; fixture ghi PID vào JSONL file riêng. Child stdout/stderr hiện trỏ vào `NUL` để chứng minh protocol không bị trộn — production phải thay bằng pipe relay có framing và redaction.

Helper dùng Rust standard library và raw Win32 FFI, không có crate runtime. TypeScript chỉ phụ thuộc Node built-ins; `typescript` và `@types/node` là dev dependencies khóa version.

## 5. Process creation flow

Flow thực tế trong helper:

```text
validate request ở TypeScript boundary
→ CreateJobObjectW
→ SetInformationJobObject(KILL_ON_JOB_CLOSE)
→ CreateProcessW(CREATE_SUSPENDED)
→ AssignProcessToJobObject
→ IsProcessInJob / QueryInformationJobObject
→ ResumeThread
→ close thread/process handles, giữ Job handle
```

Nếu create, assign hoặc resume lỗi, helper phát structured event gồm `stage`, `win32Error`, `message`; process suspended bị terminate trước khi helper đóng handles. Test-only failure injection dùng invalid Job handle và invalid thread handle để chứng minh user code chưa chạy và diagnostics không bị nuốt. Spike không dùng flow `spawn normally → assign later`.

Win32 command line được helper tạo từ executable + argument array bằng quoting theo Windows parsing rules. Không dùng shell string hoặc `shell: true`. Executable/cwd được adapter kiểm tra là file/directory trước khi gửi; helper vẫn coi `CreateProcessW` là validation cuối.

## 6. Job lifetime

Helper giữ handle duy nhất của owned Job Object và phải chạy suốt vòng đời Forge:

- normal close: Electron gửi `CLOSE`; helper đóng Job handle, tree chết;
- explicit termination: Electron gửi `TERMINATE <exitCode>`; helper gọi `TerminateJobObject`;
- Electron crash: anonymous stdin đóng; helper nhận EOF, đóng Job handle rồi exit;
- helper bị terminate/crash: Windows đóng handle của helper, kill-on-close cleanup tree;
- normal engine exit: helper vẫn query/account và đóng handle theo lifecycle command.

Spike còn terminate helper trực tiếp để mô phỏng abrupt owner exit; toàn tree bị cleanup. Nếu Electron treo nhưng chưa chết và pipe còn mở, helper không tự suy ra owner mất — watchdog/heartbeat là production follow-up, không phải thuộc tính của kill-on-close.

## 7. Descendant inheritance

Fixture tạo:

```text
root
├── cooperative_child
└── noncooperative_child
    └── grandchild
```

Mỗi process ghi PID/PPID dạng JSONL. Test gọi `IsProcessInJob(target, ownedJob)` cho root, hai child và grandchild; tất cả trả `true`. Normal close, abrupt helper exit và explicit terminate đều làm toàn bộ fixture PID chết. Một `unrelated` process được spawn từ test runner ngoài owned Job và vẫn sống sau owned tree cleanup.

Điều này chỉ chứng minh descendant tạo qua normal `CreateProcess` của fixture. Forge/extension có thể dùng service, WMI, scheduler, elevation hoặc broker bên ngoài; các đường đó cần real-runtime compatibility test.

## 8. Nested jobs

Môi trường validation ngoài sandbox báo helper hiện tại đã nằm trong một outer Job Object (`IsProcessInJob(current, NULL) = true`). Dù vậy, helper tạo child Job mới và `AssignProcessToJobObject` thành công; root/descendant nằm trong owned nested job. Đây là bằng chứng thực tế cho terminal/runner hiện tại, không phải cam kết cho mọi IDE/CI/Electron package.

Trên Windows hiện đại, nested assignment hợp lệ khi hệ thống tạo được hierarchy, Job mới phù hợp và không xung đột UI limits. `ERROR_ACCESS_DENIED` không chỉ có nghĩa “đã nằm trong Job”: nó còn có thể liên quan Windows cũ, hierarchy không hợp lệ, quyền handle, UI/security limits, session hoặc process policy. Production diagnostics phải giữ stage + Win32 code + environment facts, không map mọi code 5 thành một nguyên nhân.

Matrix còn phải chạy trong VS Code, Cursor, terminal thường, CI service và packaged Electron. Spike thực tế chạy từ Codex/PowerShell test runner, ngoài managed sandbox cho integration tests.

## 9. Breakaway

Production helper không đặt `JOB_OBJECT_LIMIT_BREAKAWAY_OK` hoặc `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`.

Spike cho một descendant gọi `CreateProcessW(CREATE_BREAKAWAY_FROM_JOB)`. API create vẫn trả thành công, nhưng vì immediate Job không cho breakaway nên flag không có hiệu lực; `IsProcessInJob` xác nhận process mới vẫn thuộc owned Job và bị kill khi handle đóng. Vì vậy “breakaway bị chặn” không nhất thiết biểu hiện bằng `CreateProcessW` trả lỗi.

`SILENT_BREAKAWAY_OK` không được bật/test vì nó đi ngược ownership invariant: mọi child sẽ tự thoát Job và cần cleanup ngoài boundary. Tài liệu Microsoft xác định trong nested hierarchy, breakaway bắt đầu từ immediate Job và đi lên cho đến Job không cho phép. Extension muốn tự tạo Job riêng có thể gặp `AssignProcessToJobObject` failure khi breakaway bị cấm; compatibility exception phải là quyết định rõ, không bật global breakaway mặc định.

## 10. Crash behavior

Các case đã chạy bằng process thật:

1. `CLOSE`: đóng Job handle, root/children/grandchild chết.
2. abrupt helper exit: gọi terminate lên helper owner, Windows đóng handle và tree chết.
3. `TERMINATE`: `TerminateJobObject` làm tree chết; gọi lặp có behavior xác định.
4. unrelated process: vẫn sống sau cleanup của owned Job.

Test luôn ghi PID trước khi assert và có defensive cleanup theo đúng PID/tree fixture nếu test lỗi. Không có code kill theo process name; không đụng terminal, Cursor, Codex hoặc process hệ thống.

## 11. N-API assessment

| Câu hỏi | Đánh giá |
|---|---|
| Gọi Win32 API | Có; C/C++ addon có thể gọi cùng API và đảm bảo suspended → assign → resume |
| ABI | Node-API ổn định ABI khi addon chỉ dùng `node_api.h`; V8/libuv/Node C++ API không có guarantee tương tự |
| Electron rebuild | Pure Node-API prebuild có thể giảm nhu cầu rebuild, nhưng Electron vẫn yêu cầu validate target architecture/toolchain; addon thường cần `@electron/rebuild`, đặc biệt nếu không thuần Node-API |
| Packaging | `.node` phải được unpack khỏi ASAR/đặt ở real filesystem; build x64/arm64 trong CI |
| Signing | `.node` là PE/DLL native artifact, cần ký cùng release chain và hash/SBOM; tooling signing phải include unpacked artifact |
| Crash impact | Access violation/UB trong addon làm crash Electron main, có thể mất composition root/log/settings cùng lúc |
| Testability | Có thể test với Node nếu addon là Node-API-compatible, nhưng vẫn cần packaged Electron smoke |
| Maintenance | Cần node-gyp/C++ headers, prebuild matrix, Electron upgrade smoke và xử lý native module loading |

Node-API giúp tách khỏi V8 ABI nhưng không loại bỏ architecture, compiler runtime, Electron packaging/signing hoặc native crash risk. Electron chính thức lưu ý native modules thường phải rebuild cho Electron; Electron Forge tự tích hợp rebuild. Xem [Node-API ABI stability](https://nodejs.org/api/n-api.html), [Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules) và [ASAR archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives).

Addon có ưu điểm IPC/in-process call đơn giản và một process ít hơn, nhưng failure containment kém hơn đúng ở boundary có quyền terminate toàn Forge tree. Spike không triển khai addon vì helper có thể kiểm chứng cùng Win32 flow mà không khóa Electron ABI/toolchain trước khi Electron scaffold tồn tại.

## 12. Helper executable assessment

Helper nên giữ Job handle, không phải Electron. Nếu Electron giữ handle trực tiếp thì phải có addon/FFI và native crash trở lại main process; helper giữ handle tạo failure containment đối xứng: Electron hoặc helper chết đều dẫn tới cleanup.

Helper phải sống cùng Forge. IPC mặc định đề xuất là anonymous stdin/stdout pipes do Electron tạo:

- không mở network listener;
- chỉ parent có pipe handles;
- EOF là owner-death signal;
- protocol có magic/version handshake;
- request/response framing tách khỏi child logs;
- renderer không biết helper, PID hoặc protocol.

Named pipe chỉ cần khi có reconnect/bootstrapper; lúc đó phải dùng random name, local namespace và explicit ACL. Local socket không đem lợi ích trên Windows cho contract này. Spike dùng binary launch request rồi line commands/JSON events; production nên dùng length-prefixed binary/JSON frames cho cả hai chiều, correlation ID và max-frame limit.

So sánh ngôn ngữ helper:

- C++: binary nhỏ và Win32 headers trực tiếp, nhưng memory-safety/protocol parsing burden cao;
- Rust: binary nhỏ, ownership/error handling tốt, raw Win32 FFI có thể không cần runtime package; spike này đã build bằng `rustc` không crate;
- C#: code Win32 interop dễ đọc nhưng framework-dependent cần .NET có sẵn, còn self-contained publish lớn hơn đáng kể;
- Go/ngôn ngữ khác: runtime/binary overhead không tạo lợi ích cho contract rất nhỏ.

Khuyến nghị Rust cho production helper, với audited Windows bindings hoặc FFI rất hẹp, pinned toolchain và prebuilt artifact. Người dùng cuối không cần Rust/compiler. Helper làm updater/signing phức tạp hơn một file, nhưng portable ZIP vốn đã multi-file và helper dễ smoke test trên clean Windows hơn `.node` gắn Electron runtime.

## 13. taskkill fallback assessment

Giữ `taskkill /PID <ownedPid> /T /F` như last resort khi:

- helper chưa resume root vì initialization lỗi và cần defensive cleanup;
- helper IPC bị lỗi nhưng Electron vẫn sống và đã xác minh exact owned PID;
- diagnostic/recovery tool được user chủ động chạy.

Không dùng taskkill theo process name. Không coi nó bảo vệ Electron crash. Endpoint security có thể chặn, command có thể fail do quyền/session, và `/T` không thay ownership guarantee. Nếu Job initialization thất bại trước resume, production ưu tiên terminate suspended process handle rồi fail closed; không resume Forge và “hy vọng taskkill sau”.

## 14. Implemented approach

Đã triển khai signed-helper direction ở dạng unsigned development artifact:

- Rust x64 MSVC helper, raw Win32 FFI, static CRT build flag;
- versioned private pipe protocol;
- TypeScript strict adapter `OwnedJobProcess`;
- structured Win32 stage errors;
- query membership/accounting;
- fake tree/crash/breakaway fixtures;
- deterministic Node integration tests, không Electron/GPU/Python.

Helper development binary nằm trong ignored `build/`, không commit. Source và build script mới là artifact của repository. Release CI phải rebuild, hash, sign và package; không tải binary prebuilt không rõ provenance.

## 15. Build instructions

Yêu cầu development: Windows x64, Node 24+, npm và Rust MSVC target. Không cần Visual Studio shell ở runtime và không có Cargo crate dependency.

```powershell
cd desktop/prototypes/windows-job-object
npm install --ignore-scripts --no-audit --no-fund
npm run build:helper
npm run typecheck
```

`build:helper` gọi `rustc --edition 2021`, optimization nhẹ và `target-feature=+crt-static`. Production phải pin Rust toolchain trong CI, build x64 và arm64 riêng, kiểm tra PE dependencies, generate SHA-256/SBOM và không build trên máy người dùng.

## 16. Test instructions

```powershell
npm test
npm run demo
```

Tests phải chạy trên Windows environment cho phép process tự tạo/assign/terminate descendants. Managed sandbox có thể chặn process-control; điều đó phải được report, không bypass bằng kill rộng. `npm run verify` clean build lại helper rồi chạy typecheck, suite và demo.

## 17. Validation results

Môi trường đã test:

- OS API: `Microsoft Windows [Version 10.0.26200.8875]`; registry báo `Windows 10 Pro`, display version `25H2` (registry label không được dùng để suy diễn packaged target);
- architecture: AMD64/x64;
- Node: `v24.11.0` x64;
- Rust: `rustc 1.95.0`, target `x86_64-pc-windows-msvc`, LLVM 22.1.2;
- runner: PowerShell/Codex; native integration chạy ngoài managed sandbox;
- current helper process nằm trong outer Job Object: `true`;
- owned nested Job assignment: thành công;
- suite gần nhất: 8 tests pass, 0 fail;
- packaged Electron và arm64: chưa test.

Suite xác minh tạo/config Job, suspended creation, assign-before-resume, resume, root execution, child/grandchild inheritance, close cleanup, explicit terminate, abrupt owner exit, unrelated isolation, invalid path, structured assign/resume failures, repeated operations và explicit breakaway attempt không thoát owned Job.

## 18. Security considerations

- Helper/target/cwd được resolve và validate ở trusted main boundary; production còn phải allowlist runtime manifest, không nhận arbitrary renderer text.
- Dùng argument array/protocol fields, không shell.
- Raw environment không được log; spike truyền inherited environment + overrides để fixture tương thích, production phải chuyển sang explicit allowlist.
- Helper có unnamed Job, không dùng global named object hoặc network listener.
- Renderer không được spawn/gọi helper, biết PID hay nhận Win32 handle.
- Protocol áp max string/count; production thêm max total frame, correlation và schema validation đầy đủ.
- Child output hiện đi `NUL`; relay production phải redact trước lưu/phát.
- Không yêu cầu Administrator cho standard same-user Job APIs; policy doanh nghiệp/session khác có thể gây lỗi và phải fail closed.

## 19. Packaging/signing considerations

Package helper như unpacked real file dưới Electron resources, không nằm trong ASAR path dùng trực tiếp bởi `spawn`. Resolve path từ `process.resourcesPath` và verify manifest/hash trước launch. Build artifact theo `win32-x64` và `win32-arm64`; không dùng một binary cho cả hai.

Ký Authenticode helper EXE và Electron binaries bằng cùng publisher certificate, timestamp signature, giữ stable product metadata. Sign trước khi assemble/checksum; release gate verify signature sau unpack. Helper tạo process và terminate tree nên antivirus/EDR có thể chú ý; tránh packer/obfuscation/self-extract, publish hashes/SBOM và test clean VM/representative endpoint security. SmartScreen reputation phụ thuộc publisher/signature/download history, không chỉ code correctness.

Rust static CRT giảm dependency ngoài OS nhưng phải kiểm tra `dumpbin /DEPENDENTS` ở release gate. Helper nhỏ không làm updater khó về data migration, nhưng shell update phải thay helper atomically khi engine đã dừng và rollback helper cùng shell compatibility manifest.

## 20. Known limitations

- Chỉ test fake Node tree, chưa test Forge, Python, Gradio hoặc extension subprocess thực.
- Chưa chạy packaged Electron; anonymous pipe EOF/crash behavior đã test với Node owner/helper, chưa với Electron crash reporter/updater topology.
- Chỉ build/test x64; arm64 là release matrix bắt buộc.
- Child stdout/stderr đi `NUL`; production log relay chưa triển khai.
- Protocol spike chưa có heartbeat, reconnect, capability negotiation đầy đủ hoặc authentication; pipe handles là local parent-child boundary.
- Assign/resume failure diagnostics dùng deliberate invalid handles; chưa tái tạo mọi real `ERROR_ACCESS_DENIED` environment.
- `SILENT_BREAKAWAY_OK` không test vì production không bật; WMI/service/scheduled/elevated process escape paths chưa test.
- Job Objects không bảo vệ power loss; process cũng chết khi OS mất.
- Không có production code signing certificate trong task.

## 21. Production recommendation

**Decision B: signed Rust helper executable làm process owner.**

Lý do chính:

1. implementation đã chứng minh critical flow suspended → assign → resume và kill-on-close;
2. helper crash không kéo Electron main vào native access violation; thay vào đó kernel cleanup Forge;
3. Electron crash/pipe EOF và helper abrupt exit đều có ownership semantics rõ;
4. helper test độc lập ngoài Electron, dễ clean-Windows smoke và không phụ thuộc Electron ABI;
5. portable ZIP đã là multi-file, nên chi phí thêm signed EXE nhỏ hơn maintenance/prebuild risk của addon.

Trade-off là thêm process, versioned IPC, một signed artifact và log relay. N-API không giữ làm production default; chỉ revisit nếu measured helper IPC/startup overhead là blocker và addon packaged spike chứng minh crash containment chấp nhận được. `taskkill` chỉ là last resort, không phải hướng mặc định.

## 22. Migration path vào process supervisor

Không copy nguyên prototype. Khi tạo `desktop/packages/process-supervisor`:

1. định nghĩa `OwnedProcessLauncher` interface ở package, không expose PID/handles ra renderer;
2. chuyển state machine/readiness/redaction hiện có sang dùng launcher thay `node:spawn` trực tiếp trên Windows;
3. đặt signed helper source/build thành package native artifact riêng với manifest/protocol version;
4. helper tạo inheritable stdout/stderr pipes và relay framed chunks về main; log service redact trước persistence/subscriber;
5. environment resolver dùng allowlist portable runtime, không merge toàn bộ `process.env` mặc định;
6. fail closed nếu create/configure/assign/resume lỗi; taskkill chỉ exact-PID defensive fallback;
7. thêm app quit/crash/IPC EOF tests, heartbeat policy, restart budget và packaged Electron clean-VM matrix;
8. contract tests pin helper protocol version và reject shell/arbitrary renderer command.

Adapter tương lai tương ứng seam `ProcessTreeController` cũ nhưng boundary đổi sớm hơn: production launcher phải sở hữu **creation**, không chỉ cung cấp `terminateOwnedTree(pid)` sau khi Node đã spawn. Đây là lý do không thể chỉ thay implementation trong `process-tree.ts`; supervisor launch seam cần được tách có chủ đích.

## 23. Proposed next task

Task kế tiếp đề xuất: **secure local Forge bridge/auth spike**. Job ownership risk đã có direction và bằng chứng đủ cho foundation; khoảng trống kiến trúc lớn tiếp theo là bảo vệ toàn bộ loopback FastAPI/Gradio surface mà không đưa secret vào argv/log và vẫn giữ Classic Forge hoạt động.
