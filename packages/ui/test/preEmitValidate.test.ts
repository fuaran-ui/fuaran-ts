import { describe, expect, it } from 'vitest';

import {
  action,
  fuaran,
  node,
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

  // ── The accessibility family (FUARAN109/110/111) ──────────────────────────
  //
  // Ported alongside the reference host's rules. Every fixture is built through
  // the real smart constructors, so each node carries the language's own
  // per-kind `defaults.accessibility.*` value — which is the rules' input, not
  // a detail of the fixture.

  const a11yCodesOf = (n: Node<Msg>): readonly PreEmitDefect['code'][] =>
    codesOf(n).filter(
      (c) =>
        c === 'INTERACTIVE_WITHOUT_ACCESSIBLE_NAME' ||
        c === 'DANGLING_ACCESSIBILITY_REFERENCE' ||
        c === 'EMPTY_ACCESSIBILITY_DECLARATION',
    );

  it('surfaces INTERACTIVE_WITHOUT_ACCESSIBLE_NAME for a button with no name at all', () => {
    const tree = fuaran.button<Msg>({ id: id('save'), label: '' });
    const r = preEmitValidate(tree);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.find((d) => d.code === 'INTERACTIVE_WITHOUT_ACCESSIBLE_NAME')).toMatchObject({
        nodeId: 'save',
        kind: 'Button',
        slot: 'label',
      });
    }
  });

  it('go-red: a named button is silent, and a whitespace-only name is still no name', () => {
    expect(a11yCodesOf(fuaran.button<Msg>({ id: id('save'), label: 'Save' }))).toEqual([]);
    expect(a11yCodesOf(fuaran.button<Msg>({ id: id('save'), label: '   ' }))).toEqual([
      'INTERACTIVE_WITHOUT_ACCESSIBLE_NAME',
    ]);
  });

  it('go-red: a BOUND label is never judged — an unresolvable name is not an absent one', () => {
    const tree = fuaran.button<Msg>({
      id: id('save'),
      label: { kind: 'Bound', binding: { kind: 'State', key: 'caption', defaultValue: '' } },
    });
    expect(a11yCodesOf(tree)).toEqual([]);
  });

  it('trap: a blank label WITH a declared accessibility.label is not flagged', () => {
    // The browser's name computation is trait label → aria-labelledby target →
    // text content, and the first arm is satisfied. Flagging it would be
    // exactly the false positive an audit cannot afford.
    const tree = node.withAccessibility<Msg>(
      { label: { kind: 'Static', value: 'Save' } },
      fuaran.button<Msg>({ id: id('save'), label: '' }),
    );
    expect(a11yCodesOf(tree)).toEqual([]);
  });

  it('a Link is not audited — it carries no interactive default and is not an Input kind', () => {
    // Two independent reasons, and both are the design: `fuaran.link` passes no
    // accessibility default, and a Link is a Display kind so the naming table
    // never reaches it. It has a structural label slot that is just as empty,
    // and the rule stays silent — the one-directional lock in action.
    const tree = fuaran.link<Msg>({ id: id('docs'), href: 'https://example.invalid', label: '' });
    expect(a11yCodesOf(tree)).toEqual([]);
  });

  it('the interactivity verdict comes from the default, not from being an Input kind', () => {
    // `Filters` is an Input kind the language pairs with no accessibility
    // default. It reaches the naming table and is turned away there, which is
    // the discriminator this test exists to pin: the table says WHICH slot
    // names a kind, the default says WHETHER the kind is audited at all.
    const tree = fuaran.filters<Msg>({ id: id('chips'), filters: [] });
    expect(a11yCodesOf(tree)).toEqual([]);
  });

  it('surfaces DANGLING_ACCESSIBILITY_REFERENCE, and stays silent when the target exists', () => {
    const dangling = fuaran.dashboard<Msg>({
      id: id('root'),
      children: [
        node.withAccessibility<Msg>(
          { labelledBy: id('no-such-node') },
          fuaran.button<Msg>({ id: id('save'), label: 'Save' }),
        ),
      ],
    });
    const r = preEmitValidate(dangling);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.find((d) => d.code === 'DANGLING_ACCESSIBILITY_REFERENCE')).toMatchObject({
        nodeId: 'save',
        slot: 'labelledBy',
        target: 'no-such-node',
      });
    }

    const resolving = fuaran.dashboard<Msg>({
      id: id('root'),
      children: [
        fuaran.metric<Msg>({ id: id('caption'), label: 'Save the document', value: 1 }),
        node.withAccessibility<Msg>(
          { describedBy: id('caption') },
          fuaran.button<Msg>({ id: id('save'), label: 'Save' }),
        ),
      ],
    });
    expect(a11yCodesOf(resolving)).toEqual([]);
  });

  it('surfaces EMPTY_ACCESSIBILITY_DECLARATION for a declared-and-empty label', () => {
    const empty = node.withAccessibility<Msg>(
      { label: { kind: 'Static', value: '' } },
      fuaran.button<Msg>({ id: id('save'), label: 'Save' }),
    );
    expect(a11yCodesOf(empty)).toEqual(['EMPTY_ACCESSIBILITY_DECLARATION']);

    const valueless = node.withAccessibility<Msg>(
      { label: { kind: 'Static', value: undefined } },
      fuaran.button<Msg>({ id: id('save'), label: 'Save' }),
    );
    expect(a11yCodesOf(valueless)).toEqual(['EMPTY_ACCESSIBILITY_DECLARATION']);
  });

  it('EMPTY_ACCESSIBILITY_DECLARATION is what closes the hole the declared-name escape opens', () => {
    // An empty declared label SILENCES the missing-name rule — the defect
    // suppresses its own detection — while the renderer drops the empty
    // aria-label and the element is named by nothing. Exactly one code fires,
    // and it is the right one.
    const tree = node.withAccessibility<Msg>(
      { label: { kind: 'Static', value: ' ' } },
      fuaran.button<Msg>({ id: id('save'), label: '' }),
    );
    expect(a11yCodesOf(tree)).toEqual(['EMPTY_ACCESSIBILITY_DECLARATION']);
  });

  it('an EMPTY reference slot is one finding, not two', () => {
    const tree = node.withAccessibility<Msg>(
      { labelledBy: id('') },
      fuaran.button<Msg>({ id: id('save'), label: 'Save' }),
    );
    expect(a11yCodesOf(tree)).toEqual(['EMPTY_ACCESSIBILITY_DECLARATION']);
  });

  it('go-red: a non-Static label binding is never judged', () => {
    const tree = node.withAccessibility<Msg>(
      { label: { kind: 'State', key: 'caption', defaultValue: '' } },
      fuaran.button<Msg>({ id: id('save'), label: 'Save' }),
    );
    expect(a11yCodesOf(tree)).toEqual([]);
  });
});
