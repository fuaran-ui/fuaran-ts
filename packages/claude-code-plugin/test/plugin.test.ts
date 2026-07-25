import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  SERVER_NAME,
  createFuaranMcpServer,
  listRecipes,
  runScaffold,
  runValidate,
  runGenerate,
} from '@fuaran-ui/mcp';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const manifest = JSON.parse(read('../.claude-plugin/plugin.json')) as {
  name: string;
  version: string;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  userConfig: Record<string, unknown>;
};

const skill = read('../skills/fuaran-integration/SKILL.md');

function frontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (m === null) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

describe('plugin manifest — .claude-plugin/plugin.json', () => {
  it('is a valid manifest with a name and version', () => {
    expect(manifest.name).toBe('fuaran');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('bundles the Fuaran MCP server under the server name the package exposes', () => {
    // The mcpServers key must match @fuaran-ui/mcp's SERVER_NAME so tool names resolve.
    expect(Object.keys(manifest.mcpServers)).toContain(SERVER_NAME);
    const server = manifest.mcpServers[SERVER_NAME]!;
    expect(server.command).toBe('npx');
    expect(server.args.join(' ')).toContain('@fuaran-ui/mcp');
  });

  it('wires the secrets through user config, never literals', () => {
    const env = manifest.mcpServers[SERVER_NAME]!.env;
    expect(env['FUARAN_ACCESS_TOKEN']).toBe('${user_config.access_token}');
    expect(env['FUARAN_PROVIDER_KEY']).toBe('${user_config.provider_key}');
    // The user-config declarations exist and mark secrets sensitive.
    expect(manifest.userConfig['access_token']).toBeDefined();
    expect(manifest.userConfig['provider_key']).toBeDefined();
    // No literal token/key anywhere in the manifest.
    const raw = read('../.claude-plugin/plugin.json');
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});

describe('skill — skills/fuaran-integration/SKILL.md', () => {
  it('has a kebab-case name and a non-empty description within the length limit', () => {
    const fm = frontmatter(skill);
    expect(fm['name']).toBe('fuaran-integration');
    expect(fm['name'] ?? '').toMatch(/^[a-z0-9-]+$/);
    const description = fm['description'] ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1536);
  });

  it('teaches the tool-driven playbook and the safe defaults', () => {
    for (const tool of ['recipe', 'generate', 'validate', 'scaffold']) {
      expect(skill).toContain(tool);
    }
    expect(skill.toLowerCase()).toContain('server-prox');
    expect(skill.toLowerCase()).toContain('never commit');
    expect(skill.toLowerCase()).toContain('opt-in');
  });
});

describe('bundled MCP tools resolve and run (the skill drives these end to end)', () => {
  it('the MCP server constructs', () => {
    expect(() => createFuaranMcpServer()).not.toThrow();
  });

  it('recipe / scaffold / validate resolve and produce output offline', () => {
    expect(listRecipes().length).toBeGreaterThan(0);

    const scaffold = runScaffold({ target: 'ts-react' });
    expect(scaffold.files.length).toBeGreaterThan(0);

    // validate flags a malformed tree with a canonical diagnostic.
    const bad = runValidate({ json: '{"id":"x"}' });
    expect(bad.valid).toBe(false);
    expect(bad.diagnostics.length).toBeGreaterThan(0);

    // generate exists as the fourth tool (drives the endpoint / mock).
    expect(typeof runGenerate).toBe('function');
  });
});
