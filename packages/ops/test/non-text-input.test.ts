// ============================================================================
//  Phase 2694 — a decoder handed a value that is not wire TEXT refuses it
//  with a typed defect; no decoder path throws a `TypeError`.
//
//  The reproduction is the default wire a structural editor synthesises for a
//  Chart: as TEXT it decodes; handed over as the already-parsed OBJECT (an
//  untyped caller skipping the stringify), it used to reach the parser's
//  cursor and throw `TypeError: s.text.substring is not a function` from
//  inside the decoder. Every text-taking decoder reads the wire through
//  `parse`, so the refusal lives there, once, and every entry point below
//  inherits it.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  decodeDagRecord,
  decodeElicitation,
  decodeElicitationOutcome,
  decodeEnvelope,
  decodeGridEdit,
  decodeNode,
  decodeNodeTolerant,
  decodeNodeWithDefects,
  decodeOp,
  decodeOps,
  encodeNode,
} from '../src/index.js';
import { parse } from '../src/parse.js';

/** The Chart default wire a structural editor synthesises (its required members only). */
const CHART_DEFAULT_WIRE =
  '{"id":"chart-1","kind":{"$type":"Chart","kind":"Line","source":{"$type":"Static"},"xField":"XField","yFields":[]}}';

/** Values an untyped caller can hand a text decoder by mistake. */
const NON_TEXT: readonly (readonly [string, unknown])[] = [
  ['the parsed Chart wire', JSON.parse(CHART_DEFAULT_WIRE) as unknown],
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['an array', ['x']],
  ['a boolean', true],
];

// Each takes the wire as text; the cast is the untyped caller this pins.
const TEXT_DECODERS: readonly (readonly [string, (input: never) => unknown])[] = [
  ['decodeNode', decodeNode],
  ['decodeNodeWithDefects', decodeNodeWithDefects],
  ['decodeNodeTolerant', decodeNodeTolerant],
  ['decodeOp', decodeOp],
  ['decodeOps', decodeOps],
  ['decodeEnvelope', decodeEnvelope],
  ['decodeDagRecord', decodeDagRecord],
  ['decodeGridEdit', decodeGridEdit],
  ['decodeElicitation', decodeElicitation],
  ['decodeElicitationOutcome', decodeElicitationOutcome],
];

describe('the Chart default wire (Phase 2694)', () => {
  it('decodes as text, and re-encodes to a fixed point', () => {
    const first = decodeNode(CHART_DEFAULT_WIRE);
    if (!first.ok) throw new Error(`the Chart default wire does not decode: ${first.error.code}`);
    const canonical = encodeNode(first.value);
    const second = decodeNode(canonical);
    if (!second.ok) throw new Error(`the canonical Chart does not re-decode: ${second.error.code}`);
    expect(encodeNode(second.value)).toBe(canonical);
  });

  it('handed over as a parsed object, is refused as INVALID_JSON at $, not thrown', () => {
    const r = decodeNode(JSON.parse(CHART_DEFAULT_WIRE) as never);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_JSON');
    expect(r.error.path).toBe('$');
    expect(r.error.message).toContain('not JSON text (got an object)');
  });
});

describe('the parser refuses a non-text input with a typed failure', () => {
  for (const [label, input] of NON_TEXT) {
    it(`${label}`, () => {
      const r = parse(input as string);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.offset).toBe(0);
      expect(r.error.limit).toBeUndefined();
      expect(r.error.message).toMatch(/^input is not JSON text \(got /);
    });
  }
});

describe('no text decoder throws on a non-text input', () => {
  for (const [name, decode] of TEXT_DECODERS) {
    for (const [label, input] of NON_TEXT) {
      it(`${name}: ${label}`, () => {
        let result: unknown;
        expect(() => {
          result = decode(input as never);
        }).not.toThrow();
        expect((result as { ok: boolean }).ok).toBe(false);
      });
    }
  }
});
