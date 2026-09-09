<#
.SYNOPSIS
    Stage-1 entry point for the fuaran-ts sibling — launch the reference demo.
.DESCRIPTION
    Per the workspace "Sibling launcher conventions" in ../CLAUDE.md, now that
    samples/demo ships (Phase 78) the root `run.ps1` is a thin pass-through to
    `dev-scripts/launch-demo.ps1 -WithUi`: it installs dependencies, builds the
    consumed `@fuaran-ui/*` packages, then serves the demo's Vite dev server on
    the workspace-reserved port 24030 and opens a browser tab.

    For the install / build / test pipeline without launching a UI — an
    automated gate, or a check before pushing — use `-Verify`, which delegates
    to `verify.ps1` and EXITS with the first failing stage's code. The default
    (no `-Verify`) serves a dev server and never returns, which is why an
    automated gate must never invoke this script bare.

.PARAMETER Verify
    Run the verify gate (`verify.ps1`) instead of launching the demo:
    install, format-check, build, typecheck, test, then exit.

.PARAMETER Lane
    Forwarded to `verify.ps1` when `-Verify` is given: `full` (default),
    `fast` (no install) or `pure` (format-check only).

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

.EXAMPLE
    .\run.ps1 -Verify
    Run the full verify gate and exit with its code. Launches nothing.
#>

[CmdletBinding()]
param(
    [switch] $Verify,

    [ValidateSet('full', 'fast', 'pure')]
    [string] $Lane = 'full',

    [switch] $SkipInstall,
    [switch] $SkipBuild,
    [switch] $NoBrowser
)

$ErrorActionPreference = 'Stop'

if ($Verify) {
    & "$PSScriptRoot\verify.ps1" -Lane $Lane -SkipInstall:$SkipInstall
    exit $LASTEXITCODE
}

& "$PSScriptRoot\dev-scripts\launch-demo.ps1" `
    -WithUi:(-not $NoBrowser) `
    -SkipInstall:$SkipInstall `
    -SkipBuild:$SkipBuild
