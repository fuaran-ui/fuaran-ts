// ============================================================================
//  @fuaran-ui/renderer — the narrowed seed walk against its own predecessor
//  (Phase 2074).
//
//  Phase 2074 stopped `collectStateSeeds` descending into DATA (a `Static`
//  value, a binding's `defaultValue`, an embedded table, a `SetState` value).
//  The claim is that no document's seeds change, because no binding can sit
//  inside a JSON value. This file holds the claim to account: the PRE-2074
//  walk is kept here, verbatim in behaviour, as the ORACLE, and both walks run
//  over every node fixture in the wire corpus plus fixtures that put bindings
//  right beside table data. They must yield identical seed sets.
//
//  The oracle lives in this test only. It is not a second implementation for
//  anything to call.
// ============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ChildReach, children, collectStateSeeds, decodeNode } from '@fuaran-ui/ops';
import { controlValueDefaults, type Node } from '@fuaran-ui/schema';

// --- The oracle: the seed walk as it stood before Phase 2074 -----------------

const HOST_RESERVED_PREFIX = 'host.';
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const isStateDeclaration = (v: unknown): v is { key: string; defaultValue: unknown } =>
  isPlainObject(v) &&
  v['kind'] === 'State' &&
  typeof v['key'] === 'string' &&
  'defaultValue' in v &&
  v['defaultValue'] !== undefined;
const controlDefaults: readonly unknown[] = Object.values(controlValueDefaults);
const deepEqual = (a: unknown, b: unknown): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};
const isAutoBoundFieldValue = (binding: { key: string; defaultValue: unknown }, fieldId: string) =>
  binding.key === fieldId && controlDefaults.some((d) => deepEqual(d, binding.defaultValue));
const isEmptyDeclaration = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) {
    const columns = value['columns'];
    if (isPlainObject(columns)) return Object.keys(columns).length === 0;
  }
  return false;
};

const oracleSeeds = <TMsg>(tree: Node<TMsg>): Record<string, unknown> => {
  const seeds: Record<string, unknown> = {};
  const seen = new Set<unknown>();
  const visit = (
    value: unknown,
    autoBindFieldId: string | undefined,
    childNodes: ReadonlySet<unknown>,
  ): void => {
    if (value === null || typeof value !== 'object') return;
    if (childNodes.has(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, autoBindFieldId, childNodes);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (isStateDeclaration(obj)) {
      const key = obj.key;
      const shouldSkip =
        key.startsWith(HOST_RESERVED_PREFIX) ||
        Object.prototype.hasOwnProperty.call(seeds, key) ||
        isEmptyDeclaration(obj.defaultValue) ||
        (autoBindFieldId !== undefined && isAutoBoundFieldValue(obj, autoBindFieldId));
      if (!shouldSkip) seeds[key] = obj.defaultValue;
    }
    const record = obj as Record<string, unknown>;
    const ownId: unknown = record['id'];
    const fieldId =
      typeof ownId === 'string' && typeof record['required'] === 'boolean' ? ownId : undefined;
    for (const [k, v] of Object.entries(obj)) {
      const established = k === 'kind' && fieldId !== undefined ? fieldId : undefined;
      visit(v, established ?? autoBindFieldId, childNodes);
    }
  };
  const visitNode = (node: Node<TMsg>): void => {
    if (seen.has(node)) return;
    const kids = children(node, ChildReach.all);
    visit(node, undefined, new Set<unknown>(kids));
    for (const c of kids) visitNode(c);
  };
  visitNode(tree);
  return seeds;
};

// --- The fixtures -------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
// test -> renderer -> packages -> fuaran-ts -> <workspace>/wire-format-fixtures
const nodesDir = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'nodes');
const corpusFiles = readdirSync(nodesDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const decode = (json: string): Node<unknown> => {
  const decoded = decodeNode(json);
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

const rows = [
  { name: 'Ada', score: 1.5, tags: ['a', 'b'] },
  { name: 'Grace', score: 2.5, tags: ['c'] },
  { name: 'Edsger', score: 3.5, tags: [] },
];

/** Bindings sitting right beside table data, in every data position the walk now skips. */
const besideTableData: Record<string, unknown> = {
  'grid-rows-transform-table-and-static-rows-side-by-side': {
    id: 'page',
    kind: {
      $type: 'Box',
      layout: { $type: 'Flex', direction: 'Vertical', wrap: false },
      role: 'Group',
      children: [
        {
          id: 'grid',
          kind: {
            $type: 'DataGrid',
            columns: [{ field: 'name', kind: { $type: 'Text' }, label: 'Name' }],
            rowKeyField: 'name',
            source: { $type: 'State', key: 'members', defaultValue: rows },
          },
        },
        {
          id: 'static-grid',
          kind: {
            $type: 'DataGrid',
            columns: [{ field: 'name', kind: { $type: 'Text' }, label: 'Name' }],
            rowKeyField: 'name',
            source: { $type: 'Static', value: rows },
          },
        },
        {
          id: 'count',
          kind: {
            $type: 'Badge',
            label: {
              $type: 'Bound',
              binding: {
                $type: 'Transform',
                pipeline: [
                  { $type: 'groupBy', aggs: [{ fn: 'count', name: 'n', of: 'name' }], keys: [] },
                ],
                source: {
                  $type: 'State',
                  key: 'scores',
                  defaultValue: rows.map(({ tags: _t, ...r }) => r),
                },
              },
            },
            variant: 'Info',
          },
        },
        {
          id: 'note',
          kind: {
            $type: 'Markdown',
            text: {
              $type: 'I18n',
              key: 'note',
              args: { who: { $type: 'State', key: 'who', defaultValue: 'Ada' } },
            },
          },
        },
      ],
    },
  },
  'transform-table-beside-a-scalar-declaration': {
    id: 'pair',
    kind: {
      $type: 'Box',
      layout: { $type: 'Flex', direction: 'Horizontal', wrap: false },
      role: 'Group',
      children: [
        {
          id: 'sum',
          kind: {
            $type: 'Badge',
            label: {
              $type: 'Bound',
              binding: {
                $type: 'Transform',
                pipeline: [],
                source: {
                  $type: 'State',
                  key: 'ledger',
                  defaultValue: [{ amount: 3 }, { amount: 4 }],
                },
              },
            },
            variant: 'Info',
          },
        },
        {
          id: 'threshold',
          kind: {
            $type: 'Badge',
            label: {
              $type: 'Bound',
              binding: { $type: 'State', key: 'threshold', defaultValue: '5' },
            },
            variant: 'Info',
          },
        },
      ],
    },
  },
};

const decodedBeside = Object.entries(besideTableData).flatMap(([name, wire]) => {
  const decoded = decodeNode(JSON.stringify(wire));
  return decoded.ok ? [[name, decoded.value] as const] : [];
});

// --- The equality -------------------------------------------------------------

describe('Phase 2074 — the narrowed seed walk yields the oracle walk’s seeds', () => {
  it('the corpus is present and large enough to mean something', () => {
    expect(corpusFiles.length).toBeGreaterThan(200);
  });

  it.each(corpusFiles)('corpus node fixture %s', (file) => {
    const tree = decode(readFileSync(join(nodesDir, file), 'utf8'));
    expect(collectStateSeeds(tree)).toEqual(oracleSeeds(tree));
  });

  it('every binding-beside-table-data fixture decodes (none is silently dropped)', () => {
    expect(decodedBeside.map(([name]) => name)).toEqual(Object.keys(besideTableData));
  });

  it.each(decodedBeside)('binding beside table data: %s', (_name, tree) => {
    const seeds = collectStateSeeds(tree);
    expect(seeds).toEqual(oracleSeeds(tree));
    // Not vacuous: these fixtures DO declare seeds.
    expect(Object.keys(seeds).length).toBeGreaterThan(0);
  });

  it('the corpus as a whole declares seeds, so the equality is not over empty sets', () => {
    const seeded = corpusFiles.filter(
      (file) =>
        Object.keys(collectStateSeeds(decode(readFileSync(join(nodesDir, file), 'utf8')))).length >
        0,
    );
    expect(seeded.length).toBeGreaterThan(5);
  });
});

describe('Phase 2074 — what the narrowing DOES change, stated', () => {
  // The one input on which the two walks differ: a value that merely LOOKS
  // like a declaration, carried as data. The oracle seeded from inside the
  // data; the narrowed walk does not, which is what the typed reference walk
  // has always done. No document in the corpus carries such a value.
  it('a declaration-shaped ROW inside a default value is data, not a declaration', () => {
    // A string slot coerces its default (the decoder keeps no object there), so
    // the only place such a value survives decode is a data-bearing slot's rows.
    const tree = decode(
      JSON.stringify({
        id: 'g',
        kind: {
          $type: 'DataGrid',
          columns: [{ field: 'key', kind: { $type: 'Text' }, label: 'Key' }],
          rowKeyField: 'key',
          source: {
            $type: 'State',
            key: 'outer',
            defaultValue: [{ kind: 'State', key: 'smuggled', defaultValue: 'x' }],
          },
        },
      }),
    );
    expect(Object.keys(oracleSeeds(tree)).sort()).toEqual(['outer', 'smuggled']);
    expect(Object.keys(collectStateSeeds(tree))).toEqual(['outer']);
  });

  it('the seeds are computed once per tree identity', () => {
    const tree = decode(readFileSync(join(nodesDir, corpusFiles[0]!), 'utf8'));
    expect(collectStateSeeds(tree)).toBe(collectStateSeeds(tree));
  });
});
