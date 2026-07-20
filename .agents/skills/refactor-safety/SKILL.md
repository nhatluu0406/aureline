# Refactor safety

## Purpose
Change structure while preserving behavior and reviewability.

## When to use
Use for moves, module extraction, dependency inversion, or removal of old paths.

## When not to use
Do not use to hide feature work inside a refactor.

## Required inputs
Current behavior, characterization tests, dependency inventory, target structure, rollback point, and removal criteria.

## Procedure
Capture behavior, inventory imports/runtime paths, make a move-only commit, make behavior fixes separately, run focused then full gates, prove old paths unused, and record rollback instructions.

## Expected output
Reviewable commits with preserved behavior and deletion evidence.

## Quality gates
Rename detection is clear, no stale paths, tests pass before and after, generated files remain ignored, and rollback is possible.

## Forbidden shortcuts
Mass formatting with moves, speculative cleanup, deleting before usage scans, or combining migration and feature behavior in one opaque commit.
