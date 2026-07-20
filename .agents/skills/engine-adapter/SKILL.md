# Engine adapter

## Purpose
Integrate a pinned third-party engine capability with minimal upstream coupling.

## When to use
Use for Forge startup seams, protected routes, compatibility probes, or runtime translation.

## When not to use
Do not use for product state, UI policy, process ownership, generation orchestration, or settings persistence.

## Required inputs
Pinned engine commit/version, inspected seam, fixture behavior, real-runtime acceptance criteria, and failure policy.

## Procedure
Inspect engine code first, prefer an external adapter over core edits, assert the compatibility seam, fail closed on drift, cover HTTP/WebSocket if relevant, then run fixture and real no-model smoke.

## Expected output
A thin adapter with explicit version assumptions and migration notes.

## Quality gates
No Forge core edit, no secret in argv/logs, loopback-only bind, pre-bind protection, protected identity, and a real-runtime result.

## Forbidden shortcuts
Monkey patches without assertions, public allowlists for sensitive self-calls, swallowing incompatibility, or copying Forge launcher code.
