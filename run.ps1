<#
.SYNOPSIS
    Stage-1 entry point for the fuaran-ts sibling — launch the reference demo.
.DESCRIPTION
    Per the workspace "Sibling launcher conventions" in ../CLAUDE.md, now that
    samples/demo ships (Phase 78) the root `run.ps1` is a thin pass-through to
    `dev-scripts/launch-demo.ps1 -WithUi`: it installs dependencies, builds the
    consumed `@fuaran-ui/*` packages, then serves the demo's Vite dev server on
    the workspace-reserved port 24030 and opens a browser tab.

    For the install / build / test pipeline without launching a UI, drive pnpm
    directly:
        pnpm install
        pnpm build
        pnpm test

.PARAMETER SkipInstall
    Skip `pnpm install` (forwarded to the launcher).

.PARAMETER SkipBuild
    Skip building the consumed packages (forwarded to the launcher).

.PARAMETER NoBrowser
    Serve the demo without opening a browser tab.

.EXAMPLE
    .\run.ps1
    Install + build + serve the demo + open a browser tab.

.EXAMPLE
    .\run.ps1 -SkipInstall -SkipBuild
    Serve immediately against an already-built workspace.
#>

[CmdletBinding()]
param(
    [switch] $SkipInstall,
    [switch] $SkipBuild,
    [switch] $NoBrowser
)

$ErrorActionPreference = 'Stop'

& "$PSScriptRoot\dev-scripts\launch-demo.ps1" `
    -WithUi:(-not $NoBrowser) `
    -SkipInstall:$SkipInstall `
    -SkipBuild:$SkipBuild
