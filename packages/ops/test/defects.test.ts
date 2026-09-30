// ============================================================================
//  Phase 1935 — a node refusal reports every independent defect
//  (WIRE_FORMAT.md §29).
//
//  The corpus certifies the lists (corpus.test.ts); this file pins the two
//  things a corpus of documents cannot state directly: the canonical ORDER, on
//  paths chosen to separate it from the orders a host might reach for instead
//  (string order, document order, decode order), and the entry point's
//  contract with the single-error form. It mirrors the reference host's
//  `DefectListTests.fs`.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  decodeNode,
  decodeNodeWithDefects,
  decodeOp,
  orderDefects,
  type DecodeError,
  type DecodeErrorCode,
} from '../src/index.js';

const order = (pairs: readonly (readonly [string, string])[]): [string, string][] =>
  orderDefects(
    pairs.map(([code, path]) => ({ code: code as DecodeErrorCode, path, message: '' })),
  ).map((d) => [d.code, d.path]);

const listOf = (json: string): [string, string][] | undefined => {
  const r = decodeNodeWithDefects(json);
  return r.ok ? undefined : r.error.map((d) => [d.code, d.path]);
};

const md = (id: string, text: string): string =>
  `{"id":"${id}","kind":{"$type":"Markdown","text":${text}}}`;

describe('§29.3 — the canonical defect order', () => {
  it('sorts an index numerically, not as text', () => {
    expect(
      order([
        ['WRONG_TYPE', '$.a[10]'],
        ['WRONG_TYPE', '$.a[9]'],
        ['WRONG_TYPE', '$.a[2]'],
      ]),
    ).toEqual([
      ['WRONG_TYPE', '$.a[2]'],
      ['WRONG_TYPE', '$.a[9]'],
      ['WRONG_TYPE', '$.a[10]'],
    ]);
  });

  it('sorts a member name Ordinally — `$type` first, upper case before lower', () => {
    expect(
      order([
        ['WRONG_TYPE', '$.k.role'],
        ['WRONG_TYPE', '$.k.Z'],
        ['WRONG_TYPE', '$.k.$type'],
      ]),
    ).toEqual([
      ['WRONG_TYPE', '$.k.$type'],
      ['WRONG_TYPE', '$.k.Z'],
      ['WRONG_TYPE', '$.k.role'],
    ]);
  });

  it('compares one segment at a time, so a name is never compared with a sibling tail', () => {
    expect(
      order([
        ['WRONG_TYPE', '$.kind.layout.wrap'],
        ['WRONG_TYPE', '$.kind.layoutX'],
      ]),
    ).toEqual([
      ['WRONG_TYPE', '$.kind.layout.wrap'],
      ['WRONG_TYPE', '$.kind.layoutX'],
    ]);
  });

  it('puts an ancestor before its descendants, and breaks a tie on path by code', () => {
    expect(
      order([
        ['WRONG_TYPE', '$.a.b'],
        ['WRONG_TYPE', '$.a'],
        ['MISSING_FIELD', '$.a.b'],
      ]),
    ).toEqual([
      ['WRONG_TYPE', '$.a'],
      ['MISSING_FIELD', '$.a.b'],
      ['WRONG_TYPE', '$.a.b'],
    ]);
  });

  it('keeps one entry per (code, path) — the last constructed', () => {
    const first: DecodeError = { code: 'WRONG_TYPE', path: '$.x', message: 'first' };
    const second: DecodeError = { code: 'WRONG_TYPE', path: '$.x', message: 'second' };
    expect(orderDefects([first, second])).toEqual([second]);
  });
});

describe('decodeNodeWithDefects', () => {
  it('decodes a clean document exactly as decodeNode does', () => {
    const json = md('a', '"hi"');
    const listed = decodeNodeWithDefects(json);
    const single = decodeNode(json);
    expect(listed.ok && single.ok).toBe(true);
    if (listed.ok && single.ok) expect(listed.value).toEqual(single.value);
  });

  it('decodes every sibling in an array: each defect, in index order', () => {
    const json = `{"id":"r","kind":{"$type":"Box","role":"Group","layout":{"$type":"Auto"},"children":[${md('a', '5')},${md('b', '"ok"')},${md('c', 'true')}]}}`;
    expect(listOf(json)).toEqual([
      ['WRONG_TYPE', '$.kind.children[0].kind.text'],
      ['WRONG_TYPE', '$.kind.children[2].kind.text'],
    ]);
  });

  it('makes INVALID_JSON a one-entry list', () => {
    expect(listOf('{"id":')).toEqual([['INVALID_JSON', '$']]);
  });

  it("returns the list's head from the single-error entry point", () => {
    const json = '{"id":"","kind":{"$type":"Box","children":[]}}';
    const listed = decodeNodeWithDefects(json);
    const single = decodeNode(json);
    expect(listed.ok || single.ok).toBe(false);
    if (!listed.ok && !single.ok) expect(single.error).toEqual(listed.error[0]);
  });

  it('leaves nothing behind from an abandoned attempt: a swallowed default is not a defect', () => {
    // A Filter binding whose `defaultValue` its slot cannot parse is dropped, not
    // refused, so the attempt's error must not surface in the list of the refusal
    // the OTHER member causes.
    const json =
      '{"id":"s","kind":{"$type":"Metric","label":"L","value":{"$type":"Filter","name":"f","defaultValue":{"x":1}},"tone":"Nope"}}';
    expect(listOf(json)).toEqual([['UNKNOWN_DU_CASE', '$.kind.tone']]);
  });

  it('leaves the op decoder single-error and fail-fast (§29.6)', () => {
    // Nothing here is collected: the op decoder is outside §29.
    const r = decodeOp('{"$type":"RemoveNode"}');
    expect(r.ok).toBe(false);
  });
});
