// fuaran_formFromSchema (Phase 1914) — the reference host's formFromSchema,
// mirrored: the same arguments, the same argument refusals, and the same bytes
// as `@fuaran-ui/ui`'s derivation over the certified parity table.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { createFuaranMcpServer, FORM_FROM_SCHEMA_TOOL, runFormFromSchema } from '../src/index.js';

interface ParityCase {
  readonly name: string;
  readonly schema: string;
  readonly outcome: 'form' | 'refused';
  readonly wire: string;
}

const here = dirname(fileURLToPath(import.meta.url));
// The paired table the derivation itself is certified against.
const table = JSON.parse(
  readFileSync(join(here, '..', '..', 'ui', 'test', 'fixtures', 'schema-form-parity.json'), 'utf8'),
) as { readonly cases: readonly ParityCase[] };

const argumentsRefusal = (path: string, message: string) => ({
  ok: false,
  refusals: `{"refusals":[{"code":"invalid-arguments","message":"${message}","path":"${path}"}]}`,
});

describe('runFormFromSchema', () => {
  // A schema read through the JavaScript object model derives the certified
  // bytes whenever its key order survives that model — no integer-like names,
  // no duplicate members, and no float-spelled whole numbers.
  const objectSafe = table.cases.filter(
    (c) =>
      !c.name.startsWith('text-') &&
      !c.name.startsWith('refuse-json-') &&
      c.name !== 'refuse-schema-not-json' &&
      c.name !== 'refuse-null-in-array-not-json' &&
      c.name !== 'refuse-root-not-object-array' &&
      c.name !== 'int32-edge-and-negative-zero',
  );

  it('the object-safe slice of the parity table is most of it', () => {
    expect(objectSafe.length).toBeGreaterThan(50);
  });

  it.each(objectSafe.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = runFormFromSchema({ schema: JSON.parse(c.schema) });
    expect(result).toEqual(
      c.outcome === 'form' ? { ok: true, wire: c.wire } : { ok: false, refusals: c.wire },
    );
  });

  it('formId and submitLabel reach the derived node', () => {
    const result = runFormFromSchema({
      schema: { type: 'object', properties: { a: { type: 'string' } } },
      formId: 'signup',
      submitLabel: 'Join',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wire).toContain('"id":"signup"');
      expect(result.wire).toContain('"submitLabel":"Join"');
    }
  });

  it('refuses malformed arguments by name, in the reference host order', () => {
    expect(runFormFromSchema([])).toEqual(argumentsRefusal('', 'the arguments are not an object'));
    expect(runFormFromSchema({ schema: {}, extra: 1 })).toEqual(
      argumentsRefusal('/extra', 'unknown argument'),
    );
    expect(runFormFromSchema({})).toEqual(
      argumentsRefusal('/schema', 'the schema argument is required'),
    );
    expect(runFormFromSchema({ schema: {}, formId: '' })).toEqual(
      argumentsRefusal('/formId', 'formId must be a non-empty string'),
    );
    expect(runFormFromSchema({ schema: {}, submitLabel: 3 })).toEqual(
      argumentsRefusal('/submitLabel', 'submitLabel must be a non-empty string'),
    );
    expect(runFormFromSchema({ schema: { a: Number.NaN } })).toEqual(
      argumentsRefusal('/schema', 'the schema argument is not JSON'),
    );
  });
});

describe('fuaran_formFromSchema over the protocol', () => {
  const connect = async (): Promise<Client> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createFuaranMcpServer({ config: {} });
    const client = new Client({ name: 'test-agent', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  };

  const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
    (result.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('');

  it('returns the canonical wire verbatim', async () => {
    const client = await connect();
    const c = table.cases.find((x) => x.name === 'nested-object-group');
    expect(c).toBeDefined();
    if (c === undefined) return;
    const result = await client.callTool({
      name: FORM_FROM_SCHEMA_TOOL,
      arguments: { schema: JSON.parse(c.schema) },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(c.wire);
  });

  it('returns the refusal envelope as an error result', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: FORM_FROM_SCHEMA_TOOL,
      arguments: {
        schema: { type: 'object', properties: { a: { type: 'string', format: 'ipv4' } } },
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      '{"refusals":[{"code":"unsupported-format","message":"format \'ipv4\' has no form control or rule","path":"/properties/a/format"}]}',
    );
  });
});
