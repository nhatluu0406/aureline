# UI quality gate

## Purpose
Review a Windows desktop surface before declaring it complete.

## When to use
Use for new pages, navigation, app-frame changes, or material component changes.

## When not to use
Skip for headless modules and invisible refactors.

## Required inputs
Target workflow, screenshots or running UI, supported states, resize range, theme and keyboard expectations.

## Procedure
Review hierarchy, typography, spacing, density, copy, empty/loading/error/success states, keyboard/focus, light/dark parity, resize, and truthful data. Exercise the running view at desktop sizes.

## Expected output
A prioritized finding list or a verified UI change with evidence.

## Quality gates
Clear primary action, no clipped content, visible focus, accessible labels, status not color-only, no starter-template feel, and no fake state.

## Forbidden shortcuts
Emoji product icons, decorative gradients everywhere, lorem ipsum, screenshot-only verification, or hiding missing behavior behind mock data.
