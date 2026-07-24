// ============================================================================
//  The kit's honesty contract: partial hosts get a partial certification
//  (skipped legs, not failures); broken hosts get per-fixture findings and a
//  non-conformant verdict; a throwing codec is a finding, not a runner crash.
// ============================================================================

import { decodeNode, decodeOp, encodeNode, encodeOp } from '@fuaran-ui/ops';
import type { Node } from '@fuaran-ui/schema';
import type { TreeOp } from '@fuaran-ui/ops';
import { describe, expect, it } from 'vitest';

import type { ConformanceAdapter } from '../src/adapter.js';
import { runConformance } from '../src/run.js';

const implementation = { name: 'test-host' };
const leg = (report: ReturnType<typeof runConformance>, id: string) =>
  report.legs.find((l) => l.leg === id)!;

describe('partial hosts', () => {
  it('a node-decode-only host certifies the node decode + reject legs and is partially-conformant', () => {
    const adapter: ConformanceAdapter = { decodeNode: (json) => decodeNode(json) };
    const report = runConformance(adapter, { implementation });

    expect(leg(report, 'node-decode').status).toBe('pass');
    expect(leg(report, 'node-reject').status).toBe('pass');
    expect(leg(report, 'node-byte-identity').status).toBe('skipped');
    expect(leg(report, 'op-decode').status).toBe('skipped');
    expect(leg(report, 'schema-validation').status).toBe('skipped');
    expect(report.verdict).toBe('partially-conformant');
  });

  it('skipped legs name the missing hooks', () => {
    const report = runConformance({}, { implementation });
    expect(leg(report, 'node-decode').skipReason).toContain('decodeNode');
    expect(leg(report, 'op-byte-identity').skipReason).toContain('encodeOp');
    expect(report.verdict).toBe('partially-conformant');
  });

  it('the reserved apply leg is always optional and skipped under corpus v1', () => {
    const report = runConformance({}, { implementation });
    expect(leg(report, 'apply').mandatory).toBe(false);
    expect(leg(report, 'apply').status).toBe('skipped');
  });
});

describe('non-conformant hosts', () => {
  it('an encoder that mangles output fails byte-identity with per-fixture findings', () => {
    const adapter: ConformanceAdapter = {
      decodeNode: (json) => decodeNode(json),
      encodeNode: (value) => encodeNode(value as Node<unknown>).replace(/"id":/, '"Id":'),
      decodeOp: (json) => decodeOp(json),
      encodeOp: (value) => encodeOp(value as TreeOp<unknown>),
    };
    const report = runConformance(adapter, { implementation });

    const byte = leg(report, 'node-byte-identity');
    expect(byte.status).toBe('fail');
    expect(byte.failures.length).toBeGreaterThan(0);
    expect(byte.failures[0]!.fixtureId).toBeTruthy();
    expect(byte.failures[0]!.detail).toContain('byte offset');
    // The intact op side still passes — failure is per-leg, not blanket.
    expect(leg(report, 'op-byte-identity').status).toBe('pass');
    expect(report.verdict).toBe('non-conformant');
  });

  it('a decoder that accepts malformed input fails the reject leg', () => {
    const adapter: ConformanceAdapter = {
      decodeNode: () => ({ ok: true, value: {} }),
    };
    const report = runConformance(adapter, { implementation });
    expect(leg(report, 'node-reject').status).toBe('fail');
    expect(report.verdict).toBe('non-conformant');
  });

  it('a throwing codec is recorded as a finding, not a runner crash', () => {
    const adapter: ConformanceAdapter = {
      decodeNode: () => {
        throw new Error('boom');
      },
    };
    const report = runConformance(adapter, { implementation });
    expect(leg(report, 'node-decode').status).toBe('fail');
    expect(leg(report, 'node-decode').failures[0]!.summary).toContain('THREW');
    expect(report.verdict).toBe('non-conformant');
  });

  it('a decoder surfacing the wrong error code fails with both codes named', () => {
    const adapter: ConformanceAdapter = {
      decodeNode: () => ({
        ok: false,
        error: { code: 'SOMETHING_ELSE', path: '$', message: 'nope' },
      }),
    };
    const report = runConformance(adapter, { implementation });
    const reject = leg(report, 'node-reject');
    expect(reject.status).toBe('fail');
    expect(reject.failures[0]!.detail).toContain('SOMETHING_ELSE');
  });
});
