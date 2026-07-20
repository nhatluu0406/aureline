# Chiến lược portable runtime

## 1. Mục tiêu và nguyên tắc

Artifact mục tiêu là portable ZIP cho Windows x64: giải nén và chạy, không yêu cầu người dùng cài Python, Git hoặc Node.js. Không bundle model. Shell, Forge runtime và user data có version/lifecycle độc lập.

“Portable” không có nghĩa single-file hoặc không bao giờ ghi disk. Nó có nghĩa mọi component bắt buộc nằm trong distribution và mọi write được định tuyến vào vùng writable đã biết, không phụ thuộc global installation/registry/PATH.

## 2. Distribution layout

```text
Aureline/
  aureline.exe
  app/
    current/                    # packaged Electron resources; replaceable
    versions/<shell-version>/   # optional staged/previous shell
  runtime/
    active.json                 # active + previous runtime IDs
    forge/<runtime-id>/
      manifest.json
      source/                   # pinned Forge source + built-in extensions
      python/                   # private CPython 3.10 runtime
      repositories/             # pinned repos required by launch.py
      licenses/
  data/
    desktop/
      settings.json
      backups/
      state/
    forge/                      # --data-dir
      config.json
      ui-config.json
      styles.csv
      params.txt
      embeddings/
      extensions/
      config_states/
      tmp/
  models/                       # --models-dir; user-managed, no bundled model
  outputs/
  cache/
    huggingface/
    torch/
    desktop/
  logs/
    desktop/
    forge/
  staging/                      # update extraction; safe to clean when stopped
```

Tên directory thực tế có thể đổi sau prototype, nhưng boundary không đổi. Không đặt `models`, `outputs`, cache, logs hay settings dưới `app/` hoặc runtime version directory.

## 3. Ownership và lifecycle

| Thành phần | Mutable khi chạy? | Lifecycle | Update |
|---|---:|---|---|
| `aureline.exe`, `app/current` | Không | Shell release | Thay riêng shell |
| `runtime/forge/<id>/source` | Về nguyên tắc không | Forge runtime release | Cài side-by-side |
| `runtime/forge/<id>/python` | Không trong normal run | Python ABI + wheel set | Đi cùng runtime ID |
| `data/desktop` | Có | User profile | Migrate schema, backup |
| `data/forge` | Có | Forge settings/extensions | Giữ qua shell/runtime update |
| `models` | Có | User-owned, dung lượng lớn | Không update tự động |
| `outputs` | Có | User output | Không xóa khi rollback |
| `cache` | Có, có thể rebuild | Runtime/model cache | Clear chọn lọc theo user |
| `logs` | Có | Diagnostics | Rotation/retention |
| `staging` | Có, tạm thời | Update transaction | Clean khi xác nhận không active |

Forge hiện còn ghi một số path theo `script_path`: `tmp/restart`, Gradio theme cache và `config_states`. Trước khi đánh dấu runtime read-only phải chạy write-audit prototype. Ưu tiên env/CLI/path junction hoặc runtime work-copy nhỏ; không patch rộng Forge core. Nếu không thể chuyển hết write, runtime active được coi **replaceable and integrity-monitored**, không tuyên bố immutable vật lý.

## 4. Path mapping khi spawn

Supervisor dùng absolute canonical paths và argument array:

```text
<runtime>/python/python.exe
  <runtime>/source/launch.py
  --skip-prepare-environment
  --skip-install
  --api
  --server-name 127.0.0.1
  --port <dynamic-port>
  --data-dir <portable-root>/data/forge
  --models-dir <portable-root>/models
  --no-download-sd-model
```

`cwd` là `<runtime>/source` vì code hiện có nhiều relative/script paths. Đặt các cache environment variables rõ ràng: `HF_HOME`, `HF_*_CACHE`, `TORCH_HOME` và cache app nếu dependency hỗ trợ. Không kế thừa `PYTHONPATH`, `PYTHONHOME`, `COMMANDLINE_ARGS`, proxy/token hoặc env development không cần thiết; dùng allowlist env cộng các biến GPU cần giữ.

Desktop settings lưu path theo quy tắc:

- path trong portable root: lưu relative path chuẩn hóa;
- user chọn external model/output folder: lưu canonical absolute path và revalidate mỗi start;
- không tự resolve symlink/junction vượt boundary rồi ghi nếu chưa kiểm tra;
- hỗ trợ root có space và Unicode;
- không giả định drive letter không đổi cho path portable relative.

## 5. Python/runtime build strategy

### 5.1 Không bootstrap trên máy người dùng

`webui.bat` tạo venv và `prepare_environment()` chạy pip/Git. Đây là developer/bootstrap flow, không phải production portable flow. Release build phải:

1. checkout exact Forge commit;
2. lấy CPython 3.10 x64 từ nguồn pin/checksum;
3. materialize environment với exact Torch/CUDA variant và `requirements_versions.txt`;
4. materialize CLIP/OpenCLIP và ba pinned repositories mà launcher cần;
5. chạy import/startup smoke trong clean Windows runner;
6. tạo manifest file list, SHA-256, component versions, license/SBOM;
7. archive runtime version độc lập với Electron shell.

CPython embeddable ZIP không kèm pip và tài liệu Python không support dùng nó như regular pip-managed environment. Có thể dùng nó làm nền nếu build vendor tất cả package đúng cách và native DLL/import smoke pass; không mặc định giả định chỉ unzip + `get-pip.py` là production-ready. Phương án thực tế cần prototype so sánh:

- application-local full CPython layout đã được build machine cài rồi relocate/verify;
- embeddable CPython + fully vendored `Lib/site-packages` và launcher/path config;
- một distribution builder có provenance rõ, nếu license/security review chấp nhận.

Không đóng `venv` có absolute activation scripts rồi giả định relocatable. Runtime manifest phải pin Python ABI, Torch build, CUDA runtime pieces, Forge commit và bridge version.

### 5.2 Extension dependencies

Normal start luôn `--skip-install`. Classic extension code vẫn nằm ở `data/forge/extensions`, nhưng extension có `install.py` không tự được chạy.

Future controlled extension install mode:

1. dừng engine;
2. clone active runtime thành runtime candidate hoặc tạo dependency layer riêng đã được prototype;
3. chạy installer trong candidate với network/consent/log rõ;
4. smoke test;
5. activate candidate hoặc rollback.

Không để extension pip-mutate runtime known-good mà không snapshot. Đây là trade-off compatibility cần hiển thị rõ, không âm thầm hứa mọi extension hoạt động offline.

## 6. Build và packaging

Output release gồm hai archive có thể compose:

- shell package: Electron app/resources, contracts và launcher;
- Forge runtime package: Python + Forge source + dependencies + licenses.

Release assembler tạo portable ZIP hoàn chỉnh cho người dùng mới. Người dùng hiện hữu có thể chỉ tải shell hoặc runtime delta/package tương ứng. Dùng deterministic manifest và archive metadata khi khả thi.

Không dùng single EXE vì:

- Python/Torch/Electron/native DLL cần file layout thực;
- self-extraction tốn thời gian và disk mỗi launch;
- antivirus dễ nghi ngờ packed/self-modifying binary;
- update/rollback từng component kém;
- model tuyệt đối không phù hợp single-file.

`aureline.exe` vẫn là một entry dễ dùng trong root; tên sản phẩm hiển thị vẫn là `Aureline` và người dùng không cần thấy/cài Python.

## 7. First-run behavior

1. Xác định portable root từ executable path, không từ current working directory.
2. Kiểm tra root writable. Nếu nằm trong `Program Files` hoặc read-only location, báo rõ và cho chọn data root; không silently ghi VirtualStore/AppData rồi mất tính portable.
3. Verify shell/runtime manifests và chọn active runtime compatible.
4. Tạo `data`, `models`, `outputs`, `cache`, `logs` atomically nếu thiếu.
5. Migrate desktop settings với backup; không sửa Forge settings nếu không cần.
6. Detect GPU/driver và trình bày profile mặc định conservative; không chạy inference calibration tự động.
7. Nếu chưa có model, mở hướng dẫn/chọn model folder; không tự tải SD model.
8. Start engine offline bằng bundled runtime; kiểm tra readiness và capability.

Dev mode được xác định bởi build-time marker/env do script dev đặt cộng `app.isPackaged === false`. Portable production dùng manifest gần executable. Không suy ra dev chỉ vì directory có `.git`, và không để user environment tùy ý bật dev privileges.

## 8. Offline behavior

Normal startup/generation phải không cần Internet nếu model và runtime đã có. Disable các đường tự động:

- `prepare_environment`, pip, Git clone/update;
- extension update/install;
- model auto-download (`--no-download-sd-model`; các auxiliary model theo feature vẫn cần UX báo trước);
- Electron remote code/content.

Nếu workflow cần auxiliary model chưa có, trả lỗi/action rõ với size/source/license và chỉ download sau consent trong future downloader. Offline mode không được treo vô hạn chờ network.

## 9. Update shell, runtime và rollback

### Shell-only update

1. Download/copy package vào `staging`.
2. Verify signature, hash, channel và compatibility range.
3. Dừng engine/app helper.
4. Đổi pointer/directory atomically qua small bootstrapper hoặc apply lúc next launch.
5. Không chạm runtime/data/models/cache/output.

### Runtime update

1. Cài vào `runtime/forge/<new-id>` side-by-side.
2. Verify manifest/import/startup smoke và API contract bằng dynamic port.
3. Ghi `active.json.new`, fsync/atomic replace thành active, lưu previous ID.
4. Start mới; chỉ đánh dấu healthy sau readiness window.
5. Nếu fail, stop candidate, restore previous pointer và giữ diagnostic logs.

### Rollback

- rollback chỉ đổi active runtime pointer sau khi engine dừng;
- không downgrade/mutate model hoặc outputs;
- Forge `config.json` có thể thay schema: backup theo runtime activation và khai báo migration compatibility;
- giữ tối thiểu một known-good runtime; cleanup version cũ chỉ sau user/retention policy;
- runtime dirty bởi extension install không được coi known-good nếu chưa re-manifest/smoke.

Updater production chưa nằm trong scope hiện tại. Foundation chỉ cần manifest format, local activation và rollback semantics có test.

## 10. Antivirus, signing và integrity

- Code-sign `aureline.exe`, Electron executables/helpers và installer/bootstrapper nếu có; timestamp signature.
- Publish SHA-256 cho ZIP/runtime package và verify trước activation.
- Tránh packer/obfuscator/self-extract-on-every-run.
- Stable product/company metadata và predictable file layout giúp giảm false positive.
- Python/extension có khả năng thực thi code; cảnh báo trust boundary và không tự clone/run extension từ URL.
- Quarantine runtime candidate bị hash mismatch; không “repair” bằng download âm thầm.
- SBOM và `licenses/` phải gồm AGPL source offer/corresponding source, Python, Electron/Chromium/Node, wheels, bundled repos và built-in extension notices.

Code signing không biến extension/model pickle thành an toàn. Không bật `--disable-safe-unpickle` mặc định.

## 11. Path cần tránh ghi vào repository/runtime source

Không ghi user/runtime state vào:

- repository root trong development;
- `app`, packaged `resources/app.asar`;
- Forge core directories `backend/`, `modules/`, `modules_forge/`;
- runtime version source trừ các write legacy đã audit và cô lập;
- `.git`, `extensions-builtin`, committed assets;
- `%TEMP%` cho dữ liệu cần giữ hoặc secret lâu hơn process.

Dev scripts phải đặt data dưới `desktop/.local/` (được ignore khi scaffold) hoặc directory explicit ngoài repo, không tái sử dụng root `models/outputs/config.json` một cách ngầm định.

## 12. Acceptance gates cho portable prototype

- Chạy trên clean Windows VM không có Python/Git/Node và không Internet.
- Root có space/Unicode và nằm trên drive khác vẫn start.
- Không có network request trong normal no-model startup ngoài loopback.
- Mọi file write nằm trong allowlisted writable paths; report mọi exception.
- Shell-only update giữ nguyên runtime/data/model/output hashes.
- Runtime failure tự rollback về known-good.
- Unzip/copy sang path khác vẫn chạy với relative portable data.
- ZIP chứa license/SBOM/source instructions và không chứa model/secret/dev cache.

## References

- [Python embeddable package limitations](https://docs.python.org/3.10/using/windows.html#the-embeddable-package)
- [Electron application packaging](https://www.electronjs.org/docs/latest/tutorial/application-distribution)
- [Electron distribution và code signing](https://www.electronjs.org/docs/latest/tutorial/distribution-overview)

