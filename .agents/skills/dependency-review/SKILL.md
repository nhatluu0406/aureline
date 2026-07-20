# Dependency review

## Purpose
Decide whether a new dependency is justified and safe to ship.

## When to use
Use before adding or materially upgrading npm, Python, Rust, native, or binary dependencies.

## When not to use
Skip when using an existing pinned dependency without changing its role.

## Required inputs
Capability gap, candidates, versions, licenses, install behavior, transitive tree, bundle/runtime impact, and alternative using built-ins.

## Procedure
Prove need, inspect maintenance and release health, license, install scripts, native code, transitive dependencies, security advisories, bundle impact, platform support, and removal path; then pin the chosen version.

## Expected output
A concise accept/reject record and lockfile change when accepted.

## Quality gates
Compatible license, no unexplained install script/binary, bounded size, current maintenance, reproducible pin, and focused tests.

## Forbidden shortcuts
Global installs, floating versions, large frameworks for one helper, unknown prebuilt binaries, or dependency additions without lockfile review.
