// Phase 2206 — the timestamp unit in the column-type lattice: the unit a cell's
// text spells, the widening of a coarser unit into a finer one, and the order of
// instant texts that carry a fraction.
import { describe, expect, it } from 'vitest';

import type { Cell, Table } from '@fuaran-ui/schema';

import {
  columnTypeWidens,
  compareInstantText,
  evalPipeline,
  timestampTypeOfText,
} from '../src/index.js';

const ts = (value: string): Cell => ({ kind: 'Timestamp', value });

describe('Phase 2206 — the column-type lattice with timestamp units', () => {
  it('a text names the unit its fraction spells; a non-canonical text is whole seconds', () => {
    expect(timestampTypeOfText('2026-10-12T16:08:57Z')).toBe('timestamp');
    expect(timestampTypeOfText('2026-10-12T16:08:57.5Z')).toBe('timestamp_ms');
    expect(timestampTypeOfText('2026-10-12T16:08:57.123Z')).toBe('timestamp_ms');
    expect(timestampTypeOfText('2026-10-12T16:08:57.1234Z')).toBe('timestamp_us');
    expect(timestampTypeOfText('2026-10-12T16:08:57.000000001Z')).toBe('timestamp_ns');
    expect(timestampTypeOfText('2026-10-12T16:08:57.50Z')).toBe('timestamp');
    expect(timestampTypeOfText('yesterday')).toBe('timestamp');
  });

  it('a coarser unit widens into a finer one, never the reverse', () => {
    expect(columnTypeWidens('timestamp', 'timestamp_ns')).toBe(true);
    expect(columnTypeWidens('timestamp_ms', 'timestamp_us')).toBe(true);
    expect(columnTypeWidens('timestamp_us', 'timestamp_ms')).toBe(false);
    expect(columnTypeWidens('int', 'decimal')).toBe(true);
    expect(columnTypeWidens('float', 'decimal')).toBe(false);
    expect(columnTypeWidens('date', 'timestamp')).toBe(false);
  });

  it('instant texts order by the instant, not by their bytes', () => {
    const asc = [
      '2026-10-12T16:08:57Z',
      '2026-10-12T16:08:57.000000001Z',
      '2026-10-12T16:08:57.5Z',
      '2026-10-12T16:08:57.55Z',
      '2026-10-12T16:08:58Z',
    ];
    const shuffled = [asc[3]!, asc[0]!, asc[4]!, asc[2]!, asc[1]!];
    expect([...shuffled].sort(compareInstantText)).toEqual(asc);
    expect(compareInstantText(asc[2]!, asc[2]!)).toBe(0);
  });

  it('the evaluator sorts a sub-second column by the instant', () => {
    const input: Table = {
      schema: [{ name: 't', type: 'timestamp_ms' }],
      columns: [
        {
          name: 't',
          type: 'timestamp_ms',
          cells: [ts('2026-01-01T00:00:00.5Z'), ts('2026-01-01T00:00:00Z')],
        },
      ],
    };
    const r = evalPipeline([{ kind: 'sort', by: [{ col: 't', dir: 'asc' }] }], input);
    expect(r.ok && r.value.columns[0]!.cells).toEqual([
      ts('2026-01-01T00:00:00Z'),
      ts('2026-01-01T00:00:00.5Z'),
    ]);
  });

  it('a derived column of mixed-unit cells takes the finest unit they spell', () => {
    const input: Table = {
      schema: [{ name: 'n', type: 'int' }],
      columns: [
        {
          name: 'n',
          type: 'int',
          cells: [
            { kind: 'Int', value: 1 },
            { kind: 'Int', value: 2 },
          ],
        },
      ],
    };
    const r = evalPipeline(
      [
        {
          kind: 'derive',
          name: 't',
          expr: {
            kind: 'case',
            cases: [
              {
                when: {
                  kind: 'binary',
                  op: 'eq',
                  left: { kind: 'col', name: 'n' },
                  right: { kind: 'lit', cell: { kind: 'Int', value: 1 } },
                },
                then: { kind: 'lit', cell: ts('2026-01-01T00:00:00Z') },
              },
            ],
            else: { kind: 'lit', cell: ts('2026-01-01T00:00:00.25Z') },
          },
        },
      ],
      input,
    );
    expect(r.ok && r.value.schema).toEqual([
      { name: 'n', type: 'int' },
      { name: 't', type: 'timestamp_ms' },
    ]);
  });
});
