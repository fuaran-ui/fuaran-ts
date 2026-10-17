// ============================================================================
//  Phase 2072 — the decoder holds no module-level state: a decode started from
//  inside another leaves the outer one's §21 counters exactly where they were.
//
//  There is no public hook that runs a callback mid-decode, so the hook is the
//  document itself: `decodeNodeFromAst` takes a `JsonAst`, and an AST whose
//  member map answers a `get` by running a second decode is a legitimate input.
//  Before this phase the counters were module-level `let`s that every entry
//  point reset, so the inner decode zeroed the outer walk's depth and the
//  outer went on to accept a tree past MAX_NODE_DEPTH.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { MAX_NODE_DEPTH } from '@fuaran-ui/schema';

import { decodeNode, decodeNodeFromAst, parse, type JsonAst } from '../src/index.js';

const nested = (depth: number): string =>
  depth === 1
    ? '{"id":"n1","kind":{"$type":"Markdown","text":"leaf"}}'
    : `{"id":"n${depth}","kind":{"$type":"Box","role":"Group","layout":{"$type":"Flex","direction":"Vertical","wrap":false},"children":[${nested(depth - 1)}]}}`;

/** The same tree, with one member map that runs `inner` the first time its `kind` is read. */
const withHook = (ast: JsonAst, inner: () => void): JsonAst => {
  if (ast.kind !== 'JObject') return ast;
  let fired = false;
  const fields = new Map(ast.fields);
  const hooked: Map<string, JsonAst> = Object.assign(fields, {
    get(key: string): JsonAst | undefined {
      if (key === 'kind' && !fired) {
        fired = true;
        inner();
      }
      return Map.prototype.get.call(fields, key);
    },
  });
  return { kind: 'JObject', fields: hooked };
};

describe('Phase 2072 — a decode is reentrant', () => {
  it('refuses a tree one past MAX_NODE_DEPTH exactly as it does with no decode interleaved', () => {
    const parsed = parse(nested(MAX_NODE_DEPTH + 1));
    if (!parsed.ok) throw new Error('fixture does not parse');
    const plain = decodeNodeFromAst(parsed.value);
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.error.code).toBe('LIMIT_EXCEEDED');

    let innerRan = 0;
    const hooked = withHook(parsed.value, () => {
      innerRan += 1;
      const inner = decodeNode(nested(3));
      expect(inner.ok).toBe(true);
    });
    const outer = decodeNodeFromAst(hooked);
    expect(innerRan).toBe(1);
    expect(outer.ok).toBe(false);
    if (!outer.ok) expect(outer.error).toEqual(plain.ok ? undefined : plain.error);
  });

  it('counts an inner decode against its own node budget, never the outer one', () => {
    const parsed = parse(nested(2));
    if (!parsed.ok) throw new Error('fixture does not parse');
    const hooked = withHook(parsed.value, () => {
      const inner = decodeNode(nested(MAX_NODE_DEPTH + 1));
      expect(inner.ok).toBe(false);
      if (!inner.ok) expect(inner.error.code).toBe('LIMIT_EXCEEDED');
    });
    expect(decodeNodeFromAst(hooked).ok).toBe(true);
  });
});
