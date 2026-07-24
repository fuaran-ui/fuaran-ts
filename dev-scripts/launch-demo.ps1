<#
.SYNOPSIS
    Launch the Fuaran TypeScript reference demo (samples/demo).
.DESCRIPTION
    Ensures the workspace dependencies are installed and the consumed
    `@fuaran-ui/*` packages are built, then starts the demo's Vite dev server
    on the workspace-reserved port 24030 (per the workspace CLAUDE.md "Port
    allocation" table: fuaran-ts/samples/demo → Vite 24030–24039).

    Per the workspace "Sibling launcher conventions" in ../CLAUDE.md, every
    `pnpm` invocation routes through the `Invoke-Pnpm` named-helper wrapper to
    avoid the Node `pnpm.ps1` substring-slice argument-corruption bug. Never
    call `& pnpm` directly from a launcher.

.PARAMETER WithUi
    Open a browser tab at the dev-server URL once it is launching.

.PARAMETER SkipInstall
    Skip `pnpm install`. Use when node_modules is already in sync.

.PARAMETER SkipBuild
    Skip building the consumed packages. Use when packages/*/dist is current.

.EXAMPLE
    .\dev-scripts\launch-demo.ps1 -WithUi
    Install + build the packages + serve the demo + open a browser tab.
#>

[CmdletBinding()]
param(
    [switch] $WithUi,
    [switch] $SkipInstall,
    [switch] $SkipBuild
)

$ErrorActionPreference = 'Stop'

# Per workspace ../CLAUDE.md "Sibling launcher conventions": Node's *.ps1 shims
# have a substring-slice argument-corruption bug when invoked from inside
# another .ps1. Route every pnpm call through the .cmd binary via this wrapper.
function Invoke-Pnpm {
    # `Get-Command pnpm.cmd` returns EVERY pnpm.cmd on PATH — potentially several. `$cmd.Source`
    # would then be an array and `& $cmd.Source` concatenates the paths into one bogus string.
    # Pin to the first match (workspace CLAUDE.md "Sibling launcher conventions (mandate)").
    [CmdletBinding()]
    param([Parameter(ValueFromRemainingArguments = $true)] $Arguments)
    $cmd = Get-Command pnpm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1
    & $cmd.Source @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm exited with code ${LASTEXITCODE}: $($Arguments -join ' ')"
    }
}

$pnpm = Get-Command pnpm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pnpm) {
    Write-Error @"
pnpm was not found on PATH.

Install Node.js 22+ (https://nodejs.org/) and pnpm 9+ via:
    corepack enable
    corepack prepare pnpm@9 --activate

Then re-run this script.
"@
    exit 1
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$demoUrl = 'http://localhost:24030/'

Push-Location $repoRoot
try {
    if (-not $SkipInstall) {
        Write-Host "=== pnpm install ===" -ForegroundColor Cyan
        Invoke-Pnpm install
    }

    if (-not $SkipBuild) {
        Write-Host ""
        Write-Host "=== building @fuaran-ui/* packages (the demo consumes their dist) ===" -ForegroundColor Cyan
        Invoke-Pnpm -r --filter "./packages/*" run build
    }

    if ($WithUi) {
        # Vite blocks while serving, so open the browser just before launch.
        # strictPort means the server will hold 24030 or fail loudly.
        Write-Host ""
        Write-Host "Opening $demoUrl" -ForegroundColor Green
        Start-Process $demoUrl
    }

    Write-Host ""
    Write-Host "=== serving demo on $demoUrl (Ctrl+C to stop) ===" -ForegroundColor Cyan
    Invoke-Pnpm --filter "@fuaran-ui/demo" run dev
} finally {
    Pop-Location
}
