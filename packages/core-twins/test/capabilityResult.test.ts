// ============================================================================
//  Phase 2741 — a capability declares its result (Core 0.43.0, fuaran-core
//  Phase 642), and the pipeline type check holds an invoke's declared output to
//  it. The shared capability-law vectors draw two cases of this
//  (`declarationRefused`, `pipelineTypeCheck`) from one seed; these pin the rest
//  of the rule the vectors do not reach: each result fault, each step of the
//  space lattice, and every pipeline refusal class in its order.
// ============================================================================

import { describe, expect, it } from 'vitest';

import type { CapabilitySigEntry, Returns } from '@fuaran-ui/schema';

import {
  admissionOf,
  capabilitySpaceSubsumes,
  createCapability,
  determinismOf,
  describeInvokeError,
  register,
  registryOf,
  emptyRegistry,
  typeCheckPipeline,
  type PipelineArg,
  type PipelineNode,
} from '../src/capability.js';

type Space = NonNullable<CapabilitySigEntry['space']>;

const ints = (min: number, max: number): Space => ({ kind: 'IntRange', min, max });
const floats = (min: number, max: number): Space => ({ kind: 'FloatRange', min, max });
const anyStr: Space = { kind: 'AnyString' };

const sig = {
  name: 'score',
  holes: [{ addr: 'x', name: 'x', kind: 'value' as const, space: ints(0, 9), required: true }],
  effect: { hostEffect: 'Pure' as const, determinism: determinismOf() },
};

const capWith = (id: string, result: Returns) =>
  createCapability(id, sig, { kind: 'Server' }, result);

describe('the declared result is held to the admission gate', () => {
  it('admits a well-formed value result and "returns nothing"', () => {
    expect(admissionOf('c', sig, { kind: 'Value', space: ints(0, 999) })).toBeUndefined();
    expect(admissionOf('c', sig, { kind: 'Nothing' })).toBeUndefined();
    // Without a result it is the gate over the signature alone.
    expect(admissionOf('c', sig)).toBeUndefined();
  });

  it('refuses an empty result space as EmptyResult, naming the space', () => {
    const empty: Space = { kind: 'Enum', choices: [] };
    expect(admissionOf('c', sig, { kind: 'Value', space: empty })).toEqual({
      kind: 'IllFormedCapability',
      id: 'c',
      fault: { kind: 'EmptyResult', space: empty },
    });
    expect(admissionOf('c', sig, { kind: 'Value', space: ints(5, 1) })?.kind).toBe(
      'IllFormedCapability',
    );
  });

  it('refuses a non-finite result bound as NonFiniteResult', () => {
    const refused = admissionOf('c', sig, { kind: 'Value', space: floats(0, Infinity) });
    expect(refused).toEqual({
      kind: 'IllFormedCapability',
      id: 'c',
      fault: { kind: 'NonFiniteResult' },
    });
    expect(describeInvokeError(refused!)).toBe('IllFormedCapability(c; NonFiniteResult)');
  });

  it('answers a signature fault before a result fault', () => {
    const bad = { ...sig, holes: [...sig.holes, ...sig.holes] };
    const refused = admissionOf('c', bad, { kind: 'Value', space: ints(1, 0) });
    expect(refused).toMatchObject({ fault: { kind: 'DuplicateHoleAddr', addr: 'x' } });
  });

  it('register runs it over the capability it is handed', () => {
    const r = register(capWith('c', { kind: 'Value', space: ints(1, 0) }), emptyRegistry);
    expect(r.ok).toBe(false);
  });
});

describe('capabilitySpaceSubsumes is the reference lattice', () => {
  const cases: [string, Space, Space, boolean][] = [
    ['an int range admits a narrower one', ints(0, 10), ints(2, 5), true],
    ['an int range does not admit a wider one', ints(2, 5), ints(0, 10), false],
    ['a float range admits an int range inside it', floats(0, 10), ints(0, 10), true],
    ['an int range never admits a float range', ints(0, 10), floats(0, 1), false],
    [
      'a string length admits an enum it bounds (UTF-16)',
      { kind: 'StringLen', minLen: 1, maxLen: 2 },
      { kind: 'Enum', choices: ['a', '\u{1F600}'] },
      true,
    ],
    [
      'a string length refuses an enum member past its bound',
      { kind: 'StringLen', minLen: 1, maxLen: 1 },
      { kind: 'Enum', choices: ['\u{1F600}'] },
      false,
    ],
    [
      'an enum admits a subset of itself',
      { kind: 'Enum', choices: ['a', 'b'] },
      { kind: 'Enum', choices: ['b'] },
      true,
    ],
    ['any string admits every scalar space', anyStr, floats(0, 1), true],
    ['any string admits no tree', anyStr, { kind: 'SlotTree' }, false],
    [
      'an unconstrained tree admits any tree',
      { kind: 'SlotTree' },
      { kind: 'SlotTree', slotKind: 'k' },
      true,
    ],
    [
      'a constrained tree admits only its kind',
      { kind: 'SlotTree', slotKind: 'k' },
      { kind: 'SlotTree' },
      false,
    ],
    ['no tree admits a scalar', { kind: 'SlotTree' }, anyStr, false],
  ];
  for (const [name, required, available, admits] of cases)
    it(name, () => expect(capabilitySpaceSubsumes(required, available)).toBe(admits));
});

describe('typeCheckPipeline names each refusal, in order', () => {
  const reg = (() => {
    const r = registryOf([
      capWith('score', { kind: 'Value', space: ints(0, 999) }),
      capWith('notify', { kind: 'Nothing' }),
    ]);
    if (!r.ok) throw new Error('fixture registry refused');
    return r.value;
  })();

  const lit = (addr: string, value: string): PipelineArg => ({
    addr,
    source: { kind: 'Literal', value },
  });
  const from = (addr: string, node: string): PipelineArg => ({
    addr,
    source: { kind: 'FromNode', node },
  });
  const inv = (
    id: string,
    capabilityId: string,
    outputType: Space,
    ...args: PipelineArg[]
  ): PipelineNode => ({
    kind: 'Invoke',
    id,
    capabilityId,
    outputType,
    args,
  });
  const src = (id: string, outputType: Space): PipelineNode => ({
    kind: 'Source',
    id,
    dataRef: id,
    outputType,
  });

  const out = ints(0, 999);
  const table: [string, PipelineNode[], string | undefined][] = [
    [
      'a well-typed chain',
      [src('s', ints(0, 9)), inv('a', 'score', out, from('x', 's'))],
      undefined,
    ],
    ['a repeated node id', [src('s', out), src('s', out)], 'DuplicateNode'],
    ['an unregistered capability', [inv('a', 'nope', out)], 'PipelineNoSuchCapability'],
    [
      'an output narrower than the result',
      [inv('a', 'score', ints(0, 9), lit('x', '1'))],
      'PipelineOutputContradicts',
    ],
    [
      'a capability that answers nothing',
      [inv('a', 'notify', anyStr, lit('x', '1'))],
      'PipelineOutputContradicts',
    ],
    [
      'an output contradiction before an argument refusal',
      [inv('a', 'notify', anyStr)],
      'PipelineOutputContradicts',
    ],
    ['a literal out of space', [inv('a', 'score', out, lit('x', '10'))], 'PipelineArgRefused'],
    [
      'an address bound twice',
      [inv('a', 'score', out, lit('x', '1'), lit('x', '2'))],
      'PipelineArgRefused',
    ],
    ['an unbound hole', [inv('a', 'score', out)], 'PipelineArgRefused'],
    ['an edge from nowhere', [inv('a', 'score', out, from('x', 'ghost'))], 'UnknownNode'],
    ['a self edge', [inv('a', 'score', out, from('x', 'a'))], 'PipelineCycle'],
    [
      'a closed cycle',
      [inv('a', 'score', out, from('x', 'b')), inv('b', 'score', out, from('x', 'a'))],
      'PipelineCycle',
    ],
    [
      'a forward edge',
      [inv('a', 'score', out, from('x', 's')), src('s', ints(0, 9))],
      'PipelineForwardEdge',
    ],
    [
      'an ill-typed edge',
      [src('s', anyStr), inv('a', 'score', out, from('x', 's'))],
      'EdgeTypeMismatch',
    ],
  ];
  for (const [name, nodes, expected] of table)
    it(name, () => expect(typeCheckPipeline(reg, { nodes })?.kind).toBe(expected));

  it('names the node, the capability, the declared output and the result', () => {
    expect(typeCheckPipeline(reg, { nodes: [inv('call', 'notify', anyStr)] })).toEqual({
      kind: 'PipelineOutputContradicts',
      node: 'call',
      capability: 'notify',
      declared: anyStr,
      result: { kind: 'Nothing' },
    });
  });

  it('names the cycle from the node around its edges', () => {
    expect(
      typeCheckPipeline(reg, {
        nodes: [inv('a', 'score', out, from('x', 'b')), inv('b', 'score', out, from('x', 'a'))],
      }),
    ).toEqual({ kind: 'PipelineCycle', node: 'a', cycle: ['a', 'b'] });
  });

  it('wraps the argument refusal the capability gives', () => {
    expect(
      typeCheckPipeline(reg, { nodes: [inv('a', 'score', out, lit('x', '1'), lit('x', '2'))] }),
    ).toEqual({
      kind: 'PipelineArgRefused',
      node: 'a',
      reason: { kind: 'DuplicateArg', addr: 'x' },
    });
  });
});
