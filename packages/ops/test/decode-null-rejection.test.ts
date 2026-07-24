// ============================================================================
//  Null-rejection parity with the F# decoder (jsonToJValStrict).
//
//  The canonical wire format has NO null in structured JVal payload positions:
//  Custom props, Action.Notify / SetState / AiTool payloads, TextSource.I18n
//  args, and a wire-form UpdateProp value all reject JSON null at any depth
//  (WIRE_FORMAT.md §16 / the schema note "any JSON except null"). The F# host's
//  `jsonToJValStrict` surfaces WRONG_TYPE with the message "null is not
//  representable in the Fuaran wire model — omit the field instead"; the TS
//  decoder must match position-for-position.
//
//  The Binding.Static / obj seam is the deliberate exception — it faithfully
//  accepts null (F# `decodeObj`: JNull -> box null), so the last block asserts
//  that a Static null value STILL decodes, proving the fix rejects only the
//  structured-payload positions and did not over-reject.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeNode, decodeOp } from '../src/index.js';

const NULL_MSG = 'null is not representable in the Fuaran wire model — omit the field instead';

/** Assert a decode failed with the strict-null WRONG_TYPE defect at a path ending `pathSuffix`. */
const expectNullRejected = (
  decoded: ReturnType<typeof decodeNode> | ReturnType<typeof decodeOp>,
  pathSuffix: string,
): void => {
  expect(decoded.ok).toBe(false);
  if (!decoded.ok) {
    expect(decoded.error.code).toBe('WRONG_TYPE');
    expect(decoded.error.message).toBe(NULL_MSG);
    expect(decoded.error.path.endsWith(pathSuffix)).toBe(true);
  }
};

describe('null rejection in structured JVal payload positions (F# jsonToJValStrict parity)', () => {
  it('Action.Notify payload rejects a scalar null', () => {
    const node =
      '{"id":"b","kind":{"$type":"Button","label":{"$type":"Literal","text":"x"},' +
      '"onClick":{"$type":"Notify","channel":"c","payload":null},"variant":"Primary"}}';
    expectNullRejected(decodeNode(node), '.payload');
  });

  it('Action.SetState value rejects a scalar null', () => {
    const node =
      '{"id":"b","kind":{"$type":"Button","label":{"$type":"Literal","text":"x"},' +
      '"onClick":{"$type":"SetState","key":"k","value":null},"variant":"Primary"}}';
    expectNullRejected(decodeNode(node), '.value');
  });

  it('Action.AiTool args rejects a scalar null', () => {
    const node =
      '{"id":"b","kind":{"$type":"Button","label":{"$type":"Literal","text":"x"},' +
      '"onClick":{"$type":"AiTool","toolName":"t","args":null},"variant":"Primary"}}';
    expectNullRejected(decodeNode(node), '.args');
  });

  it('NodeKind.Custom props rejects a null-valued prop (exact path)', () => {
    const node =
      '{"id":"c","kind":{"$type":"Custom","componentId":"trend-card",' +
      '"moduleId":"analytics","props":{"k":null}}}';
    const decoded = decodeNode(node);
    expectNullRejected(decoded, '.props.k');
    if (!decoded.ok) expect(decoded.error.path).toBe('$.kind.props.k');
  });

  it('TextSource.I18n args rejects a null-valued arg', () => {
    const node =
      '{"id":"h","kind":{"$type":"Heading","level":1,' +
      '"text":{"$type":"I18n","key":"greeting","args":{"name":null}},"variant":"Standard"}}';
    expectNullRejected(decodeNode(node), '.args.name');
  });

  it('TreeOp.UpdateProp value rejects a scalar null (exact path)', () => {
    const op = '{"$type":"UpdateProp","path":"Label","target":"m","value":null}';
    const decoded = decodeOp(op);
    expectNullRejected(decoded, '.value');
    if (!decoded.ok) expect(decoded.error.path).toBe('$.value');
  });

  it('rejects a null nested at depth inside a payload object (recursive, not just top-level)', () => {
    const node =
      '{"id":"b","kind":{"$type":"Button","label":{"$type":"Literal","text":"x"},' +
      '"onClick":{"$type":"Notify","channel":"c","payload":{"a":{"b":null}}},"variant":"Primary"}}';
    expectNullRejected(decodeNode(node), '.payload.a.b');
  });

  it('rejects a null nested inside a payload array element', () => {
    const node =
      '{"id":"b","kind":{"$type":"Button","label":{"$type":"Literal","text":"x"},' +
      '"onClick":{"$type":"Notify","channel":"c","payload":[1,null,3]},"variant":"Primary"}}';
    expectNullRejected(decodeNode(node), '.payload[1]');
  });
});

describe('Binding.Static / obj seam still accepts null (F# decodeObj parity — no over-rejection)', () => {
  it('a ReplaceBinding Static null value decodes successfully', () => {
    const op =
      '{"$type":"ReplaceBinding","binding":{"$type":"Static","value":null},"slot":"Source","target":"metric-1"}';
    const decoded = decodeOp(op);
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.value.kind === 'ReplaceBinding') {
      expect(decoded.value.binding.kind).toBe('Static');
      if (decoded.value.binding.kind === 'Static') {
        expect(decoded.value.binding.value).toBe(null);
      }
    }
  });
});
