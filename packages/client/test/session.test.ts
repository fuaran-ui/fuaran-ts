import { describe, expect, it } from 'vitest';

import { FuaranClient, FuaranSession, SURFACE_VERSION, type FetchLike } from '../src/index.js';

/** A mock endpoint that echoes a distinct produced tree per turn and records the
 *  `CurrentTreeJson` each request carried, so a test can assert the loop carries
 *  the tree forward. */
function trackingEndpoint(): {
  client: FuaranClient;
  sentCurrentTrees: Array<string | undefined>;
} {
  const sentCurrentTrees: Array<string | undefined> = [];
  let turn = 0;
  const fetch: FetchLike = (_url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    sentCurrentTrees.push(body['CurrentTreeJson'] as string | undefined);
    turn += 1;
    return Promise.resolve({
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({ TreeJson: `{"turn":${turn}}`, Ops: [], Version: SURFACE_VERSION }),
        ),
    });
  };
  return { client: new FuaranClient({ endpoint: '/api/fuaran', fetch }), sentCurrentTrees };
}

describe('FuaranSession — the turn loop carries the tree forward', () => {
  it('first turn is a fresh generation; the next prompt repairs the held tree', async () => {
    const { client, sentCurrentTrees } = trackingEndpoint();
    const session = new FuaranSession(client);

    expect(session.currentTreeJson).toBeUndefined();

    const first = await session.next('a metric card showing revenue');
    expect(first.kind).toBe('produced');
    expect(session.currentTreeJson).toBe('{"turn":1}');

    const second = await session.next('rename the metric to ARR');
    expect(second.kind).toBe('produced');
    expect(session.currentTreeJson).toBe('{"turn":2}');

    // Turn 1 sent no current tree (fresh); turn 2 sent the tree turn 1 produced
    // (a repair diff) — the token-saving ergonomic.
    expect(sentCurrentTrees).toEqual([undefined, '{"turn":1}']);
  });

  it('seeds from an existing tree so the first turn is already a repair', async () => {
    const { client, sentCurrentTrees } = trackingEndpoint();
    const session = new FuaranSession(client, { initialTreeJson: '{"seeded":true}' });

    await session.next('tweak it');

    expect(sentCurrentTrees).toEqual(['{"seeded":true}']);
  });

  it('does not advance the held tree on a non-produced result', async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      // First turn produces; second turn is denied.
      return calls === 1
        ? Promise.resolve({
            status: 200,
            text: () =>
              Promise.resolve(
                JSON.stringify({ TreeJson: '{"held":true}', Ops: [], Version: SURFACE_VERSION }),
              ),
          })
        : Promise.resolve({
            status: 401,
            text: () => Promise.resolve(JSON.stringify({ Reason: 'token expired' })),
          });
    };
    const session = new FuaranSession(new FuaranClient({ endpoint: '/api/fuaran', fetch }));

    await session.next('make it');
    expect(session.currentTreeJson).toBe('{"held":true}');

    const denied = await session.next('edit it');
    expect(denied.kind).toBe('accessDenied');
    // The held tree is unchanged, so the caller can retry the same repair.
    expect(session.currentTreeJson).toBe('{"held":true}');
  });

  it('reset() drops the held tree so the next turn is fresh again', async () => {
    const { client, sentCurrentTrees } = trackingEndpoint();
    const session = new FuaranSession(client);

    await session.next('one');
    session.reset();
    expect(session.currentTreeJson).toBeUndefined();
    await session.next('two');

    expect(sentCurrentTrees).toEqual([undefined, undefined]);
  });
});
