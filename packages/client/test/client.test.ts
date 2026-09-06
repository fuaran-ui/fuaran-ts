import { describe, expect, it } from 'vitest';

import {
  CLIENT_CODES,
  FuaranClient,
  SURFACE_VERSION,
  isSecureEndpoint,
  isSurfaceVersionCompatible,
  type FetchLike,
  type Produced,
} from '../src/index.js';

/** The endpoint's canonical 200: the tree as an OBJECT, `opsApplied` as a
 *  COUNT, and the deployment facts beside them. */
const producedBody = (opsApplied = 0): Record<string, unknown> => ({
  version: '1.6.0',
  tree: { id: 'root', kind: { $type: 'Badge', label: 'A', variant: 'Info' } },
  opsApplied,
  provider: 'openai',
  servedModel: 'gpt-4o-2024-11-20',
  snapshot: { state: 'warm', version: '7', contentHash: 'sha256:abc' },
});

/** A mock endpoint that records the last request and replies with a scripted
 *  (status, body). Stands in for the real Fuaran generation endpoint. */
function mockEndpoint(reply: { status: number; body: unknown }): {
  fetch: FetchLike;
  calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    redirect: string | undefined;
  }>;
} {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    redirect: string | undefined;
  }> = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
      redirect: init.redirect,
    });
    return Promise.resolve({
      status: reply.status,
      text: () => Promise.resolve(JSON.stringify(reply.body)),
    });
  };
  return { fetch, calls };
}

describe('FuaranClient.generate — request contract', () => {
  it('writes the deployed camelCase body and carries the secrets as headers', async () => {
    const { fetch, calls } = mockEndpoint({ status: 200, body: producedBody() });
    const client = new FuaranClient({
      endpoint: 'https://endpoint.example/generate',
      accessToken: 'tok-123',
      providerKey: 'byok-secret',
      provider: 'openai',
      fetch,
    });

    await client.generate({
      prompt: 'a metric card showing revenue',
      currentTreeJson: '{"prior":true}',
      disableCorpusRead: true,
      contributeCorpus: false,
      interactionId: 'corr-1',
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://endpoint.example/generate');
    expect(call.body).toEqual({
      prompt: 'a metric card showing revenue',
      currentTree: '{"prior":true}',
      disableCorpusRead: true,
      contributeCorpus: false,
      interactionId: 'corr-1',
    });
    expect(call.headers['authorization']).toBe('Bearer tok-123');
    expect(call.headers['x-fuaran-provider-key']).toBe('byok-secret');
    expect(call.headers['x-fuaran-provider']).toBe('openai');
    expect(call.headers['content-type']).toBe('application/json');
  });

  it('puts no secret in the body, at any argument', async () => {
    // The endpoint REFUSES a body carrying `ByokKey` / `AccessToken`, and this
    // module gives no way to write one.
    const { fetch, calls } = mockEndpoint({ status: 200, body: producedBody() });
    const client = new FuaranClient({
      endpoint: 'https://endpoint.example/generate',
      accessToken: 'tok-123',
      providerKey: 'byok-secret',
      fetch,
    });

    await client.generate({ prompt: 'go', accessToken: 'call-tok', providerKey: 'call-key' });

    const body = JSON.stringify(calls[0]!.body);
    expect(body).not.toContain('ByokKey');
    expect(body).not.toContain('AccessToken');
    expect(body).not.toContain('byok-secret');
    expect(body).not.toContain('call-key');
    expect(body).not.toContain('tok-123');
  });

  it('per-call credentials override the client config, in the headers', async () => {
    const { fetch, calls } = mockEndpoint({ status: 200, body: producedBody() });
    const client = new FuaranClient({
      endpoint: '/api/fuaran',
      accessToken: 'config-tok',
      providerKey: 'config-key',
      fetch,
    });

    await client.generate({ prompt: 'go', accessToken: 'call-tok', providerKey: 'call-key' });

    expect(calls[0]!.headers['authorization']).toBe('Bearer call-tok');
    expect(calls[0]!.headers['x-fuaran-provider-key']).toBe('call-key');
  });

  it('omits the current tree for a fresh generation, and corpus flags when unset', async () => {
    const { fetch, calls } = mockEndpoint({ status: 200, body: producedBody() });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    await client.generate({ prompt: 'fresh' });

    expect(calls[0]!.body).toEqual({ prompt: 'fresh' });
  });

  it('sends no credential header in a server-proxied request', async () => {
    const { fetch, calls } = mockEndpoint({ status: 200, body: producedBody() });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    await client.generate({ prompt: 'no secrets here' });

    const serialized = JSON.stringify(calls[0]);
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('x-fuaran-provider-key');
  });

  it("every request sets redirect: 'error' so a 307 never re-POSTs the key", async () => {
    const { fetch, calls } = mockEndpoint({ status: 200, body: producedBody() });
    const client = new FuaranClient({
      endpoint: 'https://endpoint.example/generate',
      providerKey: 'byok-secret',
      fetch,
    });

    await client.generate({ prompt: 'go' });

    expect(calls[0]!.redirect).toBe('error');
  });
});

describe('FuaranClient.generate — response discrimination', () => {
  it('200 → produced, with the tree JSON and echoed version', async () => {
    const { fetch } = mockEndpoint({ status: 200, body: producedBody(1) });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const result = await client.generate({ prompt: 'go' });

    expect(result.kind).toBe('produced');
    const produced = result as Produced;
    expect(JSON.parse(produced.treeJson)).toMatchObject({ id: 'root' });
    expect(produced.version).toBe('1.6.0');
    expect(isSurfaceVersionCompatible(produced.version)).toBe(true);
  });

  it('200 still parses a proxy stringified tree and its op list', async () => {
    const { fetch } = mockEndpoint({
      status: 200,
      body: {
        tree: '{"id":"root"}',
        ops: [{ opId: 'op-1', opJson: '{"kind":"SetText"}' }],
        version: SURFACE_VERSION,
      },
    });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const result = (await client.generate({ prompt: 'go' })) as Produced;

    expect(result.treeJson).toBe('{"id":"root"}');
    expect(result.ops).toEqual([{ opId: 'op-1', opJson: '{"kind":"SetText"}' }]);
  });

  it('200 tolerates the retired PascalCase reply', async () => {
    const { fetch } = mockEndpoint({
      status: 200,
      body: { TreeJson: '{"id":"root"}', Ops: [], Version: '1.2.0' },
    });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const result = (await client.generate({ prompt: 'go' })) as Produced;

    expect(result.treeJson).toBe('{"id":"root"}');
    expect(result.version).toBe('1.2.0');
  });

  it('401 → accessDenied from the nested envelope', async () => {
    const { fetch } = mockEndpoint({
      status: 401,
      body: { error: { code: 'ACCESS_DENIED', message: 'access token expired' } },
    });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const result = await client.generate({ prompt: 'go' });

    expect(result).toEqual({ kind: 'accessDenied', reason: 'access token expired' });
  });

  it('401 still reads the retired bare Reason member', async () => {
    const { fetch } = mockEndpoint({ status: 401, body: { Reason: 'access token expired' } });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    expect(await client.generate({ prompt: 'go' })).toEqual({
      kind: 'accessDenied',
      reason: 'access token expired',
    });
  });

  it('422 → turnFailed carrying the recoverable envelope (stage/code/message)', async () => {
    const { fetch } = mockEndpoint({
      status: 422,
      body: { error: { stage: 'apply', code: 'APPLY_REJECTED', message: 'node not found' } },
    });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const result = await client.generate({ prompt: 'rename the metric to ARR' });

    expect(result).toEqual({
      kind: 'turnFailed',
      error: { stage: 'apply', code: 'APPLY_REJECTED', message: 'node not found' },
    });
  });

  it("a 400 refusal keeps the endpoint's own code, not HTTP_400", async () => {
    // A body-carried key must be rotated and a missing key header must be
    // supplied. `HTTP_400` says neither.
    const { fetch } = mockEndpoint({
      status: 400,
      body: { error: { code: 'SECRETS_IN_BODY', message: 'rotate it' } },
    });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const result = await client.generate({ prompt: 'go' });

    expect(result.kind).toBe('turnFailed');
    if (result.kind === 'turnFailed') {
      expect(result.error.code).toBe('SECRETS_IN_BODY');
    }
  });

  it('405 / 500 / 503 all arrive through the same envelope', async () => {
    for (const [status, code] of [
      [405, 'METHOD_NOT_ALLOWED'],
      [500, 'TURN_FAULTED'],
      [503, 'HOST_NOT_CONFIGURED'],
    ] as const) {
      const { fetch } = mockEndpoint({ status, body: { error: { code, message: 'm' } } });
      const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });
      const result = await client.generate({ prompt: 'go' });
      expect(result.kind).toBe('turnFailed');
      if (result.kind === 'turnFailed') {
        expect(result.error.code).toBe(code);
      }
    }
  });

  it('an unexpected status with no envelope → a synthesised provider failure', async () => {
    const { fetch } = mockEndpoint({ status: 502, body: {} });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const result = await client.generate({ prompt: 'go' });

    expect(result.kind).toBe('turnFailed');
    if (result.kind === 'turnFailed') {
      expect(result.error.stage).toBe('provider');
      expect(result.error.code).toBe('HTTP_502');
    }
  });

  it('generateDetailed hands back the deployment facts beside the result', async () => {
    const { fetch } = mockEndpoint({ status: 200, body: producedBody(2) });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const { result, detail } = await client.generateDetailed({ prompt: 'go' });

    expect(result.kind).toBe('produced');
    expect(detail?.opsApplied).toBe(2);
    expect(detail?.provider).toBe('openai');
    expect(detail?.servedModel).toBe('gpt-4o-2024-11-20');
    expect(detail?.snapshot?.state).toBe('warm');
  });

  it('an absent servedModel reads as unreported, never as the asked-for model', async () => {
    const body = producedBody();
    delete (body as Record<string, unknown>)['servedModel'];
    const { fetch } = mockEndpoint({ status: 200, body });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const { detail } = await client.generateDetailed({ prompt: 'go' });

    expect(detail?.servedModel).toBeUndefined();
    expect(detail?.provider).toBe('openai');
  });
});

describe('FuaranClient — hardening', () => {
  it('a 200 with no tree is MALFORMED_RESPONSE, not produced with an empty tree', async () => {
    // Red before: this returned `produced` with `treeJson: ''`, and the session
    // then held '' and repaired nothing on every subsequent turn — a fault that
    // surfaces one turn later than the reply that caused it.
    for (const body of [{ version: '1.6.0', opsApplied: 0 }, {}, null]) {
      const { fetch } = mockEndpoint({ status: 200, body });
      const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });
      const result = await client.generate({ prompt: 'go' });
      expect(result.kind).toBe('turnFailed');
      if (result.kind === 'turnFailed') {
        expect(result.error.code).toBe(CLIENT_CODES.malformedResponse);
      }
    }
  });

  it('a plaintext non-loopback endpoint is refused before anything is sent', async () => {
    const { fetch, calls } = mockEndpoint({ status: 200, body: producedBody() });
    const client = new FuaranClient({
      endpoint: 'http://api.example.com/generate',
      accessToken: 'tok',
      providerKey: 'sk-key',
      fetch,
    });

    const result = await client.generate({ prompt: 'go' });

    expect(result.kind).toBe('turnFailed');
    if (result.kind === 'turnFailed') {
      expect(result.error.code).toBe(CLIENT_CODES.insecureEndpoint);
    }
    expect(calls).toHaveLength(0);
  });

  it('loopback, https and a relative proxy path are all admitted', async () => {
    for (const endpoint of [
      'http://127.0.0.1:8123',
      'http://localhost:8123/generate',
      'https://api.example.com/generate',
      '/api/fuaran',
    ]) {
      expect(isSecureEndpoint(endpoint)).toBe(true);
      const { fetch } = mockEndpoint({ status: 200, body: producedBody() });
      const client = new FuaranClient({ endpoint, fetch });
      expect((await client.generate({ prompt: 'go' })).kind).toBe('produced');
    }
  });

  it('allowInsecureEndpoint is the deliberate opt-out', async () => {
    const { fetch, calls } = mockEndpoint({ status: 200, body: producedBody() });
    const client = new FuaranClient({
      endpoint: 'http://api.example.com/generate',
      allowInsecureEndpoint: true,
      fetch,
    });

    expect((await client.generate({ prompt: 'go' })).kind).toBe('produced');
    expect(calls).toHaveLength(1);
  });

  it('an elapsed timeoutMs is NETWORK with a fixed message', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch, timeoutMs: 20 });

    const result = await client.generate({ prompt: 'go' });

    expect(result.kind).toBe('turnFailed');
    if (result.kind === 'turnFailed') {
      expect(result.error.code).toBe(CLIENT_CODES.network);
      expect(result.error.message).toContain('timed out');
    }
  });

  it("a caller's AbortSignal ends the call as NETWORK, never a rejection", async () => {
    const controller = new AbortController();
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const pending = client.generate({ prompt: 'go' }, { signal: controller.signal });
    controller.abort();
    const result = await pending;

    expect(result.kind).toBe('turnFailed');
    if (result.kind === 'turnFailed') {
      expect(result.error.code).toBe(CLIENT_CODES.network);
    }
  });

  it('no upstream error text reaches the caller', async () => {
    // Red before: the message was the fetch error verbatim, and this result is
    // routinely rendered straight into the page.
    const fetch: FetchLike = () =>
      Promise.reject(new Error('connect ECONNREFUSED internal-proxy.corp:9443'));
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const result = await client.generate({ prompt: 'go' });

    expect(result.kind).toBe('turnFailed');
    if (result.kind === 'turnFailed') {
      expect(result.error.code).toBe(CLIENT_CODES.network);
      expect(result.error.message).not.toContain('internal-proxy');
      expect(result.error.message).not.toContain('ECONNREFUSED');
    }
  });
});
