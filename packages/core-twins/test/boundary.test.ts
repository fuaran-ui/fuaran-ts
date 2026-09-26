// ============================================================================
//  The core-twins boundary, held by a test (Phase 1861).
//
//  Three claims, each with a probe that proves the check can go red:
//
//    1. nothing in src/ imports from the host's domain packages (the rule in
//       ./boundary.ts), and the admitted schema type set is exactly the pinned
//       allowlist;
//    2. the package stays private and carries no runtime dependency;
//    3. no published package's built dist names the private package — the
//       re-exporting packages bundle it, so installing from the registry never
//       needs it.
// ============================================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SCHEMA_TYPE_ALLOWLIST, checkSource, leaksPrivatePackage } from './boundary.js';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(pkgRoot, 'src');
const packagesRoot = resolve(pkgRoot, '..');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [join(dir, e.name)]
        : [],
  );

/** Check a synthetic file placed at src/probe.ts. */
const probe = (text: string) => checkSource(srcRoot, join(srcRoot, 'probe.ts'), text);

describe('core-twins boundary — src/ imports nothing from the host domain packages', () => {
  const files = sourceFiles(srcRoot);

  it('walks the real source tree (a check over zero files proves nothing)', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it('every import in src/ is admitted by the boundary rule', () => {
    const violations = files.flatMap(
      (f) => checkSource(srcRoot, f, readFileSync(f, 'utf8')).violations,
    );
    const rendered = violations.map(
      (v) => `${v.file.slice(pkgRoot.length + 1)}:${v.line} '${v.specifier}' — ${v.reason}`,
    );
    expect(rendered).toEqual([]);
  });

  it('the schema types src/ imports are EXACTLY the pinned allowlist', () => {
    const used = new Set(
      files.flatMap((f) => checkSource(srcRoot, f, readFileSync(f, 'utf8')).schemaTypes),
    );
    expect([...used].sort()).toEqual([...SCHEMA_TYPE_ALLOWLIST].sort());
  });
});

describe('core-twins boundary — the checker goes red on every forbidden shape', () => {
  it.each([
    ["import { encodeNode } from '@fuaran-ui/ops';", 'another host package'],
    ["import type { Node } from '@fuaran-ui/ui';", 'a type from another host package'],
    ["import { ok } from '@fuaran-ui/schema';", 'a runtime value from schema'],
    ["import { type Cell, err } from '@fuaran-ui/schema';", 'a mixed clause carrying a value'],
    ["import type { Node } from '@fuaran-ui/schema';", 'a schema type outside the allowlist'],
    ["import * as S from '@fuaran-ui/schema';", 'a namespace value import'],
    ["import '@fuaran-ui/schema';", 'a side-effect import'],
    ["export * from '@fuaran-ui/ops';", 'a re-export of a host package'],
    ["import { num } from '../../ops/src/encode.js';", 'a relative path out of src/'],
    ["import { readFileSync } from 'node:fs';", 'a platform module'],
    ["const m = await import('@fuaran-ui/ops');", 'a dynamic import'],
    ["const m = require('@fuaran-ui/ops');", 'a require'],
    ["type T = import('@fuaran-ui/ops').TreeOp;", 'an import-type query'],
  ])('flags %s (%s)', (text) => {
    expect(probe(text).violations.length).toBeGreaterThan(0);
  });

  it.each([
    ["import type { Cell, Table } from '@fuaran-ui/schema';"],
    ["import { type Cell, type Result } from '@fuaran-ui/schema';"],
    ["import { num } from './canonFloat.js';"],
    ["export { actorId } from './actor.js';"],
  ])('admits %s', (text) => {
    expect(probe(text).violations).toEqual([]);
  });
});

describe('core-twins stays private and runtime-dependency-free', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
    private?: boolean;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  it('is marked private, so it is never published', () => {
    expect(pkg.private).toBe(true);
  });

  it('declares no runtime or peer dependency', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(Object.keys(pkg.peerDependencies ?? {})).toEqual([]);
  });
});

describe('no published artefact references the private package', () => {
  interface Manifest {
    name: string;
    private?: boolean;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }
  const published = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(packagesRoot, e.name))
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .map((dir) => ({
      dir,
      pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest,
    }))
    .filter(({ pkg }) => pkg.private !== true);

  /** The packages that re-export a twin, so must bundle it. */
  const consumers = ['@fuaran-ui/ops', '@fuaran-ui/ui', '@fuaran-ui/op-stream'];

  it('no published package lists it as an installed dependency', () => {
    const offenders = published
      .filter(({ pkg }) =>
        [pkg.dependencies, pkg.peerDependencies, pkg.optionalDependencies].some(
          (deps) => deps !== undefined && '@fuaran-ui/core-twins' in deps,
        ),
      )
      .map(({ pkg }) => pkg.name);
    expect(offenders).toEqual([]);
  });

  it('every re-exporting package is built, so the dist scan below is not vacuous', () => {
    const built = published
      .filter(({ pkg }) => consumers.includes(pkg.name))
      .filter(({ dir }) => existsSync(join(dir, 'dist', 'index.js')))
      .map(({ pkg }) => pkg.name)
      .sort();
    expect(built).toEqual([...consumers].sort());
  });

  it('no built dist file names @fuaran-ui/core-twins as a module', () => {
    const offenders = published.flatMap(({ dir, pkg }) => {
      const dist = join(dir, 'dist');
      if (!existsSync(dist)) return [];
      return sourceFilesOf(dist)
        .filter((f) => leaksPrivatePackage(readFileSync(f, 'utf8')))
        .map((f) => `${pkg.name}: ${f.slice(dist.length + 1)}`);
    });
    expect(offenders).toEqual([]);
  });

  it.each([
    ['export { num } from "@fuaran-ui/core-twins";', true],
    ["import { num } from '@fuaran-ui/core-twins';", true],
    ['var t = require("@fuaran-ui/core-twins");', true],
    ["const t = await import('@fuaran-ui/core-twins');", true],
    ["import '@fuaran-ui/core-twins';", true],
    ['// ../core-twins/dist/index.js', false],
    ["import { num } from '@fuaran-ui/ops';", false],
  ])('the leak check reads %s as leaking=%s', (text, leaks) => {
    expect(leaksPrivatePackage(text)).toBe(leaks);
  });
});

function sourceFilesOf(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFilesOf(join(dir, e.name))
      : /\.(?:c|m)?js$|\.d\.(?:c|m)?ts$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}
