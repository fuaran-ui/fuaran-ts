// ============================================================================
//  @fuaran-ui/ops — DAG op-record wire codec (Phase 178).
//
//  Symmetric port of Fuaran.UI.OpStream.Dag.Abstractions.DagWire
//  (encodeRecord / decodeRecord). The DagOpRecord wire shape is an ADDITIVE
//  artifact: the linear OpRecord + the Node/TreeOp corpus are untouched. A DAG
//  record serialises as a canonical-JSON object (Ordinal-sorted keys, no
//  whitespace) whose `op` field nests the canonical TreeOp wire form
//  (`encodeOp`):
//
//      {"hash":"…","op":{…canonical TreeOp…},"outcomeHash":"…"?,
//       "parents":["…"],"promptId":"…"?,"resultEnvelope":{…},
//       "streamId":"…","timestamp":<unixSeconds>,"tombstoned":false,
//       "userId":"…"}
//
//  Verified byte-for-byte against the workspace wire-format-fixtures/dag corpus
//  by test/dag.test.ts — the cross-implementation parity gate for this artifact
//  (F# DagWire.encodeRecord == TS encodeDagRecord, byte-identical).
// ============================================================================

import { encodeOp } from './encode.js';
import { decodeOp } from './decode.js';
import { parse, field, type JsonAst } from './parse.js';
import type { TreeOp } from './treeOp.js';

/** The result envelope captured on a DAG record (closed shape). */
export type DagResultEnvelope =
  | { readonly $type: 'Success' }
  | { readonly $type: 'Failure'; readonly code: string; readonly message: string };

/**
 * Content-addressed, multi-parent op-record — the branching-DAG generalisation
 * of the linear `OpRecord`. `parents` is in author order (head = primary
 * parent); `outcomeHash` is present only on a merge node (committed to the
 * canonical encoding of the resulting tree). A linear chain is the degenerate
 * single-parent case.
 */
export interface DagOpRecord<TMsg = unknown> {
  readonly streamId: string;
  readonly hash: string;
  readonly parents: readonly string[];
  readonly op: TreeOp<TMsg>;
  readonly outcomeHash?: string;
  readonly promptId?: string;
  readonly userId: string;
  /** Unix seconds. */
  readonly timestamp: number;
  readonly resultEnvelope: DagResultEnvelope;
  readonly tombstoned: boolean;
}

/** Quote + escape a string per WIRE_FORMAT.md §2 rule 6 (only " \ control). */
const str = (s: string): string => {
  let out = '"';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    const code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += c;
  }
  return out + '"';
};

const encodeEnvelope = (e: DagResultEnvelope): string =>
  e.$type === 'Success'
    ? '{"$type":"Success"}'
    : `{"$type":"Failure","code":${str(e.code)},"message":${str(e.message)}}`;

/**
 * Encode a `DagOpRecord` to its canonical JSON wire form. Keys in Ordinal order
 * (hash < op < outcomeHash < parents < promptId < resultEnvelope < streamId <
 * timestamp < tombstoned < userId); `outcomeHash` / `promptId` omitted when
 * absent; `op` nests `encodeOp` verbatim. Byte-identical to the F#
 * `DagWire.encodeRecord`.
 */
export const encodeDagRecord = <TMsg>(record: DagOpRecord<TMsg>): string => {
  let out = '{';
  out += `"hash":${str(record.hash)}`;
  out += `,"op":${encodeOp(record.op as TreeOp<unknown>)}`;
  if (record.outcomeHash !== undefined) out += `,"outcomeHash":${str(record.outcomeHash)}`;
  out += `,"parents":[${record.parents.map(str).join(',')}]`;
  if (record.promptId !== undefined) out += `,"promptId":${str(record.promptId)}`;
  out += `,"resultEnvelope":${encodeEnvelope(record.resultEnvelope)}`;
  out += `,"streamId":${str(record.streamId)}`;
  out += `,"timestamp":${record.timestamp}`;
  out += `,"tombstoned":${record.tombstoned ? 'true' : 'false'}`;
  out += `,"userId":${str(record.userId)}`;
  return out + '}';
};

type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** Re-serialise a parsed JSON AST to a (non-canonical but valid) JSON string. */
const astToJson = (ast: JsonAst): string => {
  switch (ast.kind) {
    case 'JNull':
      return 'null';
    case 'JBool':
      return ast.value ? 'true' : 'false';
    case 'JNumber':
      return String(ast.value);
    case 'JString':
      return str(ast.value);
    case 'JArray':
      return `[${ast.items.map(astToJson).join(',')}]`;
    case 'JObject': {
      const parts: string[] = [];
      for (const [k, v] of ast.fields) parts.push(`${str(k)}:${astToJson(v)}`);
      return `{${parts.join(',')}}`;
    }
  }
};

const asString = (ast: JsonAst | undefined): string | undefined =>
  ast !== undefined && ast.kind === 'JString' ? ast.value : undefined;

/**
 * Decode a canonical DAG-record envelope. The nested `op` AST is routed through
 * the canonical `decodeOp` (the same structural decoder the linear wire path
 * uses). Returns a structured error string on any wire-shape violation.
 */
export const decodeDagRecord = (json: string): DecodeResult<DagOpRecord<unknown>> => {
  const parsed = parse(json);
  if (!parsed.ok) return { ok: false, error: `dag envelope parse: ${parsed.error.message}` };
  const root = parsed.value;
  if (root.kind !== 'JObject') return { ok: false, error: 'dag envelope: expected an object' };
  const f = root.fields;

  const hash = asString(field(f, 'hash'));
  const streamId = asString(field(f, 'streamId'));
  const userId = asString(field(f, 'userId'));
  const opAst = field(f, 'op');
  const parentsAst = field(f, 'parents');
  const tsAst = field(f, 'timestamp');

  if (hash === undefined || streamId === undefined || userId === undefined)
    return { ok: false, error: 'dag envelope: missing hash/streamId/userId' };
  if (opAst === undefined) return { ok: false, error: 'dag envelope: missing op' };
  if (parentsAst === undefined || parentsAst.kind !== 'JArray')
    return { ok: false, error: 'dag envelope: missing/!array parents' };
  if (tsAst === undefined || tsAst.kind !== 'JNumber')
    return { ok: false, error: 'dag envelope: missing/!number timestamp' };

  const opResult = decodeOp(astToJson(opAst));
  if (!opResult.ok)
    return { ok: false, error: `dag op decode: ${opResult.error.code} @ ${opResult.error.path}` };

  const parents: string[] = [];
  for (const item of parentsAst.items) {
    if (item.kind !== 'JString') return { ok: false, error: 'dag parents: non-string element' };
    parents.push(item.value);
  }

  const envAst = field(f, 'resultEnvelope');
  let resultEnvelope: DagResultEnvelope = { $type: 'Success' };
  if (envAst !== undefined && envAst.kind === 'JObject') {
    const t = asString(field(envAst.fields, '$type'));
    if (t === 'Failure') {
      resultEnvelope = {
        $type: 'Failure',
        code: asString(field(envAst.fields, 'code')) ?? '',
        message: asString(field(envAst.fields, 'message')) ?? '',
      };
    }
  }

  const tombAst = field(f, 'tombstoned');
  const outcomeHash = asString(field(f, 'outcomeHash'));
  const promptId = asString(field(f, 'promptId'));

  // `exactOptionalPropertyTypes` — only include optional keys when present.
  const value: DagOpRecord<unknown> = {
    streamId,
    hash,
    parents,
    op: opResult.value,
    ...(outcomeHash !== undefined ? { outcomeHash } : {}),
    ...(promptId !== undefined ? { promptId } : {}),
    userId,
    timestamp: tsAst.value,
    resultEnvelope,
    tombstoned: tombAst !== undefined && tombAst.kind === 'JBool' && tombAst.value,
  };

  return { ok: true, value };
};
