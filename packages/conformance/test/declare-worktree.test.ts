// ============================================================================
//  Phase 1802 — the declare step names the REPOSITORY, from a worktree too.
//
//  `sync-corpus.mjs --declare` writes this host's records into the corpus's
//  copies.json, addressing each copy by its workspace-relative path. It used to
//  derive that path from the snapshot's absolute location, so a run from a git
//  worktree declared the WORKTREE as the estate copy and exited 0. These tests
//  build a throwaway estate in a temp directory — a fake repository in the
//  canonical side-by-side layout, a corpus beside it, and a worktree cut from
//  the repository — and run the real script (copied in) from both checkouts.
//
//  Hermetic on purpose: it never touches this repository's worktree list or the
//  workspace corpus's copies.json, so it runs the same in CI as on a machine.
//  The worktree it adds is removed (`git worktree remove --force`) even when an
//  assertion fails.
// ============================================================================

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'sync-corpus.mjs');
const SCRIPT_IN_REPO = join('packages', 'conformance', 'scripts', 'sync-corpus.mjs');
const EXPECTED_PREFIX = 'Fuaran/Fuaran-UI/fuaran-ts/packages/conformance/corpus';

/** The ambient environment minus anything that would steer git or the script
 *  away from the directories a test names. */
const baseEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_') || key === 'FUARAN_WIRE_FIXTURES') delete env[key];
  return env;
};

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync(
    'git',
    [
      '-c',
      'user.name=probe',
      '-c',
      'user.email=probe@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', env: baseEnv() },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.stderr}`);
  return r.stdout.trim();
};

/** Run the copied script from a checkout, with the corpus root named explicitly. */
const run = (checkout: string, corpus: string | undefined, ...args: string[]) => {
  const env = baseEnv();
  if (corpus !== undefined) env['FUARAN_WIRE_FIXTURES'] = corpus;
  return spawnSync(process.execPath, [join(checkout, SCRIPT_IN_REPO), ...args], {
    cwd: checkout,
    encoding: 'utf8',
    env,
  });
};

/** A minimal corpus: a manifest naming one fixture, the schema, and a copies.json
 *  carrying a record another producer owns (which a declare must leave alone). */
const writeCorpus = (root: string) => {
  mkdirSync(join(root, 'nodes'), { recursive: true });
  writeFileSync(
    join(root, 'manifest.json'),
    `${JSON.stringify({ fixtures: [{ input: 'nodes/a.json' }] })}\n`,
  );
  writeFileSync(join(root, 'schema.json'), '{}\n');
  writeFileSync(join(root, 'nodes', 'a.json'), '{"kind":"Text"}\n');
  writeFileSync(
    join(root, 'copies.json'),
    `${JSON.stringify(
      {
        kind: 'copies',
        producer: 'wire-format-fixtures',
        note: 'probe',
        records: [
          {
            source: 'schema.json',
            consumers: ['Fuaran/Fuaran-UI/other-host/schema.json'],
            check: 'fingerprint',
            regen: 'elsewhere',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
};

/** A fresh repository holding only the script, committed. */
const makeRepo = (root: string) => {
  mkdirSync(join(root, dirname(SCRIPT_IN_REPO)), { recursive: true });
  copyFileSync(script, join(root, SCRIPT_IN_REPO));
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'probe');
};

let tmp = '';
let ui = '';
let repo = '';
let worktree = '';

beforeAll(() => {
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'fuaran-declare-')));
  ui = join(tmp, 'ws', 'Fuaran', 'Fuaran-UI');
  repo = join(ui, 'fuaran-ts');
  worktree = join(ui, 'wt-probe');
  writeCorpus(join(ui, 'wire-format-fixtures'));
  makeRepo(repo);
  git(repo, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
});

afterAll(() => {
  try {
    if (existsSync(worktree)) git(repo, 'worktree', 'remove', '--force', worktree);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

describe('sync-corpus --declare names the repository, not the checkout', () => {
  it('writes byte-identical records from a worktree and from the full checkout', () => {
    const fromCheckout = join(tmp, 'corpus-checkout');
    const fromWorktree = join(tmp, 'corpus-worktree');
    writeCorpus(fromCheckout);
    writeCorpus(fromWorktree);

    const a = run(repo, fromCheckout, '--declare');
    expect(a.status, a.stderr).toBe(0);
    const b = run(worktree, fromWorktree, '--declare');
    expect(b.status, b.stderr).toBe(0);

    const checkoutBytes = readFileSync(join(fromCheckout, 'copies.json'), 'utf8');
    const worktreeBytes = readFileSync(join(fromWorktree, 'copies.json'), 'utf8');
    expect(worktreeBytes).toBe(checkoutBytes);

    const consumers = (JSON.parse(worktreeBytes).records as { consumers: string[] }[]).flatMap(
      (r) => r.consumers,
    );
    expect(consumers).toContain(`${EXPECTED_PREFIX}/nodes/a.json`);
    expect(consumers).toContain('Fuaran/Fuaran-UI/other-host/schema.json');
    expect(consumers.filter((c) => c.includes('wt-probe'))).toEqual([]);
  });

  it('syncs the worktree snapshot from the corpus FUARAN_WIRE_FIXTURES names', () => {
    const own = join(tmp, 'corpus-own');
    writeCorpus(own);
    writeFileSync(join(own, 'nodes', 'a.json'), '{"kind":"Own"}\n');
    const r = run(worktree, own);
    expect(r.status, r.stderr).toBe(0);
    const synced = join(worktree, 'packages', 'conformance', 'corpus', 'nodes', 'a.json');
    expect(readFileSync(synced, 'utf8')).toBe('{"kind":"Own"}\n');
  });
});

describe('sync-corpus refuses what it cannot establish', () => {
  it('refuses a FUARAN_WIRE_FIXTURES that names no corpus, before touching the snapshot', () => {
    const snapshot = join(worktree, 'packages', 'conformance', 'corpus');
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, 'keep.txt'), 'untouched\n');
    const bad = join(tmp, 'not-a-corpus');
    mkdirSync(bad, { recursive: true });

    for (const args of [[], ['--declare'], ['--check']]) {
      const r = run(worktree, bad, ...args);
      expect(r.status, `args ${JSON.stringify(args)}`).toBe(1);
      expect(r.stderr).toMatch(/FUARAN_WIRE_FIXTURES=.*does not name a conformance corpus/);
    }
    expect(readFileSync(join(snapshot, 'keep.txt'), 'utf8')).toBe('untouched\n');
  });

  it('refuses, non-zero, when git cannot name the repository', () => {
    const loose = join(tmp, 'loose');
    mkdirSync(join(loose, dirname(SCRIPT_IN_REPO)), { recursive: true });
    copyFileSync(script, join(loose, SCRIPT_IN_REPO));
    const corpus = join(tmp, 'corpus-loose');
    writeCorpus(corpus);
    const before = readFileSync(join(corpus, 'copies.json'), 'utf8');

    const r = run(loose, corpus, '--declare');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Cannot declare: git cannot name the repository/);
    expect(readFileSync(join(corpus, 'copies.json'), 'utf8')).toBe(before);
  });

  it('refuses, non-zero, when the primary checkout is outside the canonical layout', () => {
    const stray = join(tmp, 'stray', 'fuaran-ts');
    makeRepo(stray);
    const corpus = join(tmp, 'corpus-stray');
    writeCorpus(corpus);
    const before = readFileSync(join(corpus, 'copies.json'), 'utf8');

    const r = run(stray, corpus, '--declare');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not sit in the canonical side-by-side layout/);
    expect(readFileSync(join(corpus, 'copies.json'), 'utf8')).toBe(before);
  });
});

// The copy used above must be the script under test, not a stale one.
it('copies the current script into the probe checkouts', () => {
  expect(readFileSync(join(repo, SCRIPT_IN_REPO), 'utf8')).toBe(readFileSync(script, 'utf8'));
});
