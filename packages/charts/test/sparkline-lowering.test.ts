// ============================================================================
//  Sparkline → Drawing lowering — cross-host byte-parity (Phase 1099; the
//  goldens are Phase 1098's).
//
//  The TS lowering (`@fuaran-ui/charts` `tryLowerSparkline`) must reproduce the
//  shared `wire-format-fixtures/sparkline-lowering/*` goldens byte-for-byte —
//  the same fixtures the F# reference (`Fuaran.UI.Charts.tryLowerSparkline`)
//  emits and every other adopting host certifies against. Each case ships an
//  `<name>.input.json` (`{"series": [...]}`, the RESOLVED value of
//  `SparklineSpec.source`, so no fixture carries a binding) and an
//  `<name>.expected.json` (the canonical wire JSON of the `Drawing` node, or the
//  JSON literal `null` for the nothing-to-draw case). Skips when the corpus is
//  absent (a standalone checkout), mirroring `chart-lowering.test.ts`.
//
//  A non-finite element arrives as the same string sentinel the wire format
//  spells it with everywhere else (`"NaN"` / `"Infinity"` / `"-Infinity"`),
//  which is what `nodes/spark-nonfinite-sentinel.json` already carries — so the
//  decoder below is the one `@fuaran-ui/ops` already applies at a float slot,
//  restated here rather than reached for through a whole node decode, because
//  the input file is a bare series and not a tree.
// ============================================================================

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeNode } from '@fuaran-ui/ops';
import { describe, expect, it } from 'vitest';

import { lowerSparklineNode, tryLowerSparkline } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/charts/test → workspace-root/wire-format-fixtures/sparkline-lowering
const SPARKLINE_LOWERING_DIR = join(
  here,
  '..',
  '..',
  '..',
  '..',
  'wire-format-fixtures',
  'sparkline-lowering',
);

/** A series element on the wire: a JSON number, or one of the three canonical
 * non-finite sentinel strings (WIRE_FORMAT.md §7). */
type WireFloat = number | string;

interface SparklineInput {
  readonly series: readonly WireFloat[];
}

const floatOf = (raw: WireFloat): number => {
  if (typeof raw === 'number') return raw;
  switch (raw) {
    case 'NaN':
      return NaN;
    case 'Infinity':
      return Infinity;
    case '-Infinity':
      return -Infinity;
    default:
      throw new Error(
        `sparkline-lowering input: unsupported series element ${JSON.stringify(raw)}`,
      );
  }
};

const cases = (): string[] => {
  if (!existsSync(SPARKLINE_LOWERING_DIR)) return [];
  return readdirSync(SPARKLINE_LOWERING_DIR)
    .filter((f) => f.endsWith('.input.json'))
    .map((f) => f.slice(0, -'.input.json'.length))
    .sort();
};

const seriesOf = (name: string): readonly number[] =>
  (
    JSON.parse(
      readFileSync(join(SPARKLINE_LOWERING_DIR, `${name}.input.json`), 'utf8'),
    ) as SparklineInput
  ).series.map(floatOf);

const expectedOf = (name: string): string =>
  readFileSync(join(SPARKLINE_LOWERING_DIR, `${name}.expected.json`), 'utf8');

describe('sparkline lowering — cross-host byte-parity', () => {
  const names = cases();

  it.runIf(names.length > 0)('corpus is present', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)('%s — TS lowering is byte-identical to the golden', (name) => {
    const node = lowerSparklineNode(`sparkline-${name}`, seriesOf(name));
    // The nothing-to-draw case is the JSON literal `null` — the wire image of
    // "this host drew no drawing and fell back", which is what the golden
    // family's README fixes. Encoding an empty canvas instead would pass a
    // shape check while asserting the opposite of the contract.
    const actual = node === null ? 'null' : encodeNode(node);
    expect(actual).toBe(expectedOf(name));
  });

  // The one thing a golden cannot state on its own: `null` is what the LOWERING
  // returns, not merely what one fixture's file happens to contain. Without it,
  // a host could satisfy `empty.expected.json` by special-casing that fixture.
  it('an empty series is the nothing-to-draw case', () => {
    expect(tryLowerSparkline([])).toBeNull();
  });
});
