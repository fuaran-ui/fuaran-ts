import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { FuaranClient, type FetchLike } from '@fuaran-ui/client';
import { handleTurnBody } from '@fuaran-ui/mock';

import { FuaranGenerated, useFuaranGenerate, type UseFuaranGenerateResult } from '../src/index.js';

// React 19 wants this flag set before act(...) drives a real root in jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A fetch that answers from the real @fuaran-ui/mock handler, in process — a
 *  genuine turn against the mock with no socket. */
const mockFetch: FetchLike = (_url, init) => {
  const reply = handleTurnBody(init.body);
  return Promise.resolve({
    status: reply.status,
    text: () => Promise.resolve(JSON.stringify(reply.body)),
  });
};

/** A fetch that fails the first `failures` turns at the apply stage (the
 *  repairable case), then answers from the mock. Records every request body so a
 *  test can assert the repair hint was threaded. */
function flakyFetch(failures: number): { fetch: FetchLike; bodies: string[] } {
  const bodies: string[] = [];
  let seen = 0;
  const fetch: FetchLike = (url, init) => {
    bodies.push(init.body);
    seen += 1;
    if (seen <= failures) {
      return Promise.resolve({
        status: 422,
        text: () =>
          Promise.resolve(
            JSON.stringify({ Stage: 'apply', Code: 'APPLY_REJECTED', Message: 'no node #x' }),
          ),
      });
    }
    return mockFetch(url, init);
  };
  return { fetch, bodies };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

/** Mount a probe that runs the hook and renders through the real renderer,
 *  exposing the latest hook state to the test. */
async function mount(fetch: FetchLike): Promise<{
  state: () => UseFuaranGenerateResult<unknown>;
  html: () => string;
}> {
  let latest: UseFuaranGenerateResult<unknown> | undefined;

  function Probe(): React.ReactElement {
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });
    const state = useFuaranGenerate({ client });
    latest = state;
    return <FuaranGenerated state={state} />;
  }

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });

  return {
    state: () => {
      if (latest === undefined) throw new Error('probe never rendered');
      return latest;
    },
    html: () => container?.innerHTML ?? '',
  };
}

describe('useFuaranGenerate — the turn-loop as React state', () => {
  it('starts idle with no tree', async () => {
    const probe = await mount(mockFetch);
    expect(probe.state().status).toBe('idle');
    expect(probe.state().tree).toBeUndefined();
    expect(probe.state().busy).toBe(false);
  });

  it('generates a tree and renders it through @fuaran-ui/renderer', async () => {
    const probe = await mount(mockFetch);

    await act(async () => {
      await probe.state().generate('a metric strip showing revenue');
    });

    expect(probe.state().status).toBe('ready');
    expect(probe.state().tree).toBeDefined();
    expect(probe.state().error).toBeUndefined();
    // The mock serves the corpus metric tree; the real renderer draws its label.
    expect(probe.html()).toContain('Revenue');
  });

  it('carries the tree forward, so the second prompt is a repair diff', async () => {
    const bodies: string[] = [];
    const recording: FetchLike = (url, init) => {
      bodies.push(init.body);
      return mockFetch(url, init);
    };
    const probe = await mount(recording);

    await act(async () => {
      await probe.state().generate('a metric strip');
    });
    await act(async () => {
      await probe.state().generate('tweak it');
    });

    expect(bodies).toHaveLength(2);
    // Turn 1 is a fresh generation; turn 2 carries the held tree.
    expect(bodies[0]).not.toContain('CurrentTreeJson');
    expect(bodies[1]).toContain('CurrentTreeJson');
  });

  it('reset() drops the held tree so the next turn is fresh again', async () => {
    const bodies: string[] = [];
    const recording: FetchLike = (url, init) => {
      bodies.push(init.body);
      return mockFetch(url, init);
    };
    const probe = await mount(recording);

    await act(async () => {
      await probe.state().generate('a metric strip');
    });
    await act(() => {
      probe.state().reset();
    });

    expect(probe.state().tree).toBeUndefined();
    expect(probe.state().status).toBe('idle');

    await act(async () => {
      await probe.state().generate('a form');
    });
    expect(bodies[1]).not.toContain('CurrentTreeJson');
  });

  it('surfaces a typed error and leaves the held tree untouched', async () => {
    const denying: FetchLike = () =>
      Promise.resolve({
        status: 401,
        text: () => Promise.resolve(JSON.stringify({ Reason: 'token expired' })),
      });

    // Seed a good tree first, then fail the next turn.
    let deny = false;
    const probe = await mount((url, init) => (deny ? denying(url, init) : mockFetch(url, init)));

    await act(async () => {
      await probe.state().generate('a metric strip');
    });
    const held = probe.state().treeJson;

    deny = true;
    await act(async () => {
      await probe.state().generate('break it');
    });

    expect(probe.state().status).toBe('error');
    expect(probe.state().error).toEqual({ kind: 'accessDenied', reason: 'token expired' });
    // The held tree survives, so the caller can retry the same repair.
    expect(probe.state().treeJson).toBe(held);
    expect(probe.state().tree).toBeDefined();
  });
});

describe('useFuaranGenerate — repair (the closed hint-threading loop)', () => {
  it('recovers from an apply-stage rejection within the bound', async () => {
    const { fetch, bodies } = flakyFetch(1);
    const probe = await mount(fetch);

    await act(async () => {
      await probe.state().repair('a metric strip');
    });

    expect(probe.state().status).toBe('ready');
    expect(probe.state().tree).toBeDefined();
    expect(bodies).toHaveLength(2);
    // The retry carried the endpoint's hint back into the prompt.
    expect(bodies[1]).toContain('[repair]');
  });

  it('surfaces the final envelope when the repair bound is exhausted', async () => {
    const { fetch, bodies } = flakyFetch(99);
    const probe = await mount(fetch);

    await act(async () => {
      await probe.state().repair('a metric strip');
    });

    expect(probe.state().status).toBe('error');
    expect(probe.state().error).toEqual({
      kind: 'turnFailed',
      error: { stage: 'apply', code: 'APPLY_REJECTED', message: 'no node #x' },
    });
    // Initial attempt + the default two retries.
    expect(bodies).toHaveLength(3);
  });
});

describe('FuaranGenerated — the render half', () => {
  it('shows the error state when there is no tree', async () => {
    const failing: FetchLike = () =>
      Promise.resolve({
        status: 401,
        text: () => Promise.resolve(JSON.stringify({ Reason: 'nope' })),
      });
    const probe = await mount(failing);

    await act(async () => {
      await probe.state().generate('anything');
    });

    expect(probe.html()).toContain('role="alert"');
    expect(probe.html()).toContain('Access denied');
  });
});
