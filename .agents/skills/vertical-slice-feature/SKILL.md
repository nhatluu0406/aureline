# Vertical slice feature

## Purpose
Deliver one user-visible behavior through existing architecture without horizontal scaffolding.

## When to use
Use for a bounded product feature that needs contract, main/application behavior, adapter work, and UI state.

## When not to use
Do not use for repository migration, pure refactor, or a large multi-feature milestone.

## Required inputs
User behavior, non-goals, acceptance criteria, failure/recovery states, and runtime dependencies.

## Procedure
Implement in order: behavior -> contract -> application service -> adapter -> UI state -> tests. Keep each layer independently testable and stop if the engine capability is unverified.

## Expected output
One working slice, focused tests, and concise documentation of limitations.

## Quality gates
Typed/runtime-validated boundary, explicit loading/error/success states, no leaked engine details, unit plus integration evidence.

## Forbidden shortcuts
UI calling localhost, speculative packages, fake success data, generic commands, or unrelated cleanup.
