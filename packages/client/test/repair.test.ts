import { describe, expect, it } from 'vitest';

import {
  FuaranClient,
  SURFACE_VERSION,
  generateWithRepair,
  isRepairable,
  threadHint,
  HINT_MARKER,
  type FetchLike,
  type GenerateArgs,
  type RecoverableError,
} from '../src/index.js';

const producedBody = JSON.stringify({ TreeJson: 't', Ops: [], Version: SURFACE_VERSION });
const applyFailBody = JSON.stringify({
  Stage: 'apply',
  Code: 'APPLY_REJECTED',
  Message: 'no node #x',
});

/** A fetch that replays a scripted list of (status, body) replies (one per call)
 *  and records every request body, so a repair loop can be driven and asserted. */
function scriptedEndpoint(replies: Array<{ status: number; body: string }>): {
  client: FuaranClient;
  bodies: string[];
} {
  const bodies: string[] = [];
  let call = 0;
  const fetch: FetchLike = (_url, init) => {
    bodies.push(init.body);
    const reply = replies[call] ?? { status: 200, body: producedBody };
    call += 1;
    return Promise.resolve({ status: reply.status, text: () => Promise.resolve(reply.body) });
  };
  return { client: new FuaranClient({ endpoint: '/api/fuaran', fetch }), bodies };
}

describe('repair — the typed closed loop', () => {
  it('isRepairable: apply/parse repairable, access-token/provider terminal', () => {
    expect(isRepairable('apply')).toBe(true);
    expect(isRepairable('parse')).toBe(true);
    expect(isRepairable('access-token')).toBe(false);
    expect(isRepairable('provider')).toBe(false);
  });

  it('threadHint preserves prompt + tree and appends the marked hint', () => {
    const args: GenerateArgs = { prompt: 'make a form', currentTreeJson: '<tree>' };
    const err: RecoverableError = { stage: 'apply', code: 'APPLY_REJECTED', message: 'no node #x' };
    const threaded = threadHint(args, err);
    expect(threaded.prompt).toContain('make a form');
    expect(threaded.prompt).toContain(HINT_MARKER);
    expect(threaded.prompt).toContain('apply');
    expect(threaded.prompt).toContain('no node #x');
    expect(threaded.currentTreeJson).toBe('<tree>');
  });

  it('recovers: fail(apply) → produced within the bound, threading the hint', async () => {
    const { client, bodies } = scriptedEndpoint([
      { status: 422, body: applyFailBody },
      { status: 200, body: producedBody },
    ]);

    const result = await generateWithRepair(client, { prompt: 'x' }, { maxRetries: 2 });
    expect(result.kind).toBe('produced');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain(HINT_MARKER);
  });

  it('surfaces the final envelope when retries are exhausted', async () => {
    const { client, bodies } = scriptedEndpoint([
      { status: 422, body: applyFailBody },
      { status: 422, body: applyFailBody },
      { status: 422, body: applyFailBody },
    ]);

    const result = await generateWithRepair(client, { prompt: 'x' }, { maxRetries: 1 });
    expect(result.kind).toBe('turnFailed');
    if (result.kind === 'turnFailed') {
      expect(result.error.code).toBe('APPLY_REJECTED');
    }
    expect(bodies).toHaveLength(2); // initial + 1 retry
  });

  it('does not retry a terminal (provider) failure', async () => {
    const { client, bodies } = scriptedEndpoint([
      { status: 500, body: 'boom' },
      { status: 200, body: producedBody },
    ]);

    const result = await generateWithRepair(client, { prompt: 'x' }, { maxRetries: 3 });
    expect(result.kind).toBe('turnFailed');
    if (result.kind === 'turnFailed') {
      expect(result.error.stage).toBe('provider');
    }
    expect(bodies).toHaveLength(1);
  });

  it('maxRetries = 0 is a single attempt', async () => {
    const { client, bodies } = scriptedEndpoint([{ status: 422, body: applyFailBody }]);
    await generateWithRepair(client, { prompt: 'x' }, { maxRetries: 0 });
    expect(bodies).toHaveLength(1);
  });
});
