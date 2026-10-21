// ============================================================================
//  Phase 2285 — the fragment-scope parity tree.
//
//  The same wire document is asserted by the .NET renderers' agreement tests,
//  so both hosts certify one answer to "which positions are fragment scope":
//  the kind-held positions plus `state.onLoading` / `state.onEmpty` are; the
//  envelope `fallback` and a `FragmentRef` slot argument are not. Collection
//  and namespacing walk that same reach.
// ============================================================================

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import type { Node } from '@fuaran-ui/schema';

import { collectFragments, FuaranRenderer } from '../src/index.js';

const md = (id: string, text: string) => ({ id, kind: { $type: 'Markdown', text } });
const decl = (id: string, name: string) => ({
  id,
  kind: { $type: 'FragmentDecl', body: md(`inner-${name}`, `BODY-${name}`), name },
});
const ref = (id: string, name: string) => ({ id, kind: { $type: 'FragmentRef', name } });

const parityTree = JSON.stringify({
  id: 'page',
  kind: {
    $type: 'Box',
    children: [
      {
        ...md('host', 'HOST'),
        state: {
          onEmpty: decl('d-empty', 'tpl-empty'),
          onLoading: decl('d-loading', 'tpl-loading'),
        },
      },
      { ...md('fb-host', 'FB-HOST'), fallback: decl('d-fallback', 'tpl-fallback') },
      {
        id: 'arg-ref',
        kind: {
          $type: 'FragmentRef',
          args: { slot: { $type: 'SlotArg', tree: decl('d-arg', 'tpl-arg') } },
          name: 'tpl-loading',
        },
      },
      ref('ref-loading', 'tpl-loading'),
      ref('ref-empty', 'tpl-empty'),
      ref('ref-fallback', 'tpl-fallback'),
      ref('ref-arg', 'tpl-arg'),
    ],
    layout: { $type: 'Flex', direction: 'Vertical', wrap: false },
    role: 'Group',
  },
});

const decoded = (): Node<unknown> => {
  const d = decodeNode(parityTree);
  if (!d.ok) throw new Error(`parity tree failed to decode: ${JSON.stringify(d.error)}`);
  return d.value as Node<unknown>;
};

describe('Phase 2285 — a state arm is fragment scope, on every host', () => {
  it('registers the decls held in state.onLoading and state.onEmpty, and nothing in fallback or a slot argument', () => {
    const found = collectFragments(new Map<string, Node<unknown>>(), decoded());
    expect([...found.keys()].sort()).toEqual(['tpl-empty', 'tpl-loading']);
  });

  it('renders a reference to a state-arm decl as its body, namespaced under the reference', () => {
    const html = renderToStaticMarkup(<FuaranRenderer tree={decoded()} />);
    expect(html).toContain('id="ref-loading.inner-tpl-loading"');
    expect(html).toContain('id="ref-empty.inner-tpl-empty"');
    expect(html).toContain('data-fuaran-fragment-unresolved="tpl-fallback"');
    expect(html).toContain('data-fuaran-fragment-unresolved="tpl-arg"');
  });
});
