// ============================================================================
//  Bundled-snapshot drift guard. The package ships a snapshot of the
//  authoritative wire-format corpus; this test fails the build if the snapshot
//  diverges from the authority (i.e. the corpus was regenerated without
//  re-running the sync).
//
//  It delegates to `scripts/sync-corpus.mjs --check` rather than reimplementing
//  the comparison, so the sync and the guard share ONE notion of what the
//  payload set is and cannot drift apart from each other — the failure mode
//  they exist to catch. The script's stderr names every missing, extra and
//  byte-drifted file, and is surfaced verbatim on failure.
//
//  Skipped outside the canonical workspace layout (e.g. a third party running
//  the published package's tests) — there the bundled snapshot IS the corpus.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const script = join(packageRoot, 'scripts', 'sync-corpus.mjs');
// The same corpus root the script resolves, through the same resolver: a
// FUARAN_WIRE_FIXTURES naming no corpus throws here rather than skipping.
const authority = wireCorpusRoot();

describe.skipIf(!existsSync(join(authority, 'manifest.json')))(
  'bundled corpus snapshot matches the authoritative workspace corpus',
  () => {
    it('is byte-identical to the authority (re-run sync-corpus on mismatch)', () => {
      const result = spawnSync(process.execPath, [script, '--check'], {
        encoding: 'utf8',
        cwd: packageRoot,
      });

      // On drift the script exits 1 having named every offending file; hand
      // that report to the reader instead of a bare status code.
      const report = (result.stderr || result.stdout || '').trim();
      expect(result.status, `sync-corpus --check said:\n${report}`).toBe(0);
    });
  },
);

// ============================================================================
//  `--check-distance --remote` (Phase 2238): the snapshot is measured against
//  the authority's REMOTE `main`, not the clone's HEAD. Three exit classes, kept
//  apart exactly as the local check keeps them apart:
//
//    0  the snapshot records the remote's `main`
//    2  the remote's `main` has moved past it (even when the clone has not)
//    1  the remote could not be asked
//
//  Every case runs against a temporary authority repository and a bare remote
//  on disk, never the network. The script is copied into a sandbox laid out
//  like this repository, so its `corpus/snapshot.json` is the test's to write.
// ============================================================================

describe('--check-distance --remote measures the authority remote, not the clone', () => {
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.test',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  const commit = (repo: string, note: string): string => {
    writeFileSync(join(repo, 'manifest.json'), JSON.stringify({ fixtures: [], note }));
    git(repo, 'add', 'manifest.json');
    git(repo, 'commit', '-q', '-m', note);
    git(repo, 'push', '-q', 'origin', 'HEAD:main');
    return git(repo, 'rev-parse', 'HEAD');
  };

  let root: string;
  let bare: string;
  let clone: string;
  let first: string;
  let second: string;

  /** Run the sandboxed script; `snapshotSha` is what the sandbox snapshot records. */
  const run = (snapshotSha: string, args: string[], env: Record<string, string> = {}) => {
    const sandbox = join(root, 'repo');
    const snapshotDir = join(sandbox, 'packages', 'conformance', 'corpus');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, 'snapshot.json'),
      `${JSON.stringify({ authorityCommit: snapshotSha, kind: 'corpusSnapshot' }, null, 2)}\n`,
    );
    const result = spawnSync(
      process.execPath,
      [join(sandbox, 'packages', 'conformance', 'scripts', 'sync-corpus.mjs'), ...args],
      {
        encoding: 'utf8',
        cwd: sandbox,
        env: { ...process.env, FUARAN_WIRE_FIXTURES: '', ...env },
      },
    );
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'corpus-remote-'));
    bare = join(root, 'authority.git');
    clone = join(root, 'authority-clone');
    git(root, 'init', '-q', '--bare', '--initial-branch=main', bare);
    git(root, 'clone', '-q', bare, clone);
    first = commit(clone, 'first');

    // A second clone moves the remote on; `clone` is never pulled, so it stays at `first`.
    const mover = join(root, 'mover');
    git(root, 'clone', '-q', bare, mover);
    second = commit(mover, 'second');

    mkdirSync(join(root, 'repo', 'dev-scripts'), { recursive: true });
    mkdirSync(join(root, 'repo', 'packages', 'conformance', 'scripts'), { recursive: true });
    copyFileSync(
      join(packageRoot, '..', '..', 'dev-scripts', 'corpus-root.mjs'),
      join(root, 'repo', 'dev-scripts', 'corpus-root.mjs'),
    );
    copyFileSync(
      script,
      join(root, 'repo', 'packages', 'conformance', 'scripts', 'sync-corpus.mjs'),
    );
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const asClone = () => ({ FUARAN_WIRE_FIXTURES: clone });

  it('the stale clone is the premise: the local check says in sync while the remote has moved', () => {
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(first);
    expect(run(first, ['--check-distance'], asClone()).status).toBe(0);
  });

  it('exits 2 when the remote main is past the snapshot, though the clone is not', () => {
    const { status, out } = run(first, ['--check-distance', '--remote'], asClone());
    expect(status, out).toBe(2);
    expect(out).toContain(second);
    expect(out).toContain('sync-corpus');
  });

  it('exits 0 when the snapshot records the remote main', () => {
    expect(run(second, ['--check-distance', '--remote'], asClone()).status).toBe(0);
  });

  it('needs no clone: with none beside the checkout it asks the specification URL', () => {
    // The published URL is rewritten onto the bare repository, so the no-clone path
    // is exercised without reaching the network.
    const rewrite = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${bare.split('\\').join('/')}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/fuaran-ui/fuaran-ui-specification.git',
    };
    expect(run(second, ['--check-distance', '--remote'], rewrite).status).toBe(0);
    const behind = run(first, ['--check-distance', '--remote'], rewrite);
    expect(behind.status, behind.out).toBe(2);
    expect(behind.out).toContain('unknown number of commits');
  });

  it('exits 1, not 2, when the remote cannot be asked', () => {
    const lonely = join(root, 'lonely');
    git(root, 'clone', '-q', bare, lonely);
    git(lonely, 'remote', 'set-url', 'origin', join(root, 'no-such-remote.git'));
    const { status, out } = run(first, ['--check-distance', '--remote'], {
      FUARAN_WIRE_FIXTURES: lonely,
    });
    expect(status, out).toBe(1);
    expect(out).toContain('UNMEASURED');
  });

  it('exits 1 when the snapshot records no authority commit', () => {
    expect(run('not-a-sha', ['--check-distance', '--remote'], asClone()).status).toBe(1);
  });

  it('refuses --remote without --check-distance', () => {
    expect(run(first, ['--check', '--remote'], asClone()).status).toBe(1);
  });
});
