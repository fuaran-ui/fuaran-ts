// ============================================================================
//  Phase 2204 — the workspace-corpus legs honour FUARAN_WIRE_FIXTURES.
//
//  A cross-host change regenerates the corpus in a worktree, and this host must
//  certify against THAT corpus before the change merges. The legs that read the
//  authoritative workspace corpus (self-certification, author-direction) and
//  the sync script resolve it through the repository's one resolver,
//  `dev-scripts/corpus-root.mjs`: an explicit
//  argument, then FUARAN_WIRE_FIXTURES, then ../wire-format-fixtures — and a
//  named root holding no manifest.json is refused, never ignored.
//
//  The end-to-end half runs the real legs in a child vitest against a scratch
//  copy of the bundled snapshot with ONE fixture changed, so a leg that ignored
//  the variable would certify the unchanged sibling clone and pass.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  CORPUS_ROOT_ENV,
  wireCorpusRoot,
  resolveCorpusRoot,
  siblingCorpusRoot,
} from '../../../dev-scripts/corpus-root.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const bundled = join(packageRoot, 'corpus');

const scratch = mkdtempSync(join(tmpdir(), 'fuaran-ts-corpus-override-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A copy of the bundled snapshot with one node fixture's input re-spaced, so
 *  its re-encode no longer matches it byte for byte. Returns the fixture id. */
const alteredCorpus = (() => {
  const root = join(scratch, 'altered');
  cpSync(bundled, root, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
    fixtures: { id: string; kind: string; inputFile: string }[];
  };
  const fixture = manifest.fixtures.find((f) => f.kind === 'node-round-trip');
  if (fixture === undefined) throw new Error('the bundled snapshot holds no node fixture');
  const file = join(root, fixture.inputFile);
  writeFileSync(file, readFileSync(file, 'utf8').replace('{', '{ '));
  return { root, id: fixture.id };
})();

const noCorpus = join(scratch, 'not-a-corpus');
mkdirSync(noCorpus, { recursive: true });

describe('resolveCorpusRoot — explicit argument, then the variable, then the sibling', () => {
  it('falls back to the sibling clone when nothing is named', () => {
    expect(resolveCorpusRoot({ env: {} })).toEqual({
      root: siblingCorpusRoot(),
      source: 'sibling',
    });
  });

  it('treats an empty or whitespace-only variable as unset', () => {
    expect(resolveCorpusRoot({ env: { [CORPUS_ROOT_ENV]: '  ' } }).source).toBe('sibling');
  });

  it('honours the variable when it names a corpus', () => {
    expect(resolveCorpusRoot({ env: { [CORPUS_ROOT_ENV]: alteredCorpus.root } })).toEqual({
      root: resolve(alteredCorpus.root),
      source: 'env',
    });
  });

  it('prefers an explicit argument over the variable', () => {
    const r = resolveCorpusRoot({
      explicit: alteredCorpus.root,
      env: { [CORPUS_ROOT_ENV]: noCorpus },
    });
    expect(r).toEqual({ root: resolve(alteredCorpus.root), source: 'explicit' });
  });

  it('refuses a variable naming no corpus, naming the variable and the path', () => {
    expect(() => resolveCorpusRoot({ env: { [CORPUS_ROOT_ENV]: noCorpus } })).toThrow(
      new RegExp(`${CORPUS_ROOT_ENV}=.*does not name a conformance corpus`),
    );
    expect(() => wireCorpusRoot({ env: { [CORPUS_ROOT_ENV]: noCorpus } })).toThrow('not-a-corpus');
  });

  it('refuses an explicit argument naming no corpus', () => {
    expect(() => resolveCorpusRoot({ explicit: noCorpus, env: {} })).toThrow(
      /does not name a conformance corpus/,
    );
  });
});

// ─── The real legs, in a child run ──────────────────────────────────────────

const vitestCli = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);

/** Run the two workspace-corpus legs with FUARAN_WIRE_FIXTURES set to `corpus`. */
const runWorkspaceLegs = (corpus: string) => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith('VITEST') && k !== 'TEST' && k !== CORPUS_ROOT_ENV) env[k] = v;
  env[CORPUS_ROOT_ENV] = corpus;
  const r = spawnSync(
    process.execPath,
    [
      vitestCli,
      'run',
      'test/self-certification.test.ts',
      'test/author-direction.test.ts',
      '-t',
      'authoritative workspace corpus',
    ],
    { cwd: packageRoot, env, encoding: 'utf8', timeout: 180_000 },
  );
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
};

describe('the workspace-corpus legs certify against the corpus FUARAN_WIRE_FIXTURES names', () => {
  it('see the one fixture changed in the named corpus', () => {
    const r = runWorkspaceLegs(alteredCorpus.root);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain(alteredCorpus.id);
  }, 200_000);

  it('refuse a FUARAN_WIRE_FIXTURES that names no corpus, rather than certifying the sibling', () => {
    const r = runWorkspaceLegs(noCorpus);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toMatch(/FUARAN_WIRE_FIXTURES=.*does not name a conformance corpus/);
  }, 200_000);
});

describe('sync-corpus --check measures the corpus FUARAN_WIRE_FIXTURES names', () => {
  it('names the changed fixture as drift', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, [CORPUS_ROOT_ENV]: alteredCorpus.root };
    const r = spawnSync(
      process.execPath,
      [join(packageRoot, 'scripts', 'sync-corpus.mjs'), '--check'],
      {
        cwd: packageRoot,
        env,
        encoding: 'utf8',
      },
    );
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/nodes[\/]/);
  });
});
