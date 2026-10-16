// ============================================================================
//  A document-chosen name never reaches `Object.prototype` (Phase 1931).
//
//  Every bag the binding resolver reads is keyed by a name the DOCUMENT chose:
//  `$state.<key>`, `$filters.<name>`, a selection's node id, a Transform ref,
//  an i18n key. Indexing one with `bag[key]` walks the prototype chain, so
//  `{"$type":"State","key":"constructor"}` resolved to the `Object` function and
//  a text slot rendered `function Object() { [native code] }` where the
//  reference host (a `Map`) answers NotResolved. Both tiers are asserted here
//  side by side: the claim is that they agree, and agree on "unset".
// ============================================================================

import { describe, expect, it } from 'vitest';

import type { Binding, TextSource } from '@fuaran-ui/schema';
import { decodeNode } from '@fuaran-ui/ops';
import { renderText as renderTextClient, resolve as resolveClient } from '@fuaran-ui/renderer';

import { renderToHtml } from '../src/index.js';
import { renderText as renderTextServer, resolve as resolveServer } from '../src/bindings.js';

const NAMES = ['constructor', 'hasOwnProperty', 'toString', '__proto__'] as const;

/** A populated host bag: real data under other keys, so "unset" is not "empty". */
const sources = {
  state: { revenue: 1 },
  filters: { region: 'eu' },
  selections: { grid: { id: 'r1' } },
  queryResults: { q: [1] },
  i18n: { greeting: 'Hello' },
};

const both = (b: Binding<unknown>) => [resolveServer(sources, b), resolveClient(sources, b)];

describe('Phase 1931 — prototype-named keys resolve as unset on both tiers', () => {
  it.each(NAMES)('State `%s` is NotResolved', (key) => {
    const b = { kind: 'State', key } as unknown as Binding<unknown>;
    expect(both(b)).toEqual([{ kind: 'NotResolved' }, { kind: 'NotResolved' }]);
  });

  it.each(NAMES)('Filter `%s` is NotResolved', (name) => {
    const b = { kind: 'Filter', name } as unknown as Binding<unknown>;
    expect(both(b)).toEqual([{ kind: 'NotResolved' }, { kind: 'NotResolved' }]);
  });

  it.each(NAMES)('Selection on node `%s` is NotResolved', (nodeId) => {
    const b = {
      kind: 'Selection',
      nodeId,
      accessor: (r: unknown) => r,
    } as unknown as Binding<unknown>;
    expect(both(b)).toEqual([{ kind: 'NotResolved' }, { kind: 'NotResolved' }]);
  });

  it.each(NAMES)('Query `%s` is NotResolved', (name) => {
    const b = { kind: 'Query', name, accessor: (r: unknown) => r } as unknown as Binding<unknown>;
    expect(both(b)).toEqual([{ kind: 'NotResolved' }, { kind: 'NotResolved' }]);
  });

  it.each(NAMES)('a Transform Ref `%s` is "not provided"', (name) => {
    const b = {
      kind: 'Transform',
      source: { kind: 'Data', source: { kind: 'Ref', name } },
      pipeline: [],
    } as unknown as Binding<unknown>;
    const [server, client] = both(b);
    expect(server).toEqual({
      kind: 'Errored',
      message: `Transform source ref '${name}' not provided`,
    });
    expect(client).toEqual(server);
  });

  it.each(NAMES)('i18n key `%s` is a missing translation', (key) => {
    const t: TextSource = { kind: 'I18n', key, args: {} } as unknown as TextSource;
    expect(renderTextServer(sources, t)).toBe(`[i18n:${key}]`);
    expect(renderTextClient(sources, t)).toBe(`[i18n:${key}]`);
  });

  it('the markup of a bare `State key:"constructor"` label carries no function source', () => {
    const doc = JSON.stringify({
      id: 't',
      kind: {
        $type: 'Badge',
        label: { $type: 'Bound', binding: { $type: 'State', key: 'constructor' } },
        variant: 'Info',
      },
    });
    const decoded = decodeNode(doc);
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.error));
    const html = renderToHtml(decoded.value, { sources });
    expect(html).not.toContain('native code');
    expect(html).not.toContain('Object()');
  });

  it('a WRITTEN prototype-named key still resolves — the guard is ownership, not the name', () => {
    const written = { state: Object.assign(Object.create(null), { constructor: 'built' }) };
    const b = { kind: 'State', key: 'constructor' } as unknown as Binding<unknown>;
    expect(resolveServer(written, b)).toEqual({ kind: 'Resolved', value: 'built' });
    expect(resolveClient(written, b)).toEqual({ kind: 'Resolved', value: 'built' });
  });
});
