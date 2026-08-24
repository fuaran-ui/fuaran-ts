// ============================================================================
//  WIRE_FORMAT.md §21 resource limits — the shape half of the totality claim.
//
//  §6 promises every wire-shape violation surfaces a structured, recoverable
//  error and never a throw. That promise held on SEMANTICS and was false on
//  SHAPE: `parseValue` / `parseObjectValue` / `parseArrayValue` were mutually
//  recursive with no counter, so a payload of `[[[[[…` — two bytes per level —
//  drove the engine off its stack and threw a `RangeError`, which is not part
//  of the declared `Result` contract.
//
//  Both halves are asserted here, and the second is the one that is easy to
//  leave out: a limit that refuses everything would pass a refusal-only suite.
//  So every limit is tested at the boundary from BOTH sides — the largest
//  conformant document MUST decode (§21.2 rule 1: refusing it is
//  non-conformance, not conservatism) and the smallest over-limit one MUST be
//  refused (rule 2).
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  MAX_ARRAY_LENGTH,
  MAX_JSON_DEPTH,
  MAX_NODE_DEPTH,
  MAX_STRING_LENGTH,
} from '@fuaran-ui/schema';

import { decodeNode, decodeOp } from '../src/decode.js';
import { parse } from '../src/parse.js';

/** A chain of `n` nested Box nodes, innermost holding an empty Box. */
const nestedNodes = (n: number): string => {
  const open =
    '{"id":"n","kind":{"$type":"Box","role":"Group",' +
    '"layout":{"$type":"Flex","direction":"Vertical","wrap":false},"children":[';
  const leaf =
    '{"id":"leaf","kind":{"$type":"Box","role":"Group",' +
    '"layout":{"$type":"Flex","direction":"Vertical","wrap":false},"children":[]}}';
  return open.repeat(n - 1) + leaf + ']}}'.repeat(n - 1);
};

/** A chain of `n` nested `Batch` ops, innermost a `RemoveNode`. */
const nestedBatch = (n: number): string =>
  '{"$type":"Batch","ops":['.repeat(n - 1) +
  '{"$type":"RemoveNode","target":"x"}' +
  ']}'.repeat(n - 1);

describe('§21 resource limits — the node-depth bound', () => {
  it('accepts a tree at exactly MAX_NODE_DEPTH (rule 1 — refusing it is non-conformance)', () => {
    const r = decodeNode(nestedNodes(MAX_NODE_DEPTH));
    expect(r.ok).toBe(true);
  });

  it('refuses a tree one level past MAX_NODE_DEPTH with LIMIT_EXCEEDED', () => {
    const r = decodeNode(nestedNodes(MAX_NODE_DEPTH + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('LIMIT_EXCEEDED');
      // Rule 2 — a limit breach is not a syntax error. Naming the wrong one
      // sends the author to repair the wrong thing.
      expect(r.error.code).not.toBe('INVALID_JSON');
      expect(r.error.message).toContain(String(MAX_NODE_DEPTH));
    }
  });

  it('refuses a deep tree by RETURNING, never by throwing', () => {
    // The original defect in one line: this input used to escape the decoder
    // as a RangeError rather than a Result.
    expect(() => decodeNode(nestedNodes(5000))).not.toThrow();
    const r = decodeNode(nestedNodes(5000));
    expect(r.ok).toBe(false);
  });
});

describe('§21 resource limits — the op-decoder axis', () => {
  // §21.5's note for implementers: bounding the node decoder is NOT sufficient,
  // because `Batch` makes the op decoder self-recursive on a separate axis and
  // the syntactic bound only LOOKS like cover for it.
  it('accepts nested Batch at exactly MAX_NODE_DEPTH', () => {
    const r = decodeOp(nestedBatch(MAX_NODE_DEPTH));
    expect(r.ok).toBe(true);
  });

  it('refuses nested Batch one level past MAX_NODE_DEPTH with LIMIT_EXCEEDED', () => {
    const r = decodeOp(nestedBatch(MAX_NODE_DEPTH + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('refuses deeply nested Batch by RETURNING, never by throwing', () => {
    expect(() => decodeOp(nestedBatch(5000))).not.toThrow();
    const r = decodeOp(nestedBatch(5000));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('counts the op axis SEPARATELY from the node axis', () => {
    // A Batch chain within the op bound, whose payload node is also within the
    // node bound, must decode — proving the two counters are not sharing one
    // budget. If they were, this would breach at the sum.
    const inner = `{"$type":"ReplaceRoot","node":${nestedNodes(MAX_NODE_DEPTH)}}`;
    const doc =
      '{"$type":"Batch","ops":['.repeat(MAX_NODE_DEPTH - 1) +
      inner +
      ']}'.repeat(MAX_NODE_DEPTH - 1);
    const r = decodeOp(doc);
    expect(r.ok).toBe(true);
  });
});

describe('§21 resource limits — the syntactic bound', () => {
  it('accepts bare nesting at exactly MAX_JSON_DEPTH', () => {
    const r = parse('['.repeat(MAX_JSON_DEPTH) + ']'.repeat(MAX_JSON_DEPTH));
    expect(r.ok).toBe(true);
  });

  it('refuses bare nesting one level past MAX_JSON_DEPTH, flagged as a limit', () => {
    const n = MAX_JSON_DEPTH + 1;
    const r = parse('['.repeat(n) + ']'.repeat(n));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.limit).toBe(true);
  });

  it('surfaces a syntactic-depth breach as LIMIT_EXCEEDED through decodeNode', () => {
    const n = MAX_JSON_DEPTH + 1;
    const r = decodeNode('['.repeat(n) + ']'.repeat(n));
    expect(r.ok).toBe(false);
    // The whole point of the `limit` flag: without it this reads INVALID_JSON,
    // which rule 2 forbids for a well-formed-but-too-deep document.
    if (!r.ok) expect(r.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('still calls genuinely malformed input INVALID_JSON', () => {
    // Non-vacuity for the flag: it must distinguish, not relabel everything.
    const r = decodeNode('}{ not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_JSON');
  });
});

describe('§21 resource limits — the linear bounds', () => {
  it('accepts a string at exactly MAX_STRING_LENGTH', () => {
    const r = parse(`"${'a'.repeat(MAX_STRING_LENGTH)}"`);
    expect(r.ok).toBe(true);
  });

  it('refuses a string past MAX_STRING_LENGTH, flagged as a limit', () => {
    const r = parse(`"${'a'.repeat(MAX_STRING_LENGTH + 2)}"`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.limit).toBe(true);
  });

  it('accepts an array at exactly MAX_ARRAY_LENGTH', () => {
    const r = parse(`[${'1,'.repeat(MAX_ARRAY_LENGTH - 1)}1]`);
    expect(r.ok).toBe(true);
  });

  it('refuses an array past MAX_ARRAY_LENGTH, flagged as a limit', () => {
    const r = parse(`[${'1,'.repeat(MAX_ARRAY_LENGTH + 1)}1]`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.limit).toBe(true);
  });
});

describe('§21 resource limits — the counters do not leak between calls', () => {
  // The counters are module-level mutable state (see the note in decode.ts), so
  // the one way that could go wrong is a walk returning early on an error and
  // leaving a counter poisoned for the next caller. Both entry points reset;
  // this is the test that says so.
  it('a refused deep decode does not poison the next decode', () => {
    const bad = decodeNode(nestedNodes(MAX_NODE_DEPTH + 1));
    expect(bad.ok).toBe(false);
    const good = decodeNode(nestedNodes(MAX_NODE_DEPTH));
    expect(good.ok).toBe(true);
  });

  it('a decode that failed on SHAPE does not poison the next decode', () => {
    const bad = decodeNode('{"id":"x","kind":{"$type":"NoSuchKind"}}');
    expect(bad.ok).toBe(false);
    const good = decodeNode(nestedNodes(MAX_NODE_DEPTH));
    expect(good.ok).toBe(true);
  });

  it('a refused op decode does not poison the next op decode', () => {
    const bad = decodeOp(nestedBatch(MAX_NODE_DEPTH + 1));
    expect(bad.ok).toBe(false);
    const good = decodeOp(nestedBatch(MAX_NODE_DEPTH));
    expect(good.ok).toBe(true);
  });
});
