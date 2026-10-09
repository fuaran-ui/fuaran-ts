// ============================================================================
//  Phase 2076 — what the root entry costs a consumer that renders one node.
//
//  Three properties, each of which a bundler relies on and none of which a
//  type-check notices going away:
//
//   1. `enhanceMath` (and with it `katex`) is NOT re-exported from the package
//      root. It is reached through `@fuaran-ui/renderer/enhance-math`.
//   2. `<FuaranRenderer>` reaches the DEBUG-only surfaces (`debugGlobal.ts`, the
//      DevTools relay) by dynamic import only, so nothing in its static import
//      graph pulls them — or `katex` — into a production bundle.
//   3. Every library package declares `sideEffects`, so a bundler may drop a
//      module the consumer does not use; the renderer's declaration keeps its
//      stylesheet, which is imported for its effect alone.
// ============================================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { fuaran } from '@fuaran-ui/ui';

import { FuaranRenderer } from '../src/Renderer.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');
const packagesDir = join(here, '..', '..');

/** The VALUE imports of a module (type-only imports and `import()` excluded). */
const staticValueImports = (file: string): string[] => {
  const text = readFileSync(file, 'utf8');
  const specs: string[] = [];
  const re = /^(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?'([^']+)'/gms;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[1] === undefined) specs.push(m[2]!);
  }
  return specs;
};

/** Resolve a relative `.js` specifier to the `.ts` / `.tsx` source beside it. */
const resolveLocal = (from: string, spec: string): string | undefined => {
  const base = resolve(dirname(from), spec).replace(/\.js$/, '');
  for (const ext of ['.ts', '.tsx']) if (existsSync(base + ext)) return base + ext;
  return undefined;
};

/** Every source module and bare package reachable from `entry` by static value import. */
const staticGraph = (entry: string): { modules: Set<string>; packages: Set<string> } => {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (modules.has(file)) return;
    modules.add(file);
    for (const spec of staticValueImports(file)) {
      if (spec.startsWith('.')) {
        const next = resolveLocal(file, spec);
        if (next !== undefined) visit(next);
      } else packages.add(spec);
    }
  };
  visit(entry);
  return { modules, packages };
};

const baseName = (p: string): string => p.split(/[\\/]/).pop()!;

describe('the root barrel (Phase 2076)', () => {
  it('does not re-export enhanceMath: the KaTeX pass lives at the enhance-math subpath', async () => {
    const root = (await import('../src/index.js')) as Record<string, unknown>;
    expect(root['enhanceMath']).toBeUndefined();
    expect(root['parseMathSegments']).toBeUndefined();
    const subpath = await import('../src/enhanceMath.js');
    expect(typeof subpath.enhanceMath).toBe('function');
    expect(typeof subpath.parseMathSegments).toBe('function');
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    expect(pkg.exports['./enhance-math'].import).toBe('./dist/enhanceMath.js');
  });

  it('keeps katex, the debug surface and the relay out of the root entry static graph', () => {
    const { modules, packages } = staticGraph(join(src, 'index.ts'));
    expect([...packages]).not.toContain('katex');
    const names = [...modules].map(baseName);
    expect(names).not.toContain('enhanceMath.ts');
    expect(names).not.toContain('debugGlobal.ts');
    expect(names).not.toContain('relay.ts');
  });

  // Every export that left the root in Phase 2076 is reachable at a subpath —
  // nothing became unreachable. The lists are the STABILITY.md record's lists.
  const movedToDebug = [
    'DEBUG_GLOBAL_KEY',
    'DEBUG_GLOBAL_VERSION',
    'buildDebugGlobal',
    'readRegisteredDebugGlobal',
    'registerDebugGlobal',
  ];
  const movedToRelay = [
    'RELAY_KEY',
    'RELAY_PROFILE',
    'acceptsRelayMessage',
    'createRelayPeer',
    'installRelayPeer',
    'parseRelayProfile',
  ];

  it('the debug and relay values left the root and live at ./debug and ./relay', async () => {
    const root = (await import('../src/index.js')) as Record<string, unknown>;
    const debug = (await import('../src/debug.js')) as Record<string, unknown>;
    const relay = (await import('../src/relay.js')) as Record<string, unknown>;
    for (const n of [...movedToDebug, ...movedToRelay]) expect(root[n], n).toBeUndefined();
    for (const n of movedToDebug) expect(debug[n], n).toBeDefined();
    for (const n of movedToRelay) expect(relay[n], n).toBeDefined();
    // The ./debug subpath is exactly the set that left the root — no widening.
    expect(Object.keys(debug).sort()).toEqual([...movedToDebug].sort());
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    expect(pkg.exports['./debug'].import).toBe('./dist/debug.js');
    expect(pkg.exports['./relay'].import).toBe('./dist/relay.js');
  });

  it('<FuaranRenderer> reaches debugGlobal and the relay by dynamic import only', () => {
    const { modules, packages } = staticGraph(join(src, 'Renderer.tsx'));
    const names = [...modules].map(baseName);
    expect(names).not.toContain('debugGlobal.ts');
    expect(names).not.toContain('relay.ts');
    expect(names).not.toContain('enhanceMath.ts');
    expect([...packages]).not.toContain('katex');
    // …and it does still load them, lazily, when `debug` is set.
    const text = readFileSync(join(src, 'Renderer.tsx'), 'utf8');
    expect(text).toContain("import('./debugGlobal.js')");
    expect(text).toContain("import('./relay.js')");
  });

  it('an unmount before the debug surface arrives leaves no global behind', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const tree = fuaran.stack<unknown>({ id: 't', children: [] });
    const container = document.createElement('div');
    const root = createRoot(container);
    // Mount and unmount in ONE synchronous act: the effect's cleanup runs before
    // the dynamic import resolves, so the late arrival must not register.
    act(() => {
      root.render(createElement(FuaranRenderer, { tree, debug: true }));
    });
    act(() => root.unmount());
    await import('../src/debugGlobal.js');
    await new Promise((r) => setTimeout(r, 0));
    expect((window as unknown as Record<string, unknown>)['__fuaran']).toBeUndefined();
  });

  it('a mounted debug renderer registers the global once the module arrives', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const tree = fuaran.stack<unknown>({ id: 't', children: [] });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(FuaranRenderer, { tree, debug: true }));
    });
    await new Promise((r) => setTimeout(r, 0));
    expect((window as unknown as Record<string, unknown>)['__fuaran']).toBeDefined();
    act(() => root.unmount());
    expect((window as unknown as Record<string, unknown>)['__fuaran']).toBeUndefined();
  });
});

describe('sideEffects declarations (Phase 2076)', () => {
  const libraries = readdirSync(packagesDir).filter((d) => existsSync(join(packagesDir, d, 'src')));

  it('every package with source declares sideEffects', () => {
    expect(libraries.length).toBeGreaterThan(10);
    const undeclared = libraries.filter((d) => {
      const pkg = JSON.parse(readFileSync(join(packagesDir, d, 'package.json'), 'utf8'));
      return pkg.sideEffects === undefined;
    });
    expect(undeclared).toEqual([]);
  });

  // `sideEffects: false` is a promise that importing a module for its effect alone
  // does nothing. A top-level expression statement, a bare `import 'x'`, or a
  // top-level control-flow statement is where such an effect would live (a CSS
  // import, a global registration, a custom-element definition, a patched
  // global), so a package making the promise may hold none — outside the files
  // its array form names.
  it('a package declaring sideEffects: false has no top-level effectful statement', () => {
    const sourceFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? sourceFiles(join(dir, e.name))
          : /\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')
            ? [join(dir, e.name)]
            : [],
      );
    const offenders: string[] = [];
    for (const d of libraries) {
      const pkg = JSON.parse(readFileSync(join(packagesDir, d, 'package.json'), 'utf8'));
      const declared: readonly string[] = pkg.sideEffects === false ? [] : (pkg.sideEffects ?? []);
      if (pkg.sideEffects !== false && !Array.isArray(pkg.sideEffects)) continue;
      for (const file of sourceFiles(join(packagesDir, d, 'src'))) {
        const stem = baseName(file).replace(/\.(ts|tsx|mts)$/, '');
        if (declared.some((g) => baseName(g).replace(/\.c?js$/, '') === stem)) continue;
        const sf = ts.createSourceFile(
          file,
          readFileSync(file, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        );
        for (const st of sf.statements) {
          const effectful =
            (ts.isImportDeclaration(st) && st.importClause === undefined) ||
            ts.isExpressionStatement(st) ||
            ts.isIfStatement(st) ||
            ts.isIterationStatement(st, false) ||
            ts.isTryStatement(st);
          if (effectful) {
            const line = sf.getLineAndCharacterOfPosition(st.getStart()).line + 1;
            offenders.push(`${d}/${baseName(file)}:${line}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the renderer's declaration keeps its stylesheet import", () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    expect(pkg.sideEffects).toEqual(['*.css']);
    expect(pkg.exports['./css']).toMatch(/\.css$/);
  });

  it('a package with a CLI entry names it as its one side-effecting module', () => {
    for (const d of libraries) {
      const pkg = JSON.parse(readFileSync(join(packagesDir, d, 'package.json'), 'utf8'));
      if (pkg.bin === undefined) continue;
      const bins = Object.values(pkg.bin as Record<string, string>);
      expect(pkg.sideEffects, d).toEqual(expect.arrayContaining(bins));
    }
  });
});
