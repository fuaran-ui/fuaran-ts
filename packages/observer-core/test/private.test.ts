// ============================================================================
//  observer-core stays private, and no published artefact names it (Phase 2075).
//
//  The two observer packages bundle this code into their dist; a published
//  module specifier naming it would resolve for nobody who installs from the
//  registry. Same three claims as the core-twins boundary, for this package.
// ============================================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = resolve(pkgRoot, '..');
const NAME = '@fuaran-ui/observer-core';

/** Module-specifier forms only — esbuild's region comments name the inlined
 * source path, and that is provenance, not a reference. */
const LEAK_RE =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']@fuaran-ui\/observer-core(?:\/[^"']*)?["']/;

interface Manifest {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const manifests = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join(packagesRoot, e.name))
  .filter((dir) => existsSync(join(dir, 'package.json')))
  .map((dir) => ({
    dir,
    pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest,
  }));
const published = manifests.filter(({ pkg }) => pkg.private !== true);

/** The packages that bundle this one. */
const consumers = ['@fuaran-ui/layout-observer', '@fuaran-ui/style-observer'];

const distFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? distFiles(join(dir, e.name))
      : /\.(?:c|m)?js$|\.d\.(?:c|m)?ts$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

describe('observer-core is private', () => {
  const self = manifests.find(({ pkg }) => pkg.name === NAME)!.pkg;

  it('is marked private, so it is never published', () => {
    expect(self.private).toBe(true);
  });

  it('declares no runtime or peer dependency', () => {
    expect(Object.keys(self.dependencies ?? {})).toEqual([]);
    expect(Object.keys(self.peerDependencies ?? {})).toEqual([]);
  });
});

describe('no published artefact references observer-core', () => {
  it('no published package lists it as an installed dependency', () => {
    const offenders = published
      .filter(({ pkg }) =>
        [pkg.dependencies, pkg.peerDependencies, pkg.optionalDependencies].some(
          (deps) => deps !== undefined && NAME in deps,
        ),
      )
      .map(({ pkg }) => pkg.name);
    expect(offenders).toEqual([]);
  });

  it('every bundling package is built, so the dist scan below is not vacuous', () => {
    const built = published
      .filter(({ pkg }) => consumers.includes(pkg.name))
      .filter(({ dir }) => existsSync(join(dir, 'dist', 'index.js')))
      .map(({ pkg }) => pkg.name)
      .sort();
    expect(built).toEqual([...consumers].sort());
  });

  it('no built dist file names it as a module', () => {
    const offenders = published.flatMap(({ dir, pkg }) => {
      const dist = join(dir, 'dist');
      if (!existsSync(dist)) return [];
      return distFiles(dist)
        .filter((f) => LEAK_RE.test(readFileSync(f, 'utf8')))
        .map((f) => `${pkg.name}: ${f.slice(dist.length + 1)}`);
    });
    expect(offenders).toEqual([]);
  });

  it.each([
    ["import { createObserver } from '@fuaran-ui/observer-core';", true],
    ['var o = require("@fuaran-ui/observer-core");', true],
    ['// ../observer-core/src/observer.ts', false],
  ])('the leak check reads %s as leaking=%s', (text, leaks) => {
    expect(LEAK_RE.test(text)).toBe(leaks);
  });
});
