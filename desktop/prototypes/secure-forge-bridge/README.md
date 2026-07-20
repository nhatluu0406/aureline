# Secure Local Forge Bridge/Auth spike

## 1. Mục tiêu

Spike này kiểm chứng một boundary thực tế để desktop app bảo vệ Forge trên loopback mà không đặt credential trong argv, URL, renderer storage hoặc log. Từ “secure” ở đây chỉ có nghĩa giảm các rủi ro trong threat model bên dưới; nó không bảo vệ tuyệt đối trước Administrator, malware cùng user có quyền đọc/inject process memory hoặc kernel compromise.

Prototype chạy độc lập với Forge, Torch, GPU và model. Nó không sửa Forge core và không triển khai Electron window. Kết luận production là **Decision C — kết hợp outer Forge middleware và Electron-main reverse proxy**:

```text
Studio renderer ─ typed IPC ─ Electron main ─ backend credential ─┐
                                                                 ▼
Classic WebContentsView ─ injected edge header ─ local proxy ─ backend header ─ Forge
                                                                  ▲
                                          outer ASGI guard ────────┘
```

Outer ASGI guard bảo vệ direct backend; proxy là route dành cho Classic. Studio không đi qua một localhost endpoint mà renderer có thể gọi.

## 2. Threat model

### Bảo vệ trước

- website độc hại gửi simple GET, form POST, fetch hoặc WebSocket tới loopback;
- local process bình thường scan được port nhưng không có per-launch credential;
- browser tab khác mở trực tiếp proxy hoặc Forge URL;
- credential lộ qua argv/process list, query string, browser URL hoặc startup log;
- credential cũ được replay sau engine restart;
- request có Host giả, `localhost`, IPv6 alias, Origin ngoài policy hoặc DNS-rebinding-style Host;
- renderer Studio bị compromise nhưng Electron main/preload boundary chưa bị chiếm;
- process giả chiếm candidate port và trả HTTP 200 giả;
- Forge vô tình bind sai host: supervisor phải từ chối cấu hình trước spawn, guard còn reject Host nhưng không thay thế bind policy.

### Không tuyên bố bảo vệ tuyệt đối trước

- Administrator, debugger/injector hoặc malware có thể đọc Electron/helper/Forge memory;
- kernel compromise, binary/package bị người dùng cố ý thay hoặc signing key bị chiếm;
- code extension đã được user cài có quyền chạy trong Forge Python process và có thể đọc memory;
- nội dung đã render bị screen capture hoặc exfiltrate bởi code đã compromise Classic page;
- denial of service từ local process giữ port, flood loopback hoặc giết process;
- service/WMI/elevated broker nằm ngoài Windows Job Object boundary nếu extension chủ động dùng chúng.

Một Classic extension chạy JavaScript trong đúng isolated Classic view có thể phát request được main inject header. Đây là capability cần cho compatibility; extension không đọc được token trực tiếp, nhưng code đã chiếm Classic origin có thể hành động với quyền của Classic session.

## 3. Non-goals

- Không làm account system, OAuth, TLS certificate, LAN/remote mode hoặc multi-user.
- Không biến CORS hay random port thành authentication.
- Không triển khai Electron shell, updater, installer hoặc production bridge merge.
- Không chạy Forge thật, Gradio thật, inference hoặc model download.
- Không đảm bảo mọi extension tương thích trước bounded real-Forge smoke.
- Không bảo vệ secret khỏi chính Forge process sau khi bridge đã đọc nó.

## 4. Forge surface cần bảo vệ

Code tại HEAD cho thấy Web UI, `/sdapi/v1/*`, `/internal/*`, progress/UI APIs, Gradio assets/upload/file/queue, docs và routes từ `on_app_started` cùng nằm trên một FastAPI/Gradio app. Vì vậy policy là **auth mọi HTTP method, GET, static, file và WebSocket**, trừ khi một endpoint public được quyết định rõ trong tương lai. Identity/readiness cũng yêu cầu auth.

Forge pin `gradio==4.40.0`. Source Gradio 4.40 cho thấy queue chính dùng HTTP POST + SSE (`/queue/join`, `/queue/data`), không nên suy diễn help text cũ rằng queue hiện luôn dùng WebSocket. Proxy vẫn hỗ trợ WebSocket vì extension/custom route có thể dùng nó và Chromium `webRequest` có resource type `webSocket`.

## 5. Các phương án đã xem xét

### A — Electron main reverse proxy

Ưu điểm:

- Classic chỉ thấy proxy origin; main giữ edge credential và inject request header;
- có một chỗ kiểm Host/Origin, navigation origin, timeout, body policy và structured log;
- generic HTTP/1.1, streaming, upload/download, redirect và WebSocket có thể relay mà không biết Forge route;
- Studio không cần dùng proxy, vẫn typed IPC → main client.

Nhược điểm:

- proxy đơn độc không chặn local process gọi trực tiếp Forge backend;
- absolute URL, CSP, cookie/path, root path và extension-specific protocol có compatibility risk;
- Electron main mở thêm một loopback listener và phải cleanup tuyệt đối;
- request-header injection cấp capability cho mọi request từ đúng Classic partition.

Kết luận: cần cho Classic, nhưng không đủ làm boundary duy nhất.

### B — thin Forge middleware/bridge

Outer ASGI middleware có thể auth toàn bộ HTTP và WebSocket, kể cả route extension thêm sau. Nó cung cấp identity endpoint và làm direct backend fail closed. Secret có thể đến từ inherited anonymous pipe thay vì CLI.

Finding quan trọng từ code Forge: `webui_worker()` gọi `shared.demo.launch()` trước `script_callbacks.app_started_callback()`. Vì vậy middleware chỉ được thêm trong `on_app_started` có một cửa sổ sau bind và không bảo vệ từ packet đầu tiên. Spike dùng launcher adapter cài outer wrapper tại `uvicorn.Config` construction trước bind; không sửa Forge core, nhưng đây là integration seam version-pinned cần real-Forge smoke. Một extension thuần `on_app_started` không được chọn làm security boundary production.

Kết luận: bắt buộc để chống direct-backend bypass, nhưng Classic vẫn cần main-controlled cách cung cấp auth.

### C — OS capability thay shared token

- Named pipe/anonymous pipe phù hợp truyền secret bootstrap, nhưng Chromium/Gradio HTTP không nói trực tiếp qua named pipe.
- Inherited socket handle đòi thay server creation của Uvicorn/Gradio và không giải quyết browser auth.
- Windows port ACL/firewall thường cần policy/admin, không có portable per-request identity và không thuận lợi cho dynamic port.
- Windows authentication/SSPI làm tăng native/browser negotiation và extension compatibility; không phù hợp single-user portable baseline.
- Process identity verification sau TCP accept có TOCTOU và không phải browser primitive.
- Private Network Access/CORS/loopback exemption có behavior browser-version-dependent và không phải authentication.

Kết luận: dùng OS capability cho **secret transport**, không dùng thay HTTP auth.

### D — Forge `--api-auth`

`modules/launch_utils.py` in `sys.argv`; `--api-auth` vì vậy lộ trong command line và startup log. `modules/api/api.py` chỉ gắn Basic dependency cho routes đi qua `Api.add_api_route()`, không bảo vệ toàn bộ Gradio/internal/static/extension surface. `--gradio-auth` là miền auth khác; `--gradio-auth-path` tránh password trong argv nhưng không hợp nhất API/custom routes. Baseline này không đạt production requirement.

## 6. Implemented prototype

```text
secure-forge-bridge/
  src/
    client/forge-client.ts       # main-only backend client + identity verification
    proxy/secure-proxy.ts        # edge auth, HTTP streaming và WebSocket relay
    security/                    # random credential, constant-time compare, Host/Origin policy
    demo.ts
  bridge/
    secure_bridge.py             # pure ASGI outer guard + Uvicorn Config wrapper seam
    test_secure_bridge.py
  fake-forge/server.ts           # Gradio-like child fixture, credential qua stdin
  test/
    secure-bridge.test.ts
    test-helpers.ts
  scripts/
    clean.mjs
    secret-scan.mjs
```

Node runtime dependency duy nhất là `ws@8.18.3`; tự viết WebSocket framing/upgrade sẽ tăng rủi ro protocol không cần thiết. TypeScript, `@types/node` và `@types/ws` là dev dependencies khóa chính xác. Python middleware chỉ dùng standard library.

## 7. Credential lifecycle

Mỗi engine launch tạo độc lập:

- `backendToken`: 32 random bytes, base64url, chỉ Electron main/helper/Forge guard biết;
- `edgeToken`: 32 random bytes, base64url, chỉ Electron main proxy và Classic session injection biết;
- `instanceId`: 16 random bytes dạng hex, dùng bind readiness với đúng launch.

Credential không persist. Restart Forge luôn rotate cả token và `instanceId`; renderer reload không rotate nếu engine instance không đổi. Khi engine/helper dừng, Forge guard biến mất, proxy đóng, Classic session bị hủy/clear, nên capability hết hiệu lực. Old token test đã bị từ chối trên instance mới.

Prototype không đặt token vào argv, URL, query, localStorage, sessionStorage hoặc serialized diagnostics. Secret so sánh bằng SHA-256 digest + `timingSafeEqual` phía Node và `hmac.compare_digest` phía Python. Constant-time comparison chỉ giảm timing leak ở bước compare; nó không che mọi timing khác của HTTP stack.

## 8. Secret transport

### Environment variable chứa token

Không nằm trong argv và dễ triển khai, nhưng Forge cùng mọi descendant kế thừa environment có thể đọc; extension/crash dump/custom log có thể in nó. Chỉ giữ làm development fallback có cảnh báo, không phải production default.

### ACL-protected temporary file

Có thể tạo file bằng DACL chỉ user hiện tại, mở delete-on-close và xóa sau khi read. Nó vẫn persist trong một khoảng thời gian, cleanup sau crash phức tạp, path có thể xuất hiện trong diagnostics và mọi process cùng user thường vẫn nằm trong cùng ACL principal. Phù hợp fallback khi inherited handle không hoạt động trong packaging, không mạnh bằng pipe capability cho threat “local process cùng user”.

### Anonymous pipe/inherited handle

Được chọn production. Electron main tạo secret; private protocol gửi nó tới signed Rust Job helper. Helper tạo anonymous pipe, ghi bootstrap frame, chỉ cho Forge root kế thừa read handle, đặt **handle number chứ không phải token** trong environment, rồi tạo Forge suspended → assign Job → resume. Launcher adapter đọc một lần, đóng handle và xóa environment key trước khi chạy Forge.

Fake Forge trong spike nhận token qua stdin anonymous pipe; child argv thực tế chỉ có Node executable, transform flag, fixture path và port. `bridge/secure_bridge.py` có read-once inherited-handle reader fail closed. Rust helper hiện tại chưa có secret-pipe frame; đó là migration work, không được tuyên bố đã tích hợp.

## 9. Studio path

```text
React renderer
  → typed preload IPC, sender/payload validated
  → Electron main MainProcessForgeClient
  → backend 127.0.0.1 với backend header
  → outer ASGI guard
```

Renderer chỉ nhận domain response đã validate; không nhận backend origin, port, PID, token, raw file path hoặc generic HTTP primitive. `MainProcessForgeClient.verifyIdentity()` yêu cầu service name, protocol version và đúng `instanceId`. Fake process trả HTTP 200 với identity sai bị từ chối.

## 10. Classic Forge path

Production direction:

1. tạo `WebContentsView` không Node/preload Studio, `contextIsolation` và sandbox bật;
2. dùng partition in-memory riêng, không prefix `persist:`;
3. partition `webRequest.onBeforeSendHeaders` chỉ cho exact proxy `http://127.0.0.1:<port>/*` và WebSocket tương ứng;
4. main inject `x-forge-desktop-authorization` vào request headers; page JavaScript không nhận token value;
5. proxy validate edge token/Host/Origin rồi thay bằng backend token trước upstream;
6. chỉ allow exact proxy origin khi navigate; deny popup mặc định, external URL qua explicit validated action;
7. deny permission mặc định; download do main authorize destination/type;
8. khi engine dừng: destroy view, remove hook, close connections và `session.clearData()`/clear cache cho partition.

Electron docs hiện tại xác nhận `onBeforeSendHeaders` cho phép sửa request headers và `resourceType` có `webSocket`; docs session xác nhận partition không có `persist:` là in-memory. Đây mới là documentation verification + Node protocol simulation, **chưa phải packaged Electron proof**. Electron chỉ dùng một active listener cho mỗi `webRequest` event, nên production cần một central registrar thay vì nhiều module ghi đè nhau.

Không dùng token trong cookie. Proxy vẫn preserve cookie Gradio/extension và strip `Domain` khi cần, nhưng cookie đó là application state, không phải bridge credential. `HttpOnly` localhost cookie có thể hỗ trợ auth khác, song `Secure`/scheme behavior và cookie lifecycle thêm complexity không cần thiết khi session header injection hoạt động.

Service worker không được dùng để giữ/inject token. Classic page có thể dùng localStorage/sessionStorage cho chính Forge/extension, nhưng bridge token không bao giờ được ghi vào đó.

## 11. HTTP authentication

Proxy yêu cầu header edge trên mọi request. Nó loại header đó trước upstream và thêm header backend. ASGI guard yêu cầu backend header cho mọi method/path, gồm GET, HTML, static, upload, download, extension route và identity. Không có “public health” endpoint; supervisor/main tự có credential trước readiness.

Fake tests bao phủ correct/missing/wrong token, direct backend, JSON, POST, multipart, binary, redirect, cookie và nested extension route. Unauthorized log chỉ giữ timestamp/code/method/path; không giữ headers, query hoặc body.

## 12. WebSocket và streaming authentication

Proxy auth ngay HTTP Upgrade trước `handleUpgrade`, sau đó mở upstream WebSocket với backend header và internal Origin. Outer ASGI middleware dùng cùng policy cho `scope.type == "websocket"` và đóng 4401/4403 trước app khi sai. Fake echo test chứng minh authorized relay; cả direct backend và proxy upgrade thiếu credential đều bị 401.

HTTP response/request dùng stream pipe/Transform, không buffer toàn file trong proxy. SSE/chunked streaming, 2 MiB response, multipart và body limit đã test. Proxy giữ một queue nhỏ chỉ cho WebSocket frame gửi trong khoảng upstream handshake; production phải có byte/frame bound cụ thể.

## 13. Origin, Host, CSRF và loopback policy

- Bind cả backend và proxy đúng `127.0.0.1`; không dùng `localhost`, `::1`, `--listen` hoặc `--share`.
- Kiểm exact `Host` gồm port; alias/Host spoof trả 421.
- Browser Origin khác exact proxy origin bị 403 tại edge.
- Request thiếu Origin nhưng `Sec-Fetch-Site` là `cross-site` bị 403, bao phủ image/script-style request thường không có Origin.
- Proxy rewrite browser Origin thành fixed `http://forge-desktop.internal`; backend chỉ nhận Origin này hoặc không Origin từ main client.
- Auth áp cả safe GET và state-changing POST; CORS không được dùng làm boundary.
- Random port giảm collision/noise nhưng không phải secret; protected identity chống nối nhầm process.

Browser Private Network Access có thể thay đổi preflight/permission behavior giữa Chromium versions; policy không dựa vào nó. Explicit IP + exact Host tránh DNS rebinding qua `localhost` name. IPv6 bị từ chối có chủ đích cho baseline.

## 14. Readiness identity

Protected response:

```json
{
  "service": "forge-desktop-bridge",
  "protocolVersion": 1,
  "instanceId": "per-launch-random",
  "enginePid": 1234
}
```

Electron main biết expected instance ID từ lúc tạo bootstrap, gọi bằng backend credential và kiểm schema/version/instance. Renderer chỉ nhận engine state, không PID. Readiness xảy ra **sau** khi outer guard đã được cài; nếu bootstrap/guard fail, launcher adapter fail closed trước Forge launch.

## 15. Proxy behavior và giới hạn rewrite

Đã implement/test:

- HTTP/1.1 status/headers/body, request/response streaming;
- multipart, binary download, SSE/chunked response, moderate large response;
- WebSocket Upgrade/frame relay;
- hop-by-hop header removal;
- upstream Host rewrite, browser Origin rewrite;
- absolute `Location` từ backend origin sang proxy origin;
- preserve cookie path/flags và bỏ explicit backend `Domain`;
- timeout, body-size policy, client abort propagation và structured 502/504;
- bounded metadata-only logs.

Không rewrite HTML/JS/CSS body, absolute WebSocket URL hoặc CSP. Buffer/rewrite body sẽ phá streaming/compression và dễ làm hỏng extension. Real-Forge smoke kế tiếp đã xác nhận root HTML và local Gradio JS/CSS dùng relative URL hoạt động qua proxy ở runtime này; third-party extension và packaged Electron vẫn chưa được chứng minh. Nếu extension hardcode backend origin, cần route-specific rewrite có test; không bật generic string replacement.

Prototype global request limit là 16 MiB mặc định và test override 4 MiB. Production phải có policy theo route/workflow để không chặn upload hợp lệ, đồng thời vẫn stream và enforce upper bounds. Response hiện không có global size cap vì download có thể lớn; main kiểm download destination/quota.

## 16. Extension compatibility

Proxy không allowlist route nên nested extension route đi qua nguyên dạng và được auth. Outer ASGI wrapper nằm ngoài router nên route đăng ký trước/sau đều được bảo vệ. Điều này tốt hơn dependency vào callback order.

Rủi ro còn lại:

- extension hardcode absolute backend URL/`localhost`;
- extension yêu cầu custom Origin, subprotocol, popup, permission hoặc external callback;
- extension tự mở listener/process khác ngoài Forge ASGI app;
- extension Python chạy trong Forge có thể đọc credential memory;
- UI reload có thể tạo app/Uvicorn lifecycle khác;
- proxy may chưa relay mọi unusual Upgrade/trailer/HTTP behavior.

Classic fallback không đồng nghĩa mọi extension được tin cậy hoặc tương thích tự động. Compatibility matrix phải chạy representative built-in/third-party routes mà không inference.

## 17. Integration với Rust Job Object helper

Lifecycle đề xuất:

```text
Electron main
  1. chọn backend port candidate + proxy port
  2. tạo edge/backend token + instanceId
  3. gửi launch request/secret frame qua private pipe tới Rust helper
Rust helper
  4. tạo Job + secret anonymous pipe
  5. create Python launcher adapter suspended, assign Job, resume
Python adapter
  6. đọc/đóng secret handle, cài ASGI/Uvicorn guard, chạy Forge launch.py
Electron main
  7. protected identity readiness
  8. mở proxy + Classic ephemeral session sau readiness
```

Helper sở hữu Forge tree; Electron main sở hữu proxy và Classic session. Helper chết → Job đóng → Forge/guard chết; main đóng proxy/session và quên token. Forge restart luôn credential mới. Renderer reload không làm engine secret rotate. Log child đi qua helper framed relay → main log service redaction; raw environment/header không được log.

Port vẫn có candidate TOCTOU race. Nếu process khác chiếm port, protected identity/auth không match; supervisor cleanup attempt và retry bounded. Backend không được coi ready chỉ vì TCP/HTTP 200.

## 18. Test architecture

Fake Forge là child Node độc lập, nhận bootstrap qua stdin pipe và mô phỏng:

- HTML/static/JSON/POST/multipart/download;
- chunked stream/SSE-like response, redirect, cookie, delayed/large/disconnect;
- WebSocket echo;
- extension-like nested route;
- request Host/Origin inspection, bounded unauthorized logs và argv inspection.

Node integration tests chạy proxy/client/fake child thật trên loopback. Python unit tests gọi pure ASGI middleware với synthetic HTTP/WebSocket scope và chứng minh Uvicorn Config nhận wrapped app trước construction. Không test GPU, Torch, model hay Forge dependency.

## 19. Test results

Kết quả validation gần nhất trong môi trường spike:

- TypeScript strict typecheck: pass;
- Node integration: 7 pass, 0 fail;
- Python ASGI: 4 pass, 0 fail;
- demo: protected identity đúng instance, Classic HTML 200, direct backend không credential 401;
- artifact secret scan: pass;
- clean full verification và final process/listener scan được ghi trong báo cáo task, không suy diễn từ đoạn này nếu command chưa chạy lại.

Một lần chạy đầu tiên bị treo ở WebSocket vì client có thể gửi frame sau edge handshake nhưng trước upstream handshake. Proxy đã được sửa bằng bounded-in-code pending handshake queue và test riêng/full suite sau đó pass. Production phải thêm byte bound cho queue này.

## 20. Security findings

1. Reverse proxy một mình không chống direct backend; outer guard bắt buộc.
2. `on_app_started` extension quá muộn để bảo vệ từ packet đầu; launcher adapter/pre-bind wrapper là seam phù hợp hơn ở HEAD này.
3. Anonymous inherited pipe giữ token khỏi argv/file/environment value tốt nhất trong ba transport đã đánh giá.
4. Studio renderer không cần localhost hoặc token; Classic dùng session capability do main inject.
5. CORS/random port/PNA không thay authentication; Host + Origin + token đều cần.
6. Gradio 4.40 chủ yếu dùng SSE cho queue; streaming correctness quan trọng ít nhất ngang WebSocket.
7. Identity contract phải gắn đúng `instanceId`, không chỉ status 200/path.
8. Proxy metadata log không được ghi raw URL query/header/body.

## 21. Limitations

- Forge/Gradio 4.40 thật đã pass bounded smoke với Uvicorn Config wrapper; packaged Electron và `webRequest` injection chưa được test.
- Không chứng minh absolute backend URL/CSP/root path của third-party extension qua proxy; root UI reload của runtime hiện tại đã pass real smoke.
- Representative user extension, upload Gradio và range download đã pass real smoke; built-in/third-party extension vẫn là unknown.
- Fake multipart backend buffer body để assert fixture; proxy vẫn stream. Đây không mô phỏng memory behavior của Gradio parser.
- Rust helper chưa implement inherited secret pipe/handle allowlist.
- Python launcher adapter executable entry chưa được tạo trong production runtime; spike chỉ có middleware/installer seam.
- Không test Chromium localStorage trực tiếp; HTML fixture không chứa storage/token và credential injection nằm ngoài page JS.
- Không test service worker, proxy auth với packaged Chromium, download manager hoặc permission handler.
- Không test endpoint-security/antivirus, clean Windows VM, x64/arm64 package hoặc signing.
- Local same-user debugger/memory reader nằm ngoài threat model.

## 22. Production decision và migration path

**Decision C — kết hợp middleware bảo vệ Forge backend và Electron proxy/session injection phục vụ Classic Forge.**

Security boundary:

- direct Forge: outer ASGI guard cài trước Uvicorn bind;
- Classic: edge auth tại Electron-owned proxy, sau đó backend auth;
- Studio: typed IPC → main-only Forge client → backend guard.

Failure behavior là fail closed: thiếu/invalid secret source, wrapper không cài được, identity sai, Host/Origin sai hoặc protocol version không khớp đều không công bố engine Ready. Không fallback tự động sang unauthenticated Forge. `--api-auth` không dùng production.

Migration không copy prototype nguyên xi:

- `desktop/packages/forge-client`: typed request, schema validation, protected identity/capability probe; không expose generic fetch cho renderer.
- `desktop/packages/process-supervisor`: generate/rotate credential, port retry, Job helper secret-frame contract, readiness/restart cleanup.
- `desktop/packages/local-bridge`: hardened streaming proxy, central Electron session header injector, navigation/permission/download policy, bounded logs.
- runtime thin adapter: audited ASGI middleware + pre-bind Uvicorn/Gradio integration, versioned cùng Forge/Gradio manifest; không chứa generation logic.

Bounded real-Forge smoke đã chứng minh wrapper nằm ngoài app từ first response quan sát được, Gradio SSE/upload/file/range/UI reload và representative extension route. Nó phát hiện Gradio self-call `/startup-events` cần scoped credential injection và identity 200 xuất hiện trước late routes. Gate còn lại là packaged Electron `webRequest` inject cả HTTP lẫn WebSocket mà page JS/storage không đọc token.

## 23. Proposed next task

Task kế tiếp duy nhất sau real-Forge smoke: **packaged-Electron Classic compatibility spike** với `WebContentsView`, ephemeral partition và request-header injection; không xây Studio UI production.

## References

- [Electron WebRequest](https://www.electronjs.org/docs/latest/api/web-request)
- [Electron Session](https://www.electronjs.org/docs/latest/api/session)
- [Electron Security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)
- [Gradio 4.40 routes source](https://github.com/gradio-app/gradio/blob/gradio%404.40.0/gradio/routes.py)
- [Starlette middleware](https://www.starlette.io/middleware/)
