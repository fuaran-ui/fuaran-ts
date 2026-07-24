// fuaran_scaffold emits compiling SDK boilerplate — the TS/React templates are
// written to a temp dir INSIDE this package (so module resolution sees the
// workspace packages) and typechecked with the real TypeScript compiler.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

import { runScaffold } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const tmpRoot = join(here, 'tmp');

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function typecheck(files: readonly { path: string; contents: string }[], label: string): string[] {
  const dir = join(tmpRoot, label);
  rmSync(dir, { recursive: true, force: true });
  const paths = files.map((f) => {
    const abs = join(dir, f.path.replace(/\//g, '-'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.contents);
    return abs;
  });

  const program = ts.createProgram(paths, {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: ['node', 'react', 'react-dom'],
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}

describe('fuaran_scaffold ts-react', () => {
  it('server-proxied: emits a panel + proxy that typecheck as-is', () => {
    const result = runScaffold({ target: 'ts-react' });
    expect(result.pattern).toBe('server-proxied');
    expect(result.files.map((f) => f.path)).toEqual([
      'src/fuaran/FuaranPanel.tsx',
      'server/fuaranProxy.ts',
    ]);
    expect(typecheck(result.files, 'server-proxied')).toEqual([]);
  });

  it('browser-byok: emits a runtime-credentials panel that typechecks as-is', () => {
    const result = runScaffold({ target: 'ts-react', pattern: 'browser-byok' });
    expect(result.files).toHaveLength(1);
    expect(typecheck(result.files, 'browser-byok')).toEqual([]);
  });

  it('bakes the secret posture into the emission', () => {
    const proxied = runScaffold({ target: 'ts-react' });
    const panel = proxied.files[0]!.contents;
    const proxy = proxied.files[1]!.contents;
    // The browser side carries no credential fields at all; the server side
    // reads them from env by name.
    expect(panel).not.toMatch(/accessToken|providerKey/);
    expect(proxy).toContain("requireEnv('FUARAN_ACCESS_TOKEN')");
    expect(proxy).toContain("requireEnv('FUARAN_PROVIDER_KEY')");
    // Client-supplied credential fields are overwritten, never trusted.
    expect(proxy).toContain('...parsed, AccessToken: accessToken, ByokKey: providerKey');
  });
});

describe('fuaran_scaffold fsharp-fable', () => {
  it('emits a Feliz panel over the canonical decoder + reference renderer', () => {
    const result = runScaffold({ target: 'fsharp-fable' });
    expect(result.files).toHaveLength(1);
    const fs = result.files[0]!.contents;
    expect(fs).toContain('JsonDecode.decodeNodeObj');
    expect(fs).toContain('Render.renderWithSources BindingResolver.empty');
    expect(fs).toContain('[<ReactComponent>]');
    // Server-proxied only — no credential ever appears in the Fable emission.
    expect(fs).not.toMatch(/accessToken|providerKey|AccessToken|ByokKey/);
    expect(result.install).toContain('Fuaran.UI.Renderer');
  });
});
