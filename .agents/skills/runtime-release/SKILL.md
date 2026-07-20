# Runtime release

## Purpose
Build and validate a versioned external Forge runtime for Aureline.

## When to use
Use for runtime materialization, update, rollback, or release packaging.

## When not to use
Do not use for normal shell builds, model distribution, or local ad-hoc virtual environments.

## Required inputs
Pinned Forge commit, Python/dependency pins, checksums, target architecture, source/notices inventory, manifest version, and clean-machine test plan.

## Procedure
Materialize in an isolated path, verify checksums, build the helper outside ASAR, exclude models and secrets, generate manifest/SBOM/notices/source information, package immutable runtime files, test offline on a clean Windows machine, and exercise rollback.

## Expected output
A versioned runtime artifact, manifest, checksums, license bundle, validation report, and rollback target.

## Quality gates
No `.env` or model, no global prerequisite, helper outside ASAR, loopback-only startup, protected readiness, clean shutdown, reproducible version, and third-party obligations included.

## Forbidden shortcuts
Downloading at app startup, unpinned Git HEAD, mutating active runtime in place, omitting source obligations, or calling a shell-only package portable.
