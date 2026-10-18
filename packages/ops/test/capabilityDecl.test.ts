// ============================================================================
//  The capability declaration reader at the Core version the twin mirrors
//  (Phase 2001): it reads a determinism set in its canonical label and only
//  that, requires `"$type":"capability"`, reads an entry as its hole kind, and
//  refuses what the registry's admission gate refuses.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeCapabilityDeclaration, encodeCapabilityDeclaration } from '../src/capabilityDecl.js';

const DOC =
  '{"$type":"capability","determinism":"clock+random","id":"c","placement":{"$type":"server"},' +
  '"signature":{"effect":{"determinism":"clock+random","host":"pure"},"holes":[' +
  '{"addr":"a","kind":"value","name":"a","required":true,"space":{"$type":"intRange","max":9,"min":0}}],"name":"c"}}';

describe('capability declaration reader', () => {
  it('reads a composed determinism set and writes it back byte-identically', () => {
    const r = decodeCapabilityDeclaration(DOC);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.value.determinism].sort()).toEqual(['ClockFactor', 'RandomFactor']);
      expect(encodeCapabilityDeclaration(r.value)).toBe(DOC);
    }
  });

  const refused: readonly (readonly [string, string, RegExp])[] = [
    ['no $type', DOC.replace('"$type":"capability",', ''), /missing field: \$type/],
    [
      'another $type',
      DOC.replace('"$type":"capability"', '"$type":"query"'),
      /not a capability declaration/,
    ],
    [
      'a non-canonical label',
      DOC.replaceAll('clock+random', 'random+clock'),
      /unknown determinism: random\+clock/,
    ],
    ['an empty space', DOC.replace('"max":9,"min":0', '"max":0,"min":9'), /EmptySpace\(a\)/],
    [
      'a value hole with no space',
      DOC.replace(',"space":{"$type":"intRange","max":9,"min":0}', ''),
      /missing field: space/,
    ],
    [
      'an unbounded repeat',
      DOC.replace('"kind":"value"', '"kind":"repeat"').replace(
        '{"$type":"intRange","max":9,"min":0}',
        '{"$type":"anyString"}',
      ),
      /NonTotalCapability/,
    ],
  ];

  for (const [name, doc, why] of refused) {
    it(`refuses ${name}`, () => {
      const r = decodeCapabilityDeclaration(doc);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(why);
    });
  }
});
