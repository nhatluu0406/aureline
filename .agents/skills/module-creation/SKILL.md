# Module creation

## Purpose
Prevent arbitrary packages and define a coherent module before adding it.

## When to use
Use when a behavior cannot clearly belong to an existing module.

## When not to use
Do not create a module for one private helper, naming symmetry, or a future capability without source.

## Required inputs
Purpose, public API, owned data, allowed dependencies, lifecycle, error model, and tests.

## Procedure
Compare existing owners, document why none fit, define the smallest public API, keep internals private, add contract and lifecycle tests, then update architecture docs only if the boundary is durable.

## Expected output
A small module with a single owner, explicit public surface, and tests.

## Quality gates
No cycles, no generic utility bucket, stable errors, bounded resources, and a removal/migration path.

## Forbidden shortcuts
Empty folders, index re-export mazes, cross-layer state, duplicate contracts, or dependency injection frameworks without review.
