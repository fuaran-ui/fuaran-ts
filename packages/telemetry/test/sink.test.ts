// ============================================================================
//  @fuaran-ui/telemetry — the sink contract, executable.
//
//  The package's promises are contractual, not incidental: a sink MUST NOT
//  throw and MUST NOT gate the operation being recorded (telemetry is evidence
//  that policy was enforced, never part of enforcing it), and `recordDeny` is a
//  bound property precisely so a host can hand it to a caller detached from its
//  sink. Both are the kind of guarantee that silently regresses under an
//  innocuous refactor — an arrow property rewritten as a class method still
//  type-checks and still passes every call site that writes `sink.recordDeny(x)`.
//  These tests pin the behaviour the doc comments describe.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  InMemoryTelemetrySink,
  noOpTelemetrySink,
  type DenyTelemetry,
  type FuaranTelemetrySink,
} from '../src/index.js';

const deny = (toolName: string, overrides: Partial<DenyTelemetry> = {}): DenyTelemetry => ({
  toolName,
  reason: `denied: ${toolName}`,
  userId: 'user-1',
  timestamp: '2026-07-29T12:00:00.000Z',
  ...overrides,
});

describe('InMemoryTelemetrySink', () => {
  it('retains every record it receives, in arrival order', () => {
    const sink = new InMemoryTelemetrySink();

    sink.recordDeny(deny('addNode'));
    sink.recordDeny(deny('removeNode'));
    sink.recordDeny(deny('setProp'));

    expect(sink.denyRecords.map((r) => r.toolName)).toEqual(['addNode', 'removeNode', 'setProp']);
  });

  it('starts empty and empties again on clear()', () => {
    const sink = new InMemoryTelemetrySink();
    expect(sink.denyRecords).toEqual([]);

    sink.recordDeny(deny('addNode'));
    expect(sink.denyRecords).toHaveLength(1);

    sink.clear();
    expect(sink.denyRecords).toEqual([]);
  });

  it('records the payload verbatim — no fabricated optional fields', () => {
    const sink = new InMemoryTelemetrySink();
    const record = deny('addNode');

    sink.recordDeny(record);

    const [stored] = sink.denyRecords;
    expect(stored).toEqual(record);
    // `activeModule` / `activePage` / `promptId` are omitted rather than
    // fabricated: an operator-initiated call belongs to no module or prompt.
    expect('activeModule' in stored!).toBe(false);
    expect('activePage' in stored!).toBe(false);
    expect('promptId' in stored!).toBe(false);
  });

  it('carries the optional attribution fields through when the host supplies them', () => {
    const sink = new InMemoryTelemetrySink();

    sink.recordDeny(
      deny('addNode', { activeModule: 'reports', activePage: 'summary', promptId: 'p-7' }),
    );

    expect(sink.denyRecords[0]).toMatchObject({
      activeModule: 'reports',
      activePage: 'summary',
      promptId: 'p-7',
    });
  });

  it('exposes recordDeny as a bound reference a host can detach', () => {
    const sink = new InMemoryTelemetrySink();
    // The seam every host uses: hand the sink's record function to a caller
    // that knows nothing about the sink. A plain method would lose `this`.
    const record: FuaranTelemetrySink['recordDeny'] = sink.recordDeny;

    record(deny('addNode'));

    expect(sink.denyRecords).toHaveLength(1);
  });

  it("keeps sinks independent — one instance never sees a sibling's records", () => {
    const a = new InMemoryTelemetrySink();
    const b = new InMemoryTelemetrySink();

    a.recordDeny(deny('addNode'));

    expect(a.denyRecords).toHaveLength(1);
    expect(b.denyRecords).toEqual([]);
  });
});

describe('noOpTelemetrySink', () => {
  it('accepts a record without throwing and returns nothing', () => {
    expect(noOpTelemetrySink.recordDeny(deny('addNode'))).toBeUndefined();
  });

  it('is usable wherever the sink interface is required', () => {
    const useSink = (sink: FuaranTelemetrySink): void => sink.recordDeny(deny('addNode'));
    expect(() => useSink(noOpTelemetrySink)).not.toThrow();
  });
});
