# Trạng thái Aureline

## Milestone 1 đã làm được

Aureline hiện có production-oriented shell dưới `app/`: Electron main, preload typed, React renderer, Rust Job Object helper, Forge pre-bind adapter, authenticated loopback proxy và Classic Forge trong `WebContentsView`. App có Home, Studio placeholder, Classic Forge, Engine, Settings, light/dark/system theme, bounded live logs và start/stop/restart engine.

Vertical slice đã chạy trên Forge thật ở `--ui-debug-mode`, CPU-only và không model: Job helper tạo Python suspended, assign vào Job Object trước resume, truyền bootstrap credential qua anonymous pipe; adapter cài outer HTTP/WebSocket guard trước bind; main xác minh first protected response, launch identity và safe API capability trước Ready. Classic session tải DOM, JS/CSS, SSE, extension WebSocket và reload qua bridge.

## Chưa làm

- Chưa có Studio generation, model discovery/browser, downloader, updater, VRAM telemetry/calibration hoặc tray.
- Chưa bundle Python/Forge runtime 2.78 GB, model hay user data.
- Chưa có installer, release signing, production icon, update channel hoặc clean-Windows release certification.
- Chưa test inference/GPU và chưa tuyên bố compatibility với extension bên thứ ba.

## Chạy ứng dụng

```powershell
npm install
npm run dev
```

Development mặc định đọc `engine/manifests/runtime-manifest.example.json`. Nếu runtime external chưa materialize, UI hiển thị `RUNTIME_NOT_CONFIGURED`/`RUNTIME_INVALID` thay vì tự tải runtime. Có thể đặt `AURELINE_RUNTIME_MANIFEST` cho một manifest local; không dùng `.env` và không đưa path này vào renderer.

## Runtime requirement

Manifest schema version 1 phải trỏ tới Python 3.10, Forge root external, launcher adapter và helper executable hợp lệ. Runtime, data, models và outputs không nằm trong app ASAR. Runtime local thuộc `engine/.runtime/` hoặc một path ngoài repository và luôn bị ignore; engine data được tạo dưới Electron user-data.

## Known limitations

Gradio 4.40 ghi backend absolute origin vào HTML/JSON config. Local bridge hiện rewrite exact origin trong response cấu hình tối đa 2 MiB; SSE/upload/download không buffer. Isolated Classic session vẫn có exact-backend header injection như compatibility fallback, không expose credential cho JavaScript. Adapter pin seam Gradio 4.40.0 và fail closed khi seam đổi.

Packaged `win-unpacked` là shell package, chưa phải portable Forge distribution. Runtime manifest của package phải được materialize riêng tại user-data.

## Milestone tiếp theo

Studio Generation Foundation: model discovery, prompt workspace và typed txt2img request contract; không thay Forge generation pipeline.
