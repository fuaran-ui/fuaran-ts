// The canonical authored tree — a parallel of the F# tier's
// `fuaran-dotnet/samples/demo/Main.fs` shape, so paper readers can compare the two
// implementations side by side.
//
// Authored entirely through the `@fuaran-ui/ui` smart-constructor surface
// (`fuaran.*` / `binding.*` / `action.*` / `format.*` / `column.*`). Data is
// passed as `binding.static(...)` so the wire-format round-trip (encode →
// decode → render) reproduces the same visual output — closures (a Query
// accessor, an onClick) cannot survive serialisation, but static values can.
// Controlled inputs use `binding.state(...)`, resolved against the same
// `BindingSources` on both the authored and the decoded tree.

import { action, binding, column, fuaran, format } from '@fuaran-ui/ui';
import type {
  Action,
  CellValue,
  FilterSpec,
  FormField,
  MapMarker,
  Node,
  SelectOption,
  TextSource,
} from '@fuaran-ui/schema';
import type { BindingSources } from '@fuaran-ui/renderer';

import { CHART_COMPONENT, CHART_MODULE } from './customRenderers';
import type { AppMsg, Channel, Model } from './model';
import { visibleChannels } from './model';

const lit = (value: string): TextSource => ({ kind: 'Literal', value });
const dispatch = (msg: AppMsg): Action<AppMsg> => action.dispatch<AppMsg>(msg);

const contributorOptions: readonly SelectOption[] = [
  { value: 'north', label: lit('Northern region') },
  { value: 'south', label: lit('Southern region') },
  { value: 'metro', label: lit('Metro syndicate') },
];

const categoryOptions: readonly SelectOption[] = [
  { value: 'audience', label: lit('Audience') },
  { value: 'performance', label: lit('Performance') },
  { value: 'attribution', label: lit('Attribution') },
];

const markers: readonly MapMarker[] = [
  { latitude: 51.5074, longitude: -0.1278, label: lit('London') },
  { latitude: 40.7128, longitude: -74.006, label: lit('New York') },
];

const FRAGMENT_NAME = 'tier-legend';

// ─── §4c canonical example: revenue KPI + editable channel grid ──────────────

const canonicalSection = (model: Model): Node<AppMsg> =>
  fuaran.dashboard<AppMsg>({
    id: 'channel-analysis',
    children: [
      fuaran.heading<AppMsg>({ id: 'canonical-h', text: 'Channel analysis', level: 2 }),
      fuaran.metric<AppMsg>({
        id: 'revenue-kpi',
        label: 'Revenue',
        value: 142500,
        format: format.currency('GBP'),
        tone: 'Brand',
        trend: 0.083,
        trendFormat: format.percent(1),
      }),
      fuaran.grid<Channel, AppMsg>({
        id: 'channel-grid',
        source: binding.static<readonly Channel[]>(visibleChannels(model)),
        rowKey: (r) => String(r.rowId),
        columns: [
          column.text<Channel, AppMsg>('Channel', (r) => r.channel),
          column.text<Channel, AppMsg>('Media type', (r) => r.mediaType),
          column.editable<Channel, AppMsg>(
            (row, value: CellValue) =>
              value.kind === 'Numeric'
                ? dispatch({ t: 'UpdateGrps', rowId: row.rowId, value: value.value })
                : action.chain<AppMsg>([]),
            column.withFormat(
              format.number(1),
              column.numeric<Channel, AppMsg>('GRPs', (r) => r.grps),
            ),
          ),
          column.withFormat(
            format.percent(1),
            column.numeric<Channel, AppMsg>('Audience share', (r) => r.audienceShare),
          ),
        ],
        onRowClick: (row) => dispatch({ t: 'SelectRow', rowId: row.rowId }),
      }),
    ],
  });

// ─── Counter — the minimal button + dispatch demonstration ───────────────────

const counterSection = (): Node<AppMsg> =>
  fuaran.card<AppMsg>({
    id: 'counter-card',
    heading: 'Dispatch loop',
    children: [
      fuaran.markdown<AppMsg>(
        'counter-intro',
        'Buttons emit a typed `AppMsg` through the renderer `dispatch`; the reducer folds it into state and the tree re-projects.',
      ),
      fuaran.metric<AppMsg>({
        id: 'counter-kpi',
        label: 'Counter',
        value: binding.state('counter', 0),
      }),
      fuaran.stack<AppMsg>({
        id: 'counter-buttons',
        orientation: 'Horizontal',
        children: [
          fuaran.button<AppMsg>({
            id: 'btn-dec',
            label: '− Decrement',
            onClick: dispatch({ t: 'Decrement' }),
            variant: 'Secondary',
          }),
          fuaran.button<AppMsg>({
            id: 'btn-inc',
            label: '+ Increment',
            onClick: dispatch({ t: 'Increment' }),
            variant: 'Primary',
          }),
        ],
      }),
    ],
  });

// ─── Reusable fragment: a tier legend declared once, referenced twice ────────

const tierLegendFragment = (): Node<AppMsg> =>
  fuaran.fragmentDecl<AppMsg>({
    id: 'tier-legend-decl',
    name: FRAGMENT_NAME,
    body: fuaran.callout<AppMsg>({
      id: 'tier-legend-body',
      tone: 'Info',
      heading: 'Privacy tiers',
      body: 'Tier 0 plaintext · Tier 1 pseudonymised · Tier 2 homomorphic.',
    }),
  });

// ─── Showcase: every other shipped NodeKind the demo exercises ───────────────

const showcaseSection = (model: Model): Node<AppMsg> => {
  const textFilter: FilterSpec<AppMsg> = {
    name: 'text-filter',
    label: lit('Search channels'),
    kind: {
      kind: 'TextFilter',
      value: binding.state('textFilter', ''),
      onChange: (v) => dispatch({ t: 'SetTextFilter', value: v }),
    },
  };

  const formFields: readonly FormField<AppMsg>[] = [
    {
      id: 'form-text',
      label: lit('Cohort name'),
      required: true,
      kind: {
        kind: 'Text',
        value: binding.state('formText', ''),
        onChange: (v) => dispatch({ t: 'SetFormText', value: v }),
      },
    },
    {
      id: 'form-choice',
      label: lit('Category'),
      required: false,
      help: lit('Pick the dominant cohort dimension.'),
      kind: {
        kind: 'Choice',
        options: binding.static(categoryOptions),
        value: binding.state<string | undefined>('formChoice', undefined),
        onChange: (v) => dispatch({ t: 'SetFormChoice', value: v }),
      },
    },
    {
      id: 'form-budget',
      label: lit('Counter (0–20)'),
      required: false,
      kind: {
        kind: 'RangedNumber',
        value: binding.state('counter', model.counter),
        onChange: (v: number) => dispatch({ t: 'SetCounter', value: v }),
        constraints: { min: 0, max: 20, step: 1 },
      },
    },
  ];

  return fuaran.dashboard<AppMsg>({
    id: 'showcase',
    children: [
      fuaran.heading<AppMsg>({ id: 'showcase-h', text: 'Component showcase', level: 2 }),
      fuaran.markdown<AppMsg>(
        'showcase-intro',
        'A representative slice of the typed vocabulary — layout, display, input, and visualisation kinds — authored through the smart-constructor surface.',
      ),

      // Filters
      fuaran.filters<AppMsg>({ id: 'showcase-filters', filters: [textFilter] }),

      // Select
      fuaran.select<AppMsg>({
        id: 'contributor-pick',
        label: 'Region',
        source: binding.static(contributorOptions),
        value: binding.state<string | undefined>('contributorPick', undefined),
        onChange: (v) => dispatch({ t: 'PickContributor', value: v }),
        placeholder: 'Choose a region…',
      }),

      // GridLayout wrapping a Form + a Card with badges
      fuaran.gridLayout<AppMsg>({
        id: 'showcase-row',
        cols: 2,
        children: [
          fuaran.form<AppMsg>({
            id: 'showcase-form',
            submitLabel: 'Submit',
            onSubmit: dispatch({ t: 'SubmitForm' }),
            fields: formFields,
          }),
          fuaran.card<AppMsg>({
            id: 'badge-card',
            heading: 'Tone badges',
            children: [
              fuaran.stack<AppMsg>({
                id: 'badge-row',
                orientation: 'Horizontal',
                wrap: true,
                children: [
                  fuaran.badge<AppMsg>({ id: 'b-neutral', label: 'Neutral', variant: 'Neutral' }),
                  fuaran.badge<AppMsg>({ id: 'b-brand', label: 'Brand', variant: 'Brand' }),
                  fuaran.badge<AppMsg>({ id: 'b-success', label: 'Success', variant: 'Success' }),
                  fuaran.badge<AppMsg>({ id: 'b-warning', label: 'Warning', variant: 'Warning' }),
                  fuaran.badge<AppMsg>({
                    id: 'b-critical',
                    label: 'Critical',
                    variant: 'Critical',
                  }),
                ],
              }),
              fuaran.sparkline<AppMsg>({
                id: 'badge-spark',
                source: model.channels.map((c) => c.grps),
              }),
            ],
          }),
        ],
      }),

      // SplitPanel
      fuaran.splitPanel<AppMsg>({
        id: 'showcase-split',
        weight: 0.6,
        children: [
          fuaran.card<AppMsg>({
            id: 'split-left',
            heading: 'Wider pane — 60%',
            children: [
              fuaran.markdown<AppMsg>(
                'sp-left',
                'A split panel takes a `weight` in (0, 1); the first child gets that share of the width.',
              ),
            ],
          }),
          fuaran.card<AppMsg>({
            id: 'split-right',
            heading: 'Narrower pane — 40%',
            // A FragmentRef expands the declared `tier-legend` fragment here.
            children: [fuaran.fragmentRef<AppMsg>({ id: 'legend-ref-1', name: FRAGMENT_NAME })],
          }),
        ],
      }),

      // Tabs
      fuaran.tabs<AppMsg>({
        id: 'showcase-tabs',
        orientation: 'Horizontal',
        children: [
          fuaran.card<AppMsg>({
            id: 'tab-overview',
            heading: 'Overview',
            children: [
              fuaran.markdown<AppMsg>('tab-1', 'Each child Card heading becomes a tab label.'),
            ],
          }),
          fuaran.card<AppMsg>({
            id: 'tab-detail',
            heading: 'Detail',
            children: [fuaran.markdown<AppMsg>('tab-2', 'Bodies render below the tab bar.')],
          }),
        ],
      }),

      // Stepper
      fuaran.stepper<AppMsg>({
        id: 'showcase-stepper',
        activeStep: binding.state('step', model.step),
        children: [
          fuaran.markdown<AppMsg>('step-1', 'Step 1 — define your cohort.'),
          fuaran.markdown<AppMsg>('step-2', 'Step 2 — choose dimensions.'),
          fuaran.markdown<AppMsg>('step-3', 'Step 3 — review and run.'),
        ],
      }),
      fuaran.stack<AppMsg>({
        id: 'stepper-buttons',
        orientation: 'Horizontal',
        children: [
          fuaran.button<AppMsg>({
            id: 'step-prev',
            label: 'Back',
            onClick: dispatch({ t: 'PrevStep' }),
          }),
          fuaran.button<AppMsg>({
            id: 'step-next',
            label: 'Next',
            onClick: dispatch({ t: 'NextStep' }),
            variant: 'Primary',
          }),
        ],
      }),

      // FileUpload
      fuaran.fileUpload<AppMsg>({
        id: 'showcase-upload',
        label: 'Upload fitted-parameters file',
        accept: ['.csv', '.json'],
        multiple: false,
        onSelect: (files) => dispatch({ t: 'FilesSelected', names: files.map((f) => f.name) }),
      }),

      // Custom node — the bounded-escape hatch
      fuaran.custom<AppMsg>({
        id: 'inline-chart',
        moduleId: CHART_MODULE,
        componentId: CHART_COMPONENT,
        props: {
          title: 'GRPs by channel',
          series: visibleChannels(model).map((c) => c.grps),
        },
      }),

      // Chart (visualisation kind)
      fuaran.chart<AppMsg>({
        id: 'showcase-chart',
        source: binding.static<readonly unknown[]>(visibleChannels(model)),
        kind: 'Bar',
        xField: 'channel',
        yFields: ['grps'],
        title: 'GRPs by channel',
      }),

      // Table (static visualisation)
      fuaran.table<AppMsg>({
        id: 'showcase-table',
        headers: ['Privacy tier', 'Description', 'Status'],
        rows: [
          ['Tier 0', 'Plaintext federation', 'Default'],
          ['Tier 1', 'Pseudonymised', 'Available'],
          ['Tier 2', 'Homomorphic', 'Beta'],
        ],
      }),

      // Map (visualisation)
      fuaran.map<AppMsg>({
        id: 'showcase-map',
        source: binding.static(markers),
        centreLatitude: 30,
        centreLongitude: -30,
        zoom: 3,
      }),

      // Second FragmentRef — same fragment, reused.
      fuaran.fragmentRef<AppMsg>({ id: 'legend-ref-2', name: FRAGMENT_NAME }),
    ],
  });
};

/** The full authored tree. */
export const buildTree = (model: Model): Node<AppMsg> =>
  fuaran.dashboard<AppMsg>({
    id: 'demo-root',
    children: [
      tierLegendFragment(),
      counterSection(),
      canonicalSection(model),
      showcaseSection(model),
    ],
  });

/** Binding sources the renderer consults — rebuilt from the model each render. */
export const buildSources = (model: Model): BindingSources => ({
  state: {
    counter: model.counter,
    textFilter: model.textFilter,
    formText: model.formText,
    formChoice: model.formChoice,
    contributorPick: model.contributorPick,
    step: model.step,
  },
});
