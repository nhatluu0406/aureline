# Kiểm thử Aureline

## Quality gates

```powershell
npm run typecheck
npm test
npm run build
```

Unit/integration hiện kiểm tra contracts, settings atomic schema, runtime manifest/path resolution, error/log redaction, local bridge auth/streaming, launcher secret seam và Windows Job helper crash cleanup. Test helper tạo process fixture bằng exact path/PID, chứng minh kill-on-owner-exit không kill unrelated process.

## Electron smoke với Forge thật

```powershell
npm run smoke
```

Smoke dùng runtime no-model external được chọn qua `AURELINE_RUNTIME_MANIFEST`; không tải model và không generation. Nó:

1. mở Electron và điều hướng App Shell;
2. start Forge qua production Rust helper/adapter;
3. chờ protected identity + safe API route;
4. load Classic `WebContentsView`;
5. xác minh Gradio DOM, representative JS/CSS, storage không chứa bearer token;
6. gọi SSE và WebSocket route của controlled real extension;
7. reload Classic;
8. stop engine;
9. xác minh exact Python-owned listener ports đóng và không còn helper/Python.

Test extension nằm trong `tests/fixtures` và chỉ copy vào isolated smoke user-data. Built-in/third-party extensions không tham gia smoke.

## Packaged shell smoke

```powershell
npm run package:dir
npm run smoke:packaged
```

Gate mở `release/win-unpacked/aureline.exe` với temp user-data không có manifest, xác minh app hiển thị trạng thái runtime chưa cấu hình và Start bị disable. Gate cũng từ chối tên executable cũ, `.reference/` và `.env` trong output. Đây chưa phải clean-VM portable release test.

## Cleanup và security checks

Sau smoke, kiểm tra không còn command line chứa production `secure_launcher.py`, không còn `job-owner-helper.exe`, và các listener ports đã ghi nhận đều đóng. Secret không được scan bằng cách in giá trị; test kiểm tra absence trong URL, HTML/storage và log artifact đã redaction. Artifact scan phải loại `.env`, `.local`, runtime, node_modules, model và generated cache.
