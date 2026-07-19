# Quy tắc làm việc trong repository

- Git HEAD và code hiện tại là source of truth; kiểm tra branch và `git status` trước mỗi task.
- Giữ nguyên mọi thay đổi không liên quan. Không push, merge hoặc tạo pull request nếu task không yêu cầu rõ.
- Không sửa Forge core (`backend/`, `modules/`, `modules_forge/`, entry point hiện có) nếu task chưa cho phép. Ưu tiên `desktop/`, extension mỏng hoặc adapter có biên rõ.
- Thiết kế để vẫn sync được upstream; tránh rename, format diện rộng và dependency xuyên vào Forge core.
- Không tải model, không chạy inference/benchmark nặng và không thay đổi generation behavior mặc định.
- Service do desktop quản lý chỉ được bind `127.0.0.1`; không bật `--listen`, `--share` hoặc expose LAN theo mặc định.
- Không log secret. Electron renderer không được bật Node integration hoặc truy cập trực tiếp filesystem/process; dùng preload API tối thiểu, typed và validate input.
- Chạy focused tests/checks tương xứng với thay đổi. Không tuyên bố PASS nếu chưa thực sự chạy kiểm tra đó.
- Báo cáo trung thực command đã chạy, kết quả, giới hạn môi trường và mọi unknown còn lại.

