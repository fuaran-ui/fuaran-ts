// @fuaran-ui/mock — the contract-faithful turn handler.
//
// Serves the same wire as the real generation endpoint, so pointing an SDK at
// the mock's base URL is the ONLY change from real → mock. Deterministic
// (prompt→tree by keyword), offline, and free: the access token and BYOK key
// are read from nowhere and required by nothing, so it is safe in CI and agent
// sandboxes. Nothing is logged here.
//
// "CONTRACT-FAITHFUL" IS THE WHOLE VALUE, and it was previously false in a way
// that mattered. The mock replied `{TreeJson, Ops, Version}` at 200 and nothing
// else, ever — which is what a client built from the old published spec
// expected, so a client this mock certified was refused by production. It now
// replies `{version, tree, opsApplied, provider, servedModel, snapshot}` at 200
// and `{error:{code,message,stage?}}` at every refusal, and it can be asked for
// each refusal the endpoint emits. A client that passes against this mock can
// talk to a deployment.
//
// What stays deliberately different: the mock still REQUIRES no credential. It
// verifies nothing, so it cannot refuse for a reason it cannot evaluate, and a
// mock that demanded a token would be a mock nobody could run offline. The
// refusals below are therefore REQUESTABLE (a prompt keyword) rather than
// enforced — which is what makes a client's error paths testable at all, since
// an endpoint that never fails cannot exercise them.

import { matchTree, REPAIR_OP_JSON } from './fixtures.js';

/** The surface-version the mock echoes on every produced turn. The mock's
 *  replies are stable across additive surface minors, so this is a fixed
 *  stamp. */
export const MOCK_SURFACE_VERSION = '1.6.0';

/** The provider id the mock reports having chosen, and the model it reports as
 *  having served. Both are fictional and obviously so — a mock that echoed a
 *  real model id would be a mock whose output could be mistaken for a
 *  measurement. */
export const MOCK_PROVIDER = 'mock';
export const MOCK_SERVED_MODEL = 'mock-1';

/** The request body the mock accepts — the canonical camelCase wire request,
 *  tolerant of the retired PascalCase spelling for the two members the mock
 *  actually reads. Secrets are deliberately absent: the mock never reads them,
 *  and the endpoint refuses a body that carries them. */
export interface MockTurnRequest {
  readonly prompt?: string;
  readonly Prompt?: string;
  readonly currentTree?: string | object;
  readonly CurrentTreeJson?: string;
}

/** An HTTP reply: the status the SDK maps onto a TurnResult case, and the body
 *  object serialised as the JSON payload. */
export interface MockReply {
  readonly status: number;
  readonly body: unknown;
}

/** The refusals the mock can be asked for, keyed on a prompt marker. A client's
 *  error paths are only testable against an endpoint that can fail, and the
 *  real one fails for reasons a mock cannot reproduce (an expired token, a
 *  provider outage). Asking is the honest substitute for pretending. */
const REQUESTABLE_REFUSALS: ReadonlyArray<{
  readonly marker: string;
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly stage?: string;
}> = [
  {
    marker: 'mock:access-denied',
    status: 401,
    code: 'ACCESS_DENIED',
    message: 'the access token was rejected — the request was refused before any provider call',
  },
  {
    marker: 'mock:turn-failed',
    status: 422,
    code: 'APPLY_REJECTED',
    message: 'the emission was refused by the apply gate; re-emit against this hint',
    stage: 'apply',
  },
  {
    marker: 'mock:secrets-in-body',
    status: 400,
    code: 'SECRETS_IN_BODY',
    message:
      'the request body carries ByokKey; this surface reads secrets from headers only, and the ' +
      'body value was not read — treat any key sent this way as exposed and rotate it',
  },
  {
    marker: 'mock:missing-key',
    status: 400,
    code: 'MISSING_PROVIDER_KEY',
    message: "no BYOK provider key presented — send it in the 'x-fuaran-provider-key' header",
  },
  {
    marker: 'mock:faulted',
    status: 500,
    code: 'TURN_FAULTED',
    message: 'the generation failed unexpectedly; nothing was stored',
  },
  {
    marker: 'mock:unconfigured',
    status: 503,
    code: 'HOST_NOT_CONFIGURED',
    message: 'the deployment is misconfigured and serves nothing',
  },
];

function readPrompt(req: MockTurnRequest): string {
  return req.prompt ?? req.Prompt ?? '';
}

function readCurrentTree(req: MockTurnRequest): string | undefined {
  const raw = req.currentTree ?? req.CurrentTreeJson;
  if (typeof raw === 'string') {
    return raw.trim() === '' ? undefined : raw;
  }
  // The endpoint accepts `currentTree` as an object too, and so does this.
  return raw !== undefined && raw !== null ? JSON.stringify(raw) : undefined;
}

/** The endpoint's refusal envelope — one shape at every status. */
export function errorReply(
  status: number,
  code: string,
  message: string,
  stage?: string,
): MockReply {
  return {
    status,
    body: { error: { code, message, ...(stage !== undefined ? { stage } : {}) } },
  };
}

/**
 * Handle one turn. A prompt carrying no `mock:` refusal marker is always a
 * `Produced` (HTTP 200) — a no-match on the fixture bank yields the
 * deterministic placeholder tree, never an error. A fresh turn (no current
 * tree) reports `opsApplied: 0`; a repair turn (a current tree present)
 * additionally returns a small canonical TreeOp as the "diff" half of the
 * fresh-vs-repair branch, with `opsApplied` counting it. Pure + deterministic;
 * reads no secret.
 *
 * The reply's `tree` is a JSON OBJECT, as the deployed endpoint writes it —
 * not the JSON string the retired shape used. `ops` is carried BESIDE
 * `opsApplied` even though the endpoint sends only the count: a mock that
 * withheld the ops would make the repair half of a client's turn loop
 * untestable, and every conformant client reads the count in preference.
 */
export function handleTurn(req: MockTurnRequest): MockReply {
  const prompt = readPrompt(req);

  const requested = REQUESTABLE_REFUSALS.find((refusal) => prompt.includes(refusal.marker));
  if (requested !== undefined) {
    return errorReply(requested.status, requested.code, requested.message, requested.stage);
  }

  if (prompt.trim() === '') {
    // The endpoint's own first refusal, and the one a client is most likely to
    // hit by accident.
    return errorReply(400, 'BAD_REQUEST', "request body has no 'prompt' string");
  }

  const isRepair = readCurrentTree(req) !== undefined;
  const treeJson = matchTree(prompt);
  const ops = isRepair ? [{ opId: 'mock-op-1', opJson: REPAIR_OP_JSON }] : [];

  return {
    status: 200,
    body: {
      version: MOCK_SURFACE_VERSION,
      tree: JSON.parse(treeJson) as unknown,
      opsApplied: ops.length,
      provider: MOCK_PROVIDER,
      servedModel: MOCK_SERVED_MODEL,
      snapshot: { state: 'mock' },
      ops,
    },
  };
}

/** Parse a raw request body string into a `MockTurnRequest`, then handle it. A
 *  malformed / empty body is the endpoint's own `400 BAD_REQUEST`, which is
 *  what makes this mock usable for testing a client's refusal paths. */
export function handleTurnBody(bodyText: string): MockReply {
  const trimmed = bodyText.trim();
  if (trimmed === '') {
    return errorReply(
      400,
      'BAD_REQUEST',
      "request body is empty — expected a JSON object with a 'prompt'",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return errorReply(400, 'BAD_REQUEST', 'request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return errorReply(400, 'BAD_REQUEST', 'request body is not a JSON object');
  }

  // The endpoint REFUSES a body carrying a secret, detected by presence and
  // never read. The mock does the same, so a client that has not moved its
  // secrets into headers fails here rather than in production.
  const members = parsed as Record<string, unknown>;
  const secrets = ['ByokKey', 'byokKey', 'AccessToken', 'accessToken'].filter(
    (name) => members[name] !== undefined,
  );
  if (secrets.length > 0) {
    return errorReply(
      400,
      'SECRETS_IN_BODY',
      `the request body carries ${secrets.join(', ')}; this surface reads secrets from the ` +
        "'authorization' and 'x-fuaran-provider-key' headers ONLY, and the body values were not " +
        'read — treat any key sent this way as exposed and rotate it',
    );
  }

  return handleTurn(parsed as MockTurnRequest);
}
