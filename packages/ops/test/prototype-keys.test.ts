// ============================================================================
//  Prototype-named wire keys round-trip (Phase 1931).
//
//  A JSON object member may be named anything, `__proto__`, `constructor` and
//  `hasOwnProperty` included. This decoder used to build every wire-keyed record
//  on a `{}` literal, so a `__proto__` member hit the prototype SETTER and
//  vanished — decode→encode lost it where the reference host, whose records are
//  `Map`s, keeps it — and every decoded record inherited `Object`'s members. The
//  records are now null-prototype, so the three keys are ordinary data.
//
//  Each document below is written in CANONICAL form (members in ordinal order,
//  the encoder's own output shape), so `encode(decode(doc)) === doc` is the
//  byte-identity the reference host's `Map` gives on the same bytes.
//
//  Host-local by necessity, not by choice: the shared corpus generator emits
//  from the reference host's typed values, and a fixture only proves this host
//  if its producer can author the key. The decoder fuzz's key vocabulary already
//  carries `__proto__`, but it asserts only a fixed point, and a key dropped on
//  EVERY pass is a fixed point — so the assertion that the key SURVIVES lives
//  here, on the four payload positions that admit arbitrary member names.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeNode, decodeOp, encodeNode, encodeOp } from '../src/index.js';
import { collectStateSeeds, withStateSeeds } from '../src/seeds.js';

const roundTripNode = (doc: string): string => {
  const d = decodeNode(doc);
  if (!d.ok) throw new Error(`decode failed: ${JSON.stringify(d.error)}`);
  return encodeNode(d.value);
};

const roundTripOp = (doc: string): string => {
  const d = decodeOp(doc);
  if (!d.ok) throw new Error(`decode failed: ${JSON.stringify(d.error)}`);
  return encodeOp(d.value);
};

/** The three names, nested so a key under a key is covered too. */
const HOSTILE = '{"__proto__":{"polluted":true},"constructor":"c","hasOwnProperty":"h"}';

describe('Phase 1931 — prototype-named keys survive decode→encode byte-identically', () => {
  it('in Custom props', () => {
    const doc = `{"id":"c","kind":{"$type":"Custom","componentId":"card","moduleId":"m","props":${HOSTILE}}}`;
    expect(roundTripNode(doc)).toBe(doc);
  });

  it('in action payloads (Notify, SetState, AiTool)', () => {
    const doc =
      `{"id":"b","kind":{"$type":"Button","label":"Go","onClick":{"$type":"Chain","ops":[` +
      `{"$type":"Notify","channel":"ch","payload":${HOSTILE}},` +
      `{"$type":"SetState","key":"k","value":${HOSTILE}},` +
      `{"$type":"AiTool","args":${HOSTILE},"toolName":"t"}]},"variant":"Primary"}}`;
    expect(roundTripNode(doc)).toBe(doc);
  });

  it('as I18n argument names', () => {
    const doc =
      '{"id":"t","kind":{"$type":"Markdown","text":{"$type":"I18n","args":' +
      '{"__proto__":"p","constructor":"c","hasOwnProperty":"h"},"key":"greeting"}}}';
    expect(roundTripNode(doc)).toBe(doc);
  });

  it('in a wire-form UpdateProp value', () => {
    const doc = `{"$type":"UpdateProp","path":"Props","target":"c","value":${HOSTILE}}`;
    expect(roundTripOp(doc)).toBe(doc);
  });

  it('a decoded record inherits nothing — Object.prototype stays untouched', () => {
    const doc = `{"id":"c","kind":{"$type":"Custom","componentId":"card","moduleId":"m","props":${HOSTILE}}}`;
    const d = decodeNode(doc);
    if (!d.ok) throw new Error(JSON.stringify(d.error));
    const props = (d.value.kind as unknown as { readonly props: Record<string, unknown> }).props;
    expect(Object.getPrototypeOf(props)).toBeNull();
    expect(Object.keys(props)).toEqual(['__proto__', 'constructor', 'hasOwnProperty']);
    expect(props['__proto__']).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('Phase 1931 — a document may seed any key', () => {
  const metric = (key: string): string =>
    `{"id":"m","kind":{"$type":"Metric","label":"L","value":{"$type":"State","defaultValue":7,"key":"${key}"}}}`;

  it.each(['__proto__', 'constructor', 'hasOwnProperty'])('seeds `%s`', (key) => {
    const d = decodeNode(metric(key));
    if (!d.ok) throw new Error(JSON.stringify(d.error));
    const seeds = collectStateSeeds(d.value);
    expect(Object.hasOwn(seeds, key)).toBe(true);
    expect(seeds[key]).toBe(7);
    const host: { readonly state?: Readonly<Record<string, unknown>> } = {};
    const state = withStateSeeds(d.value, host).state ?? {};
    expect(Object.hasOwn(state, key)).toBe(true);
    expect(state[key]).toBe(7);
  });
});
