// ============================================================================
//  @fuaran-ui/schema — typed Defaults.X values (port of Fuaran.UI/Defaults.fs).
//
//  Every spec type ships a typed default. Authors compose with object spread —
//  `{ ...defaults.metric, label: ... }` — the TS idiom matching the F#
//  record-with syntax `{ Defaults.metric with Label = ... }`. AI emitters fill
//  only the fields that differ from default.
//
//  The per-spec defaults are reached through the single `defaults` aggregate
//  (`defaults.metric`, `defaults.style`, `defaults.accessibility.button`, …) —
//  the canonical surface `import { defaults } from '@fuaran-ui/schema'`. They
//  are deliberately NOT top-level exports, to keep the package namespace clean
//  (and avoid colliding with the @fuaran-ui/ui `column` / `fuaran` namespaces).
//  Generic-over-`TMsg` defaults are nullary generic functions (a const object
//  literal cannot carry its own type parameter); non-generic ones are values.
// ============================================================================

import type {
  Accessibility,
  Action,
  BadgeSpec,
  Binding,
  ButtonSpec,
  CalloutSpec,
  CardSpec,
  ChartSpec,
  Column,
  ContentHash,
  DashboardSpec,
  DateFieldConstraints,
  DisclosureSpec,
  ErrorBoundarySpec,
  FileUploadSpec,
  FilterSpec,
  FormField,
  FormSpec,
  FragmentDeclSpec,
  FragmentId,
  FragmentRefSpec,
  SwitchSpec,
  GridLayoutSpec,
  GridSpecOf,
  HeadingSpec,
  MetricSpec,
  LabelValueRowSpec,
  FactSpec,
  LocalBinding,
  MapMarker,
  MapSpec,
  MarkdownSpec,
  Motion,
  Node,
  NodeId,
  NumberFieldConstraints,
  ProgressSpec,
  SelectOption,
  SelectSpec,
  SemanticStyle,
  SkeletonSpec,
  IconSpec,
  SparklineSpec,
  SplitPanelSpec,
  StackSpec,
  SummaryListSpec,
  StateBehaviour,
  StepperSpec,
  TabHeader,
  TableSpec,
  TabsSpec,
  TextSource,
} from './types.js';

// ─── Internal helpers ────────────────────────────────────────────────────────

const emptyLiteral: TextSource = { kind: 'Literal', value: '' };

const staticBinding = <T>(value: T): Binding<T> => ({ kind: 'Static', value });

const noActions = <TMsg>(): Action<TMsg> => ({ kind: 'Chain', actions: [] });

/**
 * Sentinel `Binding.Query` for spec fields whose source is mandatory at
 * runtime but must hold a placeholder at default-construction time. Mirrors
 * the F# `noBinding` (`Binding.Query(NotProvidedSentinel, …)`): the resolver
 * short-circuits on this name, so the accessor is never invoked.
 */
export const NOT_PROVIDED_SENTINEL = '__fuaran_not_provided__';

/**
 * Phase 596 — the typed placeholder defaults the symmetric form-field
 * auto-bind synthesizes: a Form field with an absent `value` decodes to
 * `{ kind: 'State', key: <field id>, defaultValue: <this placeholder> }`,
 * and the encoder omits a value that is exactly that auto-binding. Decode,
 * encode, and the resolver all reference THESE values (mirror of the F#
 * `Defaults.ControlValueDefaults`).
 */
export const controlValueDefaults = {
  text: '' as string,
  number: 0 as number,
  checkbox: false as boolean,
  choice: undefined as string | undefined,
  range: [0, 0] as readonly [number, number],
  /** ISO-empty — the Date control's value is an ISO-8601 string. */
  date: '' as string,
  /**
   * ISO-empty both ends — the DateRange control's value is an ordered
   * `(from, to)` pair of ISO-8601 strings (Phase 725, the `range` precedent).
   */
  dateRange: ['', ''] as readonly [string, string],
};

const noBinding = <T>(): Binding<T> => ({
  kind: 'Query',
  name: NOT_PROVIDED_SENTINEL,
  accessor: () => {
    throw new Error('Fuaran: the not-provided sentinel binding accessor was invoked');
  },
});

// ─── Cross-cutting defaults ──────────────────────────────────────────────────

const style: SemanticStyle = {
  tone: 'Default',
  weight: 'Standard',
  emphasis: 'Normal',
  role: 'None',
  voice: 'Default',
};

const stateBehaviour = <TMsg>(): StateBehaviour<TMsg> => ({});

const localBinding = <T>(): LocalBinding<T> => ({
  initialFrom: noBinding<T>(),
  flushOn: { kind: 'OnBlur' },
  onCommit: () => '__fuaran_local_no_commit__',
  parse: () => ({ ok: false, error: 'no parse function supplied to Binding.Local' }),
});

// ─── Layout defaults ─────────────────────────────────────────────────────────

const dashboard = <TMsg>(): DashboardSpec<TMsg> => ({ children: [] });

const stack = <TMsg>(): StackSpec<TMsg> => ({
  orientation: 'Vertical',
  children: [],
  wrap: false,
});

const gridLayout = <TMsg>(): GridLayoutSpec<TMsg> => ({ cols: 12, children: [] });

const splitPanel = <TMsg>(): SplitPanelSpec<TMsg> => ({ weight: 0.5, children: [] });

// `onSelect` omitted (Phase 426): the declarative floor — a State/Filter-bound
// `activeIndex` gets the clicked index written back by the renderer.
const tabs = <TMsg>(): TabsSpec<TMsg> => ({
  orientation: 'Horizontal',
  children: [],
  activeIndex: staticBinding(0),
});

const tabHeader: TabHeader = { label: emptyLiteral };

const card = <TMsg>(): CardSpec<TMsg> => ({ children: [] });

const stepper = <TMsg>(): StepperSpec<TMsg> => ({
  activeStep: staticBinding(0),
  children: [],
  onSelect: () => noActions<TMsg>(),
});

const summaryList = <TMsg>(): SummaryListSpec<TMsg> => ({ children: [] });

// `onToggle` omitted (Phase 426): the write-back default — a State/Filter-bound
// `open` gets the new open value written back by the renderer.
const disclosure = <TMsg>(): DisclosureSpec<TMsg> => ({
  heading: emptyLiteral,
  open: staticBinding(false),
  children: [],
  defaultOpen: false,
});

// ─── Display defaults ──────────────────────────────────────────────────────

const heading: HeadingSpec = { level: 2, text: emptyLiteral, variant: 'Standard' };

const labelValueRow: LabelValueRowSpec = {
  label: emptyLiteral,
  value: noBinding<number>(),
  format: { kind: 'None' },
  emphasis: false,
};

const fact: FactSpec = {
  label: emptyLiteral,
  value: emptyLiteral,
  tone: 'Default',
  emphasis: false,
};

const markdown: MarkdownSpec = { text: emptyLiteral };

const metric: MetricSpec = {
  label: emptyLiteral,
  value: noBinding<number>(),
  format: { kind: 'None' },
  tone: 'Default',
  weight: 'Standard',
  emphasis: 'Normal',
  trendPolarity: 'HigherIsBetter',
};

const badge: BadgeSpec = { label: emptyLiteral, variant: 'Neutral' };

const sparkline: SparklineSpec = { source: noBinding<readonly number[]>() };

const skeleton: SkeletonSpec = { rows: 3 };

// Phase 821 — decorative by default (no label ⇒ aria-hidden).
const icon: IconSpec = { icon: '', size: 'Medium', tone: 'Default' };

const callout: CalloutSpec = {
  tone: 'Info',
  body: emptyLiteral,
  dismissable: false,
};

const progress: ProgressSpec = {
  fraction: staticBinding(0),
  indeterminate: false,
  tone: 'Default',
};

// ─── Input defaults ────────────────────────────────────────────────────────

const button = <TMsg>(): ButtonSpec<TMsg> => ({
  label: emptyLiteral,
  onClick: noActions<TMsg>(),
  variant: 'Secondary',
});

// `onChange` omitted (Phase 426): the write-back default — a State/Filter-bound
// `value` gets the chosen option written back by the renderer.
const select = <TMsg>(): SelectSpec<TMsg> => ({
  label: emptyLiteral,
  source: staticBinding<readonly SelectOption[]>([]),
  value: staticBinding<string | undefined>(undefined),
});

const form = <TMsg>(): FormSpec<TMsg> => ({
  fields: [],
  onSubmit: noActions<TMsg>(),
  submitLabel: { kind: 'Literal', value: 'Submit' },
});

// Handler-free `Text` kind (Phase 426): the write-back default — a
// State/Filter-bound `value` gets the typed string written back.
const formField = <TMsg>(): FormField<TMsg> => ({
  id: '',
  label: emptyLiteral,
  kind: { kind: 'Text', value: staticBinding('') },
  required: false,
});

const numberFieldConstraints: NumberFieldConstraints = {};

const dateFieldConstraints: DateFieldConstraints = {};

const filter = <TMsg>(): FilterSpec<TMsg> => ({
  name: '',
  label: emptyLiteral,
  field: { kind: 'Text', value: staticBinding(''), onChange: () => noActions<TMsg>() },
});

const fileUpload = <TMsg>(): FileUploadSpec<TMsg> => ({
  label: emptyLiteral,
  accept: [],
  multiple: false,
  onSelect: () => noActions<TMsg>(),
  // Phase 1115 — both gestures off by default, which IS the wire identity: a
  // default upload encodes to exactly the bytes it always did.
  dropTarget: false,
  acceptPaste: false,
});

// ─── Visualisation defaults ──────────────────────────────────────────────────

const chart = <TMsg>(): ChartSpec<TMsg> => ({
  source: noBinding<readonly unknown[]>(),
  kind: 'Line',
  xField: '',
  yFields: [],
  stacked: false,
});

const table = <TMsg>(): TableSpec<TMsg> => ({ headers: [], rows: [] });

const map = <TMsg>(): MapSpec<TMsg> => ({
  source: noBinding<readonly MapMarker[]>(),
  centreLatitude: 0,
  centreLongitude: 0,
  zoom: 4,
});

const grid = <TRow, TMsg>(): GridSpecOf<TRow, TMsg> => ({
  source: noBinding<readonly TRow[]>(),
  rowKey: () => '',
  columns: [],
  editable: false,
});

const column = <TRow, TMsg>(): Column<TRow, TMsg> => ({
  label: '',
  value: () => ({ kind: 'Empty' }),
  format: { kind: 'None' },
  kind: { kind: 'Text' },
  width: { kind: 'Auto' },
});

// ─── Custom / ErrorBoundary / Fragment defaults ──────────────────────────────

const customContentHash: ContentHash | undefined = undefined;
const customExposedNodeIds: readonly NodeId[] = [];

const placeholderNode = <TMsg>(id: string): Node<TMsg> => ({
  id: id as NodeId,
  kind: { kind: 'Display', display: { kind: 'Skeleton', spec: { rows: 1 } } },
  state: stateBehaviour<TMsg>(),
  style,
});

const errorBoundary = <TMsg>(): ErrorBoundarySpec<TMsg> => ({
  child: placeholderNode<TMsg>('fuaran-error-boundary-placeholder'),
  fallback: placeholderNode<TMsg>('fuaran-error-boundary-placeholder'),
});

const switchSpec = <TMsg>(): SwitchSpec<TMsg> => ({
  // Phase 768 — the empty-key State form keeps FUARAN083's ungrounded-switch
  // semantics on an unedited default.
  // `defaultValue` mirrors F# None: absent at runtime (the encoder's collapse
  // rule depends on it), cast because the State variant types it as T.
  on: { kind: 'State', key: '', defaultValue: undefined as unknown as string },
  cases: [],
  default: placeholderNode<TMsg>('fuaran-switch-placeholder'),
});

const fragmentDecl = <TMsg>(): FragmentDeclSpec<TMsg> => ({
  name: '' as FragmentId,
  body: placeholderNode<TMsg>('fuaran-fragment-placeholder'),
  holes: [],
  effect: { hostEffect: 'Pure', determinism: 'Deterministic' },
});

const fragmentRef = <TMsg>(): FragmentRefSpec<TMsg> => ({ name: '' as FragmentId, args: {} });

// ─── Accessibility defaults (Phase 12.I) ─────────────────────────────────────
//
// Per-component ARIA defaults. Decorative / structural shapes default to
// `undefined` (no aria-* emission); interactive / notification shapes default
// to a sensible role + live-region.

const emptyAccessibility: Accessibility = {};

const accessibility = {
  /** Empty trait — useful as an override starting point. */
  empty: emptyAccessibility,
  /** Most nodes need no ARIA metadata (decorative / structural shapes). */
  none: undefined as Accessibility | undefined,
  button: { role: 'button' } as Accessibility,
  select: { role: 'combobox' } as Accessibility,
  form: { role: 'form' } as Accessibility,
  fileUpload: { role: 'button' } as Accessibility,
  callout: { role: 'alert', liveRegion: 'assertive' } as Accessibility,
  toast: { role: 'status', liveRegion: 'polite' } as Accessibility,
  modal: { role: 'dialog' } as Accessibility,
  scrollArea: undefined as Accessibility | undefined,
  image: undefined as Accessibility | undefined,
  list: undefined as Accessibility | undefined,
  progress: { role: 'progressbar', liveRegion: 'polite' } as Accessibility,
  metric: { liveRegion: 'polite' } as Accessibility,
  dashboard: { role: 'main' } as Accessibility,
  card: { role: 'region' } as Accessibility,
  summaryList: { role: 'region' } as Accessibility,
  disclosure: { role: 'region' } as Accessibility,
  tabs: { role: 'tablist' } as Accessibility,
  grid: { role: 'region' } as Accessibility,
  chart: { role: 'region', liveRegion: 'polite' } as Accessibility,
  map: { role: 'region' } as Accessibility,
  table: undefined as Accessibility | undefined,
} as const;

// ─── Motion defaults (Phase 12.F) ────────────────────────────────────────────

const motion = {
  /** The "no motion" baseline every smart constructor passes (omits the field). */
  none: undefined as Motion | undefined,
  metric: 'FadeInOnMount' as Motion,
  callout: 'SlideInFromBelow' as Motion,
  progress: 'PulseDuringLoad' as Motion,
  errorCallout: 'ShakeOnError' as Motion,
} as const;

// ─── Canonical aggregate (the public surface) ────────────────────────────────

export const defaults = {
  style,
  stateBehaviour,
  localBinding,
  dashboard,
  stack,
  gridLayout,
  splitPanel,
  tabs,
  tabHeader,
  card,
  stepper,
  summaryList,
  disclosure,
  heading,
  labelValueRow,
  fact,
  markdown,
  metric,
  badge,
  sparkline,
  skeleton,
  icon,
  callout,
  progress,
  button,
  select,
  form,
  formField,
  numberFieldConstraints,
  dateFieldConstraints,
  filter,
  fileUpload,
  chart,
  table,
  map,
  grid,
  column,
  customContentHash,
  customExposedNodeIds,
  errorBoundary,
  switch: switchSpec,
  fragmentDecl,
  fragmentRef,
  accessibility,
  motion,
} as const;
