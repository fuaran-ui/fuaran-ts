// @fuaran-ui/client — the HTTP envelope mapping.
//
// This is the SINGLE place that pins how the typed contract crosses the wire,
// so a future change to the endpoint's framing touches one file. The request
// body mirrors the surface's request record field-for-field (the names below
// are the canonical on-the-wire keys); the response is discriminated by HTTP
// status — 200 → produced, 401 → access denied, 422 → turn failed — per the
// endpoint's documented status map. Any other status is surfaced as a
// `provider`-stage failure so a caller never has to special-case transport.

import type {
  AppliedOp,
  GenerateArgs,
  RecoverableError,
  TurnResult,
  TurnStage,
} from './contract.js';

/** The request body sent to the endpoint, mirroring the surface request record.
 *  Secrets (`ByokKey` / `AccessToken`) are request-scoped and present only when
 *  supplied — in a server-proxied deployment the proxy injects them, so the
 *  browser-side body omits them. */
interface WireRequest {
  readonly Prompt: string;
  readonly CurrentTreeJson?: string;
  readonly ByokKey?: string;
  readonly AccessToken?: string;
  readonly DisableCorpusRead?: boolean;
  readonly ContributeCorpus?: boolean;
}

/** Resolved per-call secrets, merged from the client config + call overrides. */
export interface ResolvedSecrets {
  readonly providerKey?: string;
  readonly accessToken?: string;
}

/** Build the JSON request body from the typed args + resolved secrets. Fields
 *  are omitted (not sent as `null`) when absent, matching the surface defaults
 *  (a missing corpus flag is privacy-preserving; a missing current tree is a
 *  fresh generation). */
export function toWireBody(args: GenerateArgs, secrets: ResolvedSecrets): WireRequest {
  return {
    Prompt: args.prompt,
    ...(args.currentTreeJson !== undefined ? { CurrentTreeJson: args.currentTreeJson } : {}),
    ...(secrets.providerKey !== undefined ? { ByokKey: secrets.providerKey } : {}),
    ...(secrets.accessToken !== undefined ? { AccessToken: secrets.accessToken } : {}),
    ...(args.disableCorpusRead !== undefined ? { DisableCorpusRead: args.disableCorpusRead } : {}),
    ...(args.contributeCorpus !== undefined ? { ContributeCorpus: args.contributeCorpus } : {}),
  };
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Read a value tolerant of the canonical PascalCase wire key or a camelCase
 *  alias, so a deployment that lower-cases its JSON still parses. */
function pick(obj: Record<string, unknown>, pascal: string, camel: string): unknown {
  return obj[pascal] ?? obj[camel];
}

function parseAppliedOps(raw: unknown): AppliedOp[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const ops: AppliedOp[] = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== 'object') {
      continue;
    }
    const o = entry as Record<string, unknown>;
    const opId = asString(pick(o, 'OpId', 'opId')) ?? '';
    const opJson = asString(pick(o, 'OpJson', 'opJson')) ?? '';
    ops.push({ opId, opJson });
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

function parseJson(text: string): Record<string, unknown> {
  if (text.trim() === '') {
    return {};
  }
  try {
    const v: unknown = JSON.parse(text);
    return v != null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function failed(stage: TurnStage, code: string, message: string): TurnResult {
  const error: RecoverableError = { stage, code, message };
  return { kind: 'turnFailed', error };
}

/** Map an HTTP (status, body) pair onto the typed {@link TurnResult}. The status
 *  selects the case; the body supplies the payload. The error envelope may be
 *  flat (`{ Stage, Code, Message }`) or nested under `Error` — both parse. */
export function parseTurnResponse(status: number, bodyText: string): TurnResult {
  const body = parseJson(bodyText);

  if (status === 200) {
    return {
      kind: 'produced',
      treeJson: asString(pick(body, 'TreeJson', 'treeJson')) ?? '',
      ops: parseAppliedOps(pick(body, 'Ops', 'ops')),
      version: asString(pick(body, 'Version', 'version')) ?? '',
    };
  }

  if (status === 401) {
    return {
      kind: 'accessDenied',
      reason: asString(pick(body, 'Reason', 'reason')) ?? 'access denied',
    };
  }

  if (status === 422) {
    const envelope = (pick(body, 'Error', 'error') as Record<string, unknown> | undefined) ?? body;
    return failed(
      asStage(pick(envelope, 'Stage', 'stage')),
      asString(pick(envelope, 'Code', 'code')) ?? 'TURN_FAILED',
      asString(pick(envelope, 'Message', 'message')) ?? 'the turn failed',
    );
  }

  // Any other status is a transport-level failure — surfaced as a provider-stage
  // envelope so the caller handles it through the same `turnFailed` path.
  const detail = asString(pick(body, 'Message', 'message')) ?? bodyText.slice(0, 200);
  return failed(
    'provider',
    `HTTP_${status}`,
    detail === '' ? `unexpected status ${status}` : detail,
  );
}
