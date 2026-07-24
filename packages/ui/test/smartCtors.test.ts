import { describe, expect, it } from 'vitest';

import {
  action,
  binding,
  boundedInt,
  column,
  filterField,
  format,
  formFieldKind,
  fuaran,
  locale,
  localeFormat,
  node,
  nodeId,
  type MapMarker,
  type Node,
  type NodeId,
  type SelectOption,
} from '../src/index.js';

type Msg = 'inc' | 'dec';

const id = (s: string): NodeId => nodeId(s);

/** A `Node` is structurally valid when it carries the four mandatory slots. */
function expectValidNode<TMsg>(n: Node<TMsg>): void {
  expect(typeof n.id).toBe('string');
  expect(n.kind).toBeDefined();
  expect(typeof n.kind.kind).toBe('string');
  expect(n.state).toBeDefined();
  expect(n.style).toMatchObject({ tone: expect.any(String), weight: expect.any(String) });
}

const options: readonly SelectOption[] = [
  { value: 'a', label: { kind: 'Literal', value: 'A' } },
  { value: 'b', label: { kind: 'Literal', value: 'B' } },
];

describe('acceptance example (Phase 75 acceptance criterion)', () => {
  it('type-checks and builds the documented dashboard tree', () => {
    const tree = fuaran.dashboard<Msg>({
      id: 'root' as NodeId,
      children: [fuaran.metric<Msg>({ id: 'sales' as NodeId, label: 'Sales', value: '£42k' })],
    });

    expect(tree.kind.kind).toBe('Layout');
    if (tree.kind.kind === 'Layout') {
      // Phase 390 — dashboard is now a Box with an Auto layout + Dashboard role.
      expect(tree.kind.layout.kind).toBe('Box');
      if (tree.kind.layout.kind === 'Box') {
        expect(tree.kind.layout.spec.role).toBe('Dashboard');
        expect(tree.kind.layout.spec.layout.kind).toBe('Auto');
        expect(tree.kind.layout.spec.children).toHaveLength(1);
      }
    }
  });

  it("leniently parses a display string into the Metric's numeric value", () => {
    const metric = fuaran.metric<Msg>({ id: id('sales'), label: 'Sales', value: '£42k' });
    if (metric.kind.kind === 'Display' && metric.kind.display.kind === 'Metric') {
      const src = metric.kind.display.spec.value;
      expect(src.kind).toBe('Static');
      if (src.kind === 'Static') expect(src.value).toBe(42);
    }
  });
});

describe('every smart constructor produces a structurally valid Node', () => {
  const k = fuaran.metric<Msg>({ id: id('metric'), label: 'Revenue', value: 128_000 });

  const nodes: ReadonlyArray<Node<Msg>> = [
    fuaran.dashboard<Msg>({ id: id('dash'), children: [k] }),
    fuaran.stack<Msg>({ id: id('stack'), orientation: 'Horizontal', children: [k], wrap: true }),
    fuaran.gridLayout<Msg>({ id: id('grid'), cols: 3, children: [k] }),
    fuaran.gridLayoutTemplated<Msg>({ id: id('gridt'), templateColumns: '1fr 2fr', children: [k] }),
    fuaran.splitPanel<Msg>({ id: id('split'), weight: 0.3, children: [k] }),
    fuaran.tabs<Msg>({ id: id('tabs'), children: [k] }),
    fuaran.card<Msg>({ id: id('card'), heading: 'Heading', children: [k] }),
    fuaran.stepper<Msg>({ id: id('step'), children: [k] }),
    fuaran.summaryList<Msg>({ id: id('stats'), heading: 'Stats', children: [k] }),
    fuaran.disclosure<Msg>({ id: id('disc'), heading: 'More', children: [k] }),
    k,
    fuaran.heading<Msg>({ id: id('h'), text: 'Title', level: 1, variant: 'Lead' }),
    fuaran.labelValueRow<Msg>({ id: id('lvr'), label: 'Net', value: 10, emphasis: true }),
    fuaran.markdown<Msg>(id('md'), '# hi'),
    fuaran.markdownSpec<Msg>(id('mds'), 'body'),
    fuaran.badge<Msg>({ id: id('badge'), label: 'New', variant: 'Brand' }),
    fuaran.sparkline<Msg>({ id: id('spark'), source: [1, 2, 3] }),
    fuaran.divider<Msg>({ id: id('divider') }),
    fuaran.callout<Msg>({ id: id('callout'), body: 'note', tone: 'Warning' }),
    fuaran.progress<Msg>({ id: id('prog'), fraction: 0.5, label: 'Loading' }),
    fuaran.skeleton<Msg>(id('skel'), 2),
    fuaran.button<Msg>({ id: id('btn'), label: 'Click', onClick: action.dispatch<Msg>('inc') }),
    fuaran.select<Msg>({
      id: id('sel'),
      label: 'Pick',
      source: binding.static<readonly SelectOption[]>(options),
      value: binding.static<string | undefined>(undefined),
      onChange: () => action.chain<Msg>([]),
    }),
    fuaran.form<Msg>({
      id: id('form'),
      fields: [
        {
          id: 'name',
          label: { kind: 'Literal', value: 'Name' },
          kind: { kind: 'Text', value: binding.static(''), onChange: () => action.chain<Msg>([]) },
          required: true,
        },
      ],
      onSubmit: action.dispatch<Msg>('inc'),
    }),
    fuaran.filters<Msg>({
      id: id('filters'),
      filters: [
        {
          // 0.2.0 filters unification — a filter item carries a `field`
          // (FormFieldKind), not the retired parallel FilterKind family.
          name: 'q',
          label: { kind: 'Literal', value: 'Search' },
          field: {
            kind: 'Text',
            value: binding.static(''),
            onChange: () => action.chain<Msg>([]),
          },
        },
      ],
    }),
    fuaran.fileUpload<Msg>({
      id: id('upload'),
      label: 'Upload',
      onSelect: () => action.chain<Msg>([]),
    }),
    fuaran.chart<Msg>({
      id: id('chart'),
      source: binding.static<readonly unknown[]>([]),
      xField: 'year',
      yFields: ['amount'],
      kind: 'Bar',
    }),
    fuaran.table<Msg>({ id: id('table'), headers: ['A', 'B'], rows: [['1', '2']] }),
    fuaran.map<Msg>({ id: id('map'), source: binding.static<readonly MapMarker[]>([]) }),
    fuaran.grid<{ readonly key: string; readonly name: string }, Msg>({
      id: id('vgrid'),
      source: binding.static<readonly { readonly key: string; readonly name: string }[]>([]),
      rowKey: (r) => r.key,
      columns: [column.text('Name', (r) => r.name)],
    }),
    fuaran.custom<Msg>({ id: id('custom'), moduleId: 'mod', componentId: 'comp' }),
    fuaran.errorBoundary<Msg>({
      id: id('eb'),
      child: k,
      fallback: fuaran.skeleton<Msg>(id('eb-fallback'), 1),
    }),
    fuaran.fragmentDecl<Msg>({ id: id('fd'), name: 'frag', body: k }),
    fuaran.fragmentRef<Msg>({ id: id('fr'), name: 'frag' }),
  ];

  it.each(nodes.map((n) => [n.kind.kind, n] as const))('%s is valid', (_label, n) => {
    expectValidNode(n);
  });

  it('covers the full top-level NodeKind matrix', () => {
    const kinds = new Set(nodes.map((n) => n.kind.kind));
    expect(kinds).toEqual(
      new Set([
        'Layout',
        'Display',
        'Input',
        'Visualisation',
        'Custom',
        'ErrorBoundary',
        'FragmentDecl',
        'FragmentRef',
      ]),
    );
  });
});

describe('tabsTagged', () => {
  it('throws when tabHeaders or tabTags are absent', () => {
    expect(() => fuaran.tabsTagged<Msg>({ id: id('t'), children: [] })).toThrow(
      /tabHeaders and tabTags/,
    );
  });

  it('builds when both overlays are present', () => {
    const t = fuaran.tabsTagged<Msg>({
      id: id('t'),
      children: [fuaran.card<Msg>({ id: id('c1') })],
      tabHeaders: [{ label: { kind: 'Literal', value: 'One' } }],
      tabTags: ['one'],
    });
    expectValidNode(t);
  });
});

describe('cross-cutting helper namespaces', () => {
  it('binding constructs each case discriminated by kind', () => {
    expect(binding.static(1).kind).toBe('Static');
    expect(binding.query<{ x: number }, number>('q', (s) => s.x).kind).toBe('Query');
    expect(binding.filter('f').kind).toBe('Filter');
    expect(binding.state('k', 0).kind).toBe('State');
    expect(binding.i18n('key').kind).toBe('I18n');
  });

  it('action constructs each case discriminated by kind', () => {
    expect(action.dispatch<Msg>('inc').kind).toBe('Dispatch');
    expect(action.navigate<Msg>('/home').kind).toBe('Navigate');
    expect(action.chain<Msg>([]).kind).toBe('Chain');
    expect(action.writeToClipboard<Msg>('x').kind).toBe('WriteToClipboard');
  });

  it('format constructs typed cell formats', () => {
    expect(format.currency('GBP')).toEqual({ kind: 'Currency', code: 'GBP' });
    expect(format.percent(2)).toEqual({ kind: 'Percent', decimals: 2 });
    expect(format.percent()).toEqual({ kind: 'Percent' });
  });

  it('column builders + erase round-trip a typed column', () => {
    type Row = { readonly id: string; readonly amount: number };
    const col = column.withFormat<Row, Msg>(
      format.currency('GBP'),
      column.numeric('Amount', (r) => r.amount),
    );
    const erased = column.erase(col);
    expect(erased.kind.kind).toBe('Numeric');
    // Phase 425 made `value` optional (the closure is the override, `field`
    // the declarative floor) — `column.erase` always carries the closure.
    expect(erased.value).toBeDefined();
    expect(erased.value?.({ id: 'a', amount: 7 })).toEqual({ kind: 'Numeric', value: 7 });
  });

  it('column.withPill sets a Pill kind reusing the column value as the label', () => {
    type Row = { readonly status: string; readonly healthy: boolean };
    const col = column.withPill<Row, Msg>(
      (r) => (r.healthy ? 'Success' : 'Critical'),
      column.text('Status', (r) => r.status),
    );
    expect(col.kind.kind).toBe('Pill');
    if (col.kind.kind === 'Pill') {
      const row = { status: 'Active', healthy: true };
      expect(col.kind.label(row)).toEqual({ kind: 'Literal', value: 'Active' });
      expect(col.kind.tone(row)).toBe('Success');
      expect(col.kind.tone({ status: 'Down', healthy: false })).toBe('Critical');
    }
  });

  it('column.erase boxes a withPill column to a row-erased Pill (round-trip)', () => {
    type Row = { readonly status: string; readonly healthy: boolean };
    const erased = column.erase(
      column.withPill<Row, Msg>(
        (r) => (r.healthy ? 'Success' : 'Critical'),
        column.text('Status', (r) => r.status),
      ),
    );
    expect(erased.kind.kind).toBe('Pill');
    if (erased.kind.kind === 'Pill') {
      const row: unknown = { status: 'Active', healthy: true };
      expect(erased.kind.label(row)).toEqual({ kind: 'Literal', value: 'Active' });
      expect(erased.kind.tone(row)).toBe('Success');
    }
  });

  it('formFieldKind + filterField build the segmented cases', () => {
    const fk = formFieldKind.segmentedChoice<Msg>(
      binding.static<readonly SelectOption[]>(options),
      binding.static<string | undefined>(undefined),
      () => action.chain<Msg>([]),
    );
    expect(fk.kind).toBe('SegmentedChoice');
    // 0.2.0 filters-unification: a chip's control is an ordinary FormFieldKind
    // auto-bound to its own filter key.
    const flt = filterField.segmented<Msg>(
      'status',
      binding.static<readonly SelectOption[]>(options),
    );
    expect(flt.kind).toBe('SegmentedChoice');
    if (flt.kind === 'SegmentedChoice') {
      expect(flt.value).toEqual({ kind: 'Filter', name: 'status' });
      expect(flt.onChange).toBeUndefined();
    }
  });
});

describe('node postfix modifiers', () => {
  const base = fuaran.metric<Msg>({ id: id('k'), label: 'L', value: 1 });

  it('onLoading / onError populate the state slots', () => {
    const withLoading = node.onLoading(fuaran.skeleton<Msg>(id('s'), 1), base);
    expect(withLoading.state.onLoading).toBeDefined();
    const withError = node.onError<Msg>(() => fuaran.skeleton<Msg>(id('s'), 1), base);
    expect(typeof withError.state.onError).toBe('function');
  });

  it('withTone / withMotion adjust style + motion', () => {
    expect(node.withTone('Brand', base).style.tone).toBe('Brand');
    expect(node.withMotion('FadeInOnMount', base).motion).toBe('FadeInOnMount');
  });

  it('withExtraAttribute accepts data-* / aria-* and drops others', () => {
    const ok = node.withExtraAttribute('data-test', 'x', base);
    expect(ok.extraAttributes).toEqual({ 'data-test': 'x' });
    const dropped = node.withExtraAttribute('onclick', 'evil', base);
    expect(dropped.extraAttributes).toBeUndefined();
  });
});

describe('bounded kit (re-exported from @fuaran-ui/schema)', () => {
  it('is reachable from @fuaran-ui/ui and rejects out-of-range input', () => {
    expect(boundedInt(1, 12, 4)).toBe(4);
    expect(() => boundedInt(1, 12, 13)).toThrow();
  });
});

describe('binding.format / localeFormat / locale (Phase 102)', () => {
  it('binding.format builds the Format binding shape', () => {
    const b = binding.format(
      binding.static(1234.5),
      localeFormat.currency('GBP'),
      locale.explicit('en-GB'),
    );
    expect(b).toEqual({
      kind: 'Format',
      source: { kind: 'Static', value: 1234.5 },
      format: { kind: 'Currency', isoCode: 'GBP' },
      locale: { kind: 'Explicit', tag: 'en-GB' },
    });
  });

  it('localeFormat builders cover each Format case; decimals omitted when absent', () => {
    expect(localeFormat.number()).toEqual({ kind: 'Number' });
    expect(localeFormat.number(2)).toEqual({ kind: 'Number', decimals: 2 });
    expect(localeFormat.percent(1)).toEqual({ kind: 'Percent', decimals: 1 });
    expect(localeFormat.date('Medium')).toEqual({ kind: 'Date', dateStyle: 'Medium' });
    expect(localeFormat.relativeTime('Day')).toEqual({ kind: 'RelativeTime', unit: 'Day' });
  });

  it('locale builders cover Ambient + Explicit', () => {
    expect(locale.ambient()).toEqual({ kind: 'Ambient' });
    expect(locale.explicit('fr-FR')).toEqual({ kind: 'Explicit', tag: 'fr-FR' });
  });
});
