// ============================================================================
//  Phase 687 — the CLOSE of the migration window Phase 681 opened.
//
//  0.4.0 removed the ordinal from InsertChild and MoveNode: both append, and
//  ReorderChildren states order by naming child ids. Through the window every
//  decoder ACCEPTED AND IGNORED a legacy `position` / `newPosition` so the
//  hosts could adopt independently. Every host is now positionless and no
//  emitter produces the field, so the tolerance is withdrawn: it is a decode
//  error, named at its own path.
//
//  These are the going-red half of that change. The window's own tests asserted
//  the field was silently dropped; keeping them alongside would have meant
//  asserting both readings at once, so this file REPLACES `legacy-position.
//  test.ts` rather than sitting beside it — the accept case is not something
//  that still holds.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeOp, encodeOp } from '../src/index.js';

describe('retired positional ops (687 — the window is closed)', () => {
  it('InsertChild with a retired `position` is refused by name', () => {
    const legacy =
      '{"$type":"InsertChild","child":{"id":"n","kind":{"$type":"Markdown","text":"x"}},"parentId":"p","position":3}';
    const r = decodeOp(legacy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('WRONG_TYPE');
    // The error names the retired field, not some downstream defect.
    expect(r.error.path).toBe('$.position');
    expect(r.error.message).toContain('ReorderChildren');
  });

  it('MoveNode with a retired `newPosition` is refused by name', () => {
    const legacy = '{"$type":"MoveNode","newParentId":"q","newPosition":2,"target":"n"}';
    const r = decodeOp(legacy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('WRONG_TYPE');
    expect(r.error.path).toBe('$.newPosition');
  });

  it('the retired field is named ahead of any other defect in the same op', () => {
    // The ordering is fixed across all five hosts: an author who also omitted a
    // required field must still learn the ordinal is gone, rather than fixing
    // the other defect and meeting this one on the next run.
    const both = '{"$type":"InsertChild","position":0}';
    const r = decodeOp(both);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.path).toBe('$.position');
  });

  it('the positionless form is what the encoder emits', () => {
    const current = '{"$type":"MoveNode","newParentId":"q","target":"n"}';
    const r = decodeOp(current);
    expect(r.ok).toBe(true);
    // decode -> re-encode is the identity on the canonical form.
    if (r.ok) expect(encodeOp(r.value)).toBe(current);
  });
});
