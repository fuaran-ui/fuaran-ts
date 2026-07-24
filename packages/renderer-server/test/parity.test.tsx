// ============================================================================
//  Render-parity corpus — the cross-host lock that makes this a fidelity twin.
//
//  Two locks over the whole node fixture corpus:
//
//   Lock A (TS authority): the SET of fuaran-* classes and the SET of
//     data-fuaran-node-id values the server renderer emits equal those the React
//     client renderer (@fuaran-ui/renderer via renderToStaticMarkup) emits for
//     the same decoded tree. This is what guarantees a hydration handoff finds
//     the markup it expects, and that the packaged reference CSS styles the
//     server output identically.
//
//   Lock B (F# authority): every fuaran-* class the server renderer emits is in
//     the vocabulary extracted from the F# reference renderer source — the same
//     cross-host parity lock the Python host carries. Skips when the F# sibling
//     is not checked out alongside.
// ============================================================================

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import { FuaranRenderer } from '@fuaran-ui/renderer';

import { renderToHtml } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const estateRoot = join(here, '..', '..', '..', '..');
const nodesDir = join(estateRoot, 'wire-format-fixtures', 'nodes');

const fixtureFiles = readdirSync(nodesDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const decode = (file: string) => {
  const decoded = decodeNode(readFileSync(join(nodesDir, file), 'utf8'));
  if (!decoded.ok) throw new Error(`decode failed for ${file}: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

/** The sorted set of `fuaran-*` class tokens emitted anywhere in the HTML. */
const fuaranClasses = (html: string): string[] => {
  const out = new Set<string>();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const tok of m[1]!.split(/\s+/)) if (tok.startsWith('fuaran-')) out.add(tok);
  }
  return [...out].sort();
};

/** The sorted set of `data-fuaran-node-id` values emitted in the HTML. */
const nodeIds = (html: string): string[] => {
  const out = new Set<string>();
  for (const m of html.matchAll(/data-fuaran-node-id="([^"]+)"/g)) out.add(m[1]!);
  return [...out].sort();
};

describe('Lock A — server output matches the React client renderer (class + node-id sets)', () => {
  it.each(fixtureFiles)('%s emits the same fuaran-* class set as <FuaranRenderer>', (file) => {
    const tree = decode(file);
    const server = renderToHtml(tree);
    const react = renderToStaticMarkup(<FuaranRenderer tree={tree} />);
    expect(fuaranClasses(server)).toEqual(fuaranClasses(react));
  });

  it.each(fixtureFiles)('%s emits the same data-fuaran-node-id set as <FuaranRenderer>', (file) => {
    const tree = decode(file);
    const server = renderToHtml(tree);
    const react = renderToStaticMarkup(<FuaranRenderer tree={tree} />);
    expect(nodeIds(server)).toEqual(nodeIds(react));
  });
});

// ─── Lock B — F# reference-renderer vocabulary ───────────────────────────────

const referenceRendererFiles = [
  join(estateRoot, 'fuaran', 'src', 'Fuaran.UI.Renderer.Server', 'Render.fs'),
  join(estateRoot, 'fuaran', 'src', 'Fuaran.UI.Renderer', 'Render.fs'),
  join(estateRoot, 'fuaran', 'src', 'Fuaran.UI.Renderer.Core', 'Theme.fs'),
  // Phase 525 — the Drawing SVG class vocabulary (fuaran-drawing*) lives here.
  join(estateRoot, 'fuaran', 'src', 'Fuaran.UI.Renderer.Core', 'DrawingSvg.fs'),
];

const referenceAvailable = referenceRendererFiles.every((p) => existsSync(p));

const referenceVocabulary = (): { exact: Set<string>; prefixes: string[] } => {
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  for (const path of referenceRendererFiles) {
    const src = readFileSync(path, 'utf8');
    for (const m of src.matchAll(/fuaran-[a-zA-Z0-9-]*/g)) {
      const token = m[0];
      if (token.endsWith('-')) prefixes.add(token);
      else exact.add(token);
    }
  }
  return { exact, prefixes: [...prefixes] };
};

describe.skipIf(!referenceAvailable)(
  'Lock B — server classes are in the F# reference vocabulary',
  () => {
    it('the extracted reference vocabulary is non-trivial', () => {
      const { exact, prefixes } = referenceVocabulary();
      expect(exact.size).toBeGreaterThan(50);
      expect(exact.has('fuaran-node')).toBe(true);
      expect(prefixes).toContain('fuaran-custom-');
    });

    it.each(fixtureFiles)('%s emits only classes in the F# reference vocabulary', (file) => {
      const { exact, prefixes } = referenceVocabulary();
      const html = renderToHtml(decode(file));
      for (const cls of fuaranClasses(html)) {
        const inVocab = exact.has(cls) || prefixes.some((p) => cls.startsWith(p));
        expect(inVocab, `class ${cls} is not in the F# reference renderer vocabulary`).toBe(true);
      }
    });
  },
);
