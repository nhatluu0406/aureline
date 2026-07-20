# Chiến lược VRAM safety orchestration

## 1. Scope

Lớp desktop giảm xác suất và tác động của CUDA OOM bằng telemetry, profile có version, preflight, queue mặc định một job, cảnh báo, recovery có giới hạn và calibration. Forge vẫn là engine duy nhất quyết định load/offload/model placement trong generation.

Mục tiêu là “safer defaults và recoverable failure”, không hứa loại bỏ mọi OOM. VRAM peak phụ thuộc model architecture, precision, resolution, batch, extensions, ControlNet/LoRA, VAE, allocator fragmentation, driver và phần mềm GPU khác.

## 2. Non-goals

- Không viết lại `backend/memory_management.py`.
- Không gọi private Python memory functions từ Electron.
- Không dự đoán VRAM chính xác chỉ từ width × height.
- Không tự đổi prompt/model/seed/sampler hoặc giảm chất lượng mà không báo.
- Không tự bật fp8, CPU offload, tiled VAE, cudaMallocAsync hay precision flags trên mọi GPU.
- Không chạy calibration inference nặng ở first run.
- Không hỗ trợ multi-job concurrent generation mặc định.
- Không coi external telemetry là quyền điều khiển Forge.

## 3. Phân chia trách nhiệm

### Forge đã làm

- detect device/backend và VRAM state;
- tính free/total memory và inference reserve;
- load/unload/offload model patchers;
- chọn GPU/CPU placement và dtype capability;
- empty CUDA cache, unload all models;
- serialize các major txt2img/img2img calls trên `modules_forge.main_thread`;
- expose `/sdapi/v1/memory`, interrupt, progress, unload/reload checkpoint;
- ghi CUDA allocator retries/OOM counters trong memory API.

### Desktop nên làm

- normalize telemetry và hiển thị source/confidence;
- giữ generation queue concurrency 1;
- resolve Safe/Balanced/Maximum/Custom profile thành startup flags và policy đã test;
- estimate risk từ calibrated envelopes, current free VRAM và request features;
- warn/block/require confirmation theo confidence;
- correlate OOM evidence với job;
- staged cleanup/restart và optional one-time retry;
- persist calibration theo GPU + Forge/runtime + model family + feature signature;
- log decision/recovery không chứa secret.

### Chưa đủ dữ liệu, không tự động hóa ngay

- threshold VRAM tuyệt đối cho từng model family;
- auto chọn fp8/bf16/fp16 và attention backend;
- tự bật `--always-low-vram`, `--always-no-vram`, `--always-offload-from-vram` chỉ dựa tổng VRAM;
- AMD/Intel/DirectML memory equivalence với CUDA stats;
- multi-GPU scheduling;
- retry bằng cách tự giảm resolution/batch/ControlNet;
- tự kill process chỉ vì một telemetry sample thấp.

## 4. Telemetry

### Sources

1. **Forge API:** `/sdapi/v1/memory` là authoritative cho Torch allocator của selected CUDA device: system free/used/total, allocated/reserved/active/inactive, allocation retries và OOM count.
2. **NVIDIA provider:** NVML hoặc `nvidia-smi` nếu đã có cùng driver, để lấy adapter identity và system-wide memory không phụ thuộc engine readiness. Không bundle/require CUDA toolkit chỉ cho telemetry.
3. **OS/future providers:** Intel/AMD/DirectML chỉ thêm khi có API ổn định và mapping device đã test.

Mỗi sample:

```ts
type GpuMemorySample = {
  timestamp: string;
  adapterId: string;
  source: "forge-cuda" | "nvml" | "nvidia-smi" | "os";
  totalBytes?: number;
  usedBytes?: number;
  freeBytes?: number;
  processUsedBytes?: number;
  torchAllocatedBytes?: number;
  torchReservedBytes?: number;
  torchInactiveBytes?: number;
  allocatorRetries?: number;
  oomCount?: number;
  confidence: "high" | "medium" | "low";
  error?: string;
};
```

Không cộng/trừ metric khác nghĩa. `torch reserved` không bằng total process VRAM; system used gồm process khác. Mapping adapter phải so index/UUID/name và selected Forge flags, không mặc định GPU 0.

Sampling đề xuất: idle 2–5 giây, active 0.5–1 giây, backoff khi API lỗi. UI không cần lưu mọi raw sample lâu dài; aggregate min free/max used quanh job và giữ bounded diagnostic window.

## 5. Profiles

Profile là versioned policy bundle, không phải một “VRAM mode” mới trong Forge.

| Profile | Mục tiêu | Queue | Margin | Startup policy ban đầu |
|---|---|---:|---|---|
| Safe | Ưu tiên hoàn tất và recovery | 1 | Cao, calibrated | Chỉ dùng Forge defaults hoặc conservative flag đã benchmark; cảnh báo sớm |
| Balanced | Default sau khi có calibration | 1 | Trung bình | Forge automatic memory management; không ép precision |
| Maximum | Tối đa throughput/quality trong envelope | 1 | Thấp hơn | Không đồng nghĩa `--always-high-vram`; yêu cầu calibration và cảnh báo |
| Custom | Expert-controlled | User chọn nhưng default 1 | User chọn | Validate conflicting flags; hiển thị unsupported/unsafe combinations |

Ở foundation chưa có benchmark, cả Safe và Balanced phải giữ Forge automatic defaults; khác nhau chủ yếu ở margin, mức cảnh báo, retry/restart policy. Không giả tạo mapping flag chưa đo.

Profile resolver output:

```ts
type ResolvedVramPolicy = {
  schemaVersion: number;
  profile: "safe" | "balanced" | "maximum" | "custom";
  forgeArgs: string[];
  safetyMarginBytes: number;
  queueConcurrency: 1;
  preflightAction: "allow" | "warn" | "block";
  retryPolicy: "never" | "once-after-restart";
  rationaleCodes: string[];
};
```

Argument resolver phải reject mutually exclusive groups từ `backend/args.py`. Startup-only flags chỉ đổi sau engine restart và UI phải nói rõ.

## 6. Generation preflight

### Input features

- runtime/Forge commit và active startup flags;
- GPU identity/driver/total/free/current competing usage;
- model family/checkpoint fingerprint nếu biết;
- width, height, batch size/count, steps;
- hires fix/upscale/refiner;
- img2img/inpaint và input dimensions;
- VAE/precision, ControlNet/IP-Adapter/extension signatures nếu API contract biết;
- calibrated peak distributions của request class gần nhất.

### Decision

```text
availableBudget = currentFree - safetyMargin - transientReserve
estimatedPeakDelta = calibratedP95(requestClass)
```

Chỉ dùng công thức khi calibration tương thích và đủ sample. Nếu không có envelope:

- static rule chỉ nhận diện cấu hình hiển nhiên rủi ro (batch/resolution/hires cùng tăng mạnh);
- trả `unknown`/warning, không bịa số GB;
- Safe có thể yêu cầu confirmation cho request ngoài observed envelope;
- block chỉ cho invariant chắc chắn hoặc policy enterprise/user đã cấu hình.

Preflight output có `decision`, `confidence`, `reasonCodes`, metric snapshot, estimate range và suggested user actions. Suggestion ưu tiên giảm batch/concurrency hoặc đóng app GPU khác; không âm thầm sửa request.

Preflight phải được tính lại ngay trước dequeue vì free VRAM có thể đổi trong lúc chờ.

## 7. Runtime monitoring

Job lifecycle:

```text
Queued → Preflight → Submitted → Running → Completed
                    └────────────→ Failed/OOM → Recovering → Retried/Failed
```

- Mỗi job có correlation ID và task ID của Forge nếu API hỗ trợ.
- Theo dõi progress API, process liveness, timeout theo phase và telemetry delta.
- Low free VRAM trong khi job chạy chỉ cảnh báo/ghi metric; không interrupt chỉ vì threshold.
- OOM evidence ưu tiên: API error có CUDA OOM, process stderr exception signature, `oomCount` tăng trong job window, process exit kèm OOM log.
- Regex log đơn lẻ có thể false positive; classifier lưu evidence list và confidence.
- UI phân biệt engine crash, request validation error, model load error và confirmed/probable OOM.

## 8. OOM recovery

Recovery có budget và idempotency:

1. Đánh dấu job `Failed/OOM`, ngừng dequeue job mới.
2. Gọi interrupt nếu engine còn responsive; chờ current operation kết thúc.
3. Gọi unload checkpoint API và poll memory/readiness trong bounded timeout.
4. Nếu allocator/OOM state không hồi phục hoặc API unresponsive, shutdown process tree theo supervisor policy.
5. Restart cùng runtime/profile known-good; readiness + contract probe.
6. Optional retry đúng một lần chỉ khi:
   - request operation được coi safe-to-repeat;
   - chưa có output side effect không xác định hoặc output naming chống duplicate;
   - user/profile cho phép;
   - recovery restart thành công;
   - policy có một thay đổi conservative đã được công bố/cho phép, hoặc mục đích retry chỉ là xóa fragmentation.
7. Nếu retry OOM/fail, mở circuit breaker; không loop.

Foundation nên mặc định **không auto retry** cho đến khi output idempotency được chứng minh. Có thể cho user bấm “restart engine and retry once” với request summary. Không dùng server restart marker; supervisor restart child process.

Cleanup không xóa outputs/cache/model. `torch_gc()` là internal Forge concern; desktop chỉ dùng public unload/interrupt rồi process restart.

## 9. Safety margin

Margin gồm:

- fixed OS/display reserve;
- tỷ lệ total VRAM nhỏ có floor/cap;
- observed non-Forge background variability;
- uncertainty penalty khi telemetry/model family không chắc;
- profile adjustment.

Không chốt con số production trong tài liệu này vì chưa benchmark. Initial prototype cho phép config lab-only và ghi raw rationale. Threshold chỉ promote vào default sau khi có dữ liệu nhiều GPU/model family và review ADR/benchmark report.

## 10. Calibration

Calibration ưu tiên passive learning từ job người dùng thành công, không tự chạy inference:

1. fingerprint environment và request class;
2. record pre/post/min-free/max-used, duration, outcome;
3. loại sample khi adapter mapping sai, telemetry gap, concurrent external spike quá lớn;
4. cần minimum sample count trước khi dùng estimate;
5. dùng percentile/range, không single average;
6. invalidate/downweight khi Forge/runtime/driver/profile/model family/extension signature đổi;
7. cho user reset/export diagnostics.

Active benchmark là skill/task lab riêng, opt-in, model do tester cung cấp, matrix giới hạn và không nằm trong app normal flow.

## 11. Persistence schema

```json
{
  "schemaVersion": 1,
  "profiles": {
    "selected": "safe",
    "custom": null
  },
  "calibrations": [
    {
      "key": {
        "adapterId": "provider-stable-id",
        "driver": "normalized-version",
        "forgeCommit": "git-sha",
        "runtimeId": "runtime-id",
        "modelFamily": "sdxl",
        "modelFingerprint": "optional-hash",
        "profileRevision": 1,
        "featureSignature": "normalized-signature"
      },
      "sampleCount": 0,
      "successCount": 0,
      "oomCount": 0,
      "peakDeltaBytesP50": null,
      "peakDeltaBytesP95": null,
      "lastUpdatedAt": "ISO-8601",
      "confidence": "low"
    }
  ],
  "recovery": {
    "autoRetryEnabled": false,
    "maxRetriesPerJob": 1,
    "maxEngineRestartsPerWindow": 2
  }
}
```

Không lưu prompt, image hoặc API credential trong calibration. Dùng bounded records/LRU và atomic settings store.

## 12. Logging và privacy

Structured event tối thiểu:

- engine/runtime/profile IDs;
- GPU normalized identity và telemetry source;
- request shape/features đã giảm nhạy cảm, không prompt;
- preflight decision/rationale/confidence;
- min free/max allocated/oom counter delta;
- recovery stages, timeout và final outcome.

Redact auth header, token, full command line và user path theo policy. Diagnostics export phải preview nội dung và cho user bỏ model/path metadata.

## 13. Limitations

- `/sdapi/v1/memory` chỉ có CUDA path và selected device; non-CUDA cần provider khác.
- VRAM fragmentation/driver reservation làm free memory biến động nhanh.
- Extension có thể allocate GPU ngoài contract và không khai báo feature.
- Model family detection từ filename không đáng tin; ưu tiên metadata/loader result.
- Process restart giải phóng VRAM của Forge nhưng không giải phóng process khác.
- OOM có thể để output partial hoặc extension state không idempotent.
- Forge API contract không version rõ ở HEAD; cần runtime pin + contract tests.

## 14. Test strategy

### Không cần GPU

- unit test profile resolution và conflicting flags;
- property/boundary tests cho bytes, missing/negative/stale telemetry;
- preflight với calibrated/unknown/outlier cases;
- OOM classifier từ sanitized log/API fixtures;
- recovery state machine, retry/circuit-breaker bằng fake Forge server;
- persistence migration, corruption backup và privacy/redaction.

### Lightweight integration

- fake child process/API thay đổi readiness/memory/OOM counter;
- process crash/timeout/port collision;
- unload/restart order và no duplicate retry;
- queue concurrency luôn là 1.

### GPU lab, opt-in

- matrix GPU VRAM tiers, driver, Forge runtime và model families;
- baseline/hires/batch/ControlNet cases với user-provided model;
- success peak, OOM detection, cleanup và restart VRAM release;
- compare profile quality/performance và false warn/block rate.

Không tuyên bố Safe/Balanced/Maximum production-ready cho đến khi GPU lab có sample và acceptance threshold được phê duyệt.

## 15. Acceptance criteria theo phase

Foundation đạt khi contracts/policy/recovery test bằng fixture, không cần inference. Telemetry đạt khi mapping selected GPU và metric semantics được chứng minh trên ít nhất một NVIDIA machine, đồng thời non-CUDA fail gracefully. VRAM safety production đạt khi benchmark matrix, false-positive budget, recovery idempotency và privacy review đều pass.

