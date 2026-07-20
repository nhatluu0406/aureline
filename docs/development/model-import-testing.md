# Testing model imports

Focused tests cover Civitai URL attacks and response normalization, encrypted credential lifecycle, managed destination mapping/index caching/partial exclusion, bounded retry, Range resume, disk preflight, SHA-256 mismatch, duplicate refusal, and atomic installation. They use fixtures and never download a real model.

The packaged gate opens Models, exercises invalid-link recovery, then resolves and transfers one fixed 20-byte test-only checkpoint through the real downloader, verification, atomic install, library indexing, and Use in Studio flow. Its isolated user-data is deleted before exit. It also opens Civitai credential settings without saving a secret and returns to Studio. A bounded live smoke may fetch public metadata and headers only; it must time out, avoid real model bodies, and report `civitai.com` and `civitai.red` independently.

Run the focused suite with:

```powershell
npx vitest run tests/civitai-source.test.ts tests/credential-vault.test.ts tests/model-library.test.ts tests/download-manager.test.ts
```
