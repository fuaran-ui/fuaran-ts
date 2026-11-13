// Phase 2653 — a manifest is read under WIRE_FORMAT §21.1's syntactic limits, the
// same values the other hosts read the same manifest string under. Each edge is
// stated as the format's literal value, at it and one past it, so a host that
// drifts to figures of its own goes red here rather than in another host's suite.

import { describe, expect, it } from 'vitest';

import { decodeManifest } from '../src/index.js';

/** A vanilla DTCG tree `levels` groups deep over one leaf: `levels + 1` containers. */
const nestedGroups = (levels: number): string =>
  '{"g":'.repeat(levels) + '{"$value":"#000"}' + '}'.repeat(levels);

const tokenValue = (value: string): string => `{"tokens":{"a":{"$value":"${value}"}}}`;

const invariantItems = (n: number): string =>
  `{"tokens":{},"invariants":[${new Array<string>(n).fill('0').join(',')}]}`;

const tokenMembers = (n: number): string =>
  `{"tokens":{${Array.from({ length: n }, (_, i) => `"k${i}":0`).join(',')}}}`;

const padTo = (bytes: number): string => {
  const base = '{"tokens":{}}';
  return base + ' '.repeat(bytes - base.length);
};

const refusal = (json: string): string => {
  const r = decodeManifest(json);
  if (r.ok) throw new Error(`expected a refusal for a ${json.length}-char document`);
  return r.error;
};

const decodes = (json: string): void => {
  const r = decodeManifest(json);
  if (!r.ok) throw new Error(`expected the manifest to decode: ${r.error}`);
};

describe('decodeManifest — the §21.1 syntactic limits (Phase 2653)', () => {
  it('decodes a manifest 256 containers deep and refuses 257 by name', () => {
    const r = decodeManifest(nestedGroups(255));
    expect(r.ok && r.value.tokens.length).toBe(1);
    const e = refusal(nestedGroups(256));
    expect(e).toMatch(/^LIMIT_EXCEEDED/);
    expect(e).toContain('MAX_JSON_DEPTH = 256');
  });

  it('refuses a depth bomb by name, never as a RangeError', () => {
    // A bare JSON.parse read this, and the token walk then overflowed the stack.
    expect(() => decodeManifest(nestedGroups(100000))).not.toThrow();
    expect(refusal(nestedGroups(100000))).toContain('MAX_JSON_DEPTH = 256');
  });

  it('bounds a string at 1,048,576 code points', () => {
    decodes(tokenValue('a'.repeat(1048576)));
    expect(refusal(tokenValue('a'.repeat(1048577)))).toContain('MAX_STRING_LENGTH = 1048576');
    // Code points, not UTF-16 units: an astral character costs one.
    decodes(tokenValue('\u{1D11E}'.repeat(1048576)));
  });

  it('bounds an array at 100,000 items', () => {
    decodes(invariantItems(100000));
    expect(refusal(invariantItems(100001))).toContain('MAX_ARRAY_LENGTH = 100000');
  });

  it('bounds an object at 100,000 members', () => {
    decodes(tokenMembers(100000));
    const e = refusal(tokenMembers(100001));
    expect(e).toMatch(/^LIMIT_EXCEEDED/);
    expect(e).toContain('members');
  });

  it('bounds the document at 33,554,432 UTF-8 bytes', () => {
    decodes(padTo(33554432));
    expect(refusal(padTo(33554433))).toContain('MAX_DOCUMENT_BYTES = 33554432');
  });

  it('refuses malformed text as malformed, never as a breach', () => {
    expect(refusal('{"tokens":{')).toMatch(/^INVALID_JSON/);
  });
});
