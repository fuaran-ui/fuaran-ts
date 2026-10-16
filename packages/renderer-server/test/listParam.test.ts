// ============================================================================
//  @fuaran-ui/renderer-server — LIST-valued `Transform` params (Phase 610 on
//  this tier, ported by Phase 1931).
//
//  A multi-select chip stores its selection as a LIST, and a `filter` step's
//  `in`/`param` membership test reads it as a list param: it resolves by
//  SUBSTITUTION before the prune, and an EMPTY selection is unbound, so the step
//  prunes ("nothing selected ⇒ no constraint"). The client renderer has done this
//  since Phase 610 and the py / go / rs server renderers since Phase 1156; this
//  tier refused every list param as "resolved to a non-scalar value", so a table
//  filtered by a chip painted an error on first paint and the table after
//  hydration.
//
//  The document is the shared corpus fixture `nodes/multiselect-chip-list-param`
//  (the one Phase 1156 certified the other server renderers against), so this
//  pin and theirs read the same bytes.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Binding } from '@fuaran-ui/schema';
import { decodeNode } from '@fuaran-ui/ops';
import { resolve as resolveClient } from '@fuaran-ui/renderer';

import { renderToHtml } from '../src/index.js';
import { resolve as resolveServer, type BindingSources } from '../src/bindings.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const FIXTURE = join(wireCorpusRoot(), 'nodes', 'multiselect-chip-list-param.json');

const decodeFixture = () => {
  const decoded = decodeNode(readFileSync(FIXTURE, 'utf8'));
  if (!decoded.ok) throw new Error(`fixture decode failed: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

/** The grid's `source` — the one Transform in the document, which the chip's selection scopes. */
const gridSource = (): Binding<unknown> => {
  const found: Binding<unknown>[] = [];
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if ((v as { kind?: unknown }).kind === 'Transform') found.push(v as Binding<unknown>);
    for (const child of Object.values(v)) visit(child);
  };
  visit(decodeFixture());
  if (found.length !== 1) throw new Error(`expected one Transform, found ${found.length}`);
  return found[0]!;
};

const depts = (sources: BindingSources): unknown => {
  const r = resolveServer(sources, gridSource());
  if (r.kind !== 'Resolved') throw new Error(`expected Resolved, got ${JSON.stringify(r)}`);
  return (r.value as readonly { readonly dept: unknown }[]).map((row) => row.dept);
};

const withSelection = (selection: unknown): BindingSources => ({
  filters: { depts: selection },
});

describe('Phase 1931 — SSR list-valued Transform params', () => {
  it('a selection scopes the rows', () => {
    expect(depts(withSelection(['eng']))).toEqual(['eng']);
    expect(depts(withSelection(['eng', 'ops']))).toEqual(['eng', 'ops']);
  });

  it('an EMPTY selection prunes the step: every row, never an error', () => {
    expect(depts(withSelection([]))).toEqual(['eng', 'sales', 'ops']);
  });

  it('an unset chip prunes the step, exactly as an unset scalar chip does', () => {
    expect(depts({})).toEqual(['eng', 'sales', 'ops']);
  });

  it('a nested array is still the loud non-scalar error', () => {
    const r = resolveServer(withSelection([['eng']]), gridSource());
    expect(r).toEqual({
      kind: 'Errored',
      message: "Transform param 'depts' resolved to a non-scalar value",
    });
  });

  it('the server and the client resolve every selection identically', () => {
    for (const selection of [undefined, [], ['eng'], ['sales', 'ops'], 'eng', [['eng']]]) {
      const sources = selection === undefined ? {} : withSelection(selection);
      expect(resolveServer(sources, gridSource())).toEqual(resolveClient(sources, gridSource()));
    }
  });

  it('the first paint is the filtered table, not an error', () => {
    const html = renderToHtml(decodeFixture(), { sources: withSelection(['eng']) });
    expect(html).not.toContain('non-scalar');
    expect(html).toContain('>eng<');
    expect(html).not.toContain('>sales<');
    expect(html).not.toContain('>ops<');
  });
});
