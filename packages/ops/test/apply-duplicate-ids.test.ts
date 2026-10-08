// ============================================================================
//  Apply refuses a tree that would hold duplicate node ids (Phase 2172,
//  WIRE_FORMAT §8.1) — this host's own cases.
//
//  Every op addresses its target by id alone, so a tree that holds one id
//  twice makes every later id-addressed op ambiguous. The decoder accepts a
//  repeated id, and an apply could BUILD one from parts that each decoded
//  cleanly. The check reads the op's RESULT and charges it only for the ids it
//  installed; the shared corpus family pins the same cases across hosts, and
//  these add the precedence over the limits.
// ============================================================================

import { MAX_NODE_DEPTH } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import { apply, decodeNode, decodeOp } from '../src/index.js';

const FLEX = '"layout":{"$type":"Flex","direction":"Vertical","wrap":false},"role":"Group"';
const kind = (...children: string[]): string =>
  `{"$type":"Box","children":[${children.join(',')}],${FLEX}}`;
const box = (id: string, ...children: string[]): string =>
  `{"id":"${id}","kind":${kind(...children)}}`;
const edit = (target: string, newKind: string): string =>
  `{"$type":"EditNode","newKind":${newKind},"target":"${target}"}`;

const outcome = (tree: string, op: string): string => {
  const t = decodeNode(tree);
  const o = decodeOp(op);
  if (!t.ok || !o.ok) throw new Error('a test input did not decode');
  const r = apply(t.value, o.value);
  return r.ok ? 'applied' : r.error.code;
};

const base = box('r', box('a'), box('b'));
const x = box('x');

describe('apply refuses an installed duplicate id', () => {
  const refused: [string, string][] = [
    ['ReplaceRoot repeats an id', `{"$type":"ReplaceRoot","node":${box('r2', x, x)}}`],
    [
      'ReplaceRoot repeats its root id below',
      `{"$type":"ReplaceRoot","node":${box('r', box('r'))}}`,
    ],
    ['EditNode collides with the tree', edit('a', kind(box('b')))],
    ['EditNode repeats an id within its kind', edit('a', kind(x, x))],
    ['EditNode repeats the edited node id', edit('a', kind(box('a')))],
    [
      'UpdateState collides with the tree',
      `{"$type":"UpdateState","state":{"onLoading":${box('b')}},"target":"a"}`,
    ],
    [
      'InsertChild repeats an id within itself',
      `{"$type":"InsertChild","child":${box('c', x, x)},"parentId":"r"}`,
    ],
    [
      'InsertChild collides with the tree',
      `{"$type":"InsertChild","child":${box('b')},"parentId":"r"}`,
    ],
    [
      'a Batch whose result repeats an installed id',
      `{"$type":"Batch","ops":[${edit('a', kind(box('b')))}]}`,
    ],
  ];
  for (const [what, op] of refused) {
    it(what, () => expect(outcome(base, op)).toBe('DuplicateNodeId'));
  }
});

describe('apply accepts what only looks like a duplicate', () => {
  const withLoading = `{"id":"a","kind":{"$type":"Markdown","text":"a"},"state":{"onLoading":${box('l')}}}`;
  const accepted: [string, string, string][] = [
    [
      'ReplaceRoot reuses the replaced tree ids',
      base,
      `{"$type":"ReplaceRoot","node":${box('r', box('a'), box('b'))}}`,
    ],
    [
      'EditNode restates the children it replaces',
      box('r', box('a', box('c'))),
      edit('a', kind(box('c'), box('d'))),
    ],
    [
      'UpdateState replaces its own alternative',
      `{"id":"r","kind":${kind(withLoading)}}`,
      `{"$type":"UpdateState","state":{"onLoading":${box('l', box('l2'))}},"target":"a"}`,
    ],
    [
      'a duplicate the op did not install is not charged to it',
      box('r', box('x'), box('y', box('x')), box('z')),
      edit('z', kind(box('w'))),
    ],
    [
      'a Batch whose intermediate state duplicates but whose result does not',
      box('r', box('a'), box('s', box('b'))),
      `{"$type":"Batch","ops":[${edit('a', kind(box('b')))},${edit('s', kind())}]}`,
    ],
  ];
  for (const [what, tree, op] of accepted) {
    it(what, () => expect(outcome(tree, op)).toBe('applied'));
  }
});

describe('the limits take precedence', () => {
  it('an op past MAX_NODE_DEPTH that also installs a duplicate reports LimitExceeded', () => {
    // limitsApply's `editnode-repeated-id-past-maxdepth` pins this order.
    let chain = box('n1');
    for (let d = 2; d <= MAX_NODE_DEPTH; d += 1) chain = box(`n${d}`, chain);
    expect(outcome(chain, edit('n1', kind(box('n1'))))).toBe('LimitExceeded');
  });
});
