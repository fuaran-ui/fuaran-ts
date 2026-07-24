// End-to-end over the MCP protocol: an in-memory client lists and calls the
// four tools exactly as an agent host would — including the no-leak guarantee
// (the BYOK key + access token never appear in tool output, even when an
// upstream response quotes them).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import type { FetchLike } from '@fuaran-ui/client';

import { createFuaranMcpServer, type CreateServerOptions } from '../src/index.js';

const SENTINEL_TOKEN = 'SENTINEL-ACCESS-TOKEN-93f1';
const SENTINEL_KEY = 'SENTINEL-BYOK-KEY-7c2a';

async function connect(options?: CreateServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFuaranMcpServer(options);
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

describe('the fuaran MCP server over the wire', () => {
  it('exposes exactly the five tools, none taking a credential argument', async () => {
    const client = await connect({ config: {} });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'fuaran_ask',
      'fuaran_generate',
      'fuaran_recipe',
      'fuaran_scaffold',
      'fuaran_validate',
    ]);
    for (const tool of tools) {
      const properties = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      ).map((p) => p.toLowerCase());
      expect(properties.filter((p) => p.includes('token') || p.includes('key'))).toEqual([]);
    }
  });

  it('serves fuaran_validate + fuaran_recipe end-to-end', async () => {
    const client = await connect({ config: {} });

    const invalid = await client.callTool({
      name: 'fuaran_validate',
      arguments: { json: '{"kind":{"$type":"Markdown"}}' },
    });
    expect(textOf(invalid)).toContain('"valid": false');

    const recipe = await client.callTool({
      name: 'fuaran_recipe',
      arguments: { query: 'a form with validated fields' },
    });
    expect(textOf(recipe)).toContain('"tag": "ui.form"');
  });

  it('serves the whole recipe index when nothing matches', async () => {
    const client = await connect({ config: {} });
    const result = await client.callTool({
      name: 'fuaran_recipe',
      arguments: { query: 'zzzzz qqqqq' },
    });
    expect(textOf(result)).toContain('"allRecipes"');
  });

  it('never leaks the access token or BYOK key into tool output', async () => {
    // A hostile upstream: the endpoint echoes both credentials back in an
    // error body. The redaction pass must scrub them from the tool result.
    const echoingFetch: FetchLike = (_url, init) =>
      Promise.resolve({
        status: 500,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              Message: `upstream saw ${init.headers['authorization']} and body ${init.body}`,
            }),
          ),
      });

    const client = await connect({
      config: {
        endpoint: 'https://example.test/generate',
        accessToken: SENTINEL_TOKEN,
        providerKey: SENTINEL_KEY,
      },
      fetch: echoingFetch,
    });

    const result = await client.callTool({
      name: 'fuaran_generate',
      arguments: { prompt: 'anything' },
    });
    const text = textOf(result);
    expect(text).not.toContain(SENTINEL_TOKEN);
    expect(text).not.toContain(SENTINEL_KEY);
    expect(text).toContain('[redacted]');
  });

  it('explains missing configuration without echoing partial secrets', async () => {
    const client = await connect({ config: { accessToken: SENTINEL_TOKEN } });
    const result = await client.callTool({
      name: 'fuaran_generate',
      arguments: { prompt: 'anything' },
    });
    const text = textOf(result);
    expect(text).toContain('notConfigured');
    expect(text).toContain('FUARAN_ENDPOINT');
    expect(text).toContain('FUARAN_PROVIDER_KEY');
    expect(text).not.toContain(SENTINEL_TOKEN);
  });
});
