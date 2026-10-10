// ============================================================================
//  Phase 2204 — no leg finds the corpus for itself.
//
//  Every suite and script in this repository resolves the shared wire-format
//  corpus through `dev-scripts/corpus-root.mjs`, so one variable
//  (FUARAN_WIRE_FIXTURES) points all of them at an in-flight corpus. A leg that
//  spells the sibling path for itself reads the primary clone from a worktree
//  and certifies against the wrong oracle — silently. This guard scans every
//  tracked source file and fails, naming file and line, on any such spelling
//  outside the resolver.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The resolver itself — the one place allowed to name the sibling clone. */
const RESOLVER = 'dev-scripts/corpus-root.mjs';

/** This guard, whose allowlist and self-test necessarily spell the path. */
const SELF = 'packages/conformance/test/corpus-root-guard.test.ts';

/** Lines that name the directory without reading a corpus from it: the declare
 *  step's layout check of the PRIMARY checkout, the registry's producer field,
 *  and the throwaway estate the declare tests build. File → exact line text. */
const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  [
    'packages/conformance/scripts/sync-corpus.mjs',
    "if (!existsSync(join(dirname(checkout), 'wire-format-fixtures', 'manifest.json')))",
  ],
  ['packages/conformance/scripts/sync-corpus.mjs', "producer: 'wire-format-fixtures',"],
  ['packages/conformance/test/declare-worktree.test.ts', "producer: 'wire-format-fixtures',"],
  [
    'packages/conformance/test/declare-worktree.test.ts',
    "writeCorpus(join(ui, 'wire-format-fixtures'));",
  ],
];

/** A whole string literal that IS a corpus path: 'wire-format-fixtures',
 *  "../wire-format-fixtures/nodes" and the like — not prose that mentions one. */
const SPELLING = /['"`](?:\.\.\/)*wire-format-fixtures(?:\/[^'"`\s]*)?['"`]/;

const isComment = (line: string) => /^\s*(?:\/\/|\/?\*)/.test(line);

const trackedSources = (): string[] => {
  const r = spawnSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout
    .split('\0')
    .filter((f) => /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(f) && !f.includes('/dist/'));
};

describe('every corpus-reading leg resolves the corpus through dev-scripts/corpus-root.mjs', () => {
  it('scans a non-trivial set of tracked sources', () => {
    expect(trackedSources().length).toBeGreaterThan(200);
  });

  it('no tracked source spells the sibling corpus path for itself', () => {
    const offenders: string[] = [];
    for (const file of trackedSources()) {
      if (file === RESOLVER || file === SELF) continue;
      const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (isComment(line) || !SPELLING.test(line)) return;
        const text = line.trim();
        if (ALLOWED.some(([f, l]) => f === file && l === text)) return;
        offenders.push(`${file}:${i + 1}: ${text}`);
      });
    }
    expect(
      offenders,
      `resolve the corpus with wireCorpusRoot() from ${RESOLVER} instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('would catch a leg that spells the path (the guard is not vacuous)', () => {
    expect(
      SPELLING.test("join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'nodes')"),
    ).toBe(true);
    expect(SPELLING.test('"../wire-format-fixtures/manifest.json"')).toBe(true);
    expect(SPELLING.test('// the wire-format-fixtures corpus')).toBe(false);
    expect(SPELLING.test("'wire-format-fixtures/sanitization/manifest.json not found'")).toBe(
      false,
    );
  });
});
