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
//      {"actor":{…canonical Actor…},"hash":"…","op":{…canonical TreeOp…},
//       "outcomeHash":"…"?,"parents":["…"],"promptId":"…"?,
//       "resultEnvelope":{…},"streamId":"…","timestamp":<unixSeconds>,
//       "tombstoned":false}
//
//  Phase 1144 replaced the trailing `"userId":"…"` member with the leading
//  `"actor":{…}` — the typed `human | agent` author, in the same canonical
//  encoding `@fuaran-ui/op-stream`'s `encodeActor` pins for the linear chain.
//  Top-level keys stay Ordinal-sorted, which is why `actor` moves to the FRONT.
//  A MAJOR wire event: the actor is inside the F# content address, so every DAG
//  hash in the corpus was re-minted and pre-1144 addresses do not carry forward.
//  `decodeDagRecord` therefore REFUSES a `userId` envelope by name rather than
//  lifting it — a lift would produce a record carrying a `hash` that no host can
//  reproduce, turning a clear refusal into a silent verification failure.
//
//  Verified byte-for-byte against the workspace wire-format-fixtures/dag corpus
//  by test/dag.test.ts — the cross-implementation parity gate for this artifact
//  (F# DagWire.encodeRecord == TS encodeDagRecord, byte-identical).
// ============================================================================

import { encodeOp } from './encode.js';
import { decodeOp } from './decode.js';
import { parse, field, type JsonAst } from './parse.js';
import type { TreeOp } from './treeOp.js';

/**
 * Who authored a DAG op. Structurally identical to `Actor` in
 * `@fuaran-ui/op-stream`, and DELIBERATELY declared here rather than imported:
 * op-stream depends on this package, so importing it would invert the package
 * dependency. TypeScript is structurally typed, so an op-stream `Actor` is
 * assignable here and vice versa with no import and no new dependency edge.
 */
export type DagActor =
  | { readonly kind: 'human'; readonly id: string }
  | {
      readonly kind: 'agent';
      readonly model: string;
      readonly version: string;
      readonly id: string;
    };

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
  readonly actor: DagActor;
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

/**
 * The canonical actor encoding — member order is PINNED (`kind` first, then the
 * case fields), not Ordinal-sorted, and must match the F# `Actor.encode` and the
 * op-stream `encodeActor` byte for byte. The value nests into the DAG envelope
 * verbatim, exactly as `encodeOp` does.
 */
const encodeActorValue = (a: DagActor): string =>
  a.kind === 'human'
    ? `{"kind":"human","id":${str(a.id)}}`
    : `{"kind":"agent","model":${str(a.model)},"version":${str(a.version)},"id":${str(a.id)}}`;

const encodeEnvelope = (e: DagResultEnvelope): string =>
  e.$type === 'Success'
    ? '{"$type":"Success"}'
    : `{"$type":"Failure","code":${str(e.code)},"message":${str(e.message)}}`;

/**
 * Encode a `DagOpRecord` to its canonical JSON wire form. Keys in Ordinal order
 * (actor < hash < op < outcomeHash < parents < promptId < resultEnvelope <
 * streamId < timestamp < tombstoned); `outcomeHash` / `promptId` omitted when
 * absent; `op` nests `encodeOp` and `actor` nests the canonical actor form
 * verbatim. Byte-identical to the F# `DagWire.encodeRecord`.
 */
export const encodeDagRecord = <TMsg>(record: DagOpRecord<TMsg>): string => {
  let out = '{';
  out += `"actor":${encodeActorValue(record.actor)}`;
  out += `,"hash":${str(record.hash)}`;
  out += `,"op":${encodeOp(record.op as TreeOp<unknown>)}`;
  if (record.outcomeHash !== undefined) out += `,"outcomeHash":${str(record.outcomeHash)}`;
  out += `,"parents":[${record.parents.map(str).join(',')}]`;
  if (record.promptId !== undefined) out += `,"promptId":${str(record.promptId)}`;
  out += `,"resultEnvelope":${encodeEnvelope(record.resultEnvelope)}`;
  out += `,"streamId":${str(record.streamId)}`;
  out += `,"timestamp":${record.timestamp}`;
  out += `,"tombstoned":${record.tombstoned ? 'true' : 'false'}`;
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
 * Read a canonical actor object back to the typed shape. `undefined` on a
 * missing / non-object / unknown-`kind` value, or on a case missing one of its
 * fields — the caller turns that into a named refusal rather than a default,
 * because the actor is inside the content address and a guessed one silently
 * invalidates the record's own hash.
 */
const decodeActor = (ast: JsonAst | undefined): DagActor | undefined => {
  if (ast === undefined || ast.kind !== 'JObject') return undefined;
  const kind = asString(field(ast.fields, 'kind'));
  const id = asString(field(ast.fields, 'id'));
  if (id === undefined) return undefined;
  if (kind === 'human') return { kind: 'human', id };
  if (kind === 'agent') {
    const model = asString(field(ast.fields, 'model'));
    const version = asString(field(ast.fields, 'version'));
    if (model === undefined || version === undefined) return undefined;
    return { kind: 'agent', model, version, id };
  }
  return undefined;
};

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
  const actorAst = field(f, 'actor');
  const opAst = field(f, 'op');
  const parentsAst = field(f, 'parents');
  const tsAst = field(f, 'timestamp');

  if (actorAst === undefined && field(f, 'userId') !== undefined)
    return {
      ok: false,
      error:
        "dag envelope: pre-1144 record — 'userId' was replaced by the typed 'actor', and DAG content addresses do not carry forward",
    };
  if (hash === undefined || streamId === undefined)
    return { ok: false, error: 'dag envelope: missing hash/streamId' };
  const actor = decodeActor(actorAst);
  if (actor === undefined) return { ok: false, error: "dag envelope: missing/malformed 'actor'" };
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
    actor,
    timestamp: tsAst.value,
    resultEnvelope,
    tombstoned: tombAst !== undefined && tombAst.kind === 'JBool' && tombAst.value,
  };

  return { ok: true, value };
};
