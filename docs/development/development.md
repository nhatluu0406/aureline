# Phát triển Aureline

## Cài đặt và chạy dev

Yêu cầu build machine: Windows x64, Node 24-compatible toolchain, npm và Rust `rustc`. Người dùng release tương lai không cần các tool này.

```powershell
npm install
npm run build:helper
npm run dev
```

Dependency được pin trong `package-lock.json`; không cài global. `npm run dev` build main/preload/helper, chạy Vite trên `127.0.0.1:5173` và mở Electron. Không dùng `--listen` hoặc `--share`.

## Build và package

```powershell
npm run typecheck
npm test
npm run build
npm run package:dir
```

Output:

- `dist/renderer`: Vite renderer;
- `dist/electron`: bundled main/preload;
- `native/job-owner/bin`: generated Rust helper, ignored;
- `release/win-unpacked`: packaged shell, ignored.

Helper và launcher adapter được đặt ngoài ASAR qua `extraResources`. Build release phải prebuild/sign helper; máy người dùng không cần Rust. Package hiện không chứa Python runtime hoặc model.

## Runtime manifest

Schema bắt buộc:

```json
{
  "schemaVersion": 1,
  "runtimeId": "forge-runtime-id",
  "platform": "win32",
  "architecture": "x64",
  "pythonExecutable": "relative-or-absolute/python.exe",
  "forgeRoot": "relative-or-absolute/forge",
  "launcherAdapter": "engine/adapter/secure_launcher.py",
  "helperExecutable": "native/job-owner/bin/job-owner-helper.exe",
  "forgeCommit": "optional-sha"
}
```

Dev dùng `engine/manifests/runtime-manifest.example.json`; packaged app tìm `%APPDATA%/Aureline/runtime-manifest.json`. Relative path resolve theo directory chứa manifest. Main validate schema/path; renderer chỉ nhận summary không có executable, PID, port hoặc token. Đặt `AURELINE_RUNTIME_MANIFEST` để dùng manifest local/untracked khi Forge nằm ngoài repository.

## Cấu trúc

- `app/main`: lifecycle, IPC, window và Classic view policy.
- `app/preload`: API domain-specific duy nhất.
- `app/renderer`: React app shell và design tokens.
- `packages/contracts`: runtime-validated IPC models/error codes.
- `packages/process-supervisor`: state/lifecycle, Job helper client, logs.
- `packages/local-bridge`: streaming HTTP/WebSocket proxy.
- `packages/runtime-manifest`, `packages/settings`: validated storage.
- `engine/adapter`: pre-bind ASGI guard.
- `native/job-owner`: Rust source và generated binary.

## Runtime selection và writable paths

Không hardcode path máy cá nhân trong source. Không ghi data vào Forge root hoặc ASAR. Engine dùng Electron user-data cho config/extensions/models/outputs; runtime Python/Forge chỉ được tham chiếu qua manifest. App không tự tải runtime khi startup.

## Local Forge reference tùy chọn

Developer chỉ làm UI không cần checkout Forge. Khi cần đọc seam upstream hoặc chuẩn bị real no-model smoke, clone nguồn chính thức vào folder local đã ignore:

```powershell
git clone https://github.com/lllyasviel/stable-diffusion-webui-forge.git .reference/stable-diffusion-webui-forge
```

Không sửa, import, package hay dùng checkout này làm runtime production. Real smoke phải nhận Forge root qua `AURELINE_RUNTIME_MANIFEST` trỏ tới manifest local không track, hoặc qua test parameter explicit. Runtime production vẫn pin commit/version/checksum và materialize riêng bằng manifest/tooling dưới `engine/`; không commit absolute local path.
