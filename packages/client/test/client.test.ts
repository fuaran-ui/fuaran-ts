import { describe, expect, it } from 'vitest';

import {
  FuaranClient,
  SURFACE_VERSION,
  isSurfaceVersionCompatible,
  type FetchLike,
  type Produced,
} from '../src/index.js';

/** A mock endpoint that records the last request and replies with a scripted
 *  (status, body). Stands in for the real Fuaran generation endpoint. */
function mockEndpoint(reply: { status: number; body: unknown }): {
  fetch: FetchLike;
  calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;
} {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    return Promise.resolve({
      status: reply.status,
      text: () => Promise.resolve(JSON.stringify(reply.body)),
    });
  };
  return { fetch, calls };
}

describe('FuaranClient.generate — request contract', () => {
  it('mirrors the surface request shape on the wire (PascalCase keys + secrets)', async () => {
    const { fetch, calls } = mockEndpoint({
      status: 200,
      body: { TreeJson: '{}', Ops: [], Version: SURFACE_VERSION },
    });
    const client = new FuaranClient({
      endpoint: 'https://endpoint.example/generate',
      accessToken: 'tok-123',
      providerKey: 'byok-secret',
      fetch,
    });

    await client.generate({
      prompt: 'a metric card showing revenue',
      currentTreeJson: '{"prior":true}',
      disableCorpusRead: true,
      contributeCorpus: false,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://endpoint.example/generate');
    expect(call.body).toEqual({
      Prompt: 'a metric card showing revenue',
      CurrentTreeJson: '{"prior":true}',
      ByokKey: 'byok-secret',
      AccessToken: 'tok-123',
      DisableCorpusRead: true,
      ContributeCorpus: false,
    });
    // Access token also offered as a Bearer header for edge gateways.
    expect(call.headers['authorization']).toBe('Bearer tok-123');
    expect(call.headers['content-type']).toBe('application/json');
  });

  it('omits the current tree for a fresh generation, and corpus flags when unset', async () => {
    const { fetch, calls } = mockEndpoint({
      status: 200,
      body: { TreeJson: '{}', Ops: [], Version: SURFACE_VERSION },
    });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    await client.generate({ prompt: 'fresh' });

    expect(calls[0]!.body).toEqual({ Prompt: 'fresh' });
  });

  it('does not leak the BYOK key into a server-proxied request (no key configured)', async () => {
    const { fetch, calls } = mockEndpoint({
      status: 200,
      body: { TreeJson: '{}', Ops: [], Version: SURFACE_VERSION },
    });
    // Server-proxied pattern: client targets a same-origin proxy, no secrets.
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    await client.generate({ prompt: 'no secrets here' });

    const serialized = JSON.stringify(calls[0]);
    expect(serialized).not.toContain('ByokKey');
    expect(serialized).not.toContain('AccessToken');
    expect(serialized).not.toContain('authorization');
  });
});

describe('FuaranClient.generate — response discrimination', () => {
  it('200 → produced, with the tree JSON, applied ops, and echoed version', async () => {
    const { fetch } = mockEndpoint({
      status: 200,
      body: {
        TreeJson: '{"id":"root"}',
        Ops: [{ OpId: 'op-1', OpJson: '{"kind":"SetText"}' }],
        Version: SURFACE_VERSION,
      },
    });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const result = await client.generate({ prompt: 'go' });

    expect(result.kind).toBe('produced');
    const produced = result as Produced;
    expect(produced.treeJson).toBe('{"id":"root"}');
    expect(produced.ops).toEqual([{ opId: 'op-1', opJson: '{"kind":"SetText"}' }]);
    expect(produced.version).toBe(SURFACE_VERSION);
    expect(isSurfaceVersionCompatible(produced.version)).toBe(true);
  });

  it('401 → accessDenied with the reason, before any provider call', async () => {
    const { fetch } = mockEndpoint({ status: 401, body: { Reason: 'access token expired' } });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const result = await client.generate({ prompt: 'go' });

    expect(result).toEqual({ kind: 'accessDenied', reason: 'access token expired' });
  });

  it('422 → turnFailed carrying the recoverable envelope (stage/code/message)', async () => {
    const { fetch } = mockEndpoint({
      status: 422,
      body: { Stage: 'apply', Code: 'APPLY_REJECTED', Message: 'node not found' },
    });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const result = await client.generate({ prompt: 'rename the metric to ARR' });

    expect(result).toEqual({
      kind: 'turnFailed',
      error: { stage: 'apply', code: 'APPLY_REJECTED', message: 'node not found' },
    });
  });

  it('an unexpected status → turnFailed with a provider-stage envelope', async () => {
    const { fetch } = mockEndpoint({ status: 503, body: { Message: 'upstream unavailable' } });
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const result = await client.generate({ prompt: 'go' });

    expect(result.kind).toBe('turnFailed');
    if (result.kind === 'turnFailed') {
      expect(result.error.stage).toBe('provider');
      expect(result.error.code).toBe('HTTP_503');
    }
  });

  it('a network throw → turnFailed (NETWORK), never a rejected promise', async () => {
    const fetch: FetchLike = () => Promise.reject(new Error('connection refused'));
    const client = new FuaranClient({ endpoint: '/api/fuaran', fetch });

    const result = await client.generate({ prompt: 'go' });

    expect(result.kind).toBe('turnFailed');
    if (result.kind === 'turnFailed') {
      expect(result.error.code).toBe('NETWORK');
    }
  });

  it('per-call credentials override the client config', async () => {
    const { fetch, calls } = mockEndpoint({
      status: 200,
      body: { TreeJson: '{}', Ops: [], Version: SURFACE_VERSION },
    });
    const client = new FuaranClient({
      endpoint: '/api/fuaran',
      accessToken: 'config-tok',
      providerKey: 'config-key',
      fetch,
    });

    await client.generate({ prompt: 'go', accessToken: 'call-tok', providerKey: 'call-key' });

    expect(calls[0]!.body['AccessToken']).toBe('call-tok');
    expect(calls[0]!.body['ByokKey']).toBe('call-key');
  });
});
