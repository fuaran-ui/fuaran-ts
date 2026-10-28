// Phase 2207 — the unit algebra's parse and canonical render (twin of Fuaran.Core.Unit), past what
// the shared corpus's fieldLaws vectors pin: every refusal class, the grammar's edges, and the
// schema operations' replay law over metadata.
import { describe, expect, it } from 'vitest';

import type { SchemaEntry } from '@fuaran-ui/schema';

import { canonicalUnit, diffSchema, parseUnit, patchSchema } from '../src/index.js';

const canon = (text: string): string => {
  const r = canonicalUnit(text);
  if (!r.ok) throw new Error(`refused ${text}: ${JSON.stringify(r.error)}`);
  return r.value;
};

const refusal = (text: string): string => {
  const r = parseUnit(text);
  if (r.ok) throw new Error(`accepted ${text}`);
  return r.error.kind;
};

describe('Phase 2207 — the unit algebra twin', () => {
  it('writes the one canonical text', () => {
    expect(canon('s-1.m')).toBe('m/s');
    expect(canon('m/s/s')).toBe('m/s2');
    expect(canon('l')).toBe('L');
    expect(canon('m.m')).toBe('m2');
    expect(canon('m/m')).toBe('1');
    expect(canon('/min')).toBe('/min');
    expect(canon('kg.m/s2')).toBe('kg.m/s2');
    expect(canon('m/(s.s)')).toBe('m/s2');
    expect(canon('(/s)')).toBe('/s');
    expect(canon('1/h')).toBe('/h');
    expect(canon('m+2')).toBe('m2');
    expect(canon('m0')).toBe('1');
    expect(canon('dam')).toBe('dam');
    expect(canon('c[GBP]')).toBe('c[GBP]');
    expect(canon('[ft_i].[in_i]')).toBe('[ft_i].[in_i]');
    // Factors order by symbol, then prefix, ordinally (capitals before lower case).
    expect(canon('s.m.A')).toBe('A.m.s');
    expect(canon('km.m')).toBe('m.km');
  });

  it('refuses each text by the reference class', () => {
    expect(refusal('')).toBe('Empty');
    expect(refusal('furlong')).toBe('UnknownAtom');
    expect(refusal('m{tall}')).toBe('Annotation');
    expect(refusal('{tall}')).toBe('Annotation');
    expect(refusal('[IU]')).toBe('ArbitraryUnit');
    expect(refusal('k[IU]')).toBe('ArbitraryUnit');
    expect(refusal('Cel')).toBe('NonRatioUnit');
    expect(refusal('[degF]')).toBe('NonRatioUnit');
    expect(refusal('dB')).toBe('NonRatioUnit');
    expect(refusal('kmin')).toBe('PrefixNotAllowed');
    expect(refusal('k%')).toBe('PrefixNotAllowed');
    expect(refusal('10*3')).toBe('NumericFactor');
    expect(refusal('1000')).toBe('NumericFactor');
    for (const t of ['m^2', 'm.', 'm s', '(m', 'm)', '(m)2', 'm-', 'm2147483648', 'm/.s', 'é'])
      expect(refusal(t), t).toBe('Malformed');
  });

  it('holds exponents to ±2147483647', () => {
    expect(canon('m2147483647')).toBe('m2147483647');
    expect(refusal('m2147483647.m')).toBe('Malformed');
  });
});

describe('Phase 2207 — the schema delta replays metadata', () => {
  const ext = (o: Record<string, string>): ReadonlyMap<string, string> =>
    new Map(Object.entries(o));
  const old: SchemaEntry[] = [
    { name: 'a', type: 'int', unit: 'kg', ext: ext({ 'v.k': '1', 'v.z': 'z' }) },
    { name: 'b', type: 'float', label: '' },
    { name: 'c', type: 'string', description: 'gone' },
  ];
  const target: SchemaEntry[] = [
    { name: 'd', type: 'bool', label: 'new' },
    { name: 'b', type: 'float', label: 'B', unit: 'm/s' },
    { name: 'a', type: 'float', ext: ext({ 'v.k': '2', 'v.j': 'j' }) },
  ];

  it('patch(old, diff(old, target)) is target, and diff(a, a) changes nothing', () => {
    const p = patchSchema(old, diffSchema(old, target));
    expect(p.ok && p.value).toEqual(target);
    expect(diffSchema(target, target)).toEqual({
      added: [],
      removed: [],
      retyped: [],
      amended: [],
      reordered: false,
      order: [],
    });
  });

  it('refuses a change applied to a schema it was not computed against', () => {
    const d = diffSchema(old, target);
    const moved = old.map((f) => (f.name === 'a' ? { ...f, unit: 'g' } : f));
    const p = patchSchema(moved, d);
    expect(!p.ok && p.error.kind).toBe('MetadataDisagrees');
  });
});
