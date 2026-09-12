#!/usr/bin/env node
// Peer-range consistency check for the `@fuaran-ui/*` release set (Phase 1695).
//
// The publish workflow packs every publishable package and SKIPS any version
// already on the registry, so a tag cut without bumping a package simply does
// not republish it. That skip is what keeps re-runs idempotent, and it is also
// the hole this check closes: a package that is not republished keeps the
// inter-package ranges it was published WITH, resolved from `workspace:^`
// against the versions that stood at ITS publish time. When a package it peers
// on moves and it does not, the registry ends up holding a set no consumer can
// satisfy.
//
// That is not hypothetical. The v0.26.0 release published `@fuaran-ui/schema`
// 0.22.0 while `@fuaran-ui/ui` stayed at 0.20.0, whose published manifest
// declares `"@fuaran-ui/schema": "^0.21.0"` — mutually unsatisfiable under 0.x
// semver, and a hard install failure for anyone running with
// `strict-peer-dependencies=true`.
//
// ─── What it checks ─────────────────────────────────────────────────────────
//
// For every publishable package in `packages/*`, against the version set THIS
// publish produces (each package's workspace version):
//
//   * FRESH (the workspace version is not on the registry) — it will be
//     published from this tree, so its ranges are whatever the tarball carries.
//     A `workspace:` range is rewritten by `pnpm pack` and is satisfiable by
//     construction; a LITERAL range is checked against the set.
//   * SKIPPED (the workspace version is already on the registry) — it will NOT
//     be republished, so the ranges consumers see are the PUBLISHED ones. Each
//     `@fuaran-ui/*` dependency and peer dependency is resolved against the set,
//     and an unsatisfiable one fails the release.
//
// The remedy a failure names is always the same, and it is a version bump
// rather than a range edit: the range is generated from `workspace:^` at pack
// time, so the only way to correct it on the registry is to publish the package
// again under a new version.
//
// ─── Modes ──────────────────────────────────────────────────────────────────
//
//   --self-test   Offline. Proves the range satisfier and the verdict logic
//                 from fixed data, in BOTH directions, including the exact
//                 `ui` 0.20.0 / `schema` 0.22.0 pair above. Runs in the
//                 ordinary gate, so the check cannot rot into always-green.
//   (default)     Queries the npm registry. Intended for the publish workflow.
//                 A registry that cannot be reached is reported as UNVERIFIED
//                 and exits non-zero — a release must not proceed on an
//                 unverified consistency claim — with `--allow-unverified` for
//                 an operator who has judged otherwise.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org';

// ─── A minimal semver range satisfier ───────────────────────────────────────
//
// No dependency: this script runs before `pnpm install` has any say in the
// publish job, and the ranges in play are the ones `pnpm pack` generates.
// Anything it cannot parse is REFUSED rather than guessed at — "I cannot read
// this" must never render as "this is fine".

class Unreadable extends Error {}

const parseVersion = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (m === null) throw new Unreadable(`unreadable version "${v}"`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
};

const cmp = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/** `^x.y.z` upper bound, including npm's 0.x narrowing. */
const caretCeiling = (v) => {
  if (v.major > 0) return { major: v.major + 1, minor: 0, patch: 0 };
  if (v.minor > 0) return { major: 0, minor: v.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: v.patch + 1 };
};

const satisfiesComparator = (version, range) => {
  const r = range.trim();
  if (r === '' || r === '*' || r === 'x') return true;

  if (r.startsWith('^')) {
    const base = parseVersion(r.slice(1));
    const ceiling = caretCeiling(base);
    return cmp(version, base) >= 0 && cmp(version, ceiling) < 0;
  }
  if (r.startsWith('~')) {
    const base = parseVersion(r.slice(1));
    return (
      cmp(version, base) >= 0 && cmp(version, { ...base, minor: base.minor + 1, patch: 0 }) < 0
    );
  }
  if (r.startsWith('>=')) return cmp(version, parseVersion(r.slice(2))) >= 0;
  if (r.startsWith('>')) return cmp(version, parseVersion(r.slice(1))) > 0;
  if (r.startsWith('<=')) return cmp(version, parseVersion(r.slice(2))) <= 0;
  if (r.startsWith('<')) return cmp(version, parseVersion(r.slice(1))) < 0;
  if (r.startsWith('=')) return cmp(version, parseVersion(r.slice(1))) === 0;
  return cmp(version, parseVersion(r)) === 0;
};

/**
 * Does `versionText` satisfy `range`? Supports `||` alternation and
 * space-separated conjunction within an alternative. Throws `Unreadable` on a
 * range or version shape it does not model, and on any PRERELEASE version — npm
 * excludes prereleases from a range that does not name one, and this script
 * does not model that rule rather than approximating it.
 */
export const satisfies = (versionText, range) => {
  const version = parseVersion(versionText);
  if (version.prerelease !== null)
    throw new Unreadable(`prerelease version "${versionText}" is not modelled`);
  return range.split('||').some((alt) =>
    alt
      .trim()
      .split(/\s+/)
      .filter((c) => c !== '')
      .every((c) => satisfiesComparator(version, c)),
  );
};

/** `workspace:^` / `workspace:~` / `workspace:*` as `pnpm pack` rewrites them. */
export const resolveWorkspaceRange = (range, depVersion) => {
  if (!range.startsWith('workspace:')) return range;
  const suffix = range.slice('workspace:'.length);
  if (suffix === '^') return `^${depVersion}`;
  if (suffix === '~') return `~${depVersion}`;
  if (suffix === '*' || suffix === '') return depVersion;
  return suffix;
};

// ─── The verdict, over data ─────────────────────────────────────────────────

/**
 * `packages`: [{ name, version, published, ranges: { dep: rangeText } }] where
 * `published` says whether this publish will SKIP the package (its version is
 * already on the registry) and `ranges` are the ranges that will then be the
 * ones consumers see — the published manifest's for a skipped package, the
 * workspace manifest's for a fresh one.
 *
 * Returns { violations, unjudged }.
 */
export const checkSet = (packages) => {
  const setVersion = new Map(packages.map((p) => [p.name, p.version]));
  const violations = [];
  const unjudged = [];

  for (const p of packages) {
    for (const [dep, rangeText] of Object.entries(p.ranges)) {
      const depVersion = setVersion.get(dep);
      if (depVersion === undefined) continue; // not produced by this publish
      const range = resolveWorkspaceRange(rangeText, depVersion);
      let ok;
      try {
        ok = satisfies(depVersion, range);
      } catch (e) {
        unjudged.push(`${p.name}@${p.version} -> ${dep} "${range}": ${e.message}`);
        continue;
      }
      if (!ok) {
        violations.push(
          `${p.name}@${p.version}${p.published ? ' (already on the registry — this publish SKIPS it)' : ''} ` +
            `requires ${dep} "${range}", but this publish produces ${dep}@${depVersion}. ` +
            (p.published
              ? `Bump ${p.name} so it is REPUBLISHED with the range regenerated from workspace:^ ` +
                `— the published range cannot be corrected in place.`
              : `Correct the literal range in packages/*/package.json.`),
        );
      }
    }
  }
  return { violations, unjudged };
};

// ─── Reading the workspace ──────────────────────────────────────────────────

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const workspacePackages = () => {
  const root = join(repoRoot, 'packages');
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name, 'package.json'))
    .filter((p) => existsSync(p))
    .map(readJson)
    .filter((pkg) => pkg.private !== true);
};

const fuaranRanges = (manifest) =>
  Object.fromEntries(
    [
      ...Object.entries(manifest.dependencies ?? {}),
      ...Object.entries(manifest.peerDependencies ?? {}),
    ].filter(([name]) => name.startsWith('@fuaran-ui/')),
  );

/** The published manifest at `name@version`, or `null` when it is not on the registry. */
const publishedManifest = async (name, version) => {
  const url = `${REGISTRY}/${name.replace('/', '%2f')}/${version}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${name}@${version}: registry responded ${res.status}`);
  return await res.json();
};

// ─── Self-test (offline) ────────────────────────────────────────────────────

const selfTest = () => {
  const failures = [];
  const expect = (what, actual, wanted) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted))
      failures.push(`${what}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
  };

  // The satisfier, on the 0.x narrowing that makes this whole check necessary.
  expect('^0.21.0 admits 0.21.4', satisfies('0.21.4', '^0.21.0'), true);
  expect('^0.21.0 REFUSES 0.22.0', satisfies('0.22.0', '^0.21.0'), false);
  expect('^0.21.0 refuses 0.20.9', satisfies('0.20.9', '^0.21.0'), false);
  expect('^1.2.0 admits 1.9.9', satisfies('1.9.9', '^1.2.0'), true);
  expect('^1.2.0 refuses 2.0.0', satisfies('2.0.0', '^1.2.0'), false);
  expect('~0.21.0 refuses 0.22.0', satisfies('0.22.0', '~0.21.0'), false);
  expect('exact', satisfies('0.22.0', '0.22.0'), true);
  expect('alternation', satisfies('0.22.0', '^0.21.0 || ^0.22.0'), true);
  expect('workspace:^ resolves', resolveWorkspaceRange('workspace:^', '0.22.0'), '^0.22.0');
  expect('workspace:* resolves', resolveWorkspaceRange('workspace:*', '0.22.0'), '0.22.0');

  let refused = false;
  try {
    satisfies('0.22.0', 'not-a-range');
  } catch {
    refused = true;
  }
  expect('an unreadable range is REFUSED, not guessed', refused, true);

  // The verdict, on the pair that motivated this check. `ui` 0.20.0 is already
  // on the registry, so the publish skips it and its PUBLISHED `^0.21.0` peer
  // stands against the `schema` 0.22.0 the same publish produces.
  const motivating = checkSet([
    { name: '@fuaran-ui/schema', version: '0.22.0', published: false, ranges: {} },
    {
      name: '@fuaran-ui/ui',
      version: '0.20.0',
      published: true,
      ranges: { '@fuaran-ui/schema': '^0.21.0' },
    },
  ]);
  expect('the motivating pair is refused', motivating.violations.length, 1);
  if (motivating.violations.length === 1) {
    const v = motivating.violations[0];
    for (const fragment of ['@fuaran-ui/ui@0.20.0', 'SKIPS it', '@fuaran-ui/schema@0.22.0'])
      if (!v.includes(fragment)) failures.push(`the refusal must name ${fragment}: ${v}`);
  }

  // ... and the same set once `ui` is bumped, which is the remedy the refusal
  // names. A check that only ever fails is as useless as one that never does.
  const remedied = checkSet([
    { name: '@fuaran-ui/schema', version: '0.22.0', published: false, ranges: {} },
    {
      name: '@fuaran-ui/ui',
      version: '0.20.1',
      published: false,
      ranges: { '@fuaran-ui/schema': 'workspace:^' },
    },
  ]);
  expect('the remedied set passes', remedied.violations, []);

  // An unreadable range is neither a pass nor a violation.
  const odd = checkSet([
    { name: '@fuaran-ui/schema', version: '0.22.0', published: false, ranges: {} },
    {
      name: '@fuaran-ui/ui',
      version: '0.20.1',
      published: false,
      ranges: { '@fuaran-ui/schema': 'catalog:default' },
    },
  ]);
  expect('an unreadable range is not a violation', odd.violations, []);
  expect('an unreadable range is reported', odd.unjudged.length, 1);

  if (failures.length > 0) {
    console.error('Peer-range check SELF-TEST FAILED:\n');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('');
    process.exit(1);
  }
  console.log('Peer-range check self-test OK (satisfier + verdict, both directions).');
};

// ─── Entry point ────────────────────────────────────────────────────────────

const main = async () => {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const allowUnverified = argv.includes('--allow-unverified');

  const manifests = workspacePackages();
  const packages = [];
  const unreachable = [];

  for (const m of manifests) {
    let published = null;
    try {
      published = await publishedManifest(m.name, m.version);
    } catch (e) {
      unreachable.push(`${m.name}@${m.version}: ${e.message}`);
      continue;
    }
    packages.push({
      name: m.name,
      version: m.version,
      published: published !== null,
      ranges: fuaranRanges(published ?? m),
    });
  }

  if (unreachable.length > 0) {
    console.error('Peer-range check UNVERIFIED — the registry could not be read for:\n');
    for (const u of unreachable) console.error(`  - ${u}`);
    console.error(
      '\nThis is a fault in the lookup, not a finding about the packages. ' +
        'Re-run, or pass --allow-unverified to proceed deliberately.\n',
    );
    if (!allowUnverified) process.exit(1);
  }

  const { violations, unjudged } = checkSet(packages);

  for (const u of unjudged) console.log(`  (unjudged) ${u}`);

  if (violations.length > 0) {
    console.error('\nPeer-range check FAILED — this release set is not installable:\n');
    for (const v of violations) console.error(`  - ${v}`);
    const needBump = [
      ...new Set(
        packages
          .filter((p) => p.published && violations.some((v) => v.startsWith(`${p.name}@`)))
          .map((p) => `${p.name} (currently ${p.version})`),
      ),
    ].sort();
    if (needBump.length > 0) {
      console.error('\nBump these, then re-cut the tag:\n');
      for (const n of needBump) console.error(`  - ${n}`);
    }
    console.error('');
    process.exit(1);
  }

  const skipped = packages.filter((p) => p.published).length;
  console.log(
    `Peer-range check OK (${packages.length} publishable package(s); ` +
      `${skipped} already on the registry and checked against their PUBLISHED ranges).`,
  );
};

await main();
