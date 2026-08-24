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
import { permissiveEgress } from '@fuaran-ui/renderer/egress';

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

// ─── Protected email link (Phase 812) — the plaintext-absence lock ──────────

describe('protected email link — no plaintext address in server output', () => {
  it('link-protected-1 emits the entity-encoded anchor and no scrapeable address', () => {
    // Phase 1037 — `permissiveEgress` by name: the DEFAULT policy refuses
    // `mailto:` (`allowNonNetwork: false`), so the protected arm is
    // unreachable under it. This lock is about the entity-encoded emission,
    // not the policy; the policy has its own corpus in `egressAmbient.test.ts`.
    const html = renderToHtml(decode('link-protected-1.json'), {
      egressPolicy: permissiveEgress,
    });
    // The wrapper + protected classes, with every href/label character a
    // decimal entity (&#109;… = 'mailto:'). Byte-locked to the F# server
    // renderer's emission.
    expect(html).toContain('<span class="fuaran-link-protected-wrap">');
    expect(html).toContain(
      '<a class="fuaran-link fuaran-link-protected" href="&#109;&#97;&#105;&#108;&#116;&#111;&#58;',
    );
    // The raw source carries no plaintext address, local part, or scheme.
    expect(html).not.toContain('mailto:');
    expect(html).not.toContain('contact@example.com');
    expect(html).not.toContain('@example');
  });
});

// ─── Drawing Label rotation (Phase 877) — the cross-host emission lock ──────

describe('rotated Drawing labels emit transform=rotate anchored at the label', () => {
  it('drawing-rotated-labels matches the F# reference emission byte-for-byte', () => {
    const html = renderToHtml(decode('drawing-rotated-labels.json'));

    // The pivot is each label's own (x, y) — not the viewBox origin — so the
    // rotation composes with `textAnchor` rather than fighting it. These are
    // the exact strings the F# `DrawingSvg` emitter produces for the same
    // fixture; the corpus is the oracle, and this is the emission half of the
    // conformance the codec round-trip does not cover.
    expect(html).toContain('transform="rotate(-30 30 100)"'); // tilted category label
    expect(html).toContain('transform="rotate(-90 70 100)"'); // vertical escalation
    expect(html).toContain('transform="rotate(90 8 60)"'); // rotated y-axis title
    expect(html).toContain('transform="rotate(12.34 110 100)"'); // 2-dp fraction
    expect(html).toContain('transform="rotate(-0.5 180 100)"'); // negative fraction

    // An explicit 0 is a PRESENT value and must still emit: absent and zero are
    // different wire shapes, and a renderer that conflates them re-introduces
    // downstream the very distinction the codec is careful to preserve.
    expect(html).toContain('transform="rotate(0 150 100)"');

    // The unrotated label in the same fixture emits no transform at all — the
    // byte-unchanged guarantee for every pre-877 drawing.
    expect(html).toContain('<text class="fuaran-drawing-label" x="100" y="20"');
    expect(html.match(/transform="rotate\(/g)).toHaveLength(6);
  });
});

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
