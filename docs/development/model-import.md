# Developing model imports

Module ownership is intentionally narrow:

- `packages/model-sources/civitai` owns provider URL/API validation and normalized metadata; it never writes files.
- `packages/download-manager` owns resumable transfer state, redirect policy, verification, and atomic install; it never imports React.
- `packages/model-library` owns managed roots, discovery/index caching, duplicates, and selected checkpoint records.
- `packages/credentials` owns write-only OS-protected Civitai credential storage.

Development model files, partials, indexes, credentials, and previews belong in Electron user-data, never repository source or packaged resources. Use public HTTPS API endpoints rather than HTML scraping. Never place a real Civitai API key in `.env`, commands, fixtures, snapshots, or logs.

Supported link shapes are `https://civitai.com/models/<id>`, the same link with a slug or `modelVersionId`, equivalent `civitai.red` links, and the provider `/api/download/models/<id>` shape. Exact hosts are required; HTTP, ports, credentials, fragments, IP literals, lookalikes, and unrelated query parameters fail before a request.
