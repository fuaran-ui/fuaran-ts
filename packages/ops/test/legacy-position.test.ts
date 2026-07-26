// ============================================================================
//  Migration window: a legacy `position` / `newPosition` is ACCEPTED AND
//  IGNORED (phase 683, mirroring 681 on the F# side).
//
//  0.4.0 removed the ordinal from InsertChild and MoveNode: both append, and
//  ReorderChildren states order by naming child ids. The hosts adopt
//  independently and stored emissions outlive a release, so a v1 op must still
//  parse and still apply — as an append.
//
//  The tolerance is a migration mechanism, not a second dialect offered to an
//  author: nothing that teaches the wire mentions the field, and re-encoding
//  never writes it back. Phase 687 closes the window and makes it a decode
//  error, at which point these expectations invert.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeOp, encodeOp } from '../src/index.js';

describe('legacy positional ops (683 migration window)', () => {
  it('InsertChild with a legacy `position` decodes, and the field is dropped', () => {
    const legacy =
      '{"$type":"InsertChild","child":{"id":"n","kind":{"$type":"Markdown","text":"x"}},"parentId":"p","position":3}';
    const r = decodeOp(legacy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('InsertChild');
    // Re-encoding is the real assertion: one wire dialect, not two.
    const reencoded = encodeOp(r.value);
    expect(reencoded).toContain('"parentId":"p"');
    expect(reencoded).not.toContain('position');
  });

  it('MoveNode with a legacy `newPosition` decodes, and the field is dropped', () => {
    const legacy = '{"$type":"MoveNode","newParentId":"q","newPosition":2,"target":"n"}';
    const r = decodeOp(legacy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(encodeOp(r.value)).not.toContain('Position');
  });

  it('the positionless form is what the encoder emits', () => {
    const current = '{"$type":"MoveNode","newParentId":"q","target":"n"}';
    const r = decodeOp(current);
    expect(r.ok).toBe(true);
    // decode -> re-encode is the identity on the canonical form.
    if (r.ok) expect(encodeOp(r.value)).toBe(current);
  });
});
