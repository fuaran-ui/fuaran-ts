<#
.SYNOPSIS
    The fuaran-ts verify gate — install, format-check, build, typecheck, test, and EXIT.
.DESCRIPTION
    `run.ps1` is a Vite dev-server launcher: it serves the demo and never returns.
    That is the right shape for a human at a keyboard and the wrong shape for an
    automated gate, which must run to completion and hand back an exit code. This
    script is that gate.

    Stages, in order, each fatal:

      1. pnpm install --frozen-lockfile   (the lockfile is the contract; a gate that
                                           silently resolves a different tree is not
                                           gating the tree that is committed)
      2. pnpm format:check                (prettier, non-writing)
      3. pnpm build                       (every package, tool and template)
      4. pnpm typecheck
      5. pnpm test

    Build precedes test deliberately: the suites in this workspace import their
    siblings' built `dist/`, so testing against a half-built workspace fails every
    fixture at once and attributes the failure to the wrong package.

    Exit code is the first failing stage's, or 0.

    ONE PLACEMENT CONSTRAINT, and it is easy to trip. Some suites resolve a
    specification corpus as a SIBLING DIRECTORY of this repo — `packages/spec-hash`
    reads `../fuaran-model-execution-spec/wire-fixtures`, and fails rather than
    skipping when it is absent, on purpose: a conformance check that goes green
    without its oracle is worse than no check. So a clone or a git worktree placed
    somewhere those siblings are not is RED for a reason that has nothing to do
    with the code under test. Check the neighbours before debugging the failure.

.PARAMETER Lane
    Which stages to run.
      full  (default) — every stage above. The only lane a ship may cite.
      fast            — skip the install; format-check, build, typecheck, test.
                        For iterating against an already-installed workspace.
      pure            — format-check only. Nothing is compiled or executed.
    A partial lane is advisory: it is your own fail-fast, never gate evidence.

.PARAMETER SkipInstall
    Skip stage 1 without changing the declared lane. Prefer `-Lane fast`.

.EXAMPLE
    pwsh ./verify.ps1
    The full lane. This is what CI and an automated gate run.

.EXAMPLE
    pwsh ./verify.ps1 -Lane fast
    Everything but the install, for a tight local loop.
#>

#Requires -Version 7.0

[CmdletBinding()]
param(
    [ValidateSet('full', 'fast', 'pure')]
    [string] $Lane = 'full',

    [switch] $SkipInstall
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Seed it. $LASTEXITCODE is $null until a native command runs, so a stage that is
# skipped compares $null, takes the success branch, and `exit $null` returns 0 —
# a green gate that built nothing and tested nothing. This one line is what makes
# every guard below honest.
$LASTEXITCODE = 0

# Sibling launcher conventions — the canonical helper body; do not diverge.
function Invoke-Pnpm {
    # Node 22.x ships a pnpm.ps1 shim that rebuilds args from the caller's command-line text via
    # Substring(InvocationName.Length). Called from inside another .ps1 as `& pnpm install ...`, the
    # slice eats the leading characters and pnpm sees a mangled command. Resolving pnpm.cmd directly
    # skips the shim.
    #
    # `Get-Command pnpm.cmd` returns EVERY pnpm.cmd on PATH — typically two (installer shim +
    # %APPDATA%\npm self-update shim). `$cmd.Source` would then be an array and `& $cmd.Source`
    # concatenates the paths into one bogus string. Pin to the first match — both shims behave alike.
    [CmdletBinding()]
    param([Parameter(ValueFromRemainingArguments = $true)] $Arguments)
    $cmd = Get-Command pnpm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1
    & $cmd.Source @Arguments
}

$script:StageNumber = 0

function Invoke-Stage {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [scriptblock] $Body
    )
    $script:StageNumber++
    Write-Host ''
    Write-Host "== [$script:StageNumber] $Name ==" -ForegroundColor Cyan
    & $Body
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host "FAILED: $Name (exit $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Write-Host "fuaran-ts verify - lane '$Lane'" -ForegroundColor Cyan

if ($Lane -eq 'full' -and -not $SkipInstall) {
    # `--config.confirm-modules-purge=false` is not tidiness. pnpm PROMPTS before
    # wiping a `node_modules` whose store links no longer resolve — which happens
    # whenever the checkout is relocated, or the store is shared from a different
    # path — and a gate has no one at the keyboard. The prompt is answered by
    # whatever arrives on stdin (nothing, or the next line of a script), and the
    # observed failure is not a hang: the install returns having removed the
    # modules and reinstalled nothing, so the NEXT stage fails with
    # `Cannot find module .../prettier/bin/prettier.cjs` and the gate reports a
    # formatting failure over a workspace that has no formatter in it.
    Invoke-Stage 'pnpm install --frozen-lockfile' {
        Invoke-Pnpm install --frozen-lockfile --config.confirm-modules-purge=false
    }
}
else {
    Write-Host "(install skipped - lane '$Lane')" -ForegroundColor DarkGray
}

Invoke-Stage 'pnpm format:check' { Invoke-Pnpm format:check }

if ($Lane -ne 'pure') {
    # Build BEFORE test: the suites import siblings' built dist/.
    Invoke-Stage 'pnpm build' { Invoke-Pnpm build }
    Invoke-Stage 'pnpm typecheck' { Invoke-Pnpm typecheck }
    Invoke-Stage 'pnpm test' { Invoke-Pnpm test }
}
else {
    Write-Host "(build / typecheck / test skipped - lane 'pure')" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host "verify: PASS (lane '$Lane')" -ForegroundColor Green
exit 0
