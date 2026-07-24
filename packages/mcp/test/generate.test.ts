// fuaran_generate round-trips against the generation endpoint's contract —
// asserted with a mock endpoint speaking the documented (status, body) map.

import { describe, expect, it } from 'vitest';

import type { FetchLike } from '@fuaran-ui/client';

import {
  ENV_ACCESS_TOKEN,
  ENV_ENDPOINT,
  ENV_PROVIDER_KEY,
  runGenerate,
  type FuaranMcpConfig,
} from '../src/index.js';

const CONFIG: FuaranMcpConfig = {
  endpoint: 'https://example.test/generate',
  accessToken: 'token-abc',
  providerKey: 'key-def',
};

const TREE = '{"id":"root","kind":{"$type":"Markdown","text":{"$type":"Literal","text":"hi"}}}';

function mockEndpoint(
  status: number,
  body: unknown,
): {
  fetch: FetchLike;
  requests: { url: string; body: string; headers: Record<string, string> }[];
} {
  const requests: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = (url, init) => {
    requests.push({ url, body: init.body, headers: init.headers });
    return Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) });
  };
  return { fetch, requests };
}

describe('fuaran_generate', () => {
  it('maps a 200 onto produced with tree + ops + version', async () => {
    const { fetch, requests } = mockEndpoint(200, {
      TreeJson: TREE,
      Ops: [{ OpId: 'op-1', OpJson: '{"$type":"ReplaceRoot"}' }],
      Version: '1.2.0',
    });
    const result = await runGenerate({ prompt: 'a hello panel' }, CONFIG, fetch);
    expect(result).toEqual({
      status: 'produced',
      treeJson: TREE,
      ops: [{ opId: 'op-1', opJson: '{"$type":"ReplaceRoot"}' }],
      version: '1.2.0',
    });

    // The wire body carries the prompt + the env-sourced credentials.
    const sent = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(sent['Prompt']).toBe('a hello panel');
    expect(sent['AccessToken']).toBe('token-abc');
    expect(sent['ByokKey']).toBe('key-def');
    expect(requests[0]!.headers['authorization']).toBe('Bearer token-abc');
  });

  it('threads currentTreeJson through as a repair turn', async () => {
    const { fetch, requests } = mockEndpoint(200, { TreeJson: TREE, Ops: [], Version: '1.2.0' });
    await runGenerate({ prompt: 'rename it', currentTreeJson: TREE }, CONFIG, fetch);
    const sent = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(sent['CurrentTreeJson']).toBe(TREE);
  });

  it('maps a 401 onto accessDenied', async () => {
    const { fetch } = mockEndpoint(401, { Reason: 'token expired' });
    const result = await runGenerate({ prompt: 'x' }, CONFIG, fetch);
    expect(result).toEqual({ status: 'accessDenied', reason: 'token expired' });
  });

  it('maps a 422 onto a staged failure envelope', async () => {
    const { fetch } = mockEndpoint(422, {
      Error: { Stage: 'apply', Code: 'OUT_OF_SHAPE', Message: 're-emit against the hint' },
    });
    const result = await runGenerate({ prompt: 'x' }, CONFIG, fetch);
    expect(result).toEqual({
      status: 'failed',
      stage: 'apply',
      code: 'OUT_OF_SHAPE',
      message: 're-emit against the hint',
    });
  });

  it('reports missing configuration by env-var NAME, never by value', async () => {
    const result = await runGenerate({ prompt: 'x' }, { accessToken: 'secret-value' });
    expect(result.status).toBe('notConfigured');
    if (result.status === 'notConfigured') {
      expect(result.missing).toEqual([ENV_ENDPOINT, ENV_PROVIDER_KEY]);
      expect(result.missing).not.toContain(ENV_ACCESS_TOKEN);
      expect(JSON.stringify(result)).not.toContain('secret-value');
    }
  });
});
