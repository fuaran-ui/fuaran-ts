// ============================================================================
//  Chart → Drawing lowering — cross-host byte-parity (Phase 534, S4).
//
//  The TS lowering (`@fuaran-ui/charts` `lower`) must reproduce the shared
//  wire-format-fixtures/chart-lowering/* goldens byte-for-byte — the same fixtures
//  the F# reference (`Fuaran.UI.Charts.lower`) and the Python host certify against.
//  Each case ships an `<name>.input.json` (the neutral ChartSpec + data contract)
//  and an `<name>.expected.json` (the canonical themed Drawing node JSON). Skips
//  when the corpus is absent (a standalone checkout), mirroring the render-parity
//  pattern.
// ============================================================================

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeNode } from '@fuaran-ui/ops';
import { describe, expect, it } from 'vitest';

import { lowerNode, type ChartLowerSpec, type ChartRow } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/charts/test → workspace-root/wire-format-fixtures/chart-lowering
const CHART_LOWERING_DIR = join(
  here,
  '..',
  '..',
  '..',
  '..',
  'wire-format-fixtures',
  'chart-lowering',
);

interface ChartInput {
  readonly kind: ChartLowerSpec['kind'];
  readonly xField: string;
  readonly yFields: readonly string[];
  readonly title: string | null;
  readonly stacked: boolean;
  readonly data: readonly ChartRow[];
}

const cases = (): string[] => {
  if (!existsSync(CHART_LOWERING_DIR)) return [];
  return readdirSync(CHART_LOWERING_DIR)
    .filter((f) => f.endsWith('.input.json'))
    .map((f) => f.slice(0, -'.input.json'.length))
    .sort();
};

const specAndRows = (inp: ChartInput): { spec: ChartLowerSpec; rows: readonly ChartRow[] } => ({
  spec: {
    kind: inp.kind,
    xField: inp.xField,
    yFields: inp.yFields,
    ...(inp.title !== null ? { title: inp.title } : {}),
    stacked: inp.stacked,
  },
  rows: inp.data,
});

const readInput = (name: string): ChartInput =>
  JSON.parse(readFileSync(join(CHART_LOWERING_DIR, `${name}.input.json`), 'utf8')) as ChartInput;

describe('chart lowering — cross-host byte-parity', () => {
  const names = cases();

  it.runIf(names.length > 0)('corpus is present', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)('%s — TS lowering is byte-identical to the golden', (name) => {
    const expected = readFileSync(join(CHART_LOWERING_DIR, `${name}.expected.json`), 'utf8');
    const { spec, rows } = specAndRows(readInput(name));
    expect(encodeNode(lowerNode(`chart-${name}`, spec, rows))).toBe(expected);
  });

  it.each(names)('%s — lowering is order-independent (fields read by name)', (name) => {
    const { spec, rows } = specAndRows(readInput(name));
    const reversedRows = rows.map(
      (r) => Object.fromEntries(Object.entries(r).reverse()) as ChartRow,
    );
    const a = encodeNode(lowerNode('c', spec, rows));
    const b = encodeNode(lowerNode('c', spec, reversedRows));
    expect(a).toBe(b);
  });
});
