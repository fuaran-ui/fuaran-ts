// ============================================================================
//  Phase 101 — generative / property-based wire-format fuzzer (TS side).
//
//  Complements the fixed-corpus parity suite (corpus.test.ts) by asserting the
//  canonical byte-stable round-trip over the GENERATED tree-space the curated
//  fixtures can't reach:
//
//      encode(decode(encode x)) === encode x        (WIRE_FORMAT.md §1)
//
//  Two fast-check properties (1000 runs each, with fast-check's built-in
//  shrinking to a minimal failing tree), plus a coverage assertion that every
//  DU arm is actually generated — mirroring the F# FsCheck suite.
// ============================================================================

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { decodeNode, decodeOp, encodeNode, encodeOp } from '../src/index.js';
import { arbNode, arbOp } from './arbitraries.js';

describe('generative idempotence (Phase 101)', () => {
  it('Node: encode→decode→encode is byte-stable over 1000 generated trees', () => {
    fc.assert(
      fc.property(arbNode, (n) => {
        const wire = encodeNode(n);
        const decoded = decodeNode(wire);
        return decoded.ok && encodeNode(decoded.value) === wire;
      }),
      { numRuns: 1000 },
    );
  });

  it('TreeOp: encode→decode→encode is byte-stable over 1000 generated ops', () => {
    fc.assert(
      fc.property(arbOp, (op) => {
        const wire = encodeOp(op);
        const decoded = decodeOp(wire);
        return decoded.ok && encodeOp(decoded.value) === wire;
      }),
      { numRuns: 1000 },
    );
  });
});

// ─── DU-arm coverage ─────────────────────────────────────────────────────────

const requiredNodeTokens: string[] = [
  // NodeKind — the four behavioural categories are flat on the wire and carry
  // no own $type; only the structural primitives have a discriminator.
  'Custom',
  'ErrorBoundary',
  'FragmentDecl',
  'FragmentRef',
  // LayoutKind — Phase 390: the four container near-synonyms
  // (Dashboard/Stack/GridLayout/Card) unified into `Box`, whose nested `layout`
  // carries a Flex / Grid / Auto discriminator.
  'Box',
  'Flex',
  'Grid',
  'Auto',
  'SplitPanel',
  'Tabs',
  'Stepper',
  'SummaryList',
  'Disclosure',
  // DisplayKind
  'Heading',
  'Markdown',
  'Metric',
  'Badge',
  'Sparkline',
  'Callout',
  'Progress',
  'Skeleton',
  'LabelValueRow',
  // InputKind (Filters has no own $type)
  'Form',
  'Button',
  'FileUpload',
  'Select',
  // VisKind — Phase 393: `Table` retired; a static read-only table emits `$type:DataGrid`
  // with a `staticRows` field (covered by the DataGrid token + the table-1 fixture).
  'DataGrid',
  'Chart',
  'Map',
  // FormFieldKind
  'Text',
  'Number',
  'Checkbox',
  'Choice',
  'TextArea',
  'RangedNumber',
  'SegmentedChoice',
  // 0.2.0 filters-unification: chips are FormFieldKind; `Range` is the
  // absorbed dual-thumb control.
  'Range',
  // CellKindErased
  'Numeric',
  'Editable',
  'ButtonGroup',
  'Link',
  'Pill',
  // CellFormat
  'Currency',
  'Percent',
  'SignificantDigits',
  // Binding
  'Static',
  'Query',
  'Filter',
  'Selection',
  'State',
  'Computed',
  'I18n',
  'Local',
  // Action
  'Dispatch',
  'Call',
  'Notify',
  'Navigate',
  'SetState',
  'AiTool',
  'Chain',
  'CommitLocal',
  'WriteToClipboard',
  'ReadFileBody',
].map((c) => `"$type":"${c}"`);

const requiredOpTokens: string[] = [
  'EditNode',
  'UpdateProp',
  'ReplaceBinding',
  'UpdateStyle',
  'UpdateState',
  'InsertChild',
  'RemoveNode',
  'MoveNode',
  'ReorderChildren',
  'Batch',
].map((c) => `"$type":"${c}"`);

describe('generator DU-arm coverage (Phase 101)', () => {
  it('every Node-side DU arm is generated at least once', () => {
    const haystack = fc.sample(arbNode, 4000).map(encodeNode).join('\n');
    const missing = requiredNodeTokens.filter((t) => !haystack.includes(t));
    expect(missing, `DU arms never generated: ${missing.join(', ')}`).toEqual([]);
  });

  it('every TreeOp arm is generated at least once', () => {
    const haystack = fc.sample(arbOp, 1000).map(encodeOp).join('\n');
    const missing = requiredOpTokens.filter((t) => !haystack.includes(t));
    expect(missing, `TreeOp arms never generated: ${missing.join(', ')}`).toEqual([]);
  });
});
