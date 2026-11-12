// ============================================================================
//  Phase 2694 — the builders spell every member the wire carries for the kinds
//  they build, and a tree built through them encodes byte-identically to the
//  shared corpus.
//
//  The subject is the BUILDER, not the codec: each case constructs the corpus
//  fixture's node through `fuaran.*` from typed TypeScript values and compares
//  `encodeNode` of it with the fixture's bytes. The codec's own round-trip is
//  certified elsewhere (packages/ops/test/corpus.test.ts); what this pins is
//  that an author can REACH those bytes without hand-writing a spec.
//
//  Every case carries its falsifier: the same build with the phase's new member
//  dropped, which must NOT reproduce the fixture. A member the builder silently
//  ignored would make the two builds encode alike, and the falsifier goes red.
//
//  Skips when the corpus is absent (a standalone checkout), as the other corpus
//  suites do; CI checks the corpus out beside the repository.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decodeNode, encodeNode } from '@fuaran-ui/ops';
import { describe, expect, it } from 'vitest';

import {
  binding,
  type Affordance,
  fuaran,
  type ChartAnnotation,
  type Node,
  type SelectOption,
  type TextSource,
} from '../src/index.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const NODES_DIR = join(wireCorpusRoot(), 'nodes');
const corpusPresent = existsSync(NODES_DIR);

/** The fixture's canonical bytes, as the corpus holds them. */
const corpusBytes = (id: string): string =>
  readFileSync(join(NODES_DIR, `${id}.json`), 'utf8').trim();

const lit = (value: string): TextSource => ({ kind: 'Literal', value });
const option = (label: string, value: string): SelectOption => ({ label: lit(label), value });

/**
 * A member's typed value, read off the fixture through the decoder. Used only
 * for the structured values (annotations) whose literal spelling would restate
 * the codec; the BUILD that carries them is still the builder's.
 */
const chartMember = <K extends string>(id: string, member: K): unknown => {
  const r = decodeNode(corpusBytes(id));
  if (!r.ok) throw new Error(`${id} does not decode: ${r.error.code}`);
  const kind = r.value.kind as { visualisation?: { spec?: Record<string, unknown> } };
  return kind.visualisation?.spec?.[member];
};

interface Case {
  readonly fixture: string;
  /** The build through the builders, with every member the fixture carries. */
  readonly build: () => Node<unknown>;
  /** The same build with this phase's member dropped — must miss the fixture. */
  readonly falsifier: () => Node<unknown>;
}

/**
 * The node with the builder's DEFAULT accessibility trait reset to the wire's,
 * which these fixtures leave absent — the same reset a projector applies to the
 * base traits. The trait is not this phase's subject; the spec members are.
 */
const wireTraits = (n: Node<unknown>): Node<unknown> => {
  const { accessibility: _defaulted, ...rest } = n;
  return rest;
};

// ─── The three fixtures the phase exists for ─────────────────────────────────

const FACT_REFERENCE = '9f04f29b27c86926a1c3e5d7b8f0a2c4e6d8f0a1b3c5d7e9f1a3b5c7d9e1f3a5';

const groupedOptions = [
  option('Revenue', 'revenue-trend'),
  option('Orders', 'orders-trend'),
  option('By region', 'region-breakdown'),
  option('By channel', 'channel-breakdown'),
];

const remainderOptions = [
  option('Summary', 'summary'),
  option('Revenue', 'revenue-trend'),
  option('By region', 'region-breakdown'),
  option('Notes', 'notes'),
];

const PHASE_FIXTURES: readonly Case[] = [
  {
    fixture: 'fact-cited',
    build: () =>
      fuaran.fact({
        id: 'fact-cited',
        label: 'Revenue',
        value: '£412k',
        reference: FACT_REFERENCE,
      }),
    falsifier: () => fuaran.fact({ id: 'fact-cited', label: 'Revenue', value: '£412k' }),
  },
  {
    fixture: 'select-option-groups',
    build: () =>
      fuaran.select({
        id: 'select-option-groups',
        label: 'Chart',
        source: binding.static<readonly SelectOption[]>(groupedOptions),
        value: binding.static<string | undefined>('revenue-trend'),
        groups: [
          { label: 'Trend', values: ['orders-trend', 'revenue-trend'] },
          { label: 'Breakdown', values: ['region-breakdown', 'channel-breakdown'] },
        ],
      }),
    falsifier: () =>
      fuaran.select({
        id: 'select-option-groups',
        label: 'Chart',
        source: binding.static<readonly SelectOption[]>(groupedOptions),
        value: binding.static<string | undefined>('revenue-trend'),
      }),
  },
  {
    fixture: 'select-option-groups-remainder',
    build: () =>
      fuaran.select({
        id: 'select-option-groups-remainder',
        label: 'Chart',
        source: binding.static<readonly SelectOption[]>(remainderOptions),
        value: binding.state<string | undefined>('chart', 'summary'),
        groups: [
          { label: 'Trend', values: ['revenue-trend'] },
          { label: 'Breakdown', values: ['region-breakdown'] },
        ],
      }),
    falsifier: () =>
      fuaran.select({
        id: 'select-option-groups-remainder',
        label: 'Chart',
        source: binding.static<readonly SelectOption[]>(remainderOptions),
        value: binding.state<string | undefined>('chart', 'summary'),
      }),
  },
];

// ─── The audit's other gaps, closed in the same phase ────────────────────────

const quarters = [
  { quarter: 'Q1', revenue: 120 },
  { quarter: 'Q2', revenue: 150 },
];

const AUDIT_FIXTURES: readonly Case[] = [
  {
    fixture: 'fact-1',
    build: () =>
      fuaran.fact({
        id: 'fact-1',
        label: 'Patient',
        value: 'Alice Smith',
        tone: 'Brand',
        emphasis: true,
        help: 'Primary insured',
        icon: 'user',
      }),
    falsifier: () =>
      fuaran.fact({
        id: 'fact-1',
        label: 'Patient',
        value: 'Alice Smith',
        tone: 'Brand',
        emphasis: true,
        help: 'Primary insured',
      }),
  },
  {
    fixture: 'chart-axis-titles',
    build: () =>
      fuaran.chart({
        id: 'chart-axis-titles',
        kind: 'Bar',
        source: binding.static<readonly unknown[]>([
          { quarter: 'Q1', revenue: 12500000 },
          { quarter: 'Q2', revenue: 15200000 },
        ]),
        title: 'Revenue by quarter',
        subtitle: 'Millions of £',
        valueFormat: { kind: 'Currency', isoCode: 'GBP' },
        xField: 'quarter',
        xTitle: 'Quarter',
        yFields: ['revenue'],
        yTitle: 'Revenue',
      }),
    falsifier: () =>
      fuaran.chart({
        id: 'chart-axis-titles',
        kind: 'Bar',
        source: binding.static<readonly unknown[]>([
          { quarter: 'Q1', revenue: 12500000 },
          { quarter: 'Q2', revenue: 15200000 },
        ]),
        title: 'Revenue by quarter',
        xField: 'quarter',
        yFields: ['revenue'],
      }),
  },
  {
    fixture: 'chart-data-labels',
    build: () =>
      fuaran.chart({
        id: 'chart-data-labels',
        kind: 'Bar',
        source: binding.static<readonly unknown[]>(quarters),
        title: 'Revenue by quarter',
        dataLabels: 'Ends',
        xField: 'quarter',
        yFields: ['revenue'],
      }),
    falsifier: () =>
      fuaran.chart({
        id: 'chart-data-labels',
        kind: 'Bar',
        source: binding.static<readonly unknown[]>(quarters),
        title: 'Revenue by quarter',
        xField: 'quarter',
        yFields: ['revenue'],
      }),
  },
  {
    fixture: 'chart-legend-position',
    build: () =>
      fuaran.chart({
        id: 'chart-legend-position',
        kind: 'Bar',
        source: binding.static<readonly unknown[]>([
          { region: 'North', sales: 80, target: 100 },
          { region: 'South', sales: 130, target: 110 },
        ]),
        title: 'Sales vs target',
        legendPosition: 'Bottom',
        xField: 'region',
        yFields: ['sales', 'target'],
      }),
    falsifier: () =>
      fuaran.chart({
        id: 'chart-legend-position',
        kind: 'Bar',
        source: binding.static<readonly unknown[]>([
          { region: 'North', sales: 80, target: 100 },
          { region: 'South', sales: 130, target: 110 },
        ]),
        title: 'Sales vs target',
        xField: 'region',
        yFields: ['sales', 'target'],
      }),
  },
  {
    fixture: 'chart-temporal-x',
    build: () =>
      fuaran.chart({
        id: 'chart-temporal-x',
        kind: 'Line',
        source: binding.static<readonly unknown[]>([
          { day: '2026-01-05', sessions: 1200 },
          { day: '2026-01-12', sessions: 1450 },
          { day: '2026-01-19', sessions: 1310 },
          { day: '2026-01-26', sessions: 1580 },
        ]),
        title: 'Sessions by week',
        xField: 'day',
        xScale: 'Temporal',
        yFields: ['sessions'],
      }),
    falsifier: () =>
      fuaran.chart({
        id: 'chart-temporal-x',
        kind: 'Line',
        source: binding.static<readonly unknown[]>([
          { day: '2026-01-05', sessions: 1200 },
          { day: '2026-01-12', sessions: 1450 },
          { day: '2026-01-19', sessions: 1310 },
          { day: '2026-01-26', sessions: 1580 },
        ]),
        title: 'Sessions by week',
        xField: 'day',
        yFields: ['sessions'],
      }),
  },
  {
    fixture: 'chart-annotations',
    build: () =>
      fuaran.chart({
        id: 'chart-annotations',
        kind: 'Bar',
        source: binding.static<readonly unknown[]>([
          ...quarters,
          { quarter: 'Q3', revenue: 90 },
          { quarter: 'Q4', revenue: 175 },
        ]),
        title: 'Revenue by quarter',
        annotations: chartMember('chart-annotations', 'annotations') as readonly ChartAnnotation[],
        xField: 'quarter',
        yFields: ['revenue'],
      }),
    falsifier: () =>
      fuaran.chart({
        id: 'chart-annotations',
        kind: 'Bar',
        source: binding.static<readonly unknown[]>([
          ...quarters,
          { quarter: 'Q3', revenue: 90 },
          { quarter: 'Q4', revenue: 175 },
        ]),
        title: 'Revenue by quarter',
        xField: 'quarter',
        yFields: ['revenue'],
      }),
  },
];

describe.skipIf(!corpusPresent)('builders reproduce the corpus bytes (Phase 2694)', () => {
  for (const c of [...PHASE_FIXTURES, ...AUDIT_FIXTURES]) {
    it(`${c.fixture} — built through the builders, byte-identical`, () => {
      expect(encodeNode(wireTraits(c.build()))).toBe(corpusBytes(c.fixture));
    });
    it(`${c.fixture} — falsifier: without the member, the bytes differ`, () => {
      expect(encodeNode(wireTraits(c.falsifier()))).not.toBe(corpusBytes(c.fixture));
    });
  }
});

describe('the new members omit at their defaults', () => {
  const base = {
    id: 's',
    label: 'Chart',
    source: binding.static<readonly SelectOption[]>(groupedOptions),
    value: binding.static<string | undefined>('revenue-trend'),
  } as const;

  it('select: `groups: []` encodes as the member absent', () => {
    expect(encodeNode(fuaran.select({ ...base, groups: [] }))).toBe(
      encodeNode(fuaran.select(base)),
    );
    expect(encodeNode(fuaran.select({ ...base, groups: [] }))).not.toContain('"groups"');
  });

  it('fact: no `reference` and no `icon` encode as the pre-member fact', () => {
    const bytes = encodeNode(fuaran.fact({ id: 'f', label: 'L', value: 'V' }));
    expect(bytes).toBe('{"id":"f","kind":{"$type":"Fact","label":"L","value":"V"}}');
  });
});

describe('affordance reaches the wire from the select and button builders', () => {
  // Every other member at its default, so only `description` reaches the wire.
  const affordance: Affordance = {
    patterns: [],
    readPatterns: [],
    aliases: [],
    clearable: false,
    neverControllable: false,
    description: 'Which chart the dashboard shows',
  };

  it('select', () => {
    const built = fuaran.select({
      id: 's',
      label: 'Chart',
      source: binding.static<readonly SelectOption[]>(groupedOptions),
      affordance,
    });
    const bytes = encodeNode(built);
    expect(bytes).toContain('"affordance":{"description":"Which chart the dashboard shows"}');
    // The builder's spelling is the decoder's: the bytes are a fixed point.
    const back = decodeNode(bytes);
    if (!back.ok) throw new Error(`select with affordance does not decode: ${back.error.code}`);
    expect(encodeNode(back.value)).toBe(bytes);
  });

  it('button', () => {
    const bytes = encodeNode(fuaran.button({ id: 'b', label: 'Go', affordance }));
    expect(bytes).toContain('"affordance":{"description":"Which chart the dashboard shows"}');
    const back = decodeNode(bytes);
    if (!back.ok) throw new Error(`button with affordance does not decode: ${back.error.code}`);
    expect(encodeNode(back.value)).toBe(bytes);
  });
});
