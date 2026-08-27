// ============================================================================
//  Phase 101 — fast-check arbitraries for the wire-format fuzzer (TS side).
//
//  Mirrors the F# FsCheck generators (fuaran-dotnet/src/Fuaran.UI.JsonDecode.Tests/
//  Generators.fs) so both conformant hosts fuzz the same generated tree-space.
//  Feeds the within-host idempotence property (idempotence.test.ts):
//
//      encode(decode(encode x)) === encode x        (WIRE_FORMAT.md §1)
//
//  Values stay in the round-trip-faithful AND cross-host-safe subspace:
//   - Binding.State defaults use the per-type placeholder (0 / '' / false) —
//     the value both hosts round-trip identically.
//   - Opaque-collection Static slots use non-empty collections (→ "<opaque>").
//   - LocalBinding.format is omitted (the decoder restores it absent).
//   - JsonValue payloads are primitives.
//   - Floats stay in the plain-decimal int53 range (no exponent notation), the
//     range where the .NET "R" and JS shortest-round-trip forms agree byte-for-
//     byte (WIRE_FORMAT §5) — so the SAME arbitraries feed the cross-host
//     parity harness. NaN / ±Infinity sentinels are cross-host-safe and kept.
// ============================================================================

import fc from 'fast-check';

import type {
  Accessibility,
  Action,
  AriaRole,
  Binding,
  CellFormat,
  ColumnErased,
  CellKindErased,
  DisplayKind,
  FilterSpec,
  FormField,
  InputKind,
  JsonValue,
  LayoutKind,
  LocalFlushTrigger,
  Node,
  NodeId,
  NodeKind,
  SelectOption,
  SemanticStyle,
  StateBehaviour,
  TextSource,
  VisKind,
} from '@fuaran-ui/schema';
import { apiEndpoint, fragmentId, iconSource, nodeId } from '@fuaran-ui/schema';
import type { TreeOp } from '../src/treeOp.js';

type N = Node<unknown>;

const noopAction = (): Action<unknown> => ({ kind: 'Chain', actions: [] });

// ─── Primitives ──────────────────────────────────────────────────────────────

// Chars biased toward the JSON-escaping edges (quotes, backslash, slash,
// control chars → \uXXXX) plus a spread of non-ASCII that passes through.
const charArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789 .,-_:'.split('')),
  },
  {
    weight: 2,
    arbitrary: fc.oneof(
      fc.constantFrom('"', '\\', '/'),
      fc.integer({ min: 0, max: 31 }).map((c) => String.fromCharCode(c)),
    ),
  },
  { weight: 1, arbitrary: fc.constantFrom('é', 'ü', 'ñ', '中', '日', '€', '£', '✓', 'λ') },
);

const strArb: fc.Arbitrary<string> = fc.array(charArb, { maxLength: 12 }).map((cs) => cs.join(''));
const nonEmptyStrArb: fc.Arbitrary<string> = fc
  .array(charArb, { minLength: 1, maxLength: 12 })
  .map((cs) => cs.join(''));

const nodeIdArb: fc.Arbitrary<NodeId> = nonEmptyStrArb.map(nodeId);

const boolArb = fc.boolean();
const intArb = fc.integer({ min: -100000, max: 100000 });

// Cross-host-safe floats: plain-decimal int53 range (no exponent notation)
// plus the NaN / ±Infinity sentinels.
const finiteFloatArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: -100000000, max: 100000000 }).map((i) => i / 100) },
  { weight: 2, arbitrary: fc.constantFrom(0, -0, 1, -1, 0.5, 100, 3.141592653589793) },
);
const floatArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 7, arbitrary: finiteFloatArb },
  { weight: 1, arbitrary: fc.constantFrom(NaN, Infinity, -Infinity) },
);

const smallArr = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T[]> => fc.array(arb, { maxLength: 3 });

// ─── Enums ─────────────────────────────────────────────────────────────────

const orientationArb = fc.constantFrom('Vertical', 'Horizontal') as fc.Arbitrary<
  'Vertical' | 'Horizontal'
>;
const toneArb = fc.constantFrom(
  'Default',
  'Subdued',
  'Brand',
  'Success',
  'Warning',
  'Critical',
  'Info',
);
const weightArb = fc.constantFrom('Compact', 'Standard', 'Spacious');
const emphasisArb = fc.constantFrom('Quiet', 'Normal', 'Loud');
// Phase 867 - both polarities, so the omitted-at-default encode leg AND the
// emitted `LowerIsBetter` leg are exercised by the generative round-trip.
const trendPolarityArb = fc.constantFrom('HigherIsBetter', 'LowerIsBetter');
// Phase 147 — vary role/voice so the generative round-trip exercises the
// optional-emit wire path (omitted at default, present otherwise).
const styleRoleArb = fc.constantFrom('None', 'Eyebrow', 'Data', 'Lede', 'Caption');
const fontVoiceArb = fc.constantFrom('Default', 'Display', 'Structural');
const ariaRoleArb: fc.Arbitrary<AriaRole> = fc.oneof(
  fc.constantFrom(
    'button',
    'link',
    'dialog',
    'alert',
    'status',
    'banner',
    'navigation',
    'main',
    'form',
    'region',
    'heading',
    'progressbar',
    'tab',
    'tablist',
    'tabpanel',
  ),
  nonEmptyStrArb,
) as fc.Arbitrary<AriaRole>;
const liveRegionArb = fc.constantFrom('polite', 'assertive', 'off');

// ─── JsonValue (primitive subset) ────────────────────────────────────────────

const jsonValueArb: fc.Arbitrary<JsonValue> = fc.oneof(strArb, finiteFloatArb, boolArb);
const jsonValueMapArb: fc.Arbitrary<Record<string, JsonValue>> = fc
  .array(fc.tuple(nonEmptyStrArb, jsonValueArb), { maxLength: 3 })
  .map((pairs) => Object.fromEntries(pairs));

// ─── CellFormat / ColumnWidth ────────────────────────────────────────────────

const cellFormatArb: fc.Arbitrary<CellFormat> = fc.oneof(
  fc.constant({ kind: 'None' } as CellFormat),
  fc.option(intArb, { nil: undefined }).map((d) => ({ kind: 'Number', decimals: d }) as CellFormat),
  nonEmptyStrArb.map((code) => ({ kind: 'Currency', code }) as CellFormat),
  fc
    .option(intArb, { nil: undefined })
    .map((d) => ({ kind: 'Percent', decimals: d }) as CellFormat),
  intArb.map((digits) => ({ kind: 'SignificantDigits', digits }) as CellFormat),
  nonEmptyStrArb.map((format) => ({ kind: 'Date', format }) as CellFormat),
  fc.constant({ kind: 'Custom', format: () => '<custom>' } as CellFormat),
);

// Deterministic spread covering every CellFormat arm.
const allCellFormats: CellFormat[] = [
  { kind: 'None' },
  { kind: 'Number', decimals: 2 },
  { kind: 'Currency', code: 'GBP' },
  { kind: 'Percent' },
  { kind: 'SignificantDigits', digits: 3 },
  { kind: 'Date', format: 'yyyy-MM-dd' },
  { kind: 'Custom', format: () => '<custom>' },
];

// ─── Flush trigger ───────────────────────────────────────────────────────────

const flushTriggerArb: fc.Arbitrary<LocalFlushTrigger> = fc.oneof(
  fc.constant({ kind: 'OnBlur' } as LocalFlushTrigger),
  fc.constant({ kind: 'OnSubmit' } as LocalFlushTrigger),
  fc.constant({ kind: 'OnCommitAction' } as LocalFlushTrigger),
  fc
    .integer({ min: 0, max: 5000 })
    .map((ms) => ({ kind: 'OnDebounce', milliseconds: ms }) as LocalFlushTrigger),
);

// ─── Typed Binding arbitraries ───────────────────────────────────────────────
//
// Every arm. State uses the per-type placeholder default. Local uses a faithful
// Static initialFrom and omits `format`.

const bindingOf = <T>(staticArb: fc.Arbitrary<T>, placeholder: T): fc.Arbitrary<Binding<T>> =>
  fc.oneof(
    staticArb.map((value) => ({ kind: 'Static', value }) as Binding<T>),
    nonEmptyStrArb.map(
      (name) => ({ kind: 'Query', name, accessor: () => placeholder }) as Binding<T>,
    ),
    nonEmptyStrArb.map((name) => ({ kind: 'Filter', name }) as Binding<T>),
    nodeIdArb.map(
      (id) => ({ kind: 'Selection', nodeId: id, accessor: () => placeholder }) as Binding<T>,
    ),
    nonEmptyStrArb.map((key) => ({ kind: 'State', key, defaultValue: placeholder }) as Binding<T>),
    fc.constant({ kind: 'Computed', compute: () => placeholder } as Binding<T>),
    nonEmptyStrArb.map((key) => ({ kind: 'I18n', key }) as Binding<T>),
    fc.tuple(staticArb, flushTriggerArb).map(
      ([init, flushOn]) =>
        ({
          kind: 'Local',
          local: {
            initialFrom: { kind: 'Static', value: init },
            flushOn,
            onCommit: () => undefined,
            parse: (raw: string) => ({ ok: true, value: placeholder }),
          },
        }) as Binding<T>,
    ),
  );

const bindingNumArb = bindingOf<number>(floatArb, 0);
const bindingFiniteNumArb = bindingOf<number>(finiteFloatArb, 0);
const bindingStrArb = bindingOf<string>(strArb, '');
const bindingBoolArb = bindingOf<boolean>(boolArb, false);
const bindingIntArb = bindingOf<number>(intArb, 0);

// ─── TextSource / SelectOption ───────────────────────────────────────────────

const textSourceArb: fc.Arbitrary<TextSource> = fc.oneof(
  strArb.map((value) => ({ kind: 'Literal', value }) as TextSource),
  bindingStrArb.map((binding) => ({ kind: 'Bound', binding }) as TextSource),
  fc
    .tuple(nonEmptyStrArb, jsonValueMapArb)
    .map(([key, args]) => ({ kind: 'I18n', key, args }) as TextSource),
);

const selectOptionArb: fc.Arbitrary<SelectOption> = fc.record({
  value: strArb,
  label: textSourceArb,
});

// Opaque-collection Static slots — non-empty so the box → "<opaque>".
const bindingSelectOptionsArb: fc.Arbitrary<Binding<readonly SelectOption[]>> = fc.oneof(
  fc
    .array(selectOptionArb, { minLength: 1, maxLength: 3 })
    .map((value) => ({ kind: 'Static', value }) as Binding<readonly SelectOption[]>),
  nonEmptyStrArb.map((name) => ({ kind: 'Filter', name }) as Binding<readonly SelectOption[]>),
);

const bindingStrOptArb: fc.Arbitrary<Binding<string | undefined>> = fc.oneof(
  strArb.map((value) => ({ kind: 'Static', value }) as Binding<string | undefined>),
  fc.constant({ kind: 'Static', value: undefined } as Binding<string | undefined>),
  nonEmptyStrArb.map((name) => ({ kind: 'Filter', name }) as Binding<string | undefined>),
);

// ─── Accessibility / style ───────────────────────────────────────────────────

const semanticStyleArb: fc.Arbitrary<SemanticStyle> = fc.record({
  tone: toneArb,
  weight: weightArb,
  emphasis: emphasisArb,
  role: styleRoleArb,
  voice: fontVoiceArb,
}) as fc.Arbitrary<SemanticStyle>;

const accessibilityArb: fc.Arbitrary<Accessibility> = fc.record(
  {
    label: bindingStrArb,
    labelledBy: nodeIdArb,
    describedBy: nodeIdArb,
    role: ariaRoleArb,
    liveRegion: liveRegionArb as fc.Arbitrary<Accessibility['liveRegion']>,
    hidden: bindingBoolArb,
  },
  { requiredKeys: [] },
) as fc.Arbitrary<Accessibility>;

// ─── Display specs ───────────────────────────────────────────────────────────

const displayKindArb: fc.Arbitrary<DisplayKind> = fc.oneof(
  fc
    .record({
      level: fc.integer({ min: 1, max: 6 }),
      text: textSourceArb,
      variant: fc.constantFrom('Standard', 'Eyebrow', 'Caption', 'Lead'),
    })
    .map((spec) => ({ kind: 'Heading', spec }) as DisplayKind),
  textSourceArb.map((text) => ({ kind: 'Markdown', spec: { text } }) as DisplayKind),
  fc
    .record(
      {
        label: textSourceArb,
        value: bindingNumArb,
        format: cellFormatArb,
        tone: toneArb,
        weight: weightArb,
        emphasis: emphasisArb,
        trend: bindingNumArb,
        trendFormat: cellFormatArb,
        trendPolarity: trendPolarityArb,
        icon: nonEmptyStrArb.map(iconSource),
        subtext: textSourceArb,
      },
      {
        requiredKeys: ['label', 'value', 'format', 'tone', 'weight', 'emphasis', 'trendPolarity'],
      },
    )
    .map((spec) => ({ kind: 'Metric', spec }) as DisplayKind),
  fc
    .record({
      label: textSourceArb,
      variant: fc.constantFrom('Neutral', 'Brand', 'Success', 'Warning', 'Critical', 'Info'),
    })
    .map((spec) => ({ kind: 'Badge', spec }) as DisplayKind),
  fc
    .array(finiteFloatArb, { minLength: 1, maxLength: 4 })
    .map(
      (value) =>
        ({ kind: 'Sparkline', spec: { source: { kind: 'Static', value } } }) as DisplayKind,
    ),
  fc
    .record(
      {
        tone: toneArb,
        heading: textSourceArb,
        body: textSourceArb,
        icon: nonEmptyStrArb.map(iconSource),
        dismissable: boolArb,
      },
      { requiredKeys: ['tone', 'body', 'dismissable'] },
    )
    .map((spec) => ({ kind: 'Callout', spec }) as DisplayKind),
  fc
    .record(
      {
        fraction: bindingNumArb,
        label: textSourceArb,
        caveat: textSourceArb,
        indeterminate: boolArb,
        tone: toneArb,
      },
      { requiredKeys: ['fraction', 'indeterminate', 'tone'] },
    )
    .map((spec) => ({ kind: 'Progress', spec }) as DisplayKind),
  fc
    .integer({ min: 0, max: 12 })
    .map((rows) => ({ kind: 'Skeleton', spec: { rows } }) as DisplayKind),
  fc
    .record(
      {
        label: textSourceArb,
        value: bindingNumArb,
        format: cellFormatArb,
        emphasis: boolArb,
        help: textSourceArb,
      },
      { requiredKeys: ['label', 'value', 'format', 'emphasis'] },
    )
    .map((spec) => ({ kind: 'LabelValueRow', spec }) as DisplayKind),
);

// ─── Action ──────────────────────────────────────────────────────────────────

const actionArb: fc.Arbitrary<Action<unknown>> = fc.oneof(
  fc.constant({ kind: 'Dispatch', msg: '<msg>' } as Action<unknown>),
  nonEmptyStrArb.map(
    (ep) => ({ kind: 'Call', endpoint: apiEndpoint(ep), onResult: () => '<r>' }) as Action<unknown>,
  ),
  fc
    .tuple(nonEmptyStrArb, jsonValueArb)
    .map(([channel, payload]) => ({ kind: 'Notify', channel, payload }) as Action<unknown>),
  nonEmptyStrArb.map((route) => ({ kind: 'Navigate', route }) as Action<unknown>),
  fc
    .tuple(nonEmptyStrArb, jsonValueArb)
    .map(([key, value]) => ({ kind: 'SetState', key, value }) as Action<unknown>),
  fc
    .tuple(nonEmptyStrArb, jsonValueArb)
    .map(([toolName, args]) => ({ kind: 'AiTool', toolName, args }) as Action<unknown>),
  nonEmptyStrArb.map((id) => ({ kind: 'CommitLocal', nodeId: id }) as Action<unknown>),
  strArb.map((text) => ({ kind: 'WriteToClipboard', text }) as Action<unknown>),
  nonEmptyStrArb.map(
    (id) =>
      ({
        kind: 'ReadFileBody',
        file: { id },
        encoding: 'Base64',
        onRead: () => '<r>',
      }) as Action<unknown>,
  ),
  smallArr(nonEmptyStrArb).map(
    (routes) =>
      ({
        kind: 'Chain',
        actions: routes.map((route) => ({ kind: 'Navigate', route })),
      }) as Action<unknown>,
  ),
);

// Deterministic chain covering all ten Action arms — a form's onSubmit.
const allActionsChain: Action<unknown> = {
  kind: 'Chain',
  actions: [
    { kind: 'Dispatch', msg: '<msg>' },
    { kind: 'Call', endpoint: apiEndpoint('/api'), onResult: () => '<r>' },
    { kind: 'Notify', channel: 'ch', payload: 'p' },
    { kind: 'Navigate', route: '/route' },
    { kind: 'SetState', key: 'k', value: 'v' },
    { kind: 'AiTool', toolName: 'tool', args: 'a' },
    { kind: 'Chain', actions: [] },
    { kind: 'CommitLocal', nodeId: 'node' },
    { kind: 'WriteToClipboard', text: 'text' },
    { kind: 'ReadFileBody', file: { id: 'file:0' }, encoding: 'Base64', onRead: () => '<r>' },
  ],
};

// ─── Input specs (containers emit every sub-arm) ─────────────────────────────

const formFieldsArb: fc.Arbitrary<readonly FormField<unknown>[]> = fc
  .record({
    label: textSourceArb,
    sText: bindingStrArb,
    sNum: bindingNumArb,
    sBool: bindingBoolArb,
    sOpts: bindingSelectOptionsArb,
    sVal: bindingStrOptArb,
    rows: fc.integer({ min: 1, max: 8 }),
    orientation: orientationArb,
    mn: fc.option(finiteFloatArb, { nil: undefined }),
    mx: fc.option(finiteFloatArb, { nil: undefined }),
    st: fc.option(finiteFloatArb, { nil: undefined }),
  })
  .map((r) => {
    const mk = (id: string, kind: FormField<unknown>['kind']): FormField<unknown> => ({
      id,
      label: r.label,
      kind,
      required: false,
    });
    const constraints = {
      ...(r.mn !== undefined ? { min: r.mn } : {}),
      ...(r.mx !== undefined ? { max: r.mx } : {}),
      ...(r.st !== undefined ? { step: r.st } : {}),
    };
    // Phase 864 — the declared-rule slot. Attached to two of the seven fields on
    // purpose: the fuzzer has to see BOTH a field carrying a rule and a field
    // carrying none, because `rule` is Optional rather than omit-default and the
    // byte-stability claim is about the absence as much as the presence. Both
    // shapes below are well-formed (the decoder refuses an empty rule and an
    // inverted length pair, so a generated defect would be a decode error rather
    // than a round-trip failure — those two live in the corpus reject family).
    const formatRule = { format: 'email' as const };
    const compareRule = {
      compare: {
        op: 'gte' as const,
        against: { kind: 'State' as const, key: 'f-text', defaultValue: undefined },
      },
      message: r.label,
    };
    return [
      mk('f-text', { kind: 'Text', value: r.sText, onChange: noopAction }),
      {
        ...mk('f-email', { kind: 'Text', value: r.sText, onChange: noopAction }),
        rule: formatRule,
      },
      {
        ...mk('f-compare', { kind: 'Text', value: r.sText, onChange: noopAction }),
        rule: compareRule,
      },
      mk('f-number', { kind: 'Number', value: r.sNum, onChange: noopAction }),
      mk('f-checkbox', { kind: 'Checkbox', value: r.sBool, onToggle: noopAction }),
      mk('f-choice', { kind: 'Choice', options: r.sOpts, value: r.sVal, onChange: noopAction }),
      mk('f-textarea', { kind: 'TextArea', value: r.sText, onChange: noopAction, rows: r.rows }),
      mk('f-ranged', { kind: 'RangedNumber', value: r.sNum, onChange: noopAction, constraints }),
      mk('f-segmented', {
        kind: 'SegmentedChoice',
        options: r.sOpts,
        value: r.sVal,
        onChange: noopAction,
        orientation: r.orientation,
      }),
    ];
  });

const filtersArb: fc.Arbitrary<readonly FilterSpec<unknown>[]> = fc
  .record({
    label: textSourceArb,
    sText: bindingStrArb,
    sOpts: bindingSelectOptionsArb,
    sVal: bindingStrOptArb,
    orientation: orientationArb,
  })
  .map((r) => {
    const mk = (name: string, field: FilterSpec<unknown>['field']): FilterSpec<unknown> => ({
      name,
      label: r.label,
      field,
    });
    return [
      // 0.2.0 filters-unification: chips carry FormFieldKind controls.
      // Cover closure + declarative shapes; `ft-auto` covers the auto
      // Filter(name) binding the minimal wire synthesizes; `ft-range-typed`
      // carries the authorable {min,max} static pair. Mirror of the F# gen.
      mk('ft-text', { kind: 'Text', value: r.sText, onChange: noopAction }),
      mk('ft-choice', { kind: 'Choice', options: r.sOpts, value: r.sVal, onChange: noopAction }),
      mk('ft-range', {
        kind: 'Range',
        value: { kind: 'Static', value: [0, 0] },
        onChange: noopAction,
      }),
      mk('ft-seg', {
        kind: 'SegmentedChoice',
        options: r.sOpts,
        value: r.sVal,
        onChange: noopAction,
        orientation: r.orientation,
      }),
      mk('ft-auto', { kind: 'Text', value: { kind: 'Filter', name: 'ft-auto' } }),
      mk('ft-text-decl', { kind: 'Text', value: { kind: 'Filter', name: 'q' } }),
      mk('ft-choice-decl', { kind: 'Choice', options: r.sOpts, value: r.sVal }),
      mk('ft-range-typed', { kind: 'Range', value: { kind: 'Static', value: [1, 9] } }),
      mk('ft-seg-decl', {
        kind: 'SegmentedChoice',
        options: r.sOpts,
        value: r.sVal,
        orientation: r.orientation,
      }),
    ];
  });

const inputKindArb: fc.Arbitrary<InputKind<unknown>> = fc.oneof(
  formFieldsArb.map(
    (fields) =>
      ({
        kind: 'Form',
        spec: {
          fields,
          onSubmit: allActionsChain,
          submitLabel: { kind: 'Literal', value: 'Save' },
        },
      }) as InputKind<unknown>,
  ),
  filtersArb.map((specs) => ({ kind: 'Filters', specs }) as InputKind<unknown>),
  fc
    .record(
      {
        label: textSourceArb,
        onClick: actionArb,
        variant: fc.constantFrom('Primary', 'Secondary', 'Tertiary', 'Destructive'),
        icon: nonEmptyStrArb.map(iconSource),
        tooltip: textSourceArb,
        disabled: bindingBoolArb,
      },
      { requiredKeys: ['label', 'onClick', 'variant'] },
    )
    .map((spec) => ({ kind: 'Button', spec }) as InputKind<unknown>),
  fc
    .record({ label: textSourceArb, accept: smallArr(nonEmptyStrArb), multiple: boolArb })
    .map(
      (r) => ({ kind: 'FileUpload', spec: { ...r, onSelect: noopAction } }) as InputKind<unknown>,
    ),
  fc
    .record(
      {
        label: textSourceArb,
        source: bindingSelectOptionsArb,
        value: bindingStrOptArb,
        placeholder: textSourceArb,
      },
      { requiredKeys: ['label', 'source', 'value'] },
    )
    .map(
      (spec) => ({ kind: 'Select', spec: { ...spec, onChange: noopAction } }) as InputKind<unknown>,
    ),
);

// ─── Visualisation specs ─────────────────────────────────────────────────────

const gridColumnsArb: fc.Arbitrary<readonly ColumnErased<unknown>[]> = textSourceArb.map(
  (btnLabel) => {
    const kinds: CellKindErased<unknown>[] = [
      { kind: 'Text' },
      { kind: 'Numeric' },
      { kind: 'Date' },
      { kind: 'Editable', onEdit: noopAction },
      { kind: 'Checkbox', get: () => false, onToggle: noopAction },
      { kind: 'Button', label: btnLabel, onClick: noopAction },
      { kind: 'ButtonGroup', buttons: [[btnLabel, noopAction]] },
      { kind: 'Link', href: () => '/href', label: () => ({ kind: 'Literal', value: 'link' }) },
      { kind: 'Pill', label: () => ({ kind: 'Literal', value: 'pill' }), tone: () => 'Brand' },
      // Phase 750 — the declarative pill. `defaultTone: 'Subdued'` is deliberately
      // NON-identity so the fuzz exercises the emitted `default` key; the identity case
      // (omitted) is covered by the corpus fixture's second TonedPill column.
      { kind: 'TonedPill', field: 'status', map: { Delayed: 'Warning' }, defaultTone: 'Subdued' },
      { kind: 'Progress', fraction: () => 0.5, label: () => ({ kind: 'Literal', value: 'p' }) },
      {
        kind: 'Custom',
        render: () => leafNode('cell-custom'),
      },
    ];
    return kinds.map((kind, i) => ({
      label: `col${i}`,
      value: () => ({ kind: 'Empty' }) as const,
      format: allCellFormats[i % allCellFormats.length] as CellFormat,
      kind,
      width: { kind: 'Auto' } as const,
    }));
  },
);

const visKindArb: fc.Arbitrary<VisKind<unknown>> = fc.oneof(
  fc.record({ columns: gridColumnsArb, editable: boolArb }).map(
    (r) =>
      ({
        kind: 'Grid',
        spec: {
          source: { kind: 'Static', value: [] },
          rowKey: () => '<rk>',
          columns: r.columns,
          editable: r.editable,
          reorderable: false,
        },
      }) as VisKind<unknown>,
  ),
  fc
    .record(
      {
        kind: fc.constantFrom('Line', 'Bar', 'Area', 'Pie', 'Scatter', 'Heatmap'),
        xField: nonEmptyStrArb,
        yFields: smallArr(nonEmptyStrArb),
        title: textSourceArb,
        stacked: boolArb,
      },
      { requiredKeys: ['kind', 'xField', 'yFields', 'stacked'] },
    )
    .map(
      (spec) =>
        ({
          kind: 'Chart',
          spec: { ...spec, source: { kind: 'Static', value: [] } },
        }) as VisKind<unknown>,
    ),
  // Phase 393 — `Table` is retired; a static read-only table is the `staticRows` mode of Grid.
  fc.record({ headers: smallArr(textSourceArb), rows: smallArr(smallArr(textSourceArb)) }).map(
    (sr) =>
      ({
        kind: 'Grid',
        spec: {
          source: { kind: 'Static', value: [] },
          columns: [],
          editable: false,
          reorderable: false,
          staticRows: sr,
        },
      }) as VisKind<unknown>,
  ),
  fc
    .record({
      centreLatitude: finiteFloatArb,
      centreLongitude: finiteFloatArb,
      zoom: fc.integer({ min: 0, max: 20 }),
    })
    .map(
      (spec) =>
        ({
          kind: 'Map',
          spec: { ...spec, source: { kind: 'Static', value: [] } },
        }) as VisKind<unknown>,
    ),
);

// ─── Custom / fragments ──────────────────────────────────────────────────────

const customArb: fc.Arbitrary<NodeKind<unknown>> = fc
  .record(
    {
      moduleId: nonEmptyStrArb,
      componentId: nonEmptyStrArb,
      props: jsonValueMapArb,
      contentHash: fc.record({
        algorithm: fc.constant('SHA256'),
        hash: nonEmptyStrArb,
        strictness: fc.constantFrom('StrictReplay', 'AdvisoryWarning'),
      }),
      exposedNodeIds: smallArr(nodeIdArb),
    },
    { requiredKeys: ['moduleId', 'componentId', 'props', 'exposedNodeIds'] },
  )
  .map((r) => ({ kind: 'Custom', ...r }) as NodeKind<unknown>);

// ─── Node recursion ──────────────────────────────────────────────────────────

function leafNode(id: string): N {
  return {
    id: nodeId(id),
    kind: {
      kind: 'Display',
      display: { kind: 'Markdown', spec: { text: { kind: 'Literal', value: 'x' } } },
    },
    state: {},
    style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
  };
}

function childrenArb(depth: number): fc.Arbitrary<readonly N[]> {
  return fc.array(nodeArb(depth), { maxLength: 3 });
}

function layoutKindArb(depth: number): fc.Arbitrary<LayoutKind<unknown>> {
  const kids = childrenArb(depth - 1);
  return fc.oneof(
    // Phase 390 — the unified Box container, covering the four canonical corners
    // the retired kinds occupied: Auto/Dashboard, Flex/Group (Stack),
    // Grid/Group (GridLayout), Flex/Card (Card).
    kids.map(
      (children) =>
        ({
          kind: 'Box',
          spec: { layout: { kind: 'Auto' }, role: 'Dashboard', children },
        }) as LayoutKind<unknown>,
    ),
    fc.tuple(orientationArb, kids, boolArb).map(
      ([direction, children, wrap]) =>
        ({
          kind: 'Box',
          spec: { layout: { kind: 'Flex', direction, wrap }, role: 'Group', children },
        }) as LayoutKind<unknown>,
    ),
    fc
      .record(
        { cols: fc.integer({ min: 1, max: 12 }), children: kids, templateColumns: nonEmptyStrArb },
        { requiredKeys: ['cols', 'children'] },
      )
      .map(
        ({ cols, children, templateColumns }) =>
          ({
            kind: 'Box',
            spec: {
              layout: { kind: 'Grid', cols, ...(templateColumns ? { templateColumns } : {}) },
              role: 'Group',
              children,
            },
          }) as LayoutKind<unknown>,
      ),
    fc.record({ heading: textSourceArb, children: kids }, { requiredKeys: ['children'] }).map(
      ({ heading, children }) =>
        ({
          kind: 'Box',
          spec: {
            layout: { kind: 'Flex', direction: 'Vertical', wrap: false },
            role: 'Card',
            ...(heading !== undefined ? { heading } : {}),
            children,
          },
        }) as LayoutKind<unknown>,
    ),
    fc
      .tuple(finiteFloatArb, kids)
      .map(
        ([weight, children]) =>
          ({ kind: 'SplitPanel', spec: { weight, children } }) as LayoutKind<unknown>,
      ),
    fc.tuple(orientationArb, kids, bindingIntArb).map(
      ([orientation, children, activeIndex]) =>
        ({
          kind: 'Tabs',
          spec: { orientation, children, activeIndex, onSelect: noopAction },
        }) as LayoutKind<unknown>,
    ),
    fc.tuple(bindingIntArb, kids).map(
      ([activeStep, children]) =>
        ({
          kind: 'Stepper',
          spec: { activeStep, children, onSelect: noopAction },
        }) as LayoutKind<unknown>,
    ),
    fc
      .record({ heading: textSourceArb, children: kids }, { requiredKeys: ['children'] })
      .map((spec) => ({ kind: 'SummaryList', spec }) as LayoutKind<unknown>),
    fc.tuple(textSourceArb, bindingBoolArb, kids, boolArb).map(
      ([heading, open, children, defaultOpen]) =>
        ({
          kind: 'Disclosure',
          spec: { heading, open, onToggle: noopAction, children, defaultOpen },
        }) as LayoutKind<unknown>,
    ),
  );
}

function nodeKindArb(depth: number): fc.Arbitrary<NodeKind<unknown>> {
  const leaves: fc.Arbitrary<NodeKind<unknown>>[] = [
    displayKindArb.map((display) => ({ kind: 'Display', display }) as NodeKind<unknown>),
    inputKindArb.map((input) => ({ kind: 'Input', input }) as NodeKind<unknown>),
    visKindArb.map(
      (visualisation) => ({ kind: 'Visualisation', visualisation }) as NodeKind<unknown>,
    ),
    customArb,
    nonEmptyStrArb.map(
      (name) =>
        ({ kind: 'FragmentRef', spec: { name: fragmentId(name), args: {} } }) as NodeKind<unknown>,
    ),
  ];
  if (depth <= 0) return fc.oneof(...leaves);
  const branches: fc.Arbitrary<NodeKind<unknown>>[] = [
    layoutKindArb(depth).map((layout) => ({ kind: 'Layout', layout }) as NodeKind<unknown>),
    fc
      .tuple(nodeArb(depth - 1), nodeArb(depth - 1))
      .map(
        ([child, fallback]) =>
          ({ kind: 'ErrorBoundary', spec: { child, fallback } }) as NodeKind<unknown>,
      ),
    fc.tuple(nonEmptyStrArb, nodeArb(depth - 1)).map(
      ([name, body]) =>
        ({
          kind: 'FragmentDecl',
          spec: {
            name: fragmentId(name),
            body,
            holes: [],
            effect: { hostEffect: 'Pure', determinism: 'Deterministic' },
          },
        }) as NodeKind<unknown>,
    ),
  ];
  return fc.oneof(...leaves, ...branches);
}

function stateBehaviourArb(depth: number): fc.Arbitrary<StateBehaviour<unknown>> {
  const errNode = leafNode('err');
  if (depth <= 0) {
    return boolArb.map((onErr) => (onErr ? { onError: () => errNode } : {}));
  }
  return fc
    .tuple(
      fc.option(nodeArb(depth - 1), { nil: undefined }),
      fc.option(nodeArb(depth - 1), { nil: undefined }),
      boolArb,
    )
    .map(([onLoading, onEmpty, onErr]) => ({
      ...(onLoading !== undefined ? { onLoading } : {}),
      ...(onEmpty !== undefined ? { onEmpty } : {}),
      ...(onErr ? { onError: () => errNode } : {}),
    }));
}

function nodeArb(depth: number): fc.Arbitrary<N> {
  return fc
    .record(
      {
        id: nodeIdArb,
        kind: nodeKindArb(depth),
        state: stateBehaviourArb(depth),
        style: semanticStyleArb,
        accessibility: accessibilityArb,
      },
      { requiredKeys: ['id', 'kind', 'state', 'style'] },
    )
    .map((r) => r as N);
}

/** Top-level Node arbitrary — depth capped at 4. */
export const arbNode: fc.Arbitrary<N> = nodeArb(4);

// ─── TreeOp ──────────────────────────────────────────────────────────────────

function opArbAt(depth: number): fc.Arbitrary<TreeOp<unknown>> {
  const nonBatch: fc.Arbitrary<TreeOp<unknown>>[] = [
    fc
      .tuple(nodeIdArb, nodeKindArb(2))
      .map(([target, newKind]) => ({ kind: 'EditNode', target, newKind }) as TreeOp<unknown>),
    fc
      .tuple(nodeIdArb, nonEmptyStrArb, jsonValueArb)
      .map(
        ([target, path, value]) => ({ kind: 'UpdateProp', target, path, value }) as TreeOp<unknown>,
      ),
    fc
      .tuple(nodeIdArb, nonEmptyStrArb, bindingFiniteNumArb)
      .map(
        ([target, slot, binding]) =>
          ({ kind: 'ReplaceBinding', target, slot, binding }) as TreeOp<unknown>,
      ),
    fc
      .tuple(nodeIdArb, semanticStyleArb)
      .map(([target, style]) => ({ kind: 'UpdateStyle', target, style }) as TreeOp<unknown>),
    fc
      .tuple(nodeIdArb, stateBehaviourArb(1))
      .map(([target, state]) => ({ kind: 'UpdateState', target, state }) as TreeOp<unknown>),
    fc
      .tuple(nodeIdArb, nodeArb(2))
      .map(([parentId, child]) => ({ kind: 'InsertChild', parentId, child }) as TreeOp<unknown>),
    nodeIdArb.map((target) => ({ kind: 'RemoveNode', target }) as TreeOp<unknown>),
    fc
      .tuple(nodeIdArb, nodeIdArb)
      .map(
        ([target, newParentId]) => ({ kind: 'MoveNode', target, newParentId }) as TreeOp<unknown>,
      ),
    fc
      .tuple(nodeIdArb, smallArr(nodeIdArb))
      .map(
        ([parentId, newOrder]) =>
          ({ kind: 'ReorderChildren', parentId, newOrder }) as TreeOp<unknown>,
      ),
  ];
  if (depth <= 0) return fc.oneof(...nonBatch);
  return fc.oneof(
    ...nonBatch,
    fc
      .array(opArbAt(depth - 1), { maxLength: 3 })
      .map((ops) => ({ kind: 'Batch', ops }) as TreeOp<unknown>),
  );
}

export const arbOp: fc.Arbitrary<TreeOp<unknown>> = opArbAt(2);
