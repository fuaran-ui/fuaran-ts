import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

import { FuaranClient, FuaranSession } from '@fuaran-ui/client';
import { decodeNode } from '@fuaran-ui/ops';

import { startMockServer } from '../src/index.js';

// The acceptance test: a full SDK integration loop, offline, against the mock —
// no token, no BYOK spend. This is exactly the developer flow the mock exists
// to enable; swapping `endpoint` to the real URL is the only change to go live.

describe('@fuaran-ui/mock — end-to-end against the real @fuaran-ui/client', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = await startMockServer({ port: 0 }); // port 0 → an ephemeral free port
    server = started.server;
    baseUrl = `http://127.0.0.1:${started.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('generate() returns a produced tree that decodes to a real Node', async () => {
    const client = new FuaranClient({ endpoint: baseUrl });
    const result = await client.generate({ prompt: 'a metric strip showing revenue' });

    expect(result.kind).toBe('produced');
    if (result.kind === 'produced') {
      const decoded = decodeNode(result.treeJson);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.id).toBe('metric-1');
      }
    }
  });

  it('a session carries the tree forward across turns (the repair loop, offline)', async () => {
    const session = new FuaranSession(new FuaranClient({ endpoint: baseUrl }));

    const first = await session.next('a sign up form');
    expect(first.kind).toBe('produced');
    if (first.kind === 'produced') {
      expect(first.ops).toHaveLength(0); // fresh turn: no diff
    }
    expect(session.currentTreeJson).toBeDefined();

    const second = await session.next('tweak the form');
    expect(second.kind).toBe('produced');
    if (second.kind === 'produced') {
      // repair turn: the mock returns the small diff op
      expect(second.ops).toHaveLength(1);
    }
  });

  it('a client certified here meets the same refusals a deployment sends', async () => {
    // The whole claim of the mock, made falsifiable: the SDK's refusal paths
    // are exercised against the mock's envelope, which is the endpoint's.
    const client = new FuaranClient({ endpoint: baseUrl });

    const denied = await client.generate({ prompt: 'mock:access-denied' });
    expect(denied.kind).toBe('accessDenied');

    const failed = await client.generate({ prompt: 'mock:turn-failed' });
    expect(failed.kind).toBe('turnFailed');
    if (failed.kind === 'turnFailed') {
      expect(failed.error.stage).toBe('apply');
      expect(failed.error.code).toBe('APPLY_REJECTED');
    }

    const unconfigured = await client.generate({ prompt: 'mock:unconfigured' });
    expect(unconfigured.kind).toBe('turnFailed');
    if (unconfigured.kind === 'turnFailed') {
      // The endpoint's own code survives the 503, rather than becoming HTTP_503.
      expect(unconfigured.error.code).toBe('HOST_NOT_CONFIGURED');
    }
  });

  it('reports the deployment facts the endpoint carries', async () => {
    const client = new FuaranClient({ endpoint: baseUrl });
    const { detail } = await client.generateDetailed({ prompt: 'a sign up form' });

    expect(detail?.opsApplied).toBe(0);
    expect(detail?.provider).toBeTypeOf('string');
    expect(detail?.servedModel).toBeTypeOf('string');
  });
});
