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

import {
  lowerNode,
  type ChartAxisUnitMode,
  type ChartLowerSpec,
  type ChartLowerStyle,
  type ChartRow,
} from '../src/index.js';
import type { TextSource } from '@fuaran-ui/schema';

/** A `TextSource` in canonical wire JSON: the bare string (the canonical
 * `Literal` form, §16) or a `$type`-tagged arm. */
type WireTextSource = string | { readonly $type: string; readonly [k: string]: unknown };

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
  readonly title: WireTextSource | null;
  readonly stacked: boolean;
  // Phase 876 — `valueFormat` is a WIRE field carried in canonical `Format`
  // JSON; `axisUnitMode` is a harness-only STYLE selector (the chart style is a
  // lowering parameter, never wire), present so the corpus can pin every mode.
  readonly valueFormat?: { readonly $type: string; readonly [k: string]: unknown };
  readonly axisUnitMode?: ChartAxisUnitMode;
  // Phase 878 — the axis names + the subtitle, beside `title` and carrying the
  // same `TextSource` vocabulary (Phase 1143); omitted when absent (so every
  // pre-878 input is byte-unchanged).
  readonly xTitle?: WireTextSource;
  readonly yTitle?: WireTextSource;
  readonly subtitle?: WireTextSource;
  // Phase 880 — the legend's declared edge, a WIRE field carried as the
  // canonical enum string; omitted when absent (so every pre-880 input is
  // byte-unchanged even though the PICTURE many of them lower to has moved).
  readonly legendPosition?: ChartLowerSpec['legendPosition'];
  // Phase 881 — whether the values are written onto the picture, a WIRE field
  // carried as the canonical enum string; omitted when absent (so every pre-881
  // input AND golden is byte-unchanged).
  readonly dataLabels?: ChartLowerSpec['dataLabels'];
  // Phase 882 — what the x column MEANS, a WIRE field carried as the canonical
  // enum string; omitted when absent (so every pre-882 input AND golden is
  // byte-unchanged — `Category` is what absence means and what it always did).
  readonly xScale?: ChartLowerSpec['xScale'];
  readonly data: readonly ChartRow[];
}

/** The corpus carries a `Format` in canonical `$type` wire JSON; the lowering
 * takes the host's tagged-union shape. Only the numeric arms appear here. */
const valueFormatOf = (
  raw: NonNullable<ChartInput['valueFormat']>,
): NonNullable<ChartLowerSpec['valueFormat']> => {
  switch (raw.$type) {
    case 'Number':
      return raw['decimals'] === undefined
        ? { kind: 'Number' }
        : { kind: 'Number', decimals: raw['decimals'] as number };
    case 'Percent':
      return raw['decimals'] === undefined
        ? { kind: 'Percent' }
        : { kind: 'Percent', decimals: raw['decimals'] as number };
    case 'Currency':
      return { kind: 'Currency', isoCode: raw['isoCode'] as string };
    default:
      throw new Error(`chart-lowering input: unsupported valueFormat ${raw.$type}`);
  }
};

/** The corpus carries a `TextSource` in canonical wire JSON; the lowering takes
 * the host's tagged-union shape. Every arm crosses — dropping the non-literal
 * ones is exactly the divergence Phase 1143 closed — so this decodes all three,
 * and throws on a binding arm no fixture uses rather than inventing one. */
const textSourceOf = (raw: WireTextSource): TextSource => {
  if (typeof raw === 'string') return { kind: 'Literal', value: raw };
  switch (raw['$type']) {
    case 'Literal':
      return { kind: 'Literal', value: raw['text'] as string };
    case 'Bound': {
      const binding = raw['binding'] as { readonly $type: string; readonly [k: string]: unknown };
      if (binding.$type !== 'Static') {
        throw new Error(`chart-lowering input: unsupported Bound binding ${binding.$type}`);
      }
      return { kind: 'Bound', binding: { kind: 'Static', value: binding['value'] as string } };
    }
    case 'I18n':
      return {
        kind: 'I18n',
        key: raw['key'] as string,
        args: (raw['args'] ?? {}) as Readonly<Record<string, never>>,
      };
    default:
      throw new Error(`chart-lowering input: unsupported TextSource ${String(raw['$type'])}`);
  }
};

const cases = (): string[] => {
  if (!existsSync(CHART_LOWERING_DIR)) return [];
  return readdirSync(CHART_LOWERING_DIR)
    .filter((f) => f.endsWith('.input.json'))
    .map((f) => f.slice(0, -'.input.json'.length))
    .sort();
};

const specAndRows = (
  inp: ChartInput,
): { spec: ChartLowerSpec; rows: readonly ChartRow[]; style: ChartLowerStyle } => ({
  spec: {
    kind: inp.kind,
    xField: inp.xField,
    yFields: inp.yFields,
    ...(inp.title !== null ? { title: textSourceOf(inp.title) } : {}),
    stacked: inp.stacked,
    ...(inp.valueFormat !== undefined ? { valueFormat: valueFormatOf(inp.valueFormat) } : {}),
    // Phase 878 — the same keys beside `title`, omitted when absent; Phase
    // 1143 — carrying the same `TextSource` vocabulary, every arm.
    ...(inp.xTitle !== undefined ? { xTitle: textSourceOf(inp.xTitle) } : {}),
    ...(inp.yTitle !== undefined ? { yTitle: textSourceOf(inp.yTitle) } : {}),
    ...(inp.subtitle !== undefined ? { subtitle: textSourceOf(inp.subtitle) } : {}),
    // Phase 880 — same omitted-when-absent posture; a real wire field, so it
    // goes on the spec rather than the style.
    ...(inp.legendPosition !== undefined ? { legendPosition: inp.legendPosition } : {}),
    // Phase 881 — same omitted-when-absent posture; a real wire field.
    ...(inp.dataLabels !== undefined ? { dataLabels: inp.dataLabels } : {}),
    // Phase 882 — same omitted-when-absent posture; a real wire field.
    ...(inp.xScale !== undefined ? { xScale: inp.xScale } : {}),
  },
  rows: inp.data,
  style: inp.axisUnitMode !== undefined ? { axisUnitMode: inp.axisUnitMode } : {},
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
    const { spec, rows, style } = specAndRows(readInput(name));
    expect(encodeNode(lowerNode(`chart-${name}`, spec, rows, style))).toBe(expected);
  });

  it.each(names)('%s — lowering is order-independent (fields read by name)', (name) => {
    const { spec, rows, style } = specAndRows(readInput(name));
    const reversedRows = rows.map(
      (r) => Object.fromEntries(Object.entries(r).reverse()) as ChartRow,
    );
    const a = encodeNode(lowerNode('c', spec, rows, style));
    const b = encodeNode(lowerNode('c', spec, reversedRows, style));
    expect(a).toBe(b);
  });

  // Phase 882 — the STRONGER form the corpus cannot state. The goldens show that
  // the default is byte-unchanged (not one pre-882 `.expected.json` moved); this
  // shows the two SPELLINGS of the default agree — an absent `xScale` and an
  // explicit `'Category'` lower to the same bytes. Without it, "absent means
  // Category" would be a claim about code nothing checks.
  const categoryNames = names.filter((name) => readInput(name).xScale === undefined);

  it.runIf(names.length > 0)('has cases that declare no x-scale', () => {
    expect(categoryNames.length).toBeGreaterThan(0);
  });

  it.each(categoryNames)(
    '%s — an absent xScale is byte-identical to an explicit Category',
    (name) => {
      const { spec, rows, style } = specAndRows(readInput(name));
      const absent = encodeNode(lowerNode('c', spec, rows, style));
      const explicit = encodeNode(lowerNode('c', { ...spec, xScale: 'Category' }, rows, style));
      expect(absent).toBe(explicit);
    },
  );
});
