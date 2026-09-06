import { describe, expect, it } from 'vitest';

import {
  handleTurn,
  handleTurnBody,
  matchTree,
  MOCK_SERVED_MODEL,
  MOCK_SURFACE_VERSION,
  PLACEHOLDER_TREE_JSON,
} from '../src/index.js';

/** The deployed 200's shape, as the mock now serves it. */
interface ProducedBody {
  readonly version: string;
  readonly tree: Record<string, unknown>;
  readonly opsApplied: number;
  readonly provider: string;
  readonly servedModel: string;
  readonly snapshot: { readonly state: string };
  readonly ops: ReadonlyArray<{ readonly opId: string; readonly opJson: string }>;
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly stage?: string };
}

describe('@fuaran-ui/mock — the contract-faithful handler', () => {
  it('matches a prompt to a deterministic cookbook tree', () => {
    // Same prompt → same tree, every time.
    const a = matchTree('Show total revenue at the top');
    const b = matchTree('Show total revenue at the top');
    expect(a).toBe(b);
    expect(a).toContain('"$type":"Metric"');

    expect(matchTree('a sign up form')).toContain('"$type":"Form"');
    expect(matchTree('add a refresh button')).toContain('"$type":"Button"');
    expect(matchTree('a heads up banner')).toContain('"$type":"Callout"');
  });

  it('a no-match returns the deterministic placeholder, never an error', () => {
    const reply = handleTurn({ prompt: 'xyzzy nothing matches this at all' });
    expect(reply.status).toBe(200);
    const body = reply.body as ProducedBody;
    expect(JSON.stringify(body.tree)).toBe(JSON.stringify(JSON.parse(PLACEHOLDER_TREE_JSON)));
  });

  it('replies in the DEPLOYED shape, so a mock-certified client can talk to production', () => {
    const reply = handleTurn({ prompt: 'a metric strip' });
    const body = reply.body as ProducedBody;

    // The tree is an OBJECT, not the JSON string the retired shape used.
    expect(typeof body.tree).toBe('object');
    expect(body.version).toBe(MOCK_SURFACE_VERSION);
    expect(body.opsApplied).toBe(0);
    expect(body.provider).toBeTypeOf('string');
    expect(body.servedModel).toBe(MOCK_SERVED_MODEL);
    expect(body.snapshot.state).toBeTypeOf('string');

    // …and none of the retired members survive, so a client still reading them
    // fails HERE rather than in production.
    const members = reply.body as Record<string, unknown>;
    expect(members['TreeJson']).toBeUndefined();
    expect(members['Version']).toBeUndefined();
    expect(members['Ops']).toBeUndefined();
  });

  it('a fresh turn applies no ops; a repair turn applies one and counts it', () => {
    const fresh = handleTurn({ prompt: 'a metric strip' });
    expect((fresh.body as ProducedBody).opsApplied).toBe(0);
    expect((fresh.body as ProducedBody).ops).toHaveLength(0);

    const repair = handleTurn({ prompt: 'a metric strip', currentTree: '{"id":"x","kind":{}}' });
    const body = repair.body as ProducedBody;
    expect(body.opsApplied).toBe(1);
    expect(body.ops[0]?.opJson).toContain('"$type":"UpdateProp"');
  });

  it('accepts currentTree as an object, as the endpoint does', () => {
    const repair = handleTurn({ prompt: 'a metric strip', currentTree: { id: 'x', kind: {} } });
    expect((repair.body as ProducedBody).opsApplied).toBe(1);
  });

  it('accepts the retired PascalCase request members', () => {
    const reply = handleTurn({ Prompt: 'a metric strip', CurrentTreeJson: '{"id":"x"}' });
    expect(reply.status).toBe(200);
    expect((reply.body as ProducedBody).opsApplied).toBe(1);
  });

  it('reads no secret and never echoes one back (zero-secret posture)', () => {
    const reply = handleTurn({
      prompt: 'a metric',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ AccessToken: 'secret-access-token', ByokKey: 'sk-super-secret' } as any),
    });
    const serialised = JSON.stringify(reply);
    expect(serialised).not.toContain('secret-access-token');
    expect(serialised).not.toContain('sk-super-secret');
  });

  it('refuses a body carrying a secret, exactly as the endpoint does', () => {
    // The point of the mock is that what passes here passes there. A client
    // that has not moved its secrets into headers must fail HERE.
    const reply = handleTurnBody(JSON.stringify({ prompt: 'a metric', ByokKey: 'sk-super-secret' }));
    expect(reply.status).toBe(400);
    const body = reply.body as ErrorBody;
    expect(body.error.code).toBe('SECRETS_IN_BODY');
    expect(JSON.stringify(reply)).not.toContain('sk-super-secret');
  });

  it("a malformed / empty / prompt-less body is the endpoint's own 400, not a 200", () => {
    // Red before: all four returned 200 with the placeholder tree, so a client
    // certified here had never exercised a refusal path at all.
    for (const bodyText of ['', 'not json{{', '{}', '[]']) {
      const reply = handleTurnBody(bodyText);
      expect(reply.status, bodyText).toBe(400);
      expect((reply.body as ErrorBody).error.code, bodyText).toBe('BAD_REQUEST');
    }
  });

  it('every refusal the endpoint emits can be REQUESTED, so a client can test its error paths', () => {
    const cases: ReadonlyArray<readonly [string, number, string]> = [
      ['mock:access-denied', 401, 'ACCESS_DENIED'],
      ['mock:turn-failed', 422, 'APPLY_REJECTED'],
      ['mock:secrets-in-body', 400, 'SECRETS_IN_BODY'],
      ['mock:missing-key', 400, 'MISSING_PROVIDER_KEY'],
      ['mock:faulted', 500, 'TURN_FAULTED'],
      ['mock:unconfigured', 503, 'HOST_NOT_CONFIGURED'],
    ];

    for (const [marker, status, code] of cases) {
      const reply = handleTurn({ prompt: `please fail: ${marker}` });
      expect(reply.status, marker).toBe(status);
      expect((reply.body as ErrorBody).error.code, marker).toBe(code);
    }
  });

  it('the 422 names its stage; the other refusals do not', () => {
    const failed = handleTurn({ prompt: 'mock:turn-failed' }).body as ErrorBody;
    expect(failed.error.stage).toBe('apply');

    const denied = handleTurn({ prompt: 'mock:access-denied' }).body as ErrorBody;
    expect(denied.error.stage).toBeUndefined();
  });
});
