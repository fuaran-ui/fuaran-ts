// ============================================================================
//  @fuaran-ui/validator — CLI core (pure, testable).
//
//  `runCli` parses args, walks the matched files, prints findings, and RETURNS
//  the exit code (it never calls `process.exit` — the `cli.ts` bin shim does
//  that). I/O goes through an injectable `io` sink so tests can capture
//  stdout/stderr instead of spawning a subprocess.
//
//    fuaran-validate <glob-or-file...> [--manifest PATH] [--project-dir DIR]
//                                      [--format plain|json] [--fail-on error|warning]
//
//  Exit codes (mirroring the F# Fuaran.UI.Validator):
//    0 — no findings at or above the --fail-on threshold (default: error)
//    1 — at least one finding at or above the threshold
//    2 — malformed CLI arguments / no files matched
// ============================================================================

import { globSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateProject } from './api.js';
import { renderFindingJson, renderFindingPlain, type Severity } from './findings.js';

export const USAGE =
  'usage: fuaran-validate <glob-or-file...> [--manifest PATH] [--project-dir DIR] [--format plain|json] [--fail-on error|warning]';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

interface ParsedArgs {
  readonly patterns: readonly string[];
  readonly manifestPath: string | undefined;
  readonly projectDir: string | undefined;
  readonly format: 'plain' | 'json';
  readonly failOn: Severity;
}

function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  const patterns: string[] = [];
  let manifestPath: string | undefined;
  let projectDir: string | undefined;
  let format: 'plain' | 'json' = 'plain';
  let failOn: Severity = 'error';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--manifest':
        manifestPath = argv[++i];
        if (manifestPath === undefined) return { error: '--manifest requires a path' };
        break;
      case '--project-dir':
        projectDir = argv[++i];
        if (projectDir === undefined) return { error: '--project-dir requires a path' };
        break;
      case '--format': {
        const v = argv[++i];
        if (v !== 'plain' && v !== 'json')
          return { error: `unknown --format value: ${v ?? '(missing)'} (expected plain|json)` };
        format = v;
        break;
      }
      case '--fail-on': {
        const v = argv[++i];
        if (v !== 'error' && v !== 'warning')
          return {
            error: `unknown --fail-on value: ${v ?? '(missing)'} (expected error|warning)`,
          };
        failOn = v;
        break;
      }
      default:
        if (arg.startsWith('--')) return { error: `unknown flag: ${arg}` };
        patterns.push(arg);
    }
  }

  if (patterns.length === 0) return { error: 'missing file/glob argument' };
  return { patterns, manifestPath, projectDir, format, failOn };
}

/** Expand the patterns to a de-duplicated, sorted list of `.ts` / `.tsx` files. */
export function resolveFiles(patterns: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const pattern of patterns) {
    let matched: string[];
    try {
      matched = globSync(pattern) as string[];
    } catch {
      matched = [];
    }
    // A literal path with no glob metacharacters that didn't match is treated
    // as a direct file (globSync returns [] for a bare existing file path on
    // some platforms).
    if (matched.length === 0 && !/[*?[\]{}]/.test(pattern)) matched = [pattern];
    for (const m of matched) {
      if (m.endsWith('.ts') || m.endsWith('.tsx')) seen.add(resolve(m));
    }
  }
  return [...seen].sort();
}

export function runCli(argv: readonly string[], io: CliIO): number {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    io.err(`error: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }

  const files = resolveFiles(parsed.patterns);
  if (files.length === 0) {
    io.err(`error: no .ts/.tsx files matched: ${parsed.patterns.join(' ')}\n`);
    return 2;
  }

  const result = validateProject({
    files,
    ...(parsed.projectDir !== undefined ? { projectDir: parsed.projectDir } : {}),
    ...(parsed.manifestPath !== undefined ? { manifestPath: parsed.manifestPath } : {}),
  });

  if (parsed.format === 'json') {
    io.out(`${JSON.stringify(result.findings.map(renderFindingJson), null, 2)}\n`);
  } else {
    for (const f of result.findings) io.out(`${renderFindingPlain(f)}\n`);
  }

  const errorCount = result.findings.filter((f) => f.severity === 'error').length;
  const warningCount = result.findings.length - errorCount;
  io.err(
    `fuaran-validate: ${result.filesWalked} file(s), ${errorCount} error(s), ${warningCount} warning(s), manifest=${result.manifestPath ?? '(none)'}\n`,
  );

  const failingCount = parsed.failOn === 'warning' ? result.findings.length : errorCount;
  return failingCount > 0 ? 1 : 0;
}
