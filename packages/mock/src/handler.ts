// @fuaran-ui/mock — the contract-faithful turn handler.
//
// Serves the same TurnRequest → TurnResult shape as the real generation
// endpoint, so pointing an SDK at the mock's base URL is the ONLY change from
// real → mock. Deterministic (prompt→tree by keyword), offline, and free:
// the access token and BYOK key are read from nowhere and required by nothing,
// so it is safe in CI and agent sandboxes. Nothing is logged here.

import { matchTree, REPAIR_OP_JSON } from './fixtures.js';

/** The surface-version the mock echoes on every produced turn — the additive
 *  corpus-flag shape the SDKs are built against (matches the client's
 *  SURFACE_VERSION). The mock's replies are stable across additive surface
 *  minors, so this is a fixed stamp. */
export const MOCK_SURFACE_VERSION = '1.2.0';

/** The request body the mock accepts — the canonical PascalCase wire request,
 *  tolerant of a camelCase alias for the two fields the mock actually reads.
 *  Secrets (AccessToken / ByokKey) are deliberately absent: the mock never
 *  reads them. */
export interface MockTurnRequest {
  readonly Prompt?: string;
  readonly prompt?: string;
  readonly CurrentTreeJson?: string;
  readonly currentTreeJson?: string;
}

/** An HTTP reply: the status the SDK maps onto a TurnResult case, and the body
 *  object serialised as the JSON payload. */
export interface MockReply {
  readonly status: number;
  readonly body: unknown;
}

function readPrompt(req: MockTurnRequest): string {
  return req.Prompt ?? req.prompt ?? '';
}

function readCurrentTree(req: MockTurnRequest): string | undefined {
  return req.CurrentTreeJson ?? req.currentTreeJson;
}

/**
 * Handle one turn. Always a `Produced` (HTTP 200) — a no-match yields the
 * deterministic placeholder tree, never an error. A fresh turn (no current
 * tree) returns the matched tree with an empty op list; a repair turn (a
 * current tree present) additionally returns a small canonical TreeOp as the
 * "diff" half of the fresh-vs-repair branch. Pure + deterministic; reads no
 * secret.
 */
export function handleTurn(req: MockTurnRequest): MockReply {
  const prompt = readPrompt(req);
  const isRepair = readCurrentTree(req) !== undefined;
  const treeJson = matchTree(prompt);

  const ops = isRepair ? [{ OpId: 'mock-op-1', OpJson: REPAIR_OP_JSON }] : [];

  return {
    status: 200,
    body: { TreeJson: treeJson, Ops: ops, Version: MOCK_SURFACE_VERSION },
  };
}

/** Parse a raw request body string into a `MockTurnRequest`, then handle it. A
 *  malformed / empty body is treated as an empty fresh request (placeholder),
 *  never an error — the zero-friction posture. */
export function handleTurnBody(bodyText: string): MockReply {
  let parsed: MockTurnRequest = {};
  const trimmed = bodyText.trim();
  if (trimmed !== '') {
    try {
      const v: unknown = JSON.parse(trimmed);
      if (v !== null && typeof v === 'object') {
        parsed = v as MockTurnRequest;
      }
    } catch {
      parsed = {};
    }
  }
  return handleTurn(parsed);
}
