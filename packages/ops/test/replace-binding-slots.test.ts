// ============================================================================
//  ReplaceBinding reads the IDL's slot table (Phase 2329).
//
//  `apply`'s ReplaceBinding dispatch used to be a fourth hand-kept slot table,
//  and it lagged the vocabulary: the nine slots Phase 2073's generated table
//  added (and five more the older hand tables named) were refused although the
//  IDL declares them. It now reads `BINDING_SLOTS`, the table introspection and
//  the renderer's declared slots read, so every declared slot is replaceable
//  and an undeclared one is still `SlotNotFound`.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  BINDING_SLOTS,
  KIND_CATEGORY,
  kindSpec,
  type Binding,
  type Node,
  type NodeId,
  type NodeKind,
  type NodeKindName,
} from '@fuaran-ui/schema';

import { apply } from '../src/index.js';

const nid = (s: string): NodeId => s as NodeId;

/** A node of the IDL kind `k` carrying `spec`, wrapped the way this host spells the kind. */
const kindOf = (k: NodeKindName, spec: Record<string, unknown>): NodeKind<unknown> => {
  switch (KIND_CATEGORY[k]) {
    case 'Layout':
      return { kind: 'Layout', layout: { kind: k, spec } } as unknown as NodeKind<unknown>;
    case 'Display':
      return { kind: 'Display', display: { kind: k, spec } } as unknown as NodeKind<unknown>;
    case 'Input':
      return { kind: 'Input', input: { kind: k, spec } } as unknown as NodeKind<unknown>;
    case 'Visualisation':
      return {
        kind: 'Visualisation',
        visualisation: { kind: k === 'DataGrid' ? 'Grid' : k, spec },
      } as unknown as NodeKind<unknown>;
    case 'Meta':
      return { kind: k, spec } as unknown as NodeKind<unknown>;
  }
};

const root = (child: Node<unknown>): Node<unknown> => ({
  id: nid('root'),
  kind: {
    kind: 'Layout',
    layout: {
      kind: 'Box',
      spec: {
        layout: { kind: 'Auto' },
        role: 'Dashboard',
        keepTogether: false,
        breakBefore: false,
        children: [child],
      },
    },
  },
  state: {},
  style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
});

const target = (k: NodeKindName): Node<unknown> => ({
  id: nid('t'),
  kind: kindOf(k, { marker: 'kept' }),
  state: {},
  style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
});

const replacement: Binding<unknown> = { kind: 'State', key: 'replaced', defaultValue: undefined };

const replace = (k: NodeKindName, slot: string) =>
  apply(root(target(k)), { kind: 'ReplaceBinding', target: nid('t'), slot, binding: replacement });

/** The nine slots the hand-kept dispatch omitted that Phase 2073's generated table carries. */
const ADDED_BY_2073: readonly (readonly [NodeKindName, string, string])[] = [
  ['Modal', 'Open', 'open'],
  ['Toast', 'Open', 'open'],
  ['Embed', 'Src', 'src'],
  ['Switch', 'On', 'on'],
  ['Link', 'Href', 'href'],
  ['Image', 'Src', 'src'],
  ['Media', 'Src', 'src'],
  ['DataGrid', 'RowTotal', 'rowTotal'],
  ['Select', 'Values', 'values'],
];

const replacedMember = (k: NodeKindName, slot: string, field: string): unknown => {
  const r = replace(k, slot);
  if (!r.ok) throw new Error(`ReplaceBinding ${k}.${slot} was refused: ${r.error.message}`);
  // The target is the root's only child; read it directly rather than walking a
  // tree whose target carries no real children.
  const tree = r.value.newTree;
  const after = tree.kind.kind === 'Layout' ? tree.kind.layout.spec.children[0] : undefined;
  const spec = after === undefined ? undefined : kindSpec(after.kind);
  expect(spec?.['marker']).toBe('kept');
  return spec?.[field];
};

describe('ReplaceBinding — the slot set is the IDL binding-slot table', () => {
  it.each(ADDED_BY_2073)('applies on %s.%s', (k, slot, field) => {
    expect(BINDING_SLOTS[k].some((s) => s.slot === slot && s.field === field)).toBe(true);
    expect(replacedMember(k, slot, field)).toEqual(replacement);
  });

  it('applies on every slot the IDL declares', () => {
    const all = (Object.keys(BINDING_SLOTS) as NodeKindName[]).flatMap((k) =>
      BINDING_SLOTS[k].map((s) => [k, s.slot, s.field] as const),
    );
    expect(all.length).toBeGreaterThan(ADDED_BY_2073.length);
    for (const [k, slot, field] of all) expect(replacedMember(k, slot, field)).toEqual(replacement);
  });

  it.each([
    ['Embed', 'Value'],
    ['Metric', 'Src'],
    ['Heading', 'Text'],
    ['Box', 'Children'],
    ['Select', 'Nope'],
    ['Metric', 'value'],
  ] as const)('refuses the undeclared slot %s.%s', (k, slot) => {
    const r = replace(k, slot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SlotNotFound');
  });
});
