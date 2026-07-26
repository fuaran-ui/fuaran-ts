import { describe, expect, it } from 'vitest';

import { encodeNode } from '@fuaran-ui/ops';
import { fuaran } from '@fuaran-ui/ui';
import { InMemoryTelemetrySink } from '@fuaran-ui/telemetry';
import type { Node } from '@fuaran-ui/schema';

import {
  APPLY_TOOL_NAME,
  buildDebugGlobal,
  denyTelemetry,
  type DebugSinks,
} from '../src/debugGlobal.js';
import type { BindingSources } from '../src/index.js';

// Phase 193 — durable-sink emission for the in-page apply path.
//
// `window.__fuaran.apply` is a third dispatch path; for the op stream to stay
// the source of truth, a permitted op must journal and a denial must record.
// These pin both legs plus the shapes, which are parity-locked with the F#
// mirror in `Fuaran.UI.Renderer.DebugGlobal`.

const tree: Node<unknown> = fuaran.stack<unknown>({
  id: 'root',
  children: [
    fuaran.heading<unknown>({ id: 'title', text: 'Hello', level: 2 }),
    fuaran.metric<unknown>({ id: 'rev', label: 'Revenue', value: 42 }),
  ],
});

const sources: BindingSources = {};

/** A canonical op that removes a real node — decodes and applies cleanly. */
const validOpJson = JSON.stringify({ $type: 'RemoveNode', target: 'rev' });

function build(sinks: DebugSinks, canDispatch = true) {
  const applied: Array<Node<unknown>> = [];
  const warnings: string[] = [];
  const global = buildDebugGlobal(tree, sources, {
    runtime: { canDispatch: () => canDispatch, warn: (m: string) => warnings.push(m) },
    applyHandler: (t) => applied.push(t),
    sinks,
  });
  return { global, applied, warnings };
}

describe('deny → telemetry', () => {
  it('records a deny under the stable tool name when the gate refuses', () => {
    const telemetrySink = new InMemoryTelemetrySink();
    const { global, applied } = build({ telemetrySink, userId: 'operator-1' }, false);

    const envelope = global.apply(validOpJson);

    expect(envelope.status).toBe('denied');
    // The handler never ran — the record is evidence the policy was enforced.
    expect(applied).toHaveLength(0);

    expect(telemetrySink.denyRecords).toHaveLength(1);
    const record = telemetrySink.denyRecords[0]!;
    expect(record.toolName).toBe(APPLY_TOOL_NAME);
    expect(record.userId).toBe('operator-1');
    expect(record.reason).toContain('denied by policy gate');
    // The envelope's error and the record's reason are the same event.
    if (!envelope.ok) expect(record.reason).toBe(envelope.error);
  });

  it('defaults the audit subject when the host does not model a user', () => {
    const telemetrySink = new InMemoryTelemetrySink();
    const { global } = build({ telemetrySink }, false);
    global.apply(validOpJson);
    expect(telemetrySink.denyRecords[0]!.userId).toBe('operator');
  });

  it('a throwing sink never changes what the caller sees', () => {
    const exploding = {
      recordDeny: () => {
        throw new Error('sink is down');
      },
    };
    const { global } = build({ telemetrySink: exploding }, false);
    // Fire-and-forget: telemetry is evidence, never part of enforcement.
    expect(() => global.apply(validOpJson)).not.toThrow();
    expect(global.apply(validOpJson).status).toBe('denied');
  });

  it('emits nothing when no sink is wired (the historical behaviour)', () => {
    const { global, warnings } = build({}, false);
    expect(global.apply(validOpJson).status).toBe('denied');
    // The warn channel still fires — only the durable leg is opt-in.
    expect(warnings.some((w) => w.includes('denied by policy gate'))).toBe(true);
  });
});

describe('permitted → op-stream seam', () => {
  it('hands the applied op to the host for journalling', () => {
    const journalled: string[] = [];
    const { global, applied } = build({ onApplied: (opJson) => journalled.push(opJson) });

    expect(global.apply(validOpJson).status).toBe('applied');
    expect(applied).toHaveLength(1);
    // The host receives the op JSON verbatim, so it can decode + journal it
    // hash-chained with its own op-stream sink.
    expect(journalled).toEqual([validOpJson]);
  });

  it('does NOT journal an op that never applied', () => {
    const journalled: string[] = [];
    const sinks = { onApplied: (opJson: string) => journalled.push(opJson) };

    // A decode failure produced no TreeOp…
    const a = build(sinks);
    expect(a.global.apply('not json{{').status).toBe('decodeFailed');

    // …and a rejected op changed no tree. Journalling either would record an
    // op that never happened.
    const b = build(sinks);
    const missing = JSON.stringify({ $type: 'RemoveNode', target: 'no-such-node' });
    expect(b.global.apply(missing).status).toBe('rejected');

    expect(journalled).toEqual([]);
  });

  it('a throwing journal callback never changes what the caller sees', () => {
    const { global } = build({
      onApplied: () => {
        throw new Error('sink is down');
      },
    });
    expect(global.apply(validOpJson).status).toBe('applied');
  });

  it('journals nothing when no seam is wired (the historical behaviour)', () => {
    const { global, applied } = build({});
    expect(global.apply(validOpJson).status).toBe('applied');
    expect(applied).toHaveLength(1);
  });
});

describe('cross-tier parity of the deny record', () => {
  it('mirrors the F# DenyTelemetry field set', () => {
    const record = denyTelemetry('operator', '2026-07-26T12:00:00.000Z', 'denied');

    // camelCase mirrors of the F# PascalCase fields.
    expect(Object.keys(record).sort()).toEqual(
      ['reason', 'timestamp', 'toolName', 'userId'].sort(),
    );
    expect(record.toolName).toBe('__fuaran.apply');
    expect(record.timestamp).toBe('2026-07-26T12:00:00.000Z');

    // Operator-initiated: absent rather than fabricated, matching the F# `None`s.
    expect(record.activeModule).toBeUndefined();
    expect(record.activePage).toBeUndefined();
    expect(record.promptId).toBeUndefined();
  });

  it('the tool name is identical to the F# literal', () => {
    // F# `DebugGlobal.ApplyToolName` — a drift here breaks the drift detector's
    // ability to correlate console denials across hosts.
    expect(APPLY_TOOL_NAME).toBe('__fuaran.apply');
  });

  it('encodes a real tree so the fixture is canonical', () => {
    expect(() => encodeNode(tree)).not.toThrow();
  });
});
