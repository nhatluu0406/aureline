# Workflow Cursor + Codex

## 1. Mục tiêu

Workflow này cho phép Cursor và Codex giao task qua lại mà không cùng sửa một branch/worktree, giữ Git HEAD/code hiện tại là source of truth và ghi lại quyết định có thể review. Con người vẫn là người merge và chịu trách nhiệm release.

## 2. Phân vai mặc định

### Codex phù hợp hơn cho

- repository/code-path investigation và impact analysis;
- process supervisor, API client, contracts, settings/runtime/log services;
- tests, CI scripts, packaging validation, security/path audits;
- focused refactor có acceptance criteria rõ;
- review logic, failure modes và upstream conflict.

### Cursor phù hợp hơn cho

- React component composition và iteration trực tiếp trong editor;
- visual polish, responsive layout, accessibility pass;
- đối chiếu Figma/design tokens nếu có;
- sửa nhanh nhiều file UI khi developer đang quan sát preview;
- manual exploratory UX review.

Đây là default, không phải giới hạn năng lực. Một task chỉ có một implementation owner. Reviewer không commit trực tiếp vào branch của owner trừ khi task đã được handoff rõ.

## 3. Source-of-truth rules

1. Mỗi task bắt đầu bằng `git branch --show-current`, `git rev-parse HEAD`, `git status --short --branch` và đọc `AGENTS.md` áp dụng.
2. Code tại worktree/HEAD là truth; README, chat, issue và memory chỉ là context.
3. Không sửa/clean/stash changes không thuộc task.
4. Không tuyên bố path, flag, API hay test tồn tại nếu chưa kiểm code/command.
5. Không tuyên bố PASS cho test chưa chạy; ghi `not run` và lý do.
6. ADR thay đổi chỉ qua commit/tài liệu reviewable, không lưu quyết định quan trọng duy nhất trong chat.

## 4. Branch và worktree convention

Branch:

```text
desktop/<area>/<issue-or-task>-<slug>
```

Ví dụ:

```text
desktop/supervisor/012-readiness-probe
desktop/renderer/027-generation-form-shell
desktop/runtime/041-manifest-activation
docs/006-vram-adr
```

Mỗi agent có worktree riêng đặt cạnh repo hoặc trong root quản lý ngoài source, ví dụ:

```text
../worktrees/codex-012-readiness/
../worktrees/cursor-027-generation-form/
```

Quy tắc cứng:

- không cho hai agent cùng sửa một branch;
- không cho hai worktree checkout cùng branch;
- reviewer chỉ đọc/diff/test branch của owner;
- nếu reviewer cần sửa, owner nhận finding và sửa; hoặc handoff ownership bằng commit sạch, ghi rõ base/head, reviewer tạo branch mới;
- không dùng shared uncommitted working directory làm handoff;
- không rebase/force-push branch người khác khi chưa thỏa thuận;
- agent không push/merge theo mặc định; con người thực hiện integration.

## 5. Task lifecycle

```text
Backlog → Ready → Claimed → Implementing → Self-verified
        → Review → Findings/Fix → Approved → Human integration → Done
```

### Ready

Task nhỏ, có boundary, dependencies, acceptance criteria và verification level. Không bắt đầu nếu task ngầm yêu cầu sửa cả shell + runtime + Forge core.

### Claimed

Owner ghi agent, branch, worktree, base SHA và file ownership dự kiến. Kiểm status và bảo toàn unrelated changes.

### Implementing

Commit theo bước logic. Nếu phát hiện assumption sai hoặc cần sửa Forge core, dừng scope expansion, ghi evidence và yêu cầu decision.

### Self-verified

Chạy focused checks, review diff, xác nhận không secret/model/generated cache, và viết handoff.

### Review/fix

Reviewer phân loại finding; owner sửa trên cùng implementation branch bằng commit mới, không rewrite finding history trừ khi được yêu cầu squash khi integration.

## 6. Task template

```markdown
# <ID> — <Tên task>

## Outcome
Một kết quả quan sát được, không phải danh sách hoạt động.

## Baseline
- Base branch/SHA:
- Dependencies đã merge:
- AGENTS.md áp dụng:

## Owner và boundary
- Suggested owner: Cursor | Codex
- Allowed paths:
- Forbidden paths:
- Không nằm trong scope:

## Inputs/contracts
- API/type/design/runtime version:
- Fixtures/assets có sẵn:

## Acceptance criteria
- [ ] Điều kiện kiểm chứng 1
- [ ] Điều kiện kiểm chứng 2

## Required verification
- Command/check:
- Manual check:
- Verification level: static | unit | integration | packaged-smoke | GPU-lab

## Risks/unknowns
- ...

## Handoff output
- Files changed, decisions, commands/results, remaining risks.
```

Task không dùng câu “làm desktop app”. Mỗi task nên fit một review và có thể rollback độc lập.

## 7. Handoff template

```markdown
## Handoff <task ID>
- Owner/agent:
- Branch:
- Worktree:
- Base SHA:
- Head SHA:
- Outcome:
- Files changed:
- Contract/ADR changes:
- Commands run và exact results:
- Checks not run + reason:
- Known limitations/risks:
- Unrelated working-tree changes preserved:
- Reviewer focus:
- Suggested next action (một action):
```

Handoff không dùng “all tests pass” nếu chỉ chạy một test. Nếu chưa commit, task chưa sẵn sàng handoff giữa worktree.

## 8. Review loop

Priority:

- **P0:** security/data loss/process escape/release blocker;
- **P1:** correctness, contract break, crash/recovery, upstream conflict lớn;
- **P2:** maintainability/test/accessibility đáng kể;
- **P3:** polish hoặc suggestion không block.

Reviewer cung cấp file/line, reproduction/evidence, expected behavior và priority. Owner trả lời từng finding bằng `fixed <commit>`, `accepted-follow-up <task>` hoặc `disagree <evidence>`.

Không đóng review khi:

- P0/P1 chưa resolve;
- acceptance criterion chưa kiểm;
- generated artifact/lockfile đổi không giải thích;
- API/IPC contract đổi nhưng consumer/test/docs không cập nhật;
- diff chạm Forge core ngoài allowed paths.

## 9. Cursor review UI cho task Codex

Quy trình mẫu:

1. Codex implement logic/scaffold trên branch riêng, commit và handoff URL/path + run command.
2. Cursor checkout branch đó trong **review worktree chỉ đọc**, chạy preview và review layout, states, keyboard, accessibility, responsive behavior.
3. Cursor gửi findings có screenshot/viewport/reproduction, không sửa trực tiếp branch.
4. Codex sửa logic/implementation findings trên branch gốc, commit riêng và cập nhật mapping finding → commit.
5. Cursor re-review chỉ finding UI chưa đóng; Codex chạy lại automated checks.
6. Nếu cần visual redesign lớn, tạo task Cursor mới trên branch mới sau khi branch Codex đã integrated; không biến review thành parallel rewrite.

Ngược lại, khi Cursor implement UI, Codex review contracts, IPC boundary, error states, tests và packaging implications.

## 10. Commit discipline

- Một commit một intent reviewable; imperative subject có task ID khi có.
- Không commit `.env`, token, model, output, log, cache, packaged runtime hoặc local settings.
- Không mix format toàn repo với feature.
- Lockfile change phải do dependency/task yêu cầu và được giải thích.
- Không dùng `--no-verify` để né gate nếu chưa ghi lý do/approval.
- Không amend/rewrite commit đã handoff mà không báo reviewer.
- Commit message ví dụ:

```text
desktop(supervisor): add bounded readiness state machine
test(forge-client): cover incompatible memory payload
docs(desktop): record secure local auth unknown
```

## 11. Merge/integration rules

- Agent không push, merge hoặc tạo PR nếu task không cấp quyền rõ; mặc định chỉ chuẩn bị branch/commit local.
- Human integrator kiểm base drift, review approval và required gates.
- Ưu tiên fast-forward/rebase sạch theo project policy tại thời điểm integration; không merge changes chưa review từ branch khác.
- Khi conflict với upstream Forge, giữ upstream behavior và reapply desktop adapter; không chọn ours/theirs máy móc.
- Nếu task phải sửa Forge core, cần ADR/issue giải thích vì sao extension/adapter/CLI không đủ và có focused regression test.
- Sau integration, task tiếp theo luôn base trên HEAD mới, không branch từ branch cũ chưa merge.

## 12. Architecture decision records

ADR nằm trong `docs/`, tên có số khi có nhiều quyết định. ADR chứa Context, Decision, Alternatives, Consequences, Risks, Revisit conditions và baseline commit. Task làm thay đổi process boundary, security model, packaging lifecycle, bridge scope hoặc VRAM automation phải update/tạo ADR trước hoặc cùng implementation.

Implementation detail nhỏ ghi trong package README/design note gần code, không tạo ADR cho mọi class.

## 13. AGENTS.md strategy

Root `AGENTS.md` hiện đủ cho repository-wide safety. Khi bắt đầu scaffold:

- cập nhật root/app `AGENTS.md`: commands, package boundaries, quality gates và portable-path rule;
- nested `app/renderer/AGENTS.md` chỉ khi cần rule accessibility/design/test riêng;
- nested `app/main/AGENTS.md` chỉ khi cần IPC/security/process rule chi tiết;
- bridge extension có `AGENTS.md` riêng vì đây là boundary vào Forge, cấm generation logic/core patch;
- không tạo nested file chỉ lặp root rules.

## 14. Repository skills đề xuất

Skill phải là workflow hẹp, input/output xác định:

| Skill | Input | Output | Không làm |
|---|---|---|---|
| `upstream-sync-audit` | upstream ref, fork base/head | conflict map, changed contracts, recommended sync steps | Tự merge/push hoặc resolve toàn bộ |
| `forge-api-contract-check` | runtime/Forge SHA, endpoint allowlist | OpenAPI snapshot/diff, fixture và compatibility report | Sửa API/generation tự động |
| `desktop-quality-gate` | changed paths, verification level | exact lint/type/unit/integration commands + result manifest | Chạy GPU inference hoặc tuyên bố release-ready |
| `vram-benchmark-run` | approved GPU/model matrix, limits, output dir | anonymized samples/report, no threshold promotion | Tải model, đổi default profile, chạy không consent |
| `portable-release-assemble` | signed shell/runtime artifacts + manifests | staged ZIP, hashes, SBOM/license/check report | Publish/update user machine hoặc bundle model |

Mỗi skill cần `SKILL.md`, preconditions, safety/timeout, schema input/output và examples. Không tạo skill “build whole desktop app”. Skill chưa được tạo trong task khảo sát này.

## 15. Tool/MCP policy trong workflow

- Local Git/terminal là nguồn chính cho code/status/test.
- GitHub MCP chỉ đọc upstream PR/issue/commit khi task cần context; không merge mặc định.
- Playwright CLI tạo test versioned/CI; Playwright MCP dùng exploratory review khi có lợi.
- Figma MCP chỉ khi task có Figma file/node cụ thể.
- Không thêm filesystem/memory MCP khi repo + terminal + ADR đã đủ.
- Documentation tooling chỉ tra official current APIs và phải ghi link/version; code pinned vẫn quyết định behavior runtime.

## 16. Definition of done cho một task

- Outcome và acceptance criteria đạt.
- Diff chỉ chạm allowed paths, unrelated changes còn nguyên.
- Required checks thực sự chạy và exact result được ghi.
- Không secret/model/cache/output trong diff.
- Contract/docs/ADR cập nhật nếu behavior boundary đổi.
- Review P0/P1 resolved.
- Handoff có base/head và unknown trung thực.

