// ============================================================================
//  Cross-host function-registry conformance (Phase 558).
//
//  Loads the shared `wire-format-fixtures/function-registry/goldens.json` — the
//  canonical registry + findBySignature (EXACT/SUBSUMES) queries + compose-path
//  queries with expected results, derived from the SHIPPED Python reference (the
//  twin of the F# Fuaran.Core.FunctionRegistry engine). This TS host must resolve
//  every golden identically. The registry-shape pin is the 548-style attestation
//  guard: a shape drift fails here with the entry named.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HoleValueSpace } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import {
  type ComposeResult,
  type FunctionEntry,
  type MatchMode,
  type RegistrySigEntry,
  compose,
  findBySignature,
  functionRegistryOf,
  registrySignatureShape,
} from '../src/function.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/ui/test → workspace-root/wire-format-fixtures/function-registry
const goldensPath = join(
  here,
  '..',
  '..',
  '..',
  '..',
  'wire-format-fixtures',
  'function-registry',
  'goldens.json',
);

interface NeutralSpace {
  readonly kind: 'intRange' | 'floatRange' | 'stringLen' | 'enum' | 'anyString';
  readonly min?: number;
  readonly max?: number;
  readonly choices?: readonly string[];
}
interface NeutralSig {
  readonly addr: string;
  readonly name: string;
  readonly kind: RegistrySigEntry['kind'];
  readonly space: NeutralSpace | null;
  readonly slot: string | null;
  readonly required: boolean;
}
interface Goldens {
  readonly registry: readonly {
    readonly id: string;
    readonly resultType: string;
    readonly holes: readonly NeutralSig[];
  }[];
  readonly registryShape: readonly string[];
  readonly findBySignature: readonly {
    readonly name: string;
    readonly mode: MatchMode;
    readonly query: {
      readonly resultType: string | null;
      readonly available: readonly NeutralSig[];
    };
    readonly expectedIds: readonly string[];
  }[];
  readonly compose: readonly {
    readonly name: string;
    readonly output: string;
    readonly inputs: readonly NeutralSig[];
    readonly expected: ComposeResult;
  }[];
}

const toSpace = (j: NeutralSpace): HoleValueSpace => {
  switch (j.kind) {
    case 'intRange':
      return { kind: 'IntRange', min: j.min!, max: j.max! };
    case 'floatRange':
      return { kind: 'FloatRange', min: j.min!, max: j.max! };
    case 'stringLen':
      return { kind: 'StringLen', minLen: j.min!, maxLen: j.max! };
    case 'enum':
      return { kind: 'Enum', choices: [...j.choices!] };
    case 'anyString':
      return { kind: 'AnyString' };
  }
};

const toSig = (j: NeutralSig): RegistrySigEntry => ({
  addr: j.addr,
  name: j.name,
  kind: j.kind,
  required: j.required,
  ...(j.space === null ? {} : { space: toSpace(j.space) }),
  ...(j.slot === null ? {} : { slot: j.slot }),
});

const toEntry = (j: Goldens['registry'][number]): FunctionEntry => ({
  id: j.id,
  resultType: j.resultType,
  holes: j.holes.map(toSig),
});

const goldens: Goldens = JSON.parse(readFileSync(goldensPath, 'utf-8')) as Goldens;

const built = functionRegistryOf(goldens.registry.map(toEntry));
if (!built.ok) throw new Error(`golden registry failed to build: ${JSON.stringify(built.error)}`);
const reg = built.value;

describe('function registry — cross-host goldens (Phase 558)', () => {
  it('registry-shape attestation matches the shared goldens (548-style drift guard)', () => {
    expect(registrySignatureShape(reg)).toEqual([...goldens.registryShape]);
  });

  describe('findBySignature — EXACT / SUBSUMES', () => {
    for (const f of goldens.findBySignature) {
      it(`${f.name} [${f.mode}]`, () => {
        const ids = findBySignature(
          f.mode,
          { resultType: f.query.resultType, available: f.query.available.map(toSig) },
          reg,
        ).map((e) => e.id);
        expect(ids).toEqual([...f.expectedIds]);
      });
    }
  });

  describe('compose — ComposePath / NoPath', () => {
    for (const c of goldens.compose) {
      it(`${c.name}`, () => {
        const res = compose(reg, c.output, c.inputs.map(toSig));
        expect(res).toEqual(c.expected);
      });
    }
  });
});
