// ============================================================================
//  Phase 2698 — `fuaran.dataGrid` builds the DataGrid's interactive mode, and
//  every interactive grid in the shared corpus is reachable through it.
//
//  Two suites, both about the BUILDER, not the codec:
//
//  1. Hand-written builds from typed TypeScript values for a spread of the
//     corpus's interactive grids, each compared with the fixture's bytes, each
//     with a falsifier that drops the grid-behaviour member it is about.
//  2. A sweep over EVERY corpus node fixture holding an interactive grid (a
//     DataGrid with no `staticRows`), at any depth: the grid's spec members are
//     read off the decoded fixture and handed to `fuaran.dataGrid`, and the
//     rebuilt grid must encode as the decoded one does. Per member, dropping it
//     from the build must change the bytes, so a member the builder ignored
//     goes red rather than reading green by omission.
//
//  Skips when the corpus is absent (a standalone checkout), as the other corpus
//  suites do; CI checks the corpus out beside the repository.
// ============================================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decodeNode, encodeNode } from '@fuaran-ui/ops';
import { describe, expect, it } from 'vitest';

import {
  binding,
  type CellFormat,
  type ColumnErased,
  type DataGridOptions,
  fuaran,
  type Node,
} from '../src/index.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const NODES_DIR = join(wireCorpusRoot(), 'nodes');
const corpusPresent = existsSync(NODES_DIR);

const corpusBytes = (id: string): string =>
  readFileSync(join(NODES_DIR, `${id}.json`), 'utf8').trim();

/** The builder's default accessibility trait reset to the wire's, which these fixtures leave absent. */
const wireTraits = (n: Node<unknown>): Node<unknown> => {
  const { accessibility: _defaulted, ...rest } = n;
  return rest;
};

const NONE: CellFormat = { kind: 'None' };

/** A declarative column: the cell reads the row's `field`. */
const fieldColumn = (
  label: string,
  field: string,
  extra: Partial<ColumnErased<unknown>> = {},
): ColumnErased<unknown> => ({
  label,
  field,
  format: NONE,
  kind: { kind: 'Text' },
  width: { kind: 'Auto' },
  ...extra,
});

const ledger = binding.state<readonly unknown[]>('ledger', [
  { month: 'Jan', revenue: 980 },
  { month: 'Feb', revenue: 1105 },
]);
const ledgerColumns = [
  fieldColumn('Month', 'month'),
  fieldColumn('Revenue', 'revenue', { kind: { kind: 'Numeric' } }),
];

interface Case {
  readonly fixture: string;
  readonly build: () => Node<unknown>;
  /** The same build with one grid-behaviour member dropped — must miss the fixture. */
  readonly falsifier: () => Node<unknown>;
}

const CASES: readonly Case[] = [
  {
    fixture: 'grid-paged-sorted',
    build: () =>
      fuaran.dataGrid({
        id: 'grid-paged-sorted',
        source: ledger,
        columns: ledgerColumns,
        rowKeyField: 'month',
        sortStateKey: 'ledger-sort',
        pageSize: 10,
        pageStateKey: 'ledger-page',
      }),
    falsifier: () =>
      fuaran.dataGrid({
        id: 'grid-paged-sorted',
        source: ledger,
        columns: ledgerColumns,
        rowKeyField: 'month',
        sortStateKey: 'ledger-sort',
        pageSize: 10,
      }),
  },
  {
    fixture: 'grid-windowed-sorted',
    build: () =>
      fuaran.dataGrid({
        id: 'grid-windowed-sorted',
        source: ledger,
        columns: ledgerColumns,
        rowKeyField: 'month',
        sortStateKey: 'ledger-sort',
        defaultSort: { column: 1, direction: 'desc' },
        windowStateKey: 'ledger-window',
      }),
    falsifier: () =>
      fuaran.dataGrid({
        id: 'grid-windowed-sorted',
        source: ledger,
        columns: ledgerColumns,
        rowKeyField: 'month',
        sortStateKey: 'ledger-sort',
        windowStateKey: 'ledger-window',
      }),
  },
  {
    fixture: 'grid-declared-edit',
    build: () =>
      fuaran.dataGrid({
        id: 'grid-declared-edit',
        source: binding.query<unknown, readonly unknown[]>('stock', () => []),
        columns: [
          fieldColumn('Month', 'month'),
          fieldColumn('Revenue', 'revenue'),
          fieldColumn('Note', 'note', { editable: false }),
        ],
        rowKeyField: 'month',
        editable: true,
        editStateKey: 'stock-adjustments',
      }),
    falsifier: () =>
      fuaran.dataGrid({
        id: 'grid-declared-edit',
        source: binding.query<unknown, readonly unknown[]>('stock', () => []),
        columns: [
          fieldColumn('Month', 'month'),
          fieldColumn('Revenue', 'revenue'),
          fieldColumn('Note', 'note', { editable: false }),
        ],
        rowKeyField: 'month',
        editable: true,
      }),
  },
  {
    fixture: 'grid-1',
    // The closure spellings: a row-key closure and a closure column, each crossing
    // the wire as the closure sentinel.
    build: () =>
      fuaran.dataGrid({
        id: 'grid-1',
        source: binding.static<readonly { channel: string; revenue: number }[]>([
          { channel: 'Direct', revenue: 1200 },
          { channel: 'Referral', revenue: 830 },
        ]),
        rowKey: (row) => row.channel,
        columns: [
          {
            label: 'Channel',
            value: () => ({ kind: 'Empty' }),
            format: NONE,
            kind: { kind: 'Text' },
            width: { kind: 'Auto' },
          },
        ],
      }),
    falsifier: () =>
      fuaran.dataGrid({
        id: 'grid-1',
        source: binding.static<readonly { channel: string; revenue: number }[]>([
          { channel: 'Direct', revenue: 1200 },
          { channel: 'Referral', revenue: 830 },
        ]),
        columns: [
          {
            label: 'Channel',
            value: () => ({ kind: 'Empty' }),
            format: NONE,
            kind: { kind: 'Text' },
            width: { kind: 'Auto' },
          },
        ],
      }),
  },
];

describe.skipIf(!corpusPresent)('fuaran.dataGrid reproduces the corpus bytes (Phase 2698)', () => {
  for (const c of CASES) {
    it(`${c.fixture} — built through the builder, byte-identical`, () => {
      expect(encodeNode(wireTraits(c.build()))).toBe(corpusBytes(c.fixture));
    });
    it(`${c.fixture} — falsifier: without the member, the bytes differ`, () => {
      expect(encodeNode(wireTraits(c.falsifier()))).not.toBe(corpusBytes(c.fixture));
    });
  }
});

// ─── The sweep: every interactive grid in the corpus ─────────────────────────

type Spec = Record<string, unknown>;

const gridSpecOf = (n: unknown): Spec | undefined => {
  const kind = (n as { kind?: { kind?: string; visualisation?: { kind?: string; spec?: Spec } } })
    .kind;
  if (kind?.kind !== 'Visualisation' || kind.visualisation?.kind !== 'Grid') return undefined;
  const spec = kind.visualisation.spec;
  return spec !== undefined && spec['staticRows'] === undefined ? spec : undefined;
};

/** Every interactive-grid node in a decoded tree, at any depth. */
const interactiveGrids = (v: unknown, out: Node<unknown>[] = []): Node<unknown>[] => {
  if (v === null || typeof v !== 'object') return out;
  if (Array.isArray(v)) {
    for (const x of v) interactiveGrids(x, out);
    return out;
  }
  if (gridSpecOf(v) !== undefined) out.push(v as Node<unknown>);
  for (const x of Object.values(v)) interactiveGrids(x, out);
  return out;
};

/** The grid rebuilt through the builder, every other trait of the node kept as decoded. */
const rebuild = (n: Node<unknown>, spec: Spec): Node<unknown> => {
  const built = fuaran.dataGrid({ ...spec, id: n.id } as unknown as DataGridOptions<
    unknown,
    unknown
  >);
  return { ...n, kind: built.kind };
};

interface SweepEntry {
  readonly fixture: string;
  readonly grid: Node<unknown>;
}

const sweep = (): readonly SweepEntry[] => {
  if (!corpusPresent) return [];
  const entries: SweepEntry[] = [];
  for (const file of readdirSync(NODES_DIR).sort()) {
    if (!file.endsWith('.json')) continue;
    const text = readFileSync(join(NODES_DIR, file), 'utf8');
    if (!text.includes('"DataGrid"')) continue;
    const r = decodeNode(text);
    if (!r.ok) continue; // the codec suites own a fixture that does not decode
    for (const grid of interactiveGrids(r.value)) {
      entries.push({ fixture: file.replace(/\.json$/, ''), grid });
    }
  }
  return entries;
};

const SWEEP = sweep();

describe.skipIf(!corpusPresent)(
  'every interactive grid in the corpus builds through fuaran.dataGrid',
  () => {
    it('the sweep is not vacuous', () => {
      // Every case above is in it, and so is a grid nested inside another node.
      const fixtures = new Set(SWEEP.map((e) => e.fixture));
      for (const c of CASES) expect(fixtures).toContain(c.fixture);
      expect(fixtures).toContain('transfer-board');
      expect(SWEEP.length).toBeGreaterThan(30);
    });

    for (const { fixture, grid } of SWEEP) {
      const spec = gridSpecOf(grid)!;
      it(`${fixture} / ${grid.id} — rebuilt, byte-identical`, () => {
        expect(encodeNode(rebuild(grid, spec))).toBe(encodeNode(grid));
      });
      // Each member the grid declares reaches the wire through the builder: without
      // it, the rebuilt bytes differ. `false` is the omitted default, so dropping it
      // is no change and is not a falsifier.
      const declared = Object.keys(spec).filter(
        (k) => k !== 'source' && k !== 'columns' && spec[k] !== false && spec[k] !== undefined,
      );
      for (const member of declared) {
        it(`${fixture} / ${grid.id} — falsifier: without \`${member}\`, the bytes differ`, () => {
          const { [member]: _dropped, ...rest } = spec;
          expect(encodeNode(rebuild(grid, rest))).not.toBe(encodeNode(grid));
        });
      }
    }
  },
);

describe('the interactive mode omits what it does not declare', () => {
  it('a grid declaring nothing past source and columns encodes no behaviour member', () => {
    const bytes = encodeNode(
      wireTraits(
        fuaran.dataGrid({
          id: 'g',
          source: binding.static<readonly unknown[]>([]),
          columns: [fieldColumn('A', 'a')],
        }),
      ),
    );
    expect(bytes).toBe(
      '{"id":"g","kind":{"$type":"DataGrid","columns":[{"field":"a","kind":{"$type":"Text"},"label":"A"}],"source":{"$type":"Static","value":[]}}}',
    );
  });

  it('fuaran.grid builds through fuaran.dataGrid: the typed and erased spellings agree', () => {
    type Row = { readonly month: string };
    const source = binding.state<readonly Row[]>('ledger', [{ month: 'Jan' }]);
    const typed = fuaran.grid<Row, unknown>({
      id: 'g',
      source,
      rowKey: (r) => r.month,
      columns: [],
      rowKeyField: 'month',
      sortStateKey: 's',
      pageSize: 5,
      pageStateKey: 'p',
      editStateKey: 'e',
      defaultSort: { column: 0, direction: 'asc' },
    });
    const erased = fuaran.dataGrid<Row, unknown>({
      id: 'g',
      source,
      rowKey: (r) => r.month,
      columns: [],
      rowKeyField: 'month',
      sortStateKey: 's',
      pageSize: 5,
      pageStateKey: 'p',
      editStateKey: 'e',
      defaultSort: { column: 0, direction: 'asc' },
    });
    expect(encodeNode(typed)).toBe(encodeNode(erased));
    expect(encodeNode(typed)).toContain('"pageStateKey":"p"');
  });

  it('the two modes cannot be mixed in one options value', () => {
    const interactive = {
      id: 'g',
      source: binding.static<readonly unknown[]>([]),
      columns: [],
    };
    // @ts-expect-error — `headers` is the static mode's, refused by type.
    fuaran.dataGrid({ ...interactive, headers: ['A'] });
    // @ts-expect-error — so is `rows`.
    fuaran.dataGrid({ ...interactive, rows: [['a']] });
    // @ts-expect-error — and a sort key is the interactive mode's, not the table's.
    fuaran.table({ id: 't', headers: ['A'], rows: [['a']], sortStateKey: 's' });
    expect(true).toBe(true);
  });
});
