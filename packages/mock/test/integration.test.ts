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
});
