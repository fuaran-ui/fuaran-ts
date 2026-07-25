import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startMockServer } from '@fuaran-ui/mock';

import { run } from '../src/index.js';

const validTree = '{"id":"badge-1","kind":{"$type":"Badge","label":"Beta","variant":"Info"}}';

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fuaran-cli-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('fuaran validate', () => {
  it('passes a canonical tree', async () => {
    const f = join(tmp, 'good.json');
    writeFileSync(f, validTree);
    const r = await run(['validate', f]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('valid');
  });

  it('fails a malformed tree with a diagnostic', async () => {
    const f = join(tmp, 'bad.json');
    writeFileSync(f, '{"id":"x"}');
    const r = await run(['validate', f]);
    expect(r.code).toBe(1);
    expect(r.out.toLowerCase()).toContain('invalid');
  });
});

describe('fuaran recipe', () => {
  it('returns a matching recipe for a known pattern', async () => {
    const r = await run(['recipe', 'a', 'row', 'of', 'metric', 'tiles']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('ui.metric-strip');
    expect(r.out).toContain('Canonical prompts');
  });
});

describe('fuaran scaffold', () => {
  it('emits ts-react files', async () => {
    const r = await run(['scaffold', '--target', 'ts']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('ts-react');
    expect(r.out).toContain('====');
  });

  it('emits fsharp-fable files (always server-proxied by design)', async () => {
    const r = await run(['scaffold', '--target', 'fsharp']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('fsharp-fable');
    expect(r.out).toContain('server-proxied');
  });

  it('honours the browser-byok pattern for ts-react', async () => {
    const r = await run(['scaffold', '--target', 'ts', '--pattern', 'browser-byok']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('browser-byok');
  });

  it('requires a target', async () => {
    const r = await run(['scaffold']);
    expect(r.code).toBe(2);
  });
});

describe('fuaran generate --mock (offline, no secret)', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const started = await startMockServer({ port: 0 });
    server = started.server;
    url = `http://127.0.0.1:${started.port}`;
  });
  afterAll(() => server.close());

  it('produces a canonical tree against the mock', async () => {
    const r = await run(['generate', 'a metric strip showing revenue', '--mock', url]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"$type":"Metric"');
  });

  it('never prints a token or key', async () => {
    process.env['FUARAN_ACCESS_TOKEN'] = 'secret-tok';
    const r = await run(['generate', 'a button', '--mock', url]);
    expect(r.out).not.toContain('secret-tok');
    delete process.env['FUARAN_ACCESS_TOKEN'];
  });
});

describe('fuaran help', () => {
  it('prints usage with no args', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage:');
  });
});
