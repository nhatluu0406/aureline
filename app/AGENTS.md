# Quy tắc cho Forge Desktop

- Giữ biên Electron main/preload/renderer rõ ràng; renderer không có Node, filesystem, process hoặc network credential.
- IPC phải domain-specific, typed và validate runtime; không expose generic channel/invoke/command execution.
- Không đưa secret, PID, backend port hoặc raw command vào renderer, log hay persisted settings.
- Không sửa Forge core; tích hợp qua package trong `app/` và adapter dưới `runtime/`.
- Chạy typecheck, unit/integration tests và Electron smoke phù hợp trước khi báo PASS.
- UI phải có hierarchy, focus state, empty/loading/error state có chủ đích; không để starter UI mặc định.
- Giữ dependency/package nhỏ và không copy nguyên xi prototype; chỉ chuyển contract/seam đã được chứng minh.
