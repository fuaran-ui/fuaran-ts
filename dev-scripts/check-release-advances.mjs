#!/usr/bin/env node
// Release-advance check for the `@fuaran-ui/*` release set (Phase 2216).
//
// The publish workflow fires on a `v*` tag, packs every publishable package and
// SKIPS any version the registry already serves. That skip keeps re-runs
// idempotent, and it is also how a release leaves a package out without a
// word: a package whose sources moved since the last tag but whose `version`
// did not is simply not republished, so the registry keeps the stale copy and
// every sibling that did advance ships against it. The release prepared by
// Phase 2216 found eleven packages in exactly that state.
//
// ─── What it checks ─────────────────────────────────────────────────────────
//
// The base is the newest `v*` tag reachable from HEAD. Each package's version
// AT THAT TAG stands for the version that release published — the offline
// proxy for "a version the registry serves" (the registry itself is consulted
// at release time, by `check-peer-ranges.mjs` in the publish workflow). For
// every publishable package in `packages/*`, comparing the tag with the
// working tree:
//
//   * MOVED and NOT ADVANCED — its sources differ from the tag while its
//     version equals the tag's. This is the failure the check exists for.
//   * WENT BACKWARDS — its version is lower than the tag's. Also a failure: a
//     release cannot publish a version below one it already published.
//   * Otherwise it passes: unmoved (whatever its version), or moved with a
//     version above the tag's (a draft that later changes ride, per
//     STABILITY.md's versioning policy).
//
// A package that is absent at the tag, or private there, is new to the release
// set and passes. A private package is never published and is not judged
// itself — but a private workspace package a publishable one lists in
// `devDependencies` is BUNDLED into that package's `dist` (tsup `noExternal`),
// so its movement moves every package that bundles it. A defensive name-holding
// placeholder (a `-placeholder.N` version) is never re-released for a metadata
// change and is exempt.
//
// What counts as "sources moved" — every changed or untracked file under the
// package directory EXCEPT:
//
//   * tests: a `test/`, `tests/` or `__tests__/` directory, `*.test.*`,
//     `*.spec.*`, `vitest.config.*`, `tsconfig.test.json`;
//   * Markdown (`*.md`): documentation does not alter what a consumer
//     installs or runs;
//   * a `package.json` change confined to `version`, `scripts` and
//     `devDependencies` (a bundled private dependency is followed through the
//     rule above instead).
//
// Everything else counts, including a shipped data directory such as the
// conformance package's bundled `corpus/` — the rule is deliberately an
// exclusion list, so a build input added later is covered without editing it.
//
// ─── Modes ──────────────────────────────────────────────────────────────────
//
//   --self-test   Proves the classification and the verdict from fixed data,
//                 in BOTH directions, so the check cannot rot into always-green.
//   (default)     Reads the tag and the working tree with git; no network.
//
// A SHALLOW clone (CI's default checkout fetches no tags) cannot answer the
// question: the check says NOT CHECKED loudly, names the remedy (a full-history
// checkout, `fetch-depth: 0`) and exits 0. A full clone with no reachable `v*`
// tag is a failure, not a skip.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─── Versions ───────────────────────────────────────────────────────────────
//
// Self-contained rather than imported from `check-peer-ranges.mjs`, whose
// module body runs its registry lookup on import.

const parseVersion = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(v).trim(),
  );
  if (m === null) throw new Error(`unreadable version "${v}"`);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4]?.split('.') ?? [] };
};

/** Semver precedence: negative when `a` < `b`, 0 when equal, positive when `a` > `b`. */
export const compareVersions = (a, b) => {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
};

const isPlaceholder = (version) => /-placeholder(\.|$)/.test(String(version));

// ─── Classification ─────────────────────────────────────────────────────────

/** Whether `relPath` (relative to the package directory) is a source of what the package ships. */
export const isSourcePath = (relPath) => {
  const p = relPath.replace(/\\/g, '/');
  if (/(^|\/)(test|tests|__tests__)\//.test(p)) return false;
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (/\.(test|spec)\.[^/]+$/.test(base)) return false;
  if (/^vitest\.config\./.test(base) || base === 'tsconfig.test.json') return false;
  if (/\.md$/i.test(base)) return false;
  return true;
};

const MANIFEST_INERT_KEYS = ['version', 'scripts', 'devDependencies'];

const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(',')}}`
      : JSON.stringify(value);

/** Whether two manifests differ in anything beyond the keys that do not reach a consumer. */
export const manifestMoved = (base, head) => {
  const strip = (m) =>
    Object.fromEntries(Object.entries(m).filter(([k]) => !MANIFEST_INERT_KEYS.includes(k)));
  return canonical(strip(base)) !== canonical(strip(head));
};

// ─── The verdict, over data ─────────────────────────────────────────────────

/**
 * `packages`: [{ dir, head, base, changed }] — `head` the working-tree manifest,
 * `base` the manifest at the tag (or `null` when absent there), `changed` the
 * package-relative paths that differ from the tag (manifest included).
 *
 * Returns { violations, judged, exempt }.
 */
export const judgeSet = (packages) => {
  const own = new Map();
  for (const p of packages) {
    const reasons = p.changed.filter((f) => f !== 'package.json' && isSourcePath(f));
    if (p.base !== null && p.changed.includes('package.json') && manifestMoved(p.base, p.head)) {
      reasons.push('package.json');
    }
    own.set(p.head.name, reasons);
  }
  const privateNames = new Set(
    packages.filter((p) => p.head.private === true).map((p) => p.head.name),
  );

  const violations = [];
  const exempt = [];
  let judged = 0;
  for (const p of packages) {
    const { name, version } = p.head;
    if (p.head.private === true) continue;
    if (isPlaceholder(version)) {
      exempt.push(`${name}@${version} (placeholder)`);
      continue;
    }
    judged++;
    if (p.base === null || p.base.private === true) continue; // new to the release set
    const moved = [...own.get(name)];
    for (const dep of Object.keys(p.head.devDependencies ?? {})) {
      if (privateNames.has(dep) && own.get(dep).length > 0) moved.push(`bundles ${dep}`);
    }
    const order = compareVersions(version, p.base.version);
    if (order < 0) {
      violations.push(
        `${name}: ${version} is BELOW ${p.base.version}, the version the tag released — ` +
          `a release cannot publish a version below one it already published.`,
      );
    } else if (order === 0 && moved.length > 0) {
      const shown =
        moved.slice(0, 6).join(', ') + (moved.length > 6 ? `, … (${moved.length})` : '');
      violations.push(
        `${name}@${version}: sources moved since the tag (${shown}) but the version did not — ` +
          `the release would SKIP it. Advance it per STABILITY.md (pre-1.0: breaking or additive ` +
          `is a minor, a fix a patch) and record the change there.`,
      );
    }
  }
  return { violations, judged, exempt };
};

// ─── Reading git ────────────────────────────────────────────────────────────

const git = (...args) =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const workspaceDirs = () =>
  readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && existsSync(join(repoRoot, 'packages', e.name, 'package.json')),
    )
    .map((e) => e.name);

const readPackages = (tag) => {
  const listed = [
    ...git('diff', '--name-only', tag, '--', 'packages').split('\n'),
    ...git('ls-files', '--others', '--exclude-standard', '--', 'packages').split('\n'),
  ].filter((l) => l !== '');
  return workspaceDirs().map((dir) => {
    const prefix = `packages/${dir}/`;
    const atTag = tryGit('show', `${tag}:${prefix}package.json`);
    return {
      dir,
      head: readJson(join(repoRoot, 'packages', dir, 'package.json')),
      base: atTag === null ? null : JSON.parse(atTag),
      changed: listed.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length)),
    };
  });
};

// ─── Self-test (offline) ────────────────────────────────────────────────────

const selfTest = () => {
  const failures = [];
  const expect = (label, actual, wanted) => {
    if (actual !== wanted) failures.push(`${label}: got ${actual}, want ${wanted}`);
  };

  expect('0.12.3 < 0.12.4', compareVersions('0.12.3', '0.12.4') < 0, true);
  expect('0.13.0 > 0.12.9', compareVersions('0.13.0', '0.12.9') > 0, true);
  expect('1.0.0-rc.1 < 1.0.0', compareVersions('1.0.0-rc.1', '1.0.0') < 0, true);
  expect('rc.2 < rc.10', compareVersions('1.0.0-rc.2', '1.0.0-rc.10') < 0, true);
  expect('equal', compareVersions('0.30.0', '0.30.0'), 0);

  expect('src counts', isSourcePath('src/wire.ts'), true);
  expect('tsup config counts', isSourcePath('tsup.config.ts'), true);
  expect('bundled corpus counts', isSourcePath('corpus/nodes/form-1.json'), true);
  expect('test dir does not', isSourcePath('test/wire.test.ts'), false);
  expect('nested test dir does not', isSourcePath('src/__tests__/x.ts'), false);
  expect('spec file does not', isSourcePath('src/x.spec.ts'), false);
  expect('vitest config does not', isSourcePath('vitest.config.ts'), false);
  expect('test tsconfig does not', isSourcePath('tsconfig.test.json'), false);
  expect('README does not', isSourcePath('README.md'), false);

  const m = { name: '@x/a', version: '0.1.0', scripts: { test: 'a' }, sideEffects: false };
  expect(
    'scripts-only manifest change',
    manifestMoved(m, { ...m, version: '0.1.1', scripts: {} }),
    false,
  );
  expect(
    'devDependencies-only change',
    manifestMoved(m, { ...m, devDependencies: { y: '1' } }),
    false,
  );
  expect('sideEffects change', manifestMoved(m, { ...m, sideEffects: ['./dist/cli.js'] }), true);
  expect('key order is not a change', manifestMoved({ a: 1, b: 2 }, { b: 2, a: 1 }), false);

  const pkg = (name, version, extra = {}) => ({ name, version, ...extra });
  const entry = (head, base, changed) => ({ dir: head.name, head, base, changed });
  const verdict = (set) => judgeSet(set).violations.length;

  // RED direction — each must be refused.
  expect(
    'moved source, same version',
    verdict([entry(pkg('@x/a', '0.1.0'), pkg('@x/a', '0.1.0'), ['src/a.ts'])]),
    1,
  );
  expect(
    'packaging metadata moved, same version',
    verdict([
      entry(pkg('@x/a', '0.1.0', { sideEffects: false }), pkg('@x/a', '0.1.0'), ['package.json']),
    ]),
    1,
  );
  expect(
    'bundled private dependency moved, same version',
    verdict([
      entry(
        pkg('@x/a', '0.1.0', { devDependencies: { '@x/twins': 'workspace:*' } }),
        pkg('@x/a', '0.1.0'),
        [],
      ),
      entry(pkg('@x/twins', '0.0.0', { private: true }), pkg('@x/twins', '0.0.0'), ['src/t.ts']),
    ]),
    1,
  );
  expect(
    'version below the tag',
    verdict([entry(pkg('@x/a', '0.1.0'), pkg('@x/a', '0.2.0'), [])]),
    1,
  );

  // GREEN direction — each must pass.
  expect(
    'moved source, advanced',
    verdict([entry(pkg('@x/a', '0.1.1'), pkg('@x/a', '0.1.0'), ['src/a.ts'])]),
    0,
  );
  expect(
    'tests and docs only',
    verdict([entry(pkg('@x/a', '0.1.0'), pkg('@x/a', '0.1.0'), ['test/a.test.ts', 'README.md'])]),
    0,
  );
  expect(
    'scripts-only manifest change',
    verdict([
      entry(pkg('@x/a', '0.1.0', { scripts: { b: 'c' } }), pkg('@x/a', '0.1.0'), ['package.json']),
    ]),
    0,
  );
  expect('new package', verdict([entry(pkg('@x/n', '0.1.0'), null, ['src/n.ts'])]), 0);
  expect(
    'private package is not judged',
    verdict([entry(pkg('@x/p', '0.0.0', { private: true }), pkg('@x/p', '0.0.0'), ['src/p.ts'])]),
    0,
  );
  expect(
    'placeholder is exempt',
    verdict([
      entry(
        pkg('@x/f', '0.0.0-placeholder.2', { sideEffects: false }),
        pkg('@x/f', '0.0.0-placeholder.2'),
        ['package.json'],
      ),
    ]),
    0,
  );

  if (failures.length > 0) {
    console.error('Release-advance check self-test FAILED:\n');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('Release-advance check self-test OK (classification + verdict, both directions).');
};

// ─── Entry point ────────────────────────────────────────────────────────────

const main = () => {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }

  const tag = tryGit('describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD')?.trim();
  if (tag === undefined || tag === '') {
    if (tryGit('rev-parse', '--is-shallow-repository')?.trim() === 'true') {
      console.log(
        '\n*** Release-advance check NOT CHECKED: this is a SHALLOW clone and no `v*` tag is ' +
          'reachable from HEAD, so it cannot say which packages moved since the last release. ***\n' +
          '*** Remedy: check out full history with tags (actions/checkout `fetch-depth: 0`, or ' +
          '`git fetch --unshallow --tags`) and re-run `node dev-scripts/check-release-advances.mjs`. ***\n',
      );
      return;
    }
    console.error(
      'Release-advance check FAILED: no `v*` tag is reachable from HEAD in this clone ' +
        '(or this is not a git checkout), so there is no release to compare against. ' +
        'Fetch the tags (`git fetch --tags`) and re-run.',
    );
    process.exit(1);
  }

  const { violations, judged, exempt } = judgeSet(readPackages(tag));
  if (violations.length > 0) {
    console.error(`\nRelease-advance check FAILED against ${tag}:\n`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error('');
    process.exit(1);
  }
  console.log(
    `Release-advance check OK against ${tag} (${judged} publishable package(s)` +
      (exempt.length > 0 ? `; exempt: ${exempt.join(', ')}` : '') +
      ').',
  );
};

main();
