import { describe, expect, it } from 'vitest';

import {
  action,
  fuaran,
  nodeId,
  preEmitValidate,
  type Node,
  type NodeId,
  type PreEmitDefect,
} from '../src/index.js';

type Msg = 'noop';

const id = (s: string): NodeId => nodeId(s);

const codesOf = (n: Node<Msg>): readonly PreEmitDefect['code'][] => {
  const r = preEmitValidate(n);
  return r.ok ? [] : r.error.map((d) => d.code);
};

describe('preEmitValidate', () => {
  it('returns ok with a branded ValidatedNode for a clean tree', () => {
    const tree = fuaran.dashboard<Msg>({
      id: id('root'),
      children: [fuaran.metric<Msg>({ id: id('sales'), label: 'Sales', value: 1 })],
    });
    const r = preEmitValidate(tree);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe('root');
  });

  it('surfaces EMPTY_NODE_ID', () => {
    const tree = fuaran.metric<Msg>({ id: id(''), label: 'x', value: 1 });
    expect(codesOf(tree)).toContain('EMPTY_NODE_ID');
  });

  it('surfaces DUPLICATE_NODE_ID with the offending id and count', () => {
    const dup = fuaran.metric<Msg>({ id: id('twin'), label: 'x', value: 1 });
    const tree = fuaran.dashboard<Msg>({ id: id('root'), children: [dup, dup] });
    const r = preEmitValidate(tree);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const dupDefect = r.error.find((d) => d.code === 'DUPLICATE_NODE_ID');
      expect(dupDefect).toMatchObject({ code: 'DUPLICATE_NODE_ID', id: 'twin', count: 2 });
    }
  });

  it('surfaces EMPTY_CUSTOM_KIND_IDENTIFIER', () => {
    const tree = fuaran.custom<Msg>({ id: id('c'), moduleId: '', componentId: 'comp' });
    expect(codesOf(tree)).toContain('EMPTY_CUSTOM_KIND_IDENTIFIER');
  });

  it('surfaces TAB_HEADER_COUNT_MISMATCH', () => {
    const tree = fuaran.tabs<Msg>({
      id: id('t'),
      children: [fuaran.card<Msg>({ id: id('c1') }), fuaran.card<Msg>({ id: id('c2') })],
      tabHeaders: [{ label: { kind: 'Literal', value: 'only-one' } }],
    });
    expect(codesOf(tree)).toContain('TAB_HEADER_COUNT_MISMATCH');
  });

  it('surfaces TAB_TAG_COUNT_MISMATCH', () => {
    const tree = fuaran.tabs<Msg>({
      id: id('t'),
      children: [fuaran.card<Msg>({ id: id('c1') })],
      tabTags: ['one', 'two'],
    });
    expect(codesOf(tree)).toContain('TAB_TAG_COUNT_MISMATCH');
  });

  it('surfaces TAB_ACTIVE_TAG_WITHOUT_TAGS', () => {
    const tree = fuaran.tabs<Msg>({
      id: id('t'),
      children: [fuaran.card<Msg>({ id: id('c1') })],
      activeTag: { kind: 'Static', value: 'one' },
    });
    expect(codesOf(tree)).toContain('TAB_ACTIVE_TAG_WITHOUT_TAGS');
  });

  it('collects every defect in one pass rather than short-circuiting', () => {
    const dup = fuaran.custom<Msg>({ id: id('dup'), moduleId: '', componentId: '' });
    const tree = fuaran.dashboard<Msg>({ id: id('dup'), children: [dup] });
    const codes = codesOf(tree);
    expect(codes).toContain('DUPLICATE_NODE_ID');
    expect(codes).toContain('EMPTY_CUSTOM_KIND_IDENTIFIER');
  });

  it('recurses through ErrorBoundary child and fallback', () => {
    const tree = fuaran.errorBoundary<Msg>({
      id: id('eb'),
      child: fuaran.metric<Msg>({ id: id('shared'), label: 'x', value: 1 }),
      fallback: fuaran.metric<Msg>({ id: id('shared'), label: 'y', value: 2 }),
    });
    expect(codesOf(tree)).toContain('DUPLICATE_NODE_ID');
  });

  it('uses action helpers without affecting validation outcome', () => {
    const tree = fuaran.button<Msg>({
      id: id('b'),
      label: 'go',
      onClick: action.dispatch<Msg>('noop'),
    });
    expect(preEmitValidate(tree).ok).toBe(true);
  });

  // ── FUARAN069 — inert-control check (Phase 426 write-back default) ──

  it('surfaces INERT_CONTROL for a handler-free form field over a non-writable binding', () => {
    const tree = fuaran.form<Msg>({
      id: id('frm'),
      onSubmit: action.chain<Msg>([]),
      fields: [
        {
          id: 'inert-name',
          label: { kind: 'Literal', value: 'Name' },
          kind: { kind: 'Text', value: { kind: 'Static', value: '' } },
          required: false,
        },
      ],
    });
    const r = preEmitValidate(tree);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({
        code: 'INERT_CONTROL',
        nodeId: 'frm',
        control: 'FormField(inert-name)',
      });
    }
  });

  it('passes a handler-free form field whose value is State-bound (write-back target)', () => {
    const tree = fuaran.form<Msg>({
      id: id('frm'),
      onSubmit: action.chain<Msg>([]),
      fields: [
        {
          id: 'profile-name',
          label: { kind: 'Literal', value: 'Name' },
          kind: {
            kind: 'Text',
            value: { kind: 'State', key: 'profileName', defaultValue: '' },
          },
          required: false,
        },
      ],
    });
    expect(preEmitValidate(tree).ok).toBe(true);
  });

  it('surfaces INERT_CONTROL for a dismissable modal with no onDismiss and a static open', () => {
    const tree = fuaran.modal<Msg>({ id: id('confirm'), dismissable: true });
    expect(codesOf(tree)).toContain('INERT_CONTROL');
  });

  it('surfaces INERT_CONTROL for fully-static handler-free tabs, and passes State-bound ones', () => {
    const inert = fuaran.tabs<Msg>({
      id: id('t'),
      children: [fuaran.card<Msg>({ id: id('c1') })],
    });
    expect(codesOf(inert)).toContain('INERT_CONTROL');

    const live = fuaran.tabs<Msg>({
      id: id('t'),
      children: [fuaran.card<Msg>({ id: id('c1') })],
      activeIndex: { kind: 'State', key: 'activePane', defaultValue: 0 },
    });
    expect(preEmitValidate(live).ok).toBe(true);
  });
});
