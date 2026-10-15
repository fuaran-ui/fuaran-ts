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
// The base is the newest `v*` tag reachable from HEAD (a tag pointing AT HEAD is the
// release being cut and is skipped, so the publish job, which runs on it, compares with
// the one before). Each package's version
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
// What counts as "sources moved" — a changed or untracked file under the
// package directory that the package SHIPS or that is an INPUT to what it ships
// (operator decision 2026-10-15, Phase 2249; before it, every file counted, so
// Phase 2238's change to the conformance package's unshipped
// `scripts/sync-corpus.mjs` demanded a release it did not need):
//
//   * shipped: a path the manifest's `files` allowlist names (a directory entry
//     ships everything beneath it; globs and `!` exclusions are honoured), a
//     `main`/`bin` target, and a LICENSE/NOTICE file;
//   * a build input: a path the package's `tsconfig.json` compiles into the
//     shipped output (its `include` globs and `rootDir`, READ from each package,
//     never hard-coded), plus the build configuration itself (`tsconfig.json`,
//     `tsup*.config.*`);
//   * a `package.json` change outside `version`, `scripts` and `devDependencies`
//     (a bundled private dependency is followed through the rule above instead).
//
// Never counted, for any package: tests (a `test/`, `tests/` or `__tests__/`
// directory, `*.test.*`, `*.spec.*`, `vitest.config.*`, `tsconfig.test.json`) and
// Markdown (`*.md`: documentation does not alter what a consumer installs or runs).
//
// A package WITHOUT a `files` list ships its whole directory, so for it the old
// rule stands unchanged: everything but tests and Markdown counts. The same holds
// for an entry the caller gives no layout.
//
// ─── The second clause: a range a sibling's advance leaves behind (Phase 2237) ─
//
// A package that is NOT advanced is not republished, so consumers keep the
// manifest the tag published, and `pnpm pack` wrote that manifest's
// `workspace:` ranges against the sibling versions that stood AT THE TAG
// (`workspace:^` becomes `^<tag-time sibling>`, `~` becomes `~…`, `*` becomes
// the exact version). When the sibling then advances out of that range (pre-1.0,
// any minor does), the unadvanced package's published range excludes it and the
// registry holds a set no consumer can satisfy. So for every publishable package
// whose version equals the tag's, each `@fuaran-ui/*` `workspace:` dependency,
// peer dependency and optional dependency is resolved the way the tag's pack did
// (from the tag-time manifests, via `git show`; no network), and a range that
// excludes the sibling's CURRENT workspace version fails as `LEFT BEHIND BY
// <sibling>`, naming the advance that fixes it.
//
// `devDependencies` are not judged: npm never installs a dependency's own
// devDependencies, so a stale exact pin there (the mock's `workspace:*` on the
// client, which only its tests import) constrains no consumer. A literal
// (non-`workspace:`) range, and the registry-side verdict, belong to
// `check-peer-ranges.mjs`, which is not imported here: its module body runs the
// registry lookup on import.
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

/** A glob (`*`, `**`, `?`) as an anchored RegExp over a slash-separated relative path. */
const globToRegExp = (glob) => {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
};

const normaliseGlob = (g) => g.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** Whether `path` is what `entry` names, or lies beneath it (an entry naming a directory ships all of it). */
const underGlob = (path, entry) => {
  const re = globToRegExp(normaliseGlob(entry));
  const parts = path.split('/');
  return parts.some((_, i) => re.test(parts.slice(0, i + 1).join('/')));
};

/** The package's build configuration: what turns its inputs into the files it ships. */
const isBuildConfig = (p) => p === 'tsconfig.json' || /^tsup(\.[^/]+)?\.config\.[^/]+$/.test(p);

/**
 * Whether `p` ships, or builds something that ships, under `layout`: `files` the manifest's
 * `files` allowlist (`null` when it has none) and `inputs` the globs its tsconfig compiles
 * into the shipped `dist`.
 */
const reachesConsumer = (p, layout) => {
  const listed = layout.files ?? [];
  const shipped = listed.filter((f) => !f.startsWith('!'));
  const excluded = listed.filter((f) => f.startsWith('!')).map((f) => f.slice(1));
  if (shipped.some((f) => underGlob(p, f)) && !excluded.some((f) => underGlob(p, f))) return true;
  if (/^(license|licence|notice)(\.[^/]*)?$/i.test(p)) return true;
  return isBuildConfig(p) || layout.inputs.some((g) => underGlob(p, g));
};

/**
 * Whether `relPath` (relative to the package directory) is a source of what the package ships.
 * `layout` is omitted, or its `files` is `null`, for a package that declares no `files` list:
 * it ships everything, so everything but tests and Markdown counts.
 */
export const isSourcePath = (relPath, layout) => {
  const p = relPath.replace(/\\/g, '/');
  if (/(^|\/)(test|tests|__tests__)\//.test(p)) return false;
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (/\.(test|spec)\.[^/]+$/.test(base)) return false;
  if (/^vitest\.config\./.test(base) || base === 'tsconfig.test.json') return false;
  if (/\.md$/i.test(base)) return false;
  if (layout === undefined || layout.files === null) return true;
  return reachesConsumer(p, layout);
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

// ─── Published ranges, as `pnpm pack` wrote them ────────────────────────────

/** The manifest sections whose ranges a consumer's install resolves. */
const CONSUMER_EDGES = ['dependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * The range `pnpm pack` writes for a `workspace:` spec when the sibling stands at
 * `siblingVersion`, or `null` for a literal range, which pack leaves alone.
 */
export const packedRange = (spec, siblingVersion) => {
  if (!spec.startsWith('workspace:')) return null;
  const rest = spec.slice('workspace:'.length);
  if (rest === '^' || rest === '~') return `${rest}${siblingVersion}`;
  if (rest === '*' || rest === '') return siblingVersion;
  return rest;
};

/**
 * Whether `version` satisfies `range`, for the three shapes a pack produces: `^x.y.z`,
 * `~x.y.z` and an exact version. Anything else throws rather than being guessed at,
 * so a range this cannot read is a finding and never a quiet pass.
 */
export const satisfiesRange = (version, range) => {
  const r = range.trim();
  const op = r[0] === '^' || r[0] === '~' ? r[0] : '';
  const base = parseVersion(op === '' ? r : r.slice(1));
  const v = parseVersion(version);
  if (op === '') return compareVersions(version, r) === 0;
  const [a, b, c] = base.core;
  const ceiling =
    op === '~' ? [a, b + 1, 0] : a > 0 ? [a + 1, 0, 0] : b > 0 ? [0, b + 1, 0] : [0, 0, c + 1];
  // npm: a prerelease satisfies only a range naming a prerelease on the same x.y.z.
  const preOk =
    v.pre.length === 0 || (base.pre.length > 0 && v.core.every((n, i) => n === base.core[i]));
  return (
    preOk &&
    compareVersions(version, r.slice(1)) >= 0 &&
    compareVersions(version, `${ceiling.join('.')}-0`) < 0
  );
};

/** The range violations of one UNADVANCED package against the tag-time and current sibling versions. */
const leftBehind = (p, siblings) => {
  const found = [];
  const { name, version } = p.head;
  for (const section of CONSUMER_EDGES) {
    for (const [dep, spec] of Object.entries(p.base[section] ?? {})) {
      const sibling = siblings.get(dep);
      if (sibling === undefined || sibling.base === null || sibling.base.private === true) continue;
      const published = packedRange(spec, sibling.base.version);
      if (published === null) continue;
      const current = sibling.head.version;
      let satisfied;
      try {
        satisfied = satisfiesRange(current, published);
      } catch (e) {
        found.push(
          `${name}@${version}: the tag published ${dep} "${published}" (${section}), which this ` +
            `check cannot read (${e.message}) — refusing rather than guessing.`,
        );
        continue;
      }
      if (satisfied) continue;
      const [x, y, z] = parseVersion(version).core;
      found.push(
        `${name}@${version} LEFT BEHIND BY ${dep}@${current}: the tag published ${name} with ${dep} ` +
          `"${published}" (${section}, from ${spec}), a range that excludes ${current} — the release ` +
          `would SKIP ${name} and the registry would serve an uninstallable set. Advance ${name} to ` +
          `${x}.${y}.${z + 1} (a release-consistency patch; the next pack then writes ` +
          `"${packedRange(spec, current)}") and record it in STABILITY.md.`,
      );
    }
  }
  return found;
};

// ─── The verdict, over data ─────────────────────────────────────────────────

/**
 * `packages`: [{ dir, head, base, changed, layout }] — `head` the working-tree manifest,
 * `base` the manifest at the tag (or `null` when absent there), `changed` the
 * package-relative paths that differ from the tag (manifest included), `layout` what the
 * package ships (see `isSourcePath`; omitted means the old everything-counts rule).
 *
 * Returns { violations, judged, exempt }.
 */
export const judgeSet = (packages) => {
  const own = new Map();
  for (const p of packages) {
    const reasons = p.changed.filter((f) => f !== 'package.json' && isSourcePath(f, p.layout));
    if (p.base !== null && p.changed.includes('package.json') && manifestMoved(p.base, p.head)) {
      reasons.push('package.json');
    }
    own.set(p.head.name, reasons);
  }
  const privateNames = new Set(
    packages.filter((p) => p.head.private === true).map((p) => p.head.name),
  );

  const siblings = new Map(packages.map((p) => [p.head.name, p]));

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
    } else if (order === 0) {
      violations.push(...leftBehind(p, siblings));
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

const binTargets = (m) => (typeof m.bin === 'string' ? [m.bin] : Object.values(m.bin ?? {}));

/** What the package at `dir` ships: its `files` allowlist and the globs its tsconfig compiles. */
const readLayout = (dir, head) => {
  const tsconfig = join(repoRoot, 'packages', dir, 'tsconfig.json');
  const compiled = existsSync(tsconfig) ? readJson(tsconfig) : {};
  const rootDir = compiled.compilerOptions?.rootDir;
  return {
    files: Array.isArray(head.files)
      ? [...head.files, head.main, ...binTargets(head)].filter(Boolean)
      : null,
    inputs: [...(compiled.include ?? []), ...(rootDir === undefined ? [] : [rootDir])],
  };
};

const readPackages = (tag) => {
  const listed = [
    ...git('diff', '--name-only', tag, '--', 'packages').split('\n'),
    ...git('ls-files', '--others', '--exclude-standard', '--', 'packages').split('\n'),
  ].filter((l) => l !== '');
  return workspaceDirs().map((dir) => {
    const prefix = `packages/${dir}/`;
    const atTag = tryGit('show', `${tag}:${prefix}package.json`);
    const head = readJson(join(repoRoot, 'packages', dir, 'package.json'));
    return {
      dir,
      head,
      layout: readLayout(dir, head),
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
  const entry = (head, base, changed, layout) => ({ dir: head.name, head, base, changed, layout });
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

  // What a package SHIPS (Phase 2249). A package with a `files` list is judged by what
  // that list ships plus what its tsconfig compiles; each class is its own case.
  const layout = { files: ['dist', 'corpus', 'README.md'], inputs: ['src/**/*'] };
  const shippedMoved = (path, lay = layout) =>
    verdict([entry(pkg('@x/a', '0.1.0'), pkg('@x/a', '0.1.0'), [path], lay)]);
  // RED direction.
  expect('shipped data file moved', shippedMoved('corpus/nodes/form-1.json'), 1);
  expect('build input moved', shippedMoved('src/wire.ts'), 1);
  expect('build config moved', shippedMoved('tsup.config.ts'), 1);
  expect('tsconfig moved', shippedMoved('tsconfig.json'), 1);
  expect(
    'an input named by a non-src include',
    shippedMoved('gen/a.ts', { files: ['dist'], inputs: ['src/**/*', 'gen/**/*'] }),
    1,
  );
  expect(
    'a file named by a files glob',
    shippedMoved('css/theme.css', { files: ['dist', 'css/*.css'], inputs: ['src/**/*'] }),
    1,
  );
  expect(
    'a package without a files list: a repository tool counts',
    shippedMoved('scripts/sync-corpus.mjs', { files: null, inputs: ['src/**/*'] }),
    1,
  );
  expect(
    'no layout at all: the old rule',
    verdict([entry(pkg('@x/a', '0.1.0'), pkg('@x/a', '0.1.0'), ['scripts/x.mjs'])]),
    1,
  );
  // GREEN direction.
  expect('unshipped repository tool', shippedMoved('scripts/sync-corpus.mjs'), 0);
  expect('unshipped examples directory', shippedMoved('examples/a.json'), 0);
  expect(
    'a files entry is a whole directory, not a prefix',
    shippedMoved('corpus-notes/a.json'),
    0,
  );
  expect('a test under a shipped directory', shippedMoved('corpus/test/a.test.ts'), 0);
  expect('a test of the build input', shippedMoved('src/wire.test.ts'), 0);
  expect('Markdown under a shipped directory', shippedMoved('corpus/NOTES.md'), 0);
  expect('Markdown at the root', shippedMoved('README.md'), 0);
  expect(
    'a negated files entry is not shipped',
    shippedMoved('corpus/skip/a.json', { files: ['corpus', '!corpus/skip'], inputs: [] }),
    0,
  );
  expect(
    'the test directory of a no-files package',
    shippedMoved('test/a.test.ts', { files: null, inputs: [] }),
    0,
  );

  // Packed ranges and their satisfier (second clause).
  expect('pack ^', packedRange('workspace:^', '0.12.4'), '^0.12.4');
  expect('pack ~', packedRange('workspace:~', '0.12.4'), '~0.12.4');
  expect('pack *', packedRange('workspace:*', '0.12.4'), '0.12.4');
  expect('pack explicit range', packedRange('workspace:^0.3.0', '0.12.4'), '^0.3.0');
  expect('pack leaves a literal range', packedRange('^0.3.0', '0.12.4'), null);
  expect('0.x caret excludes the next minor', satisfiesRange('0.13.0', '^0.12.4'), false);
  expect('0.x caret includes a later patch', satisfiesRange('0.12.9', '^0.12.4'), true);
  expect('0.x caret excludes an earlier patch', satisfiesRange('0.12.3', '^0.12.4'), false);
  expect('1.x caret includes a later minor', satisfiesRange('1.9.0', '^1.2.0'), true);
  expect('1.x caret excludes the next major', satisfiesRange('2.0.0', '^1.2.0'), false);
  expect('0.0.x caret is exact', satisfiesRange('0.0.4', '^0.0.3'), false);
  expect('tilde includes a later patch', satisfiesRange('0.12.9', '~0.12.4'), true);
  expect('tilde excludes the next minor', satisfiesRange('0.13.0', '~0.12.4'), false);
  expect('exact range excludes a later patch', satisfiesRange('0.12.5', '0.12.4'), false);
  expect('exact range includes itself', satisfiesRange('0.12.4', '0.12.4'), true);
  expect('prerelease is outside a plain caret', satisfiesRange('0.12.5-rc.1', '^0.12.4'), false);
  expect(
    'unreadable range throws',
    (() => {
      try {
        satisfiesRange('1.0.0', '>=1');
        return false;
      } catch {
        return true;
      }
    })(),
    true,
  );

  // The second clause, over a synthetic dependent/sibling pair. `dep` stood at the
  // tag with `@x/s` at 0.12.4 and `spec` on it; `@x/s` now stands at `now`.
  const edge = (
    spec,
    now,
    { section = 'dependencies', dependentNow = '0.1.0', sibPrivate } = {},
  ) => [
    entry(
      pkg('@x/d', dependentNow, { [section]: { '@x/s': spec } }),
      pkg('@x/d', '0.1.0', { [section]: { '@x/s': spec } }),
      [],
    ),
    entry(
      pkg('@x/s', now),
      pkg('@x/s', '0.12.4', sibPrivate === true ? { private: true } : {}),
      now === '0.12.4' ? [] : ['src/s.ts'],
    ),
  ];
  const messages = (set) => judgeSet(set).violations.join('\n');

  // RED direction — each must be refused.
  expect('caret dependency left behind by a minor', verdict(edge('workspace:^', '0.13.0')), 1);
  expect(
    'the refusal names the sibling and the advance',
    /LEFT BEHIND BY @x\/s@0\.13\.0.*"\^0\.12\.4".*Advance @x\/d to 0\.1\.1.*"\^0\.13\.0"/.test(
      messages(edge('workspace:^', '0.13.0')),
    ),
    true,
  );
  expect(
    'peer dependency left behind',
    verdict(edge('workspace:^', '0.13.0', { section: 'peerDependencies' })),
    1,
  );
  expect(
    'optional dependency left behind',
    verdict(edge('workspace:^', '0.13.0', { section: 'optionalDependencies' })),
    1,
  );
  expect('exact pin left behind by a patch', verdict(edge('workspace:*', '0.12.5')), 1);
  expect('tilde left behind by a minor', verdict(edge('workspace:~', '0.13.0')), 1);
  expect('a range the check cannot read is refused', verdict(edge('workspace:>=0.1', '0.13.0')), 1);

  // GREEN direction — each must pass.
  expect('caret holds across a patch', verdict(edge('workspace:^', '0.12.9')), 0);
  expect('sibling unmoved', verdict(edge('workspace:^', '0.12.4')), 0);
  expect(
    'dependent advanced since the tag',
    verdict(edge('workspace:^', '0.13.0', { dependentNow: '0.1.1' })),
    0,
  );
  expect(
    'devDependencies constrain no consumer',
    verdict(edge('workspace:*', '0.13.0', { section: 'devDependencies' })),
    0,
  );
  expect('literal range is not this check', verdict(edge('^0.12.4', '0.13.0')), 0);
  expect(
    'private sibling at the tag is not a range',
    verdict(edge('workspace:^', '0.13.0', { sibPrivate: true })),
    0,
  );

  expect('no tag at HEAD: plain describe', describeArgs([]).includes('--exclude'), false);
  expect(
    'a tag at HEAD is the release being cut, not the base',
    describeArgs(['v0.31.0']).join(' '),
    'describe --tags --abbrev=0 --match v* --exclude v0.31.0 HEAD',
  );

  if (failures.length > 0) {
    console.error('Release-advance check self-test FAILED:\n');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('Release-advance check self-test OK (classification + verdict, both directions).');
};

/**
 * The `git describe` arguments naming the release to compare with. The publish workflow
 * runs ON the new tag, so a `v*` tag pointing at HEAD is the release being cut, not the
 * one it is compared with: it is excluded, and the base is the newest tag before it.
 */
export const describeArgs = (tagsAtHead) => [
  'describe',
  '--tags',
  '--abbrev=0',
  '--match',
  'v*',
  ...tagsAtHead.flatMap((t) => ['--exclude', t]),
  'HEAD',
];

// ─── Entry point ────────────────────────────────────────────────────────────

const main = () => {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }

  const atHead = (tryGit('tag', '--points-at', 'HEAD', '--list', 'v*') ?? '')
    .split('\n')
    .filter(Boolean);
  const tag = tryGit(...describeArgs(atHead))?.trim();
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
