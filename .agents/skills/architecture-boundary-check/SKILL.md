# Architecture boundary check

## Purpose
Confirm ownership and dependency direction before a cross-module change.

## When to use
Use for changes touching two or more of renderer, preload, main, packages, engine, or native code.

## When not to use
Skip for isolated copy, documentation, or styling changes that do not alter a contract.

## Required inputs
Behavior to change, affected paths, data ownership, security impact, and proposed dependencies.

## Procedure
1. Name the owning module and public contract.
2. Trace dependencies from renderer to adapters and reject reverse imports.
3. Identify lifecycle, errors, secrets, and trust boundaries.
4. List focused unit, integration, and smoke coverage.

## Expected output
A short boundary note with owner, contract location, dependency direction, forbidden dependency, and test plan.

## Quality gates
No renderer Node/localhost access; no credential/PID/port exposure; contracts are runtime validated; engine details stay behind adapters.

## Forbidden shortcuts
Generic IPC, shared mutable globals across layers, importing archive code, or moving product state into the engine adapter.
