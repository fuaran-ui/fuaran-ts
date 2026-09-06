// @fuaran-ui/client — the HTTP envelope mapping.
//
// This is the SINGLE place that pins how the typed contract crosses the wire,
// so a future change to the endpoint's framing touches one file.
//
// IT SPEAKS THE DEPLOYED WIRE, and that was a correction. This file used to
// write `{Prompt, CurrentTreeJson, ByokKey, AccessToken, …}` and read
// `{TreeJson, Ops, Version}` across a 200/401/422 status map, because that is
// what the published specification described. The endpoint reads `prompt` /
// `currentTree`, takes secrets from HEADERS ONLY, replies
// `{version, tree, opsApplied, provider, servedModel?, snapshot}`, and refuses
// with `{error:{code,message,stage?}}` at 400 / 401 / 405 / 422 / 500 / 503. A
// client built from the old shape was answered `400 BAD_REQUEST: request body
// has no 'prompt' string`.
//
// So: the request body carries NO SECRET — `client.ts` puts the access token and
// the BYOK key in headers, and the endpoint REFUSES a body that carries either,
// never reading the value. There is no way to express the old shape through this
// module, which is the point.
//
// Reads stay tolerant of the retired PascalCase spelling — a same-origin proxy
// or a mock in front of the endpoint may still speak it — but writes do not.

import {
  CLIENT_CODES,
  type AppliedOp,
  type GenerateArgs,
  type ProducedDetail,
  type RecoverableError,
  type SnapshotState,
  type TurnResult,
  type TurnStage,
} from './contract.js';

/** The request body sent to the endpoint. Secrets are deliberately absent: they
 *  are headers, and a body carrying one is refused by the endpoint. */
interface WireRequest {
  readonly prompt: string;
  readonly currentTree?: string;
  readonly disableCorpusRead?: boolean;
  readonly contributeCorpus?: boolean;
  readonly interactionId?: string;
}

/** Resolved per-call secrets, merged from the client config + call overrides.
 *  They travel as HEADERS (see `client.ts`); this type exists to carry them to
 *  that point, never into a body. */
export interface ResolvedSecrets {
  readonly providerKey?: string;
  readonly accessToken?: string;
}

/** Build the JSON request body from the typed args. Fields are omitted (not
 *  sent as `null`) when absent, matching the endpoint's defaults (a missing
 *  corpus flag is privacy-preserving; a missing current tree is a fresh
 *  generation).
 *
 *  `currentTreeJson` is written as a JSON STRING rather than inlined as an
 *  object. The endpoint accepts both, and the string form is the one that
 *  cannot corrupt the payload: inlining would mean re-emitting the caller's
 *  canonical bytes, and the whole repair ergonomic depends on the tree crossing
 *  back and forth unchanged. */
export function toWireBody(args: GenerateArgs): WireRequest {
  return {
    prompt: args.prompt,
    ...(args.currentTreeJson !== undefined ? { currentTree: args.currentTreeJson } : {}),
    ...(args.disableCorpusRead !== undefined ? { disableCorpusRead: args.disableCorpusRead } : {}),
    ...(args.contributeCorpus !== undefined ? { contributeCorpus: args.contributeCorpus } : {}),
    ...(args.interactionId !== undefined ? { interactionId: args.interactionId } : {}),
  };
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** Read a value tolerant of the canonical wire key or an alternate spelling, so
 *  a proxy or mock that has not yet moved still parses. */
function pick(obj: Record<string, unknown>, canonical: string, alias: string): unknown {
  return obj[canonical] ?? obj[alias];
}

function parseAppliedOps(raw: unknown): AppliedOp[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const ops: AppliedOp[] = [];
  for (const entry of raw) {
    const o = asRecord(entry);
    if (o === undefined) {
      continue;
    }
    ops.push({
      opId: asString(pick(o, 'opId', 'OpId')) ?? '',
      opJson: asString(pick(o, 'opJson', 'OpJson')) ?? '',
    });
  }
  return ops;
}

const TURN_STAGES: readonly TurnStage[] = ['access-token', 'provider', 'parse', 'apply'];

function asStage(v: unknown): TurnStage {
  const s = asString(v);
  return s !== undefined && (TURN_STAGES as readonly string[]).includes(s)
    ? (s as TurnStage)
    : 'provider';
}

/** Parse a JSON body into its root object, or `undefined` — so a 200 can be
 *  told from a 200-shaped nothing. */
function parseJson(text: string): Record<string, unknown> | undefined {
  if (text.trim() === '') {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function failed(stage: TurnStage, code: string, message: string): TurnResult {
  const error: RecoverableError = { stage, code, message };
  return { kind: 'turnFailed', error };
}

/** The endpoint replied 200 with nothing usable in it. A `turnFailed`, not a
 *  `produced` with an empty tree: the session HOLDS the produced tree, so an
 *  empty one poisons every later repair rather than failing the turn that
 *  caused it. */
export function malformedResponse(detail: string): TurnResult {
  return failed('provider', CLIENT_CODES.malformedResponse, detail);
}

/** The produced tree's canonical wire JSON, however the reply carried it. The
 *  deployed endpoint writes `tree` as an OBJECT; a proxy or mock may write it
 *  as a JSON string, and the retired shape called it `TreeJson`. */
function readTree(body: Record<string, unknown>): string | undefined {
  const raw = pick(body, 'tree', 'TreeJson');
  const asObject = asRecord(raw);
  if (asObject !== undefined) {
    return JSON.stringify(asObject);
  }
  const asText = asString(raw);
  return asText !== undefined && asText.trim() !== '' ? asText : undefined;
}

function readSnapshot(body: Record<string, unknown>): SnapshotState | undefined {
  const snapshot = asRecord(body['snapshot']);
  if (snapshot === undefined) {
    return undefined;
  }
  const state = asString(pick(snapshot, 'state', 'State'));
  if (state === undefined) {
    return undefined;
  }
  const version = asString(pick(snapshot, 'version', 'Version'));
  const contentHash = asString(pick(snapshot, 'contentHash', 'ContentHash'));
  return {
    state,
    ...(version !== undefined ? { version } : {}),
    ...(contentHash !== undefined ? { contentHash } : {}),
  };
}

/** The deployment facts a 200 carries beyond the tree. `undefined` when the
 *  status was not 200, or the body carried no usable tree — the same condition
 *  that makes the turn `MALFORMED_RESPONSE`, so a caller can never read a
 *  detail off a reply the turn itself rejected. */
export function parseProducedDetail(status: number, bodyText: string): ProducedDetail | undefined {
  if (status !== 200) {
    return undefined;
  }
  const body = parseJson(bodyText);
  if (body === undefined || readTree(body) === undefined) {
    return undefined;
  }
  const count = pick(body, 'opsApplied', 'OpsApplied');
  const provider = asString(pick(body, 'provider', 'Provider'));
  const servedModel = asString(pick(body, 'servedModel', 'ServedModel'));
  const snapshot = readSnapshot(body);
  return {
    // No count on the wire: fall back to the length of an op list, which is what
    // a proxy or the offline mock sends instead.
    opsApplied:
      typeof count === 'number' ? count : parseAppliedOps(pick(body, 'ops', 'Ops')).length,
    ...(provider !== undefined ? { provider } : {}),
    ...(servedModel !== undefined ? { servedModel } : {}),
    ...(snapshot !== undefined ? { snapshot } : {}),
  };
}

/** Map an HTTP (status, body) pair onto the typed {@link TurnResult}. The status
 *  selects the case; the body supplies the payload.
 *
 *  The endpoint sends ONE refusal shape — `{error:{code,message,stage?}}` — at
 *  every non-200 status, so every refusal is read the same way and a caller
 *  never has to special-case transport. The retired flat and `Error`-nested
 *  PascalCase forms still parse, for a proxy or mock that has not moved. */
export function parseTurnResponse(status: number, bodyText: string): TurnResult {
  const body = parseJson(bodyText) ?? {};
  const envelope = asRecord(pick(body, 'error', 'Error')) ?? body;

  if (status === 200) {
    const treeJson = readTree(body);
    if (treeJson === undefined) {
      return malformedResponse('the endpoint replied 200 with no tree');
    }
    return {
      kind: 'produced',
      treeJson,
      ops: parseAppliedOps(pick(body, 'ops', 'Ops')),
      version: asString(pick(body, 'version', 'Version')) ?? '',
    };
  }

  if (status === 401) {
    return {
      kind: 'accessDenied',
      // The retired shape put the reason in a bare `Reason` member.
      reason:
        asString(pick(envelope, 'message', 'Message')) ??
        asString(pick(body, 'Reason', 'reason')) ??
        'access denied',
    };
  }

  if (status === 422) {
    return failed(
      asStage(pick(envelope, 'stage', 'Stage')),
      asString(pick(envelope, 'code', 'Code')) ?? 'TURN_FAILED',
      asString(pick(envelope, 'message', 'Message')) ?? 'the turn failed',
    );
  }

  // Every other refusal — 400 / 405 / 500 / 503, and anything a proxy invents —
  // is surfaced as a provider-stage envelope so the caller handles it through
  // the same `turnFailed` path. The endpoint's OWN code is preferred over a
  // synthesised one: a body-carried secret and a missing key header are
  // different mistakes with different remedies, and `HTTP_400` names neither.
  return failed(
    asStage(pick(envelope, 'stage', 'Stage')),
    asString(pick(envelope, 'code', 'Code')) ?? `HTTP_${status}`,
    asString(pick(envelope, 'message', 'Message')) ?? `unexpected status ${status}`,
  );
}
