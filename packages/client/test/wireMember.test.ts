// Phase 2239 — a canonical member of the wrong type is a malformed member.
//
// THE PARITY TABLE. `fuaran-dotnet/src/Fuaran.UI.Client.Tests/WireMemberTests.fs`
// carries the same rows, in the same order, against the same entry points. The
// two clients live in separate repositories, so the table is held twice; a row
// changed in one is changed in the other in the same change-set, or the hosts
// stop agreeing on what a tolerant payload means.
//
// The rule: an alternate spelling is a fallback for an ABSENT canonical member
// (the key missing, or JSON `null`). A canonical member that is present and of
// the wrong type is malformed, so the alias is NOT read and the field reads as
// absent: the caller's existing absent-field handling applies.
//
// Each row: the field read, the members the body carries, and what the client
// reads (`-` is "absent"; a field with a default shows its default).

import { describe, expect, it } from 'vitest';

import { parseProducedDetail, parseTurnResponse } from '../src/index.js';

const TREE = '"tree":{"id":"r"}';

const opt = (v: string | undefined): string => (v === undefined ? '-' : v);

function detail(members: string) {
  const d = parseProducedDetail(200, `{${TREE},${members}}`);
  if (d === undefined) {
    throw new Error(`no produced detail for ${members}`);
  }
  return d;
}

function produced(members: string) {
  const r = parseTurnResponse(200, `{${members}}`);
  return r.kind === 'produced' ? r : undefined;
}

function failure(members: string) {
  const r = parseTurnResponse(422, `{${members}}`);
  if (r.kind !== 'turnFailed') {
    throw new Error(`expected turnFailed, got ${r.kind}`);
  }
  return r.error;
}

function read(field: string, members: string): string {
  switch (field) {
    case 'provider':
      return opt(detail(members).provider);
    case 'servedModel':
      return opt(detail(members).servedModel);
    case 'snapshot.state':
      return opt(detail(`"snapshot":{${members}}`).snapshot?.state);
    case 'snapshot.version':
      return opt(detail(`"snapshot":{${members}}`).snapshot?.version);
    case 'opsApplied':
      return String(detail(members).opsApplied);
    case 'version':
      return opt(produced(`${TREE},${members}`)?.version);
    case 'op.opId':
      return opt(produced(`${TREE},${members}`)?.ops[0]?.opId);
    case 'tree':
      return opt(produced(members)?.treeJson);
    case 'code':
      return failure(members).code;
    case 'message':
      return failure(members).message;
    case 'stage':
      return failure(members).stage;
    case 'reason': {
      const r = parseTurnResponse(401, `{${members}}`);
      if (r.kind !== 'accessDenied') {
        throw new Error(`expected accessDenied, got ${r.kind}`);
      }
      return r.reason;
    }
    default:
      throw new Error(`unknown field ${field}`);
  }
}

const TABLE: ReadonlyArray<readonly [string, string, string]> = [
  // A string member: canonical, alias, both, and the wrong-type rows.
  ['provider', '"provider":"a"', 'a'],
  ['provider', '"Provider":"b"', 'b'],
  ['provider', '"provider":"a","Provider":"b"', 'a'],
  ['provider', '"provider":7,"Provider":"b"', '-'],
  ['provider', '"provider":{"x":1},"Provider":"b"', '-'],
  ['provider', '"provider":false,"Provider":"b"', '-'],
  ['provider', '"provider":7', '-'],
  ['provider', '"provider":"a","Provider":7', 'a'],
  // A JSON null canonical is absent, so the alias is read.
  ['provider', '"provider":null,"Provider":"b"', 'b'],
  ['provider', '"provider":null', '-'],
  ['servedModel', '"servedModel":[],"ServedModel":"m"', '-'],
  ['servedModel', '"servedModel":null,"ServedModel":"m"', 'm'],
  // The snapshot members.
  ['snapshot.state', '"state":"s"', 's'],
  ['snapshot.state', '"State":"S"', 'S'],
  ['snapshot.state', '"state":7,"State":"done"', '-'],
  ['snapshot.state', '"state":null,"State":"done"', 'done'],
  ['snapshot.version', '"state":"s","version":7,"Version":"2"', '-'],
  ['snapshot.version', '"state":"s","version":null,"Version":"2"', '2'],
  // The applied-op count, and the op list it falls back to.
  ['opsApplied', '"opsApplied":3', '3'],
  ['opsApplied', '"OpsApplied":2', '2'],
  ['opsApplied', '"opsApplied":null,"OpsApplied":2', '2'],
  ['opsApplied', '"opsApplied":"3","OpsApplied":2,"ops":[{"opId":"a","opJson":"{}"}]', '1'],
  ['opsApplied', '"ops":7,"Ops":[{"opId":"a","opJson":"{}"}]', '0'],
  ['opsApplied', '"ops":null,"Ops":[{"opId":"a","opJson":"{}"}]', '1'],
  // An applied op's own members.
  ['op.opId', '"ops":[{"opId":"a","opJson":"{}"}]', 'a'],
  ['op.opId', '"ops":[{"opId":7,"OpId":"a","opJson":"{}"}]', ''],
  ['op.opId', '"ops":[{"opId":null,"OpId":"a","opJson":"{}"}]', 'a'],
  // The version echo.
  ['version', '"version":"1.6.0"', '1.6.0'],
  ['version', '"version":7,"Version":"1.2.0"', ''],
  ['version', '"version":null,"Version":"1.2.0"', '1.2.0'],
  // The tree, which is an object or a string.
  ['tree', '"tree":{"id":"r"}', '{"id":"r"}'],
  ['tree', '"tree":7,"TreeJson":"{\\"id\\":\\"r\\"}"', '-'],
  ['tree', '"tree":null,"TreeJson":"{\\"id\\":\\"r\\"}"', '{"id":"r"}'],
  ['tree', '"tree":"  ","TreeJson":"{\\"id\\":\\"r\\"}"', '-'],
  // A refusal's members, inside the envelope.
  ['code', '"error":{"code":"A"}', 'A'],
  ['code', '"error":{"code":7,"Code":"B"}', 'TURN_FAILED'],
  ['code', '"error":{"code":null,"Code":"B"}', 'B'],
  ['message', '"error":{"message":7,"Message":"m"}', 'the turn failed'],
  ['stage', '"error":{"stage":7,"Stage":"parse"}', 'provider'],
  ['stage', '"error":{"stage":null,"Stage":"parse"}', 'parse'],
  // The envelope itself: a wrong-typed `error` is malformed, so the body is the envelope.
  ['code', '"error":"boom","code":"Z"', 'Z'],
  ['code', '"error":7,"Error":{"code":"Y"},"code":"Z"', 'Z'],
  ['code', '"error":null,"Error":{"code":"Y"}', 'Y'],
  // A 401's reason member.
  ['reason', '"Reason":"r"', 'r'],
  ['reason', '"Reason":7,"reason":"r"', 'access denied'],
  ['reason', '"Reason":null,"reason":"r"', 'r'],
];

describe('the wire member parity table', () => {
  for (const [field, members, expected] of TABLE) {
    it(`${field} reads {${members}} as ${expected}`, () => {
      expect(read(field, members)).toBe(expected);
    });
  }
});
