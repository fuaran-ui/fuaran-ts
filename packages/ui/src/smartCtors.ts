// ============================================================================
//  @fuaran-ui/ui — smart constructors (port of Fuaran.UI/Fuaran.fs).
//
//  The ergonomic author surface that distinguishes "a TS implementation of the
//  Fuaran contract" from "TS users hand-writing JSON". Mirrors the F# module
//  layout (§4c):
//   - Components live under the `fuaran` namespace (`fuaran.dashboard`,
//     `fuaran.metric`, `fuaran.tabs`, …) — names match the F# `Fuaran.X` surface
//     so AI_AUTHORING_GUIDE.md recipes translate mechanically.
//   - Cross-cutting helpers are top-level namespaces (`binding`, `action`,
//     `format`, `column`, `node`).
//
//  Every constructor is generic over the consumer's message type `TMsg` and
//  returns a typed `Node<TMsg>` directly. Unlike F#, no `obj`-erasure is needed
//  at the author surface — structural typing handles it — except the row-typed
//  grid, which erases to `unknown` at the tree level (mirroring the F# `obj`
//  boundary) because `Node<TMsg>` cannot carry the row type parameter.
//
//  Constructors take a single options object combining the node `id` with the
//  spec's fields, applying ergonomic coercions: a bare `string` becomes a
//  `TextSource.Literal`; a bare `number` becomes a `Binding.Static`. Fields the
//  author omits fall back to `defaults.*`.
// ============================================================================

import {
  apiEndpoint,
  defaults,
  fragmentId,
  iconSource,
  nodeId,
  projectSelectionField,
} from '@fuaran-ui/schema';
import type {
  Accessibility,
  Action,
  ApiEndpoint,
  BadgeVariant,
  Binding,
  BindingContext,
  ButtonVariant,
  CalloutSpec,
  CellFormat,
  CellValue,
  ChartKind,
  Column,
  ColumnErased,
  ColumnWidth,
  ContentHash,
  DataSource,
  DateFieldConstraints,
  DateStyle,
  DateVariant,
  EffectClass,
  ImageAspect,
  ImageFit,
  ImageLoading,
  ImageVariant,
  LinkProtection,
  MathDisplay,
  ScrollOrientation,
  InvokeArg,
  Emphasis,
  FontVoice,
  FragmentArg,
  StyleRole,
  ErrorPayload,
  FileReadEncoding,
  FileRef,
  FileSelection,
  FilterSpec,
  Format,
  FormField,
  FormFieldKind,
  HeadingVariant,
  HoleDecl,
  IconSpec,
  JsonValue,
  MetricSpec,
  LocalBinding,
  LocaleSource,
  LocalFlushTrigger,
  MapMarker,
  Motion,
  Node,
  NodeId,
  NodeKind,
  NumberFieldConstraints,
  Orientation,
  RelativeTimeUnit,
  Result,
  SelectOption,
  StyleWeight,
  TabHeader,
  TabsSpec,
  TextSource,
  ToneVariant,
  TrendPolarity,
  Transform,
} from '@fuaran-ui/schema';

// ─── Ergonomic input coercions ───────────────────────────────────────────────

/** A `TextSource`, or a bare string that becomes a `TextSource.Literal`. */
export type TextInput = string | TextSource;

/** A `Binding<number>`, or a bare number that becomes a `Binding.Static`. */
export type NumberInput = number | Binding<number>;

/** A `Binding<string>`, or a bare string that becomes a `Binding.Static`. */
export type StringInput = string | Binding<string>;

const text = (input: TextInput): TextSource =>
  typeof input === 'string' ? { kind: 'Literal', value: input } : input;

/**
 * Project a `CellValue` into the `TextSource` the Pill cell renders as its
 * label. Mirrors the renderer's default (formatless) `CellValue` → string
 * mapping so a `withPill` column reads the same label the source column did.
 */
const cellValueToText = (cv: CellValue): TextSource => {
  switch (cv.kind) {
    case 'Text':
      return { kind: 'Literal', value: cv.value };
    case 'Numeric':
      return { kind: 'Literal', value: String(cv.value) };
    case 'Bool':
      return { kind: 'Literal', value: cv.value ? 'true' : 'false' };
    case 'Date':
      return { kind: 'Literal', value: cv.value.toISOString().slice(0, 10) };
    case 'Empty':
      return { kind: 'Literal', value: '' };
  }
};

const numberBinding = (input: NumberInput): Binding<number> =>
  typeof input === 'number' ? { kind: 'Static', value: input } : input;

const stringBinding = (input: StringInput): Binding<string> =>
  typeof input === 'string' ? { kind: 'Static', value: input } : input;

/** A `Binding<boolean>`, or a bare boolean that becomes a `Binding.Static`. */
export type BoolInput = boolean | Binding<boolean>;

const boolBinding = (input: BoolInput): Binding<boolean> =>
  typeof input === 'boolean' ? { kind: 'Static', value: input } : input;

const numberArrayBinding = (
  input: readonly number[] | Binding<readonly number[]>,
): Binding<readonly number[]> =>
  Array.isArray(input)
    ? { kind: 'Static', value: input as readonly number[] }
    : (input as Binding<readonly number[]>);

const stringArrayBinding = (
  input: readonly string[] | Binding<readonly string[]>,
): Binding<readonly string[]> =>
  Array.isArray(input)
    ? { kind: 'Static', value: input as readonly string[] }
    : (input as Binding<readonly string[]>);

/**
 * KPI value coercion. Accepts a `Binding<number>`, a bare number, or a display
 * string. A string is leniently parsed (non-numeric characters stripped) into
 * a `Binding.Static` — a convenience for prototypes like `value: '£42k'`; pass
 * a number or a `Binding` + `format` for precise control.
 */
const metricValue = (input: string | NumberInput): Binding<number> => {
  if (typeof input === 'number') return { kind: 'Static', value: input };
  if (typeof input === 'string') {
    const parsed = Number.parseFloat(input.replace(/[^0-9.eE+-]/g, ''));
    return { kind: 'Static', value: Number.isFinite(parsed) ? parsed : 0 };
  }
  return input;
};

// ─── Per-Node postfix modifiers (the `node` namespace) ───────────────────────

export const node = {
  onLoading<TMsg>(placeholder: Node<TMsg>, n: Node<TMsg>): Node<TMsg> {
    return { ...n, state: { ...n.state, onLoading: placeholder } };
  },
  onEmpty<TMsg>(placeholder: Node<TMsg>, n: Node<TMsg>): Node<TMsg> {
    return { ...n, state: { ...n.state, onEmpty: placeholder } };
  },
  onError<TMsg>(render: (payload: ErrorPayload) => Node<TMsg>, n: Node<TMsg>): Node<TMsg> {
    return { ...n, state: { ...n.state, onError: render } };
  },
  withTone<TMsg>(tone: ToneVariant, n: Node<TMsg>): Node<TMsg> {
    return { ...n, style: { ...n.style, tone } };
  },
  withWeight<TMsg>(weight: StyleWeight, n: Node<TMsg>): Node<TMsg> {
    return { ...n, style: { ...n.style, weight } };
  },
  withEmphasis<TMsg>(emphasis: Emphasis, n: Node<TMsg>): Node<TMsg> {
    return { ...n, style: { ...n.style, emphasis } };
  },
  /**
   * Phase 147 — tag the node with a semantic content role (`fuaran-role-{role}`).
   * `'None'` clears it. On a `Heading`, prefer `HeadingVariant.Eyebrow`/`Caption`.
   */
  withRole<TMsg>(role: StyleRole, n: Node<TMsg>): Node<TMsg> {
    return { ...n, style: { ...n.style, role } };
  },
  /** Phase 147 — tag the node's font voice (`fuaran-voice-{voice}`); `'Default'` clears it. */
  withVoice<TMsg>(voice: FontVoice, n: Node<TMsg>): Node<TMsg> {
    return { ...n, style: { ...n.style, voice } };
  },
  withAccessibility<TMsg>(a11y: Accessibility, n: Node<TMsg>): Node<TMsg> {
    return { ...n, accessibility: a11y };
  },
  withMotion<TMsg>(motion: Motion, n: Node<TMsg>): Node<TMsg> {
    return { ...n, motion };
  },
  /**
   * Consumer-side hatch for `data-*` / `aria-*` attributes. Non-conforming
   * keys are dropped (a warning is emitted to the console), mirroring the F#
   * `Node.withExtraAttribute` prefix policy.
   */
  withExtraAttribute<TMsg>(key: string, value: string, n: Node<TMsg>): Node<TMsg> {
    const trimmed = key.trim();
    if (!trimmed.startsWith('data-') && !trimmed.startsWith('aria-')) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Fuaran] node.withExtraAttribute: rejected key '${trimmed}' — only data-* and aria-* prefixes are allowed.`,
      );
      return n;
    }
    return { ...n, extraAttributes: { ...(n.extraAttributes ?? {}), [trimmed]: value } };
  },
};

// ─── Typed binding entry points (the `binding` namespace) ────────────────────

export const binding = {
  static<T>(value: T): Binding<T> {
    return { kind: 'Static', value };
  },
  query<TSource, T>(name: string, accessor: (source: TSource) => T): Binding<T> {
    return { kind: 'Query', name, accessor: (o: unknown) => accessor(o as TSource) };
  },
  filter<T>(name: string): Binding<T> {
    return { kind: 'Filter', name };
  },
  selection<TRow, T>(id: NodeId, accessor: (row: TRow) => T): Binding<T> {
    return { kind: 'Selection', nodeId: id, accessor: (o: unknown) => accessor(o as TRow) };
  },
  /**
   * A selection read with a default (0.2.9, Phase 629): yields `defaultValue`
   * until the user first selects a row on `nodeId`.
   */
  selectionWithDefault<TRow, T>(
    id: NodeId,
    accessor: (row: TRow) => T,
    defaultValue: T,
  ): Binding<T> {
    return {
      kind: 'Selection',
      nodeId: id,
      accessor: (o: unknown) => accessor(o as TRow),
      defaultValue,
    };
  },
  /**
   * A declarative row-field selection read (0.2.10, Phase 632): projects
   * `field` off the clicked row — the wire-expressible twin of a typed
   * accessor. `defaultValue` (the projected scalar, not a row) yields until
   * the user first selects a row on `nodeId`.
   */
  selectionField<T>(id: NodeId, field: string, defaultValue?: T): Binding<T> {
    return {
      kind: 'Selection',
      nodeId: id,
      accessor: projectSelectionField<T>(field),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      field,
    };
  },
  state<T>(key: string, defaultValue: T): Binding<T> {
    return { kind: 'State', key, defaultValue };
  },
  computed<T>(compute: (ctx: BindingContext) => T): Binding<T> {
    return { kind: 'Computed', compute };
  },
  i18n(key: string, args?: Readonly<Record<string, Binding<JsonValue>>>): Binding<string> {
    return args !== undefined ? { kind: 'I18n', key, args } : { kind: 'I18n', key };
  },
  /**
   * Phase 62: component-scoped local buffer for controlled inputs. The typed
   * `Action<TMsg>` `onCommit` returns is erased to `unknown` at the tree level
   * (the renderer recovers it at dispatch time), mirroring the F# `'T -> obj`
   * erasure.
   */
  local<T, TMsg>(
    initialFrom: Binding<T>,
    flushOn: LocalFlushTrigger,
    onCommit: (value: T) => Action<TMsg>,
    parse: (raw: string) => Result<T, string>,
    format?: (value: T) => string,
  ): Binding<T> {
    const local: LocalBinding<T> =
      format !== undefined
        ? { initialFrom, flushOn, onCommit: (t: T) => onCommit(t), parse, format }
        : { initialFrom, flushOn, onCommit: (t: T) => onCommit(t), parse };
    return { kind: 'Local', local };
  },
  /**
   * Phase 102: locale-aware formatted value. Wraps a numeric `source` binding
   * and projects it to a localised display string via the renderer's `Intl`
   * formatter. `fmt` is the bounded semantic intent (build with `localeFormat`);
   * `loc` selects the BCP-47 locale (build with `locale`). Returns a
   * `Binding<string>` — drop it into any `Binding<string>` slot.
   */
  format(source: Binding<number>, fmt: Format, loc: LocaleSource): Binding<string> {
    return { kind: 'Format', source, format: fmt, locale: loc };
  },
  /**
   * Phase 282 — a declarative dataframe transform. A `pipeline` (the v1 verb set)
   * over a columnar `source`, evaluated client-side as data by @fuaran-ui/ops.
   * Build the pipeline ergonomically with `df(source).…` from `@fuaran-ui/ui`.
   * Resolves to the transformed rows at a data-bearing node's source slot.
   */
  transform<T>(source: DataSource, pipeline: readonly Transform[]): Binding<T> {
    return { kind: 'Transform', source: { kind: 'Data', source }, pipeline };
  },
  /**
   * Phase 818 — a LIVE declarative dataframe transform (the reactive-derivation
   * first cut). `source` is a binding (typically `binding.state` carrying
   * initial rows in its default; a selection / query binding also works) the
   * runtime re-evaluates the pipeline against with subscription semantics — a
   * `SetState` on the key re-derives every reader. The resolver derives the
   * evaluation table from the binding's resolved value (its carried default
   * until the store is written), so the authoring-side `initial` snapshot
   * starts empty — the renderer never reads it for a resolvable source.
   */
  transformLive<T>(source: Binding<JsonValue>, pipeline: readonly Transform[]): Binding<T> {
    return {
      kind: 'Transform',
      source: {
        kind: 'Live',
        binding: source,
        initial: { kind: 'Embedded', table: { schema: [], columns: [] } },
      },
      pipeline,
    };
  },
  /**
   * Phase 283 — invoke a host-registered compute capability for a value.
   * `args` are scalar `(addr, value)` pairs; the body is host-provided, never on
   * the wire. (Resolves to a `Deferred<T>` once the Phase 283 runtime lands.)
   */
  invoke<T>(capabilityId: string, args: readonly InvokeArg[] = []): Binding<T> {
    return { kind: 'Invoke', capabilityId, args };
  },
};

// ─── Typed action entry points (the `action` namespace) ──────────────────────

export const action = {
  dispatch<TMsg>(msg: TMsg): Action<TMsg> {
    return { kind: 'Dispatch', msg };
  },
  call<TResult, TMsg>(
    endpoint: ApiEndpoint | string,
    onResult: (result: TResult) => TMsg,
  ): Action<TMsg> {
    return {
      kind: 'Call',
      endpoint: typeof endpoint === 'string' ? apiEndpoint(endpoint) : endpoint,
      onResult: (o: unknown) => onResult(o as TResult),
    };
  },
  /**
   * Declarative fetch (Phase 428): call the endpoint and write the response to
   * the `$state.<key>` slot — every `Binding.State key` reader re-renders on
   * completion (the closure-free shape an AI author emits).
   */
  callIntoState<TMsg>(endpoint: ApiEndpoint | string, key: string): Action<TMsg> {
    return {
      kind: 'Call',
      endpoint: typeof endpoint === 'string' ? apiEndpoint(endpoint) : endpoint,
      into: { kind: 'State', key },
    };
  },
  /**
   * Declarative fetch (Phase 428): call the endpoint and write the response to
   * the `queryResults` slot `<name>` — every `Binding.Query name` reader
   * re-renders on completion (data-preserving per the 421 identity accessor).
   */
  callIntoQuery<TMsg>(endpoint: ApiEndpoint | string, name: string): Action<TMsg> {
    return {
      kind: 'Call',
      endpoint: typeof endpoint === 'string' ? apiEndpoint(endpoint) : endpoint,
      into: { kind: 'Query', name },
    };
  },
  notify<TMsg>(channel: string, payload: JsonValue): Action<TMsg> {
    return { kind: 'Notify', channel, payload };
  },
  navigate<TMsg>(route: string): Action<TMsg> {
    return { kind: 'Navigate', route };
  },
  setState<TMsg>(key: string, value: JsonValue): Action<TMsg> {
    return { kind: 'SetState', key, value };
  },
  /**
   * Phase 818 — write a DERIVED value to the State channel: `source` is a
   * Binding evaluated at dispatch time inside the existing gate (value XOR
   * valueFrom on the wire). Closes "set state from what the user
   * clicked/typed" without closures — e.g.
   * `action.setStateFrom('chosen-id', binding.selectionField('grid', 'id'))`.
   */
  setStateFrom<TMsg>(key: string, source: Binding<JsonValue>): Action<TMsg> {
    return { kind: 'SetState', key, valueFrom: source };
  },
  aiTool<TMsg>(toolName: string, args: JsonValue): Action<TMsg> {
    return { kind: 'AiTool', toolName, args };
  },
  chain<TMsg>(actions: readonly Action<TMsg>[]): Action<TMsg> {
    return { kind: 'Chain', actions };
  },
  commitLocal<TMsg>(id: string): Action<TMsg> {
    return { kind: 'CommitLocal', nodeId: id };
  },
  writeToClipboard<TMsg>(text: string): Action<TMsg> {
    return { kind: 'WriteToClipboard', text };
  },
  /**
   * Phase 136 — read a previously-selected file's body in `encoding`, then
   * dispatch `onRead body`. `file` is the opaque `FileRef` handed to the
   * author on a `FileSelection`. Routes through `FuaranRuntime.readFileBody`
   * (browser fallback: `FileReader`) — no consumer-side interop.
   */
  readFileBody<TMsg>(
    file: FileRef,
    encoding: FileReadEncoding,
    onRead: (body: string) => TMsg,
  ): Action<TMsg> {
    return { kind: 'ReadFileBody', file, encoding, onRead };
  },
  /**
   * Phase 283 — invoke a host-registered compute capability as an effect (the
   * effectful sibling of `binding.invoke`). Same wire shape: `capabilityId` +
   * scalar `(addr, value)` args; the body never on the wire.
   */
  invoke<TMsg>(capabilityId: string, args: readonly InvokeArg[] = []): Action<TMsg> {
    return { kind: 'Invoke', capabilityId, args };
  },
};

// ─── Typed format entry points (the `format` namespace) ──────────────────────

export const format = {
  none(): CellFormat {
    return { kind: 'None' };
  },
  currency(code: string): CellFormat {
    return { kind: 'Currency', code };
  },
  percent(decimals?: number): CellFormat {
    return decimals !== undefined ? { kind: 'Percent', decimals } : { kind: 'Percent' };
  },
  number(decimals?: number): CellFormat {
    return decimals !== undefined ? { kind: 'Number', decimals } : { kind: 'Number' };
  },
  significantDigits(digits: number): CellFormat {
    return { kind: 'SignificantDigits', digits };
  },
  date(fmt: string): CellFormat {
    return { kind: 'Date', format: fmt };
  },
};

// ─── Locale-aware Format / LocaleSource entry points (Phase 102) ─────────────
//
// The bounded, semantic formatting intent + locale selector carried by
// `binding.format`. Distinct from the `format` namespace above (which builds
// `CellFormat` for grid columns / KPIs) — these build the locale-aware `Format`
// DU. No raw Intl option-bag escape.

export const localeFormat = {
  number(decimals?: number): Format {
    return decimals !== undefined ? { kind: 'Number', decimals } : { kind: 'Number' };
  },
  currency(isoCode: string): Format {
    return { kind: 'Currency', isoCode };
  },
  percent(decimals?: number): Format {
    return decimals !== undefined ? { kind: 'Percent', decimals } : { kind: 'Percent' };
  },
  date(dateStyle: DateStyle): Format {
    return { kind: 'Date', dateStyle };
  },
  relativeTime(unit: RelativeTimeUnit): Format {
    return { kind: 'RelativeTime', unit };
  },
};

export const locale = {
  /** Defer to the host-supplied ambient locale. */
  ambient(): LocaleSource {
    return { kind: 'Ambient' };
  },
  /** Pin an explicit BCP-47 locale tag (e.g. "en-GB"). */
  explicit(tag: string): LocaleSource {
    return { kind: 'Explicit', tag };
  },
};

// ─── Column helpers (the `column` namespace) ─────────────────────────────────

export const column = {
  text<TRow, TMsg>(label: string, value: (row: TRow) => string): Column<TRow, TMsg> {
    return {
      ...defaults.column<TRow, TMsg>(),
      label,
      value: (r) => ({ kind: 'Text', value: value(r) }),
      kind: { kind: 'Text' },
    };
  },
  numeric<TRow, TMsg>(label: string, value: (row: TRow) => number): Column<TRow, TMsg> {
    return {
      ...defaults.column<TRow, TMsg>(),
      label,
      value: (r) => ({ kind: 'Numeric', value: value(r) }),
      kind: { kind: 'Numeric' },
    };
  },
  date<TRow, TMsg>(label: string, value: (row: TRow) => Date): Column<TRow, TMsg> {
    return {
      ...defaults.column<TRow, TMsg>(),
      label,
      value: (r) => ({ kind: 'Date', value: value(r) }),
      kind: { kind: 'Date' },
    };
  },
  bool<TRow, TMsg>(label: string, value: (row: TRow) => boolean): Column<TRow, TMsg> {
    return {
      ...defaults.column<TRow, TMsg>(),
      label,
      value: (r) => ({ kind: 'Bool', value: value(r) }),
      kind: { kind: 'Text' },
    };
  },
  editable<TRow, TMsg>(
    onEdit: (row: TRow, value: CellValue) => Action<TMsg>,
    col: Column<TRow, TMsg>,
  ): Column<TRow, TMsg> {
    return { ...col, kind: { kind: 'Editable', onEdit } };
  },
  /**
   * Postfix helper: render a column's value as a tone-bearing pill. Reuses the
   * column's existing value accessor for the pill label (projected to text) and
   * the supplied function for the per-row `ToneVariant`. The renderer already
   * ships the `Pill` cell — this is the author-surface entry point so grids
   * reach the pill idiom without hand-constructing the row-erased `kind: 'Pill'`.
   *
   * Mirrors the F# `Column.withPill`.
   */
  withPill<TRow, TMsg>(
    tone: (row: TRow) => ToneVariant,
    col: Column<TRow, TMsg>,
  ): Column<TRow, TMsg> {
    return {
      ...col,
      kind: { kind: 'Pill', label: (r) => cellValueToText(col.value(r)), tone },
    };
  },
  /**
   * Postfix helper: render a column's value as a tone-bearing pill whose tone comes from
   * a DECLARED value→tone map rather than a host closure (Phase 750). Unlike
   * {@link withPill} this survives the wire intact — the pill's label and tone key are
   * both the named row property, so a decoded grid renders the distinction with zero host
   * code, and an AI author can emit it.
   *
   * `defaultTone` covers a value the map does not mention; `'Default'` means "leave the
   * rest plain" (it is then omitted on the wire).
   *
   * Mirrors the F# `Column.withTonedPill`.
   */
  withTonedPill<TRow, TMsg>(
    field: string,
    map: Readonly<Record<string, ToneVariant>>,
    defaultTone: ToneVariant,
    col: Column<TRow, TMsg>,
  ): Column<TRow, TMsg> {
    return { ...col, kind: { kind: 'TonedPill', field, map, defaultTone } };
  },
  withFormat<TRow, TMsg>(fmt: CellFormat, col: Column<TRow, TMsg>): Column<TRow, TMsg> {
    return { ...col, format: fmt };
  },
  withWidth<TRow, TMsg>(width: ColumnWidth, col: Column<TRow, TMsg>): Column<TRow, TMsg> {
    return { ...col, width };
  },
  /** Erase a typed `Column<TRow, TMsg>` into the tree-level `ColumnErased<TMsg>`. */
  erase<TRow, TMsg>(col: Column<TRow, TMsg>): ColumnErased<TMsg> {
    const k = col.kind;
    let erased: ColumnErased<TMsg>['kind'];
    switch (k.kind) {
      case 'Text':
        erased = { kind: 'Text' };
        break;
      case 'Numeric':
        erased = { kind: 'Numeric' };
        break;
      case 'Date':
        erased = { kind: 'Date' };
        break;
      case 'Editable':
        erased = { kind: 'Editable', onEdit: (o, v) => k.onEdit(o as TRow, v) };
        break;
      case 'Checkbox':
        erased = {
          kind: 'Checkbox',
          get: (o) => k.get(o as TRow),
          onToggle: (o, b) => k.onToggle(o as TRow, b),
        };
        break;
      case 'Button':
        erased = { kind: 'Button', label: k.label, onClick: (o) => k.onClick(o as TRow) };
        break;
      case 'ButtonGroup':
        erased = {
          kind: 'ButtonGroup',
          buttons: k.buttons.map(([l, f]) => [l, (o: unknown) => f(o as TRow)] as const),
        };
        break;
      case 'Link':
        erased = {
          kind: 'Link',
          href: (o) => k.href(o as TRow),
          label: (o) => k.label(o as TRow),
        };
        break;
      case 'Pill':
        erased = {
          kind: 'Pill',
          label: (o) => k.label(o as TRow),
          tone: (o) => k.tone(o as TRow),
        };
        break;
      // Phase 750 — nothing to erase: the declarative pill holds no row accessor, so the
      // typed and erased forms are the same three values.
      case 'TonedPill':
        erased = { kind: 'TonedPill', field: k.field, map: k.map, defaultTone: k.defaultTone };
        break;
      case 'Progress': {
        const labelFn = k.label;
        erased = {
          kind: 'Progress',
          fraction: (o) => k.fraction(o as TRow),
          ...(labelFn !== undefined ? { label: (o: unknown) => labelFn(o as TRow) } : {}),
        };
        break;
      }
      case 'Custom':
        erased = {
          kind: 'Custom',
          render: (jsonOf: (row: unknown) => JsonValue) => k.render((r: TRow) => jsonOf(r)),
        };
        break;
    }
    return {
      label: col.label,
      value: (o) => col.value(o as TRow),
      format: col.format,
      kind: erased,
      width: col.width,
    };
  },
};

// ─── FormFieldKind / FilterKind smart constructors ───────────────────────────

export const formFieldKind = {
  rangedNumber<TMsg>(
    value: Binding<number>,
    onChange: (value: number) => Action<TMsg>,
    constraints?: NumberFieldConstraints,
  ): FormFieldKind<TMsg> {
    return { kind: 'RangedNumber', value, onChange, constraints: constraints ?? {} };
  },
  numberStepped<TMsg>(
    value: Binding<number>,
    onChange: (value: number) => Action<TMsg>,
    step: number,
  ): FormFieldKind<TMsg> {
    return { kind: 'RangedNumber', value, onChange, constraints: { step } };
  },
  segmentedChoice<TMsg>(
    options: Binding<readonly SelectOption[]>,
    value: Binding<string | undefined>,
    onChange: (value: string | undefined) => Action<TMsg>,
    orientation: Orientation = 'Horizontal',
  ): FormFieldKind<TMsg> {
    return { kind: 'SegmentedChoice', options, value, onChange, orientation };
  },
  date<TMsg>(
    value: Binding<string>,
    onChange: (value: string) => Action<TMsg>,
    variant: DateVariant = 'Date',
    constraints?: DateFieldConstraints,
  ): FormFieldKind<TMsg> {
    return { kind: 'Date', value, onChange, variant, constraints: constraints ?? {} };
  },
  /**
   * Phase 725 — single-control date range. `value` is the ordered `(from, to)`
   * ISO-8601 pair; `constraints` bound BOTH ends.
   */
  dateRange<TMsg>(
    value: Binding<readonly [string, string]>,
    onChange: (value: readonly [string, string]) => Action<TMsg>,
    variant: DateVariant = 'Date',
    constraints?: DateFieldConstraints,
  ): FormFieldKind<TMsg> {
    return { kind: 'DateRange', value, onChange, variant, constraints: constraints ?? {} };
  },

  // ── Handler-free (declarative) ctors — Phase 426, the control write-back
  //    default. Each omits the handler, the shape an AI author uses: the
  //    renderer writes the changed value back to the field's own `value`
  //    binding when that binding is directly `State` / `Filter` (any other
  //    shape is inert — FUARAN069). Mirrors the F# `FormFieldKind.*Declarative`
  //    family.

  /** Handler-free `Text` — writes the typed string back to the value slot. */
  textDeclarative<TMsg>(value: Binding<string>): FormFieldKind<TMsg> {
    return { kind: 'Text', value };
  },
  /** Handler-free `Number` — writes the typed number back to the value slot. */
  numberDeclarative<TMsg>(value: Binding<number>): FormFieldKind<TMsg> {
    return { kind: 'Number', value };
  },
  /** Handler-free `Checkbox` — writes the toggled bool back to the value slot. */
  checkboxDeclarative<TMsg>(value: Binding<boolean>): FormFieldKind<TMsg> {
    return { kind: 'Checkbox', value };
  },
  /** Handler-free `Choice` — writes the chosen option back; a cleared choice clears the slot. */
  choiceDeclarative<TMsg>(
    options: Binding<readonly SelectOption[]>,
    value: Binding<string | undefined>,
  ): FormFieldKind<TMsg> {
    return { kind: 'Choice', options, value };
  },
  /** Handler-free `TextArea` — writes the typed string back to the value slot. */
  textAreaDeclarative<TMsg>(value: Binding<string>, rows: number): FormFieldKind<TMsg> {
    return { kind: 'TextArea', value, rows };
  },
  /** Handler-free `RangedNumber` — writes the typed number back to the value slot. */
  rangedNumberDeclarative<TMsg>(
    value: Binding<number>,
    constraints?: NumberFieldConstraints,
  ): FormFieldKind<TMsg> {
    return { kind: 'RangedNumber', value, constraints: constraints ?? {} };
  },
  /** Handler-free `SegmentedChoice` — writes the chosen option back to the value slot. */
  segmentedChoiceDeclarative<TMsg>(
    options: Binding<readonly SelectOption[]>,
    value: Binding<string | undefined>,
    orientation: Orientation = 'Horizontal',
  ): FormFieldKind<TMsg> {
    return { kind: 'SegmentedChoice', options, value, orientation };
  },
  /** Handler-free `Date` — writes the ISO-8601 string back to the value slot. */
  dateDeclarative<TMsg>(
    value: Binding<string>,
    variant: DateVariant = 'Date',
    constraints?: DateFieldConstraints,
  ): FormFieldKind<TMsg> {
    return { kind: 'Date', value, variant, constraints: constraints ?? {} };
  },
  /** Handler-free `DateRange` — writes the changed (from, to) pair back to the value slot. */
  dateRangeDeclarative<TMsg>(
    value: Binding<readonly [string, string]>,
    variant: DateVariant = 'Date',
    constraints?: DateFieldConstraints,
  ): FormFieldKind<TMsg> {
    return { kind: 'DateRange', value, variant, constraints: constraints ?? {} };
  },
};

// 0.2.0 filters-unification: a chip's control is an ordinary `FormFieldKind`
// auto-bound to its own filter key — mirror of the F# `FilterField` module.
export const filterField = {
  /** Text chip bound to its own filter key. */
  text<TMsg>(name: string): FormFieldKind<TMsg> {
    return { kind: 'Text', value: { kind: 'Filter', name } };
  },
  /** Dropdown choice chip bound to its own filter key. */
  choice<TMsg>(name: string, options: Binding<readonly SelectOption[]>): FormFieldKind<TMsg> {
    return { kind: 'Choice', options, value: { kind: 'Filter', name } };
  },
  /** Segmented choice chip bound to its own filter key. */
  segmented<TMsg>(
    name: string,
    options: Binding<readonly SelectOption[]>,
    orientation: Orientation = 'Horizontal',
  ): FormFieldKind<TMsg> {
    return { kind: 'SegmentedChoice', options, value: { kind: 'Filter', name }, orientation };
  },
  /** Dual-thumb range chip bound to its own filter key. */
  range<TMsg>(name: string): FormFieldKind<TMsg> {
    return { kind: 'Range', value: { kind: 'Filter', name } };
  },
  /** Date-range chip bound to its own filter key (Phase 725). */
  dateRange<TMsg>(name: string, variant: DateVariant = 'Date'): FormFieldKind<TMsg> {
    return { kind: 'DateRange', value: { kind: 'Filter', name }, variant, constraints: {} };
  },
};

// ─── Components — the `fuaran` author surface ────────────────────────────────

// Author surface accepts a bare `string` for any node id and brands it to
// `NodeId` here — mirroring the F# `Fuaran.X` surface, whose ids are plain
// string literals. A pre-branded `NodeId` is still accepted (it is a `string`
// subtype), so this is a backward-compatible widening.
const buildNode = <TMsg>(
  id: NodeId | string,
  kind: NodeKind<TMsg>,
  accessibility?: Accessibility,
): Node<TMsg> => {
  const base: Node<TMsg> = {
    id: nodeId(id),
    kind,
    state: defaults.stateBehaviour<TMsg>(),
    style: defaults.style,
  };
  return accessibility !== undefined ? { ...base, accessibility } : base;
};

// Option object shapes -------------------------------------------------------

export interface DashboardOptions<TMsg> {
  readonly id: NodeId | string;
  readonly children?: readonly Node<TMsg>[];
}

export interface StackOptions<TMsg> {
  readonly id: NodeId | string;
  readonly orientation?: Orientation;
  readonly children?: readonly Node<TMsg>[];
  readonly wrap?: boolean;
}

export interface GridLayoutOptions<TMsg> {
  readonly id: NodeId | string;
  readonly cols?: number;
  readonly children?: readonly Node<TMsg>[];
  readonly templateColumns?: string;
}

export interface SplitPanelOptions<TMsg> {
  readonly id: NodeId | string;
  readonly weight?: number;
  readonly children?: readonly Node<TMsg>[];
}

export interface TabsOptions<TMsg> {
  readonly id: NodeId | string;
  readonly orientation?: Orientation;
  readonly children?: readonly Node<TMsg>[];
  readonly activeIndex?: Binding<number>;
  readonly onSelect?: (index: number) => Action<TMsg>;
  readonly tabHeaders?: readonly TabHeader[];
  readonly tabTags?: readonly string[];
  readonly activeTag?: Binding<string>;
  readonly onSelectTag?: (tag: string) => Action<TMsg>;
}

export interface CardOptions<TMsg> {
  readonly id: NodeId | string;
  readonly heading?: TextInput;
  readonly children?: readonly Node<TMsg>[];
}

export interface StepperOptions<TMsg> {
  readonly id: NodeId | string;
  readonly activeStep?: Binding<number>;
  readonly children?: readonly Node<TMsg>[];
  /** Step-header click dispatch (defaults to a no-op `Chain []`). */
  readonly onSelect?: (index: number) => Action<TMsg>;
}

export interface SummaryListOptions<TMsg> {
  readonly id: NodeId | string;
  readonly heading?: TextInput;
  readonly children?: readonly Node<TMsg>[];
}

export interface DisclosureOptions<TMsg> {
  readonly id: NodeId | string;
  readonly heading?: TextInput;
  readonly open?: Binding<boolean>;
  readonly onToggle?: (open: boolean) => Action<TMsg>;
  readonly children?: readonly Node<TMsg>[];
  readonly defaultOpen?: boolean;
}

export interface MetricOptions {
  readonly id: NodeId | string;
  readonly label: TextInput;
  readonly value: string | NumberInput;
  readonly format?: CellFormat;
  readonly tone?: ToneVariant;
  readonly weight?: StyleWeight;
  readonly emphasis?: Emphasis;
  readonly trend?: NumberInput;
  readonly trendFormat?: CellFormat;
  /** Phase 867 - which direction of this quantity is GOOD; defaults to `HigherIsBetter`. */
  readonly trendPolarity?: TrendPolarity;
  readonly icon?: string;
  readonly subtext?: TextInput;
}

export interface HeadingOptions {
  readonly id: NodeId | string;
  readonly text: TextInput;
  readonly level?: number;
  readonly variant?: HeadingVariant;
}

export interface LabelValueRowOptions {
  readonly id: NodeId | string;
  readonly label: TextInput;
  readonly value: NumberInput;
  readonly format?: CellFormat;
  readonly emphasis?: boolean;
  readonly help?: TextInput;
}

export interface FactOptions {
  readonly id: NodeId | string;
  readonly label: TextInput;
  readonly value: TextInput;
  readonly tone?: ToneVariant;
  readonly emphasis?: boolean;
  readonly help?: TextInput;
}

export interface BadgeOptions {
  readonly id: NodeId | string;
  readonly label: TextInput;
  readonly variant?: BadgeVariant;
}

export interface LinkOptions {
  readonly id: NodeId | string;
  readonly href: StringInput;
  readonly label: TextInput;
  readonly rel?: string;
  readonly target?: string;
  readonly download?: boolean;
  /** Phase 812 — anti-scraper render strategy (`'email'` for a protected `mailto:`). */
  readonly protection?: LinkProtection;
}

export interface ImageOptions {
  readonly id: NodeId | string;
  readonly src: StringInput;
  readonly alt: TextInput;
  readonly variant?: ImageVariant;
  /** Phase 1077 — how the pixels fill the box; omitted ⇒ `'Natural'` (no `object-fit`). */
  readonly fit?: ImageFit;
  /** Phase 1077 — the box reserved before the image loads; omitted ⇒ `'Natural'` (no reservation). */
  readonly aspectRatio?: ImageAspect;
  /** Phase 1077 — fetch timing; omitted ⇒ `'Eager'` (no attribute, the browser default). */
  readonly loading?: ImageLoading;
  /**
   * Phase 1078 — an optional caption. Present, the image renders inside a
   * `<figure>` with the resolved text in a `<figcaption>`; omitted, the
   * emission is the bare `<img>`. A full `TextSource`, so it is i18n-capable.
   */
  readonly caption?: TextInput;
  /**
   * Phase 1080 — alternate renditions of the same picture at declared intrinsic
   * pixel widths. Omitted (or empty) emits no `srcset` at all. Authored order is
   * free: the renderers emit candidates ascending by width, and the wire keeps
   * whatever order you wrote.
   */
  readonly srcSet?: readonly SrcSetEntryInput[];
  /**
   * Phase 1079 — whether the full-size asset is reachable from the rendered
   * image. Set, the renderers wrap the `<img>` in a real `<a href>` to the
   * source and mark it `data-fuaran-expandable`: the link works with no script,
   * and an enhancement tier upgrades it in place into an in-page overlay.
   * Omitted ⇒ `false`, the bare `<img>`.
   */
  readonly expandable?: boolean;
}

/**
 * Phase 1080 — one candidate rendition in `ImageOptions.srcSet`. `width` is the
 * `w` descriptor and must be a positive integer; the wire refuses zero and
 * negative widths. `src` passes the same URL floor the primary source does — a
 * candidate that fails it is dropped from the emitted list rather than served.
 */
export interface SrcSetEntryInput {
  readonly src: StringInput;
  readonly width: number;
}

export interface ListOptions {
  readonly id: NodeId | string;
  readonly items: readonly TextInput[];
  readonly ordered?: boolean;
}

export interface DividerOptions {
  readonly id: NodeId | string;
}

export interface ToastOptions {
  readonly id: NodeId | string;
  readonly message: TextInput;
  readonly tone?: ToneVariant;
  readonly open?: BoolInput;
  readonly dismissable?: boolean;
}

export interface ModalOptions<TMsg> {
  readonly id: NodeId | string;
  readonly open?: BoolInput;
  readonly heading?: TextInput;
  readonly dismissable?: boolean;
  readonly children?: readonly Node<TMsg>[];
  readonly onDismiss?: Action<TMsg>;
}

export interface CodeBlockOptions {
  readonly id: NodeId | string;
  readonly code: string;
  readonly language?: string;
  readonly lineNumbers?: boolean;
  readonly highlightLines?: readonly number[];
  readonly copyable?: boolean;
}

export interface MathOptions {
  readonly id: NodeId | string;
  readonly source: string;
  readonly display?: MathDisplay;
}

export interface ScrollAreaOptions<TMsg> {
  readonly id: NodeId | string;
  readonly orientation?: ScrollOrientation;
  readonly children?: readonly Node<TMsg>[];
  readonly maxHeight?: number;
  readonly maxWidth?: number;
}

export interface SparklineOptions {
  readonly id: NodeId | string;
  readonly source: readonly number[] | Binding<readonly number[]>;
}

export interface CalloutOptions {
  readonly id: NodeId | string;
  readonly body: TextInput;
  readonly tone?: ToneVariant;
  readonly heading?: TextInput;
  readonly icon?: string;
  readonly dismissable?: boolean;
}

export interface ProgressOptions {
  readonly id: NodeId | string;
  readonly fraction: NumberInput;
  readonly label?: TextInput;
  readonly caveat?: TextInput;
  readonly indeterminate?: boolean;
  readonly tone?: ToneVariant;
}

export interface ButtonOptions<TMsg> {
  readonly id: NodeId | string;
  readonly label: TextInput;
  readonly onClick?: Action<TMsg>;
  readonly variant?: ButtonVariant;
  readonly icon?: string;
  readonly tooltip?: TextInput;
  /** Phase 129 — optional bound disabled-state; absent means always enabled. */
  readonly disabled?: Binding<boolean>;
}

export interface SelectOptions<TMsg> {
  readonly id: NodeId | string;
  readonly label: TextInput;
  readonly source: Binding<readonly SelectOption[]>;
  readonly value: Binding<string | undefined>;
  /** Phase 426 — optional; omitted arms the `value` write-back default. */
  readonly onChange?: (value: string | undefined) => Action<TMsg>;
  readonly placeholder?: TextInput;
  /** Phase 130 — optional bound disabled-state; absent means always enabled. */
  readonly disabled?: Binding<boolean>;
  /** Phase 291 — multi-select flag; absent/false is single-select. */
  readonly multiple?: boolean;
  /** Phase 291 — the multi-select value binding (the selected-value list). */
  readonly values?: readonly string[] | Binding<readonly string[]>;
  /** Phase 426 — optional multi handler; omitted arms the `values` write-back default. */
  readonly onChangeMulti?: (values: readonly string[]) => Action<TMsg>;
}

export interface FormOptions<TMsg> {
  readonly id: NodeId | string;
  readonly fields: readonly FormField<TMsg>[];
  readonly onSubmit: Action<TMsg>;
  readonly submitLabel?: TextInput;
  /** Phase 130 — optional bound disabled-state; absent means always enabled. */
  readonly disabled?: Binding<boolean>;
}

export interface FileUploadOptions<TMsg> {
  readonly id: NodeId | string;
  readonly label: TextInput;
  readonly onSelect: (files: readonly FileSelection[]) => Action<TMsg>;
  readonly accept?: readonly string[];
  readonly multiple?: boolean;
  /** Phase 130 — optional bound disabled-state; absent means always enabled. */
  readonly disabled?: Binding<boolean>;
}

export interface ChartOptions<TMsg> {
  readonly id: NodeId | string;
  readonly source: Binding<readonly unknown[]>;
  readonly xField: string;
  readonly yFields: readonly string[];
  readonly kind?: ChartKind;
  readonly title?: TextInput;
  readonly onPointClick?: (point: unknown) => Action<TMsg>;
  readonly stacked?: boolean;
}

export interface TableOptions<TMsg> {
  readonly id: NodeId | string;
  readonly headers: readonly TextInput[];
  readonly rows: readonly (readonly TextInput[])[];
  readonly onRowClick?: (index: number) => Action<TMsg>;
}

export interface MapOptions<TMsg> {
  readonly id: NodeId | string;
  readonly source: Binding<readonly MapMarker[]>;
  readonly centreLatitude?: number;
  readonly centreLongitude?: number;
  readonly zoom?: number;
  readonly onMarkerClick?: (marker: MapMarker) => Action<TMsg>;
}

export interface GridOptions<TRow, TMsg> {
  readonly id: NodeId | string;
  readonly source: Binding<readonly TRow[]>;
  readonly rowKey: (row: TRow) => string;
  readonly columns: readonly Column<TRow, TMsg>[];
  readonly onRowClick?: (row: TRow) => Action<TMsg>;
  readonly editable?: boolean;
  // Phase 934 — declarative row reorder; absent means off, as `editable`.
  readonly reorderable?: boolean;
}

export interface CustomOptions {
  readonly id: NodeId | string;
  readonly moduleId: string;
  readonly componentId: string;
  readonly props?: Readonly<Record<string, JsonValue>>;
  readonly contentHash?: ContentHash;
  readonly exposedNodeIds?: readonly NodeId[];
}

export interface ErrorBoundaryOptions<TMsg> {
  readonly id: NodeId | string;
  readonly child: Node<TMsg>;
  readonly fallback: Node<TMsg>;
}

/** Options for {@link fuaran.switch} (Phase 392). */
export interface SwitchOptions<TMsg> {
  readonly id: NodeId | string;
  /** The reactive state key whose value selects the case. */
  readonly stateKey: string;
  /** Ordered `{ match, child }` cases; first match on the state value's string form wins. */
  readonly cases: readonly { readonly match: string; readonly child: Node<TMsg> }[];
  /** Rendered when no case matches (and the SSR / first-paint surface). */
  readonly default: Node<TMsg>;
}

export interface FragmentDeclOptions<TMsg> {
  readonly id: NodeId | string;
  readonly name: string;
  readonly body: Node<TMsg>;
  /** Phase 180 — declared holes (value params + tree slots). Defaults to none (fixed-body). */
  readonly holes?: readonly HoleDecl[];
  /** Phase 180 — declared effect class. Defaults to pure-deterministic. */
  readonly effect?: EffectClass;
}

export interface FragmentRefOptions<TMsg> {
  readonly id: NodeId | string;
  readonly name: string;
  /** Phase 180 — bound arguments (value scalars + slot subtrees). Defaults to none. */
  readonly args?: Readonly<Record<string, FragmentArg<TMsg>>>;
}

export interface FiltersOptions<TMsg> {
  readonly id: NodeId | string;
  readonly filters: readonly FilterSpec<TMsg>[];
}

export const fuaran = {
  // ─── Layout ────────────────────────────────────────────────────────────
  // Phase 390 — `dashboard` / `stack` / `gridLayout` / `card` are now
  // `Box`-emitting convenience surfaces (mirroring the F# smart ctors). The
  // authoring vocabulary is unchanged; only the wire consolidates to `Box`.
  dashboard<TMsg>(o: DashboardOptions<TMsg>): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Layout',
        layout: {
          kind: 'Box',
          spec: { layout: { kind: 'Auto' }, role: 'Dashboard', children: o.children ?? [] },
        },
      },
      defaults.accessibility.dashboard,
    );
  },
  stack<TMsg>(o: StackOptions<TMsg>): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Layout',
      layout: {
        kind: 'Box',
        spec: {
          layout: { kind: 'Flex', direction: o.orientation ?? 'Vertical', wrap: o.wrap ?? false },
          role: 'Group',
          children: o.children ?? [],
        },
      },
    });
  },
  gridLayout<TMsg>(o: GridLayoutOptions<TMsg>): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Layout',
      layout: {
        kind: 'Box',
        spec: {
          layout: {
            kind: 'Grid',
            cols: o.cols ?? 12,
            ...(o.templateColumns !== undefined ? { templateColumns: o.templateColumns } : {}),
          },
          role: 'Group',
          children: o.children ?? [],
        },
      },
    });
  },
  /** Phase 67: irregular-grid ctor; pre-populates `templateColumns`. */
  gridLayoutTemplated<TMsg>(o: GridLayoutOptions<TMsg> & { templateColumns: string }): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Layout',
      layout: {
        kind: 'Box',
        spec: {
          layout: { kind: 'Grid', cols: o.cols ?? 12, templateColumns: o.templateColumns },
          role: 'Group',
          children: o.children ?? [],
        },
      },
    });
  },
  splitPanel<TMsg>(o: SplitPanelOptions<TMsg>): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Layout',
      layout: { kind: 'SplitPanel', spec: { weight: o.weight ?? 0.5, children: o.children ?? [] } },
    });
  },
  tabs<TMsg>(o: TabsOptions<TMsg>): Node<TMsg> {
    return buildNode(
      o.id,
      { kind: 'Layout', layout: { kind: 'Tabs', spec: buildTabsSpec(o) } },
      defaults.accessibility.tabs,
    );
  },
  /**
   * Phase 69: tabs ctor for the typed-tag overlay. Requires both `tabHeaders`
   * and `tabTags` — the "I'm using the typed overlay" contract; throws otherwise.
   */
  tabsTagged<TMsg>(o: TabsOptions<TMsg>): Node<TMsg> {
    if (o.tabHeaders === undefined || o.tabTags === undefined) {
      throw new Error(
        'fuaran.tabsTagged requires both tabHeaders and tabTags; use fuaran.tabs for the integer-indexed shape.',
      );
    }
    return buildNode(
      o.id,
      { kind: 'Layout', layout: { kind: 'Tabs', spec: buildTabsSpec(o) } },
      defaults.accessibility.tabs,
    );
  },
  card<TMsg>(o: CardOptions<TMsg>): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Layout',
        layout: {
          kind: 'Box',
          spec: {
            layout: { kind: 'Flex', direction: 'Vertical', wrap: false },
            role: 'Card',
            children: o.children ?? [],
            ...(o.heading !== undefined ? { heading: text(o.heading) } : {}),
          },
        },
      },
      defaults.accessibility.card,
    );
  },
  stepper<TMsg>(o: StepperOptions<TMsg>): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Layout',
      layout: {
        kind: 'Stepper',
        spec: {
          activeStep: o.activeStep ?? { kind: 'Static', value: 0 },
          children: o.children ?? [],
          onSelect: o.onSelect ?? (() => action.chain<TMsg>([])),
        },
      },
    });
  },
  summaryList<TMsg>(o: SummaryListOptions<TMsg>): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Layout',
        layout: {
          kind: 'SummaryList',
          spec: {
            children: o.children ?? [],
            ...(o.heading !== undefined ? { heading: text(o.heading) } : {}),
          },
        },
      },
      defaults.accessibility.summaryList,
    );
  },
  disclosure<TMsg>(o: DisclosureOptions<TMsg>): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Layout',
        layout: {
          kind: 'Disclosure',
          spec: {
            heading: text(o.heading ?? ''),
            open: o.open ?? { kind: 'Static', value: false },
            // Phase 426: omitted by default — the `open` write-back default.
            ...(o.onToggle !== undefined ? { onToggle: o.onToggle } : {}),
            children: o.children ?? [],
            defaultOpen: o.defaultOpen ?? false,
          },
        },
      },
      defaults.accessibility.disclosure,
    );
  },
  modal<TMsg>(o: ModalOptions<TMsg>): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Layout',
        layout: {
          kind: 'Modal',
          spec: {
            open: boolBinding(o.open ?? false),
            dismissable: o.dismissable ?? false,
            children: o.children ?? [],
            // Phase 426: omitted by default — dismiss writes `false` to a
            // writable `open` binding (the write-back default).
            ...(o.onDismiss !== undefined ? { onDismiss: o.onDismiss } : {}),
            ...(o.heading !== undefined ? { heading: text(o.heading) } : {}),
          },
        },
      },
      defaults.accessibility.modal,
    );
  },
  scrollArea<TMsg>(o: ScrollAreaOptions<TMsg>): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Layout',
      layout: {
        kind: 'ScrollArea',
        spec: {
          orientation: o.orientation ?? 'Vertical',
          children: o.children ?? [],
          ...(o.maxHeight !== undefined ? { maxHeight: o.maxHeight } : {}),
          ...(o.maxWidth !== undefined ? { maxWidth: o.maxWidth } : {}),
        },
      },
    });
  },

  // ─── Display ───────────────────────────────────────────────────────────
  metric<TMsg>(o: MetricOptions): Node<TMsg> {
    const spec: MetricSpec = {
      ...defaults.metric,
      label: text(o.label),
      value: metricValue(o.value),
      ...(o.format !== undefined ? { format: o.format } : {}),
      ...(o.tone !== undefined ? { tone: o.tone } : {}),
      ...(o.weight !== undefined ? { weight: o.weight } : {}),
      ...(o.emphasis !== undefined ? { emphasis: o.emphasis } : {}),
      ...(o.trend !== undefined ? { trend: numberBinding(o.trend) } : {}),
      ...(o.trendFormat !== undefined ? { trendFormat: o.trendFormat } : {}),
      ...(o.trendPolarity !== undefined ? { trendPolarity: o.trendPolarity } : {}),
      ...(o.icon !== undefined ? { icon: iconSource(o.icon) } : {}),
      ...(o.subtext !== undefined ? { subtext: text(o.subtext) } : {}),
    };
    return buildNode(
      o.id,
      { kind: 'Display', display: { kind: 'Metric', spec } },
      defaults.accessibility.metric,
    );
  },
  heading<TMsg>(o: HeadingOptions): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Display',
      display: {
        kind: 'Heading',
        spec: { level: o.level ?? 2, text: text(o.text), variant: o.variant ?? 'Standard' },
      },
    });
  },
  labelValueRow<TMsg>(o: LabelValueRowOptions): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Display',
      display: {
        kind: 'LabelValueRow',
        spec: {
          label: text(o.label),
          value: numberBinding(o.value),
          format: o.format ?? { kind: 'None' },
          emphasis: o.emphasis ?? false,
          ...(o.help !== undefined ? { help: text(o.help) } : {}),
        },
      },
    });
  },
  fact<TMsg>(o: FactOptions): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Display',
      display: {
        kind: 'Fact',
        spec: {
          label: text(o.label),
          value: text(o.value),
          tone: o.tone ?? 'Default',
          emphasis: o.emphasis ?? false,
          ...(o.help !== undefined ? { help: text(o.help) } : {}),
        },
      },
    });
  },
  markdown<TMsg>(id: NodeId | string, body: string): Node<TMsg> {
    return buildNode(id, {
      kind: 'Display',
      display: { kind: 'Markdown', spec: { text: { kind: 'Literal', value: body } } },
    });
  },
  markdownSpec<TMsg>(id: NodeId | string, content: TextInput): Node<TMsg> {
    return buildNode(id, {
      kind: 'Display',
      display: { kind: 'Markdown', spec: { text: text(content) } },
    });
  },
  badge<TMsg>(o: BadgeOptions): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Display',
      display: { kind: 'Badge', spec: { label: text(o.label), variant: o.variant ?? 'Neutral' } },
    });
  },
  link<TMsg>(o: LinkOptions): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Display',
      display: {
        kind: 'Link',
        spec: {
          href: stringBinding(o.href),
          label: text(o.label),
          download: o.download ?? false,
          ...(o.rel !== undefined ? { rel: o.rel } : {}),
          ...(o.target !== undefined ? { target: o.target } : {}),
          ...(o.protection !== undefined ? { protection: o.protection } : {}),
        },
      },
    });
  },
  image<TMsg>(o: ImageOptions): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Display',
      display: {
        kind: 'Image',
        spec: {
          src: stringBinding(o.src),
          alt: text(o.alt),
          variant: o.variant ?? 'Default',
          fit: o.fit ?? 'Natural',
          aspectRatio: o.aspectRatio ?? 'Natural',
          loading: o.loading ?? 'Eager',
          // Phase 1080 — ALWAYS present on the spec, even when empty: the wire
          // says an absent `srcSet` is `[]`, so a constructed spec that left the
          // field off would disagree with what a decoded one carries.
          srcSet: (o.srcSet ?? []).map((e) => ({ src: stringBinding(e.src), width: e.width })),
          // Phase 1079 — ALWAYS present on the spec, for the reason `srcSet` is:
          // the wire says an absent `expandable` is `false`, so a constructed
          // spec that left the field off would disagree with a decoded one.
          expandable: o.expandable ?? false,
          ...(o.caption !== undefined ? { caption: text(o.caption) } : {}),
        },
      },
    });
  },
  list<TMsg>(o: ListOptions): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Display',
      display: {
        kind: 'List',
        spec: { items: o.items.map(text), ordered: o.ordered ?? false },
      },
    });
  },
  /**
   * A separator — a plain horizontal rule (Phase 459: the retired `Divider`,
   * now a `Box` `Separator` role). Renders `<hr class="fuaran-layout-separator">`.
   * For a labelled / vertical separator, author a `box` with `role: 'Separator'`
   * + a `heading` / horizontal layout axis directly.
   */
  divider<TMsg>(o: DividerOptions): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Layout',
      layout: {
        kind: 'Box',
        spec: {
          layout: { kind: 'Flex', direction: 'Horizontal', wrap: false },
          role: 'Separator',
          children: [],
        },
      },
    });
  },
  toast<TMsg>(o: ToastOptions): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Display',
        display: {
          kind: 'Toast',
          spec: {
            message: text(o.message),
            tone: o.tone ?? 'Default',
            open: boolBinding(o.open ?? false),
            dismissable: o.dismissable ?? false,
          },
        },
      },
      defaults.accessibility.toast,
    );
  },
  codeBlock<TMsg>(o: CodeBlockOptions): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Display',
      display: {
        kind: 'CodeBlock',
        spec: {
          code: o.code,
          language: o.language ?? '',
          lineNumbers: o.lineNumbers ?? false,
          highlightLines: o.highlightLines ?? [],
          copyable: o.copyable ?? false,
        },
      },
    });
  },
  math<TMsg>(o: MathOptions): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Display',
      display: {
        kind: 'Math',
        spec: { source: o.source, display: o.display ?? 'Inline' },
      },
    });
  },
  sparkline<TMsg>(o: SparklineOptions): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Display',
      display: { kind: 'Sparkline', spec: { source: numberArrayBinding(o.source) } },
    });
  },
  callout<TMsg>(o: CalloutOptions): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Display',
        display: {
          kind: 'Callout',
          spec: {
            tone: o.tone ?? 'Info',
            body: text(o.body),
            dismissable: o.dismissable ?? false,
            ...(o.heading !== undefined ? { heading: text(o.heading) } : {}),
            ...(o.icon !== undefined ? { icon: iconSource(o.icon) } : {}),
          } satisfies CalloutSpec,
        },
      },
      defaults.accessibility.callout,
    );
  },
  progress<TMsg>(o: ProgressOptions): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Display',
        display: {
          kind: 'Progress',
          spec: {
            fraction: numberBinding(o.fraction),
            indeterminate: o.indeterminate ?? false,
            tone: o.tone ?? 'Default',
            ...(o.label !== undefined ? { label: text(o.label) } : {}),
            ...(o.caveat !== undefined ? { caveat: text(o.caveat) } : {}),
          },
        },
      },
      defaults.accessibility.progress,
    );
  },
  skeleton<TMsg>(id: NodeId | string, rows: number): Node<TMsg> {
    return buildNode(id, { kind: 'Display', display: { kind: 'Skeleton', spec: { rows } } });
  },
  /** Phase 821 — the standalone icon-only display kind, decorative form
   * (no label ⇒ `aria-hidden`). Full record form via `iconSpec`. */
  icon<TMsg>(id: NodeId | string, name: string): Node<TMsg> {
    return buildNode(id, {
      kind: 'Display',
      display: { kind: 'Icon', spec: { icon: name, size: 'Medium', tone: 'Default' } },
    });
  },
  iconSpec<TMsg>(id: NodeId | string, spec: IconSpec): Node<TMsg> {
    return buildNode(id, { kind: 'Display', display: { kind: 'Icon', spec } });
  },

  // ─── Input ─────────────────────────────────────────────────────────────
  button<TMsg>(o: ButtonOptions<TMsg>): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Input',
        input: {
          kind: 'Button',
          spec: {
            label: text(o.label),
            onClick: o.onClick ?? action.chain<TMsg>([]),
            variant: o.variant ?? 'Secondary',
            ...(o.icon !== undefined ? { icon: iconSource(o.icon) } : {}),
            ...(o.tooltip !== undefined ? { tooltip: text(o.tooltip) } : {}),
            ...(o.disabled !== undefined ? { disabled: o.disabled } : {}),
          },
        },
      },
      defaults.accessibility.button,
    );
  },
  select<TMsg>(o: SelectOptions<TMsg>): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Input',
        input: {
          kind: 'Select',
          spec: {
            label: text(o.label),
            source: o.source,
            value: o.value,
            // Phase 426: omitted by default — the `value` write-back default.
            ...(o.onChange !== undefined ? { onChange: o.onChange } : {}),
            ...(o.placeholder !== undefined ? { placeholder: text(o.placeholder) } : {}),
            ...(o.disabled !== undefined ? { disabled: o.disabled } : {}),
            ...(o.multiple ? { multiple: true } : {}),
            ...(o.values !== undefined ? { values: stringArrayBinding(o.values) } : {}),
            ...(o.onChangeMulti !== undefined ? { onChangeMulti: o.onChangeMulti } : {}),
          },
        },
      },
      defaults.accessibility.select,
    );
  },
  form<TMsg>(o: FormOptions<TMsg>): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Input',
        input: {
          kind: 'Form',
          spec: {
            fields: o.fields,
            onSubmit: o.onSubmit,
            submitLabel: text(o.submitLabel ?? 'Submit'),
            ...(o.disabled !== undefined ? { disabled: o.disabled } : {}),
          },
        },
      },
      defaults.accessibility.form,
    );
  },
  filters<TMsg>(o: FiltersOptions<TMsg>): Node<TMsg> {
    return buildNode(o.id, { kind: 'Input', input: { kind: 'Filters', specs: o.filters } });
  },
  fileUpload<TMsg>(o: FileUploadOptions<TMsg>): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Input',
        input: {
          kind: 'FileUpload',
          spec: {
            label: text(o.label),
            accept: o.accept ?? [],
            multiple: o.multiple ?? false,
            onSelect: o.onSelect,
            ...(o.disabled !== undefined ? { disabled: o.disabled } : {}),
          },
        },
      },
      defaults.accessibility.fileUpload,
    );
  },

  // ─── Visualisation ───────────────────────────────────────────────────────
  chart<TMsg>(o: ChartOptions<TMsg>): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Visualisation',
        visualisation: {
          kind: 'Chart',
          spec: {
            source: o.source,
            kind: o.kind ?? 'Line',
            xField: o.xField,
            yFields: o.yFields,
            stacked: o.stacked ?? false,
            ...(o.title !== undefined ? { title: text(o.title) } : {}),
            ...(o.onPointClick !== undefined ? { onPointClick: o.onPointClick } : {}),
          },
        },
      },
      defaults.accessibility.chart,
    );
  },
  table<TMsg>(o: TableOptions<TMsg>): Node<TMsg> {
    // Phase 393 — a static read-only table lowers into the `staticRows` mode of `Grid`
    // (one tabular kind); the renderer emits semantic <table> markup. `onRowClick` on the
    // retired TableSpec was host-only and is not carried (the mode is non-interactive). The
    // empty Static source encodes to {"$type":"Static","value":[]} under the fuaran#665
    // typed row-source encoding — byte-identical to the F# static grid's
    // `Binding.Static Seq.empty`.
    return buildNode(
      o.id,
      {
        kind: 'Visualisation',
        visualisation: {
          kind: 'Grid',
          spec: {
            source: { kind: 'Static', value: [] },
            columns: [],
            editable: false,
            reorderable: false,
            staticRows: {
              headers: o.headers.map(text),
              rows: o.rows.map((row) => row.map(text)),
            },
          },
        },
      },
      defaults.accessibility.table,
    );
  },
  map<TMsg>(o: MapOptions<TMsg>): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Visualisation',
        visualisation: {
          kind: 'Map',
          spec: {
            source: o.source,
            centreLatitude: o.centreLatitude ?? 0,
            centreLongitude: o.centreLongitude ?? 0,
            zoom: o.zoom ?? 4,
            ...(o.onMarkerClick !== undefined ? { onMarkerClick: o.onMarkerClick } : {}),
          },
        },
      },
      defaults.accessibility.map,
    );
  },
  /**
   * Typed grid. Erases the row-typed `GridSpecOf<TRow, TMsg>` author surface
   * into the tree-level `GridSpec<TMsg>` (row = `unknown`), mirroring the F#
   * `Fuaran.grid` `obj`-erasure.
   */
  grid<TRow, TMsg>(o: GridOptions<TRow, TMsg>): Node<TMsg> {
    return buildNode(
      o.id,
      {
        kind: 'Visualisation',
        visualisation: {
          kind: 'Grid',
          spec: {
            source: eraseSource(o.source),
            rowKey: (row: unknown) => o.rowKey(row as TRow),
            columns: o.columns.map((c) => column.erase(c)),
            editable: o.editable ?? false,
            // Phase 934 — declarative row reorder; absent means off, as `editable`.
            reorderable: o.reorderable ?? false,
            ...(o.onRowClick !== undefined
              ? { onRowClick: (row: unknown) => o.onRowClick!(row as TRow) }
              : {}),
          },
        },
      },
      defaults.accessibility.grid,
    );
  },

  // ─── Custom / ErrorBoundary / Fragment ─────────────────────────────────
  custom<TMsg>(o: CustomOptions): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Custom',
      moduleId: o.moduleId,
      componentId: o.componentId,
      props: o.props ?? {},
      exposedNodeIds: o.exposedNodeIds ?? [],
      ...(o.contentHash !== undefined ? { contentHash: o.contentHash } : {}),
    });
  },
  errorBoundary<TMsg>(o: ErrorBoundaryOptions<TMsg>): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'ErrorBoundary',
      spec: { child: o.child, fallback: o.fallback },
    });
  },
  /** State-bound conditional child (Phase 392) — render one of several child
   * subtrees based on a reactive state key. See {@link SwitchOptions}. */
  switch<TMsg>(o: SwitchOptions<TMsg>): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'Switch',
      spec: {
        // Phase 768 — the spec selector is any Binding; the authoring surface
        // keeps the compact stateKey string and wraps it in the State form,
        // which the encoder collapses back to the `stateKey` wire spelling.
        on: { kind: 'State', key: o.stateKey, defaultValue: undefined as unknown as string },
        cases: o.cases.map((c) => ({ match: c.match, child: c.child })),
        default: o.default,
      },
    });
  },
  fragmentDecl<TMsg>(o: FragmentDeclOptions<TMsg>): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'FragmentDecl',
      spec: {
        name: fragmentId(o.name),
        body: o.body,
        holes: o.holes ?? [],
        effect: o.effect ?? { hostEffect: 'Pure', determinism: 'Deterministic' },
      },
    });
  },
  fragmentRef<TMsg>(o: FragmentRefOptions<TMsg>): Node<TMsg> {
    return buildNode(o.id, {
      kind: 'FragmentRef',
      spec: { name: fragmentId(o.name), args: o.args ?? {} },
    });
  },
};

// ─── Internal grid-erasure helpers ───────────────────────────────────────────

const buildTabsSpec = <TMsg>(o: TabsOptions<TMsg>): TabsSpec<TMsg> => ({
  orientation: o.orientation ?? 'Horizontal',
  children: o.children ?? [],
  activeIndex: o.activeIndex ?? { kind: 'Static', value: 0 },
  // `onSelect` omitted by default (Phase 426): the write-back default — a
  // State/Filter-bound `activeIndex` gets the clicked index written back.
  ...(o.onSelect !== undefined ? { onSelect: o.onSelect } : {}),
  ...(o.tabHeaders !== undefined ? { tabHeaders: o.tabHeaders } : {}),
  ...(o.tabTags !== undefined ? { tabTags: o.tabTags } : {}),
  ...(o.activeTag !== undefined ? { activeTag: o.activeTag } : {}),
  ...(o.onSelectTag !== undefined ? { onSelectTag: o.onSelectTag } : {}),
});

/**
 * Erase a typed row-sequence binding to a `Binding<readonly unknown[]>`.
 * `Binding<T>` is invariant in `T` (its `Local` case has `T` in input
 * positions), so the erasure is an explicit double cast — the renderer
 * recovers the row type at resolution time, exactly as the F# tier does.
 */
const eraseSource = <TRow>(source: Binding<readonly TRow[]>): Binding<readonly unknown[]> =>
  source as unknown as Binding<readonly unknown[]>;
