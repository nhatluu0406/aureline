# IPC contract

## Purpose
Add or change a renderer-to-main capability safely.

## When to use
Use whenever preload or Electron IPC channels change.

## When not to use
Skip for main-internal or renderer-local state with no IPC boundary.

## Required inputs
Domain action, request/response schemas, error codes, subscription lifecycle, and caller UI states.

## Procedure
Define the domain contract in `packages/contracts`, add runtime validation in main and preload, expose one named preload method, serialize stable errors, clean up subscriptions, and test invalid inputs.

## Expected output
A typed capability that reveals no Electron primitives.

## Quality gates
Strict schemas, bounded payloads, stable errors, listener cleanup, and renderer tests for failure state.

## Forbidden shortcuts
Exposing `ipcRenderer`, generic `invoke`, arbitrary channel names/URLs/paths, or returning tokens, PID, ports, or raw commands.
