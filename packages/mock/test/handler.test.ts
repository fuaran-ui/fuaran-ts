import { describe, expect, it } from 'vitest';

import {
  handleTurn,
  handleTurnBody,
  matchTree,
  MOCK_SURFACE_VERSION,
  PLACEHOLDER_TREE_JSON,
} from '../src/index.js';

describe('@fuaran-ui/mock — the contract-faithful handler', () => {
  it('matches a prompt to a deterministic cookbook tree', () => {
    // Same prompt → same tree, every time.
    const a = matchTree('Show total revenue at the top');
    const b = matchTree('Show total revenue at the top');
    expect(a).toBe(b);
    expect(a).toContain('"$type":"Metric"');

    expect(matchTree('a sign up form')).toContain('"$type":"Form"');
    expect(matchTree('add a refresh button')).toContain('"$type":"Button"');
    expect(matchTree('a heads up banner')).toContain('"$type":"Callout"');
  });

  it('a no-match returns the deterministic placeholder, never an error', () => {
    const reply = handleTurn({ Prompt: 'xyzzy nothing matches this at all' });
    expect(reply.status).toBe(200);
    const body = reply.body as { TreeJson: string; Ops: unknown[]; Version: string };
    expect(body.TreeJson).toBe(PLACEHOLDER_TREE_JSON);
  });

  it('a fresh turn returns the tree with no ops; a repair turn returns a diff op', () => {
    const fresh = handleTurn({ Prompt: 'a metric strip' });
    expect((fresh.body as { Ops: unknown[] }).Ops).toHaveLength(0);

    const repair = handleTurn({
      Prompt: 'a metric strip',
      CurrentTreeJson: '{"id":"x","kind":{}}',
    });
    const ops = (repair.body as { Ops: Array<{ OpId: string; OpJson: string }> }).Ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]?.OpJson).toContain('"$type":"UpdateProp"');
  });

  it('echoes the surface version on every produced turn', () => {
    const reply = handleTurn({ Prompt: 'a button' });
    expect((reply.body as { Version: string }).Version).toBe(MOCK_SURFACE_VERSION);
  });

  it('reads no secret and never echoes one back (zero-secret posture)', () => {
    // Tokens are supplied but must be ignored and never surface in the reply.
    const reply = handleTurn({
      Prompt: 'a metric',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ AccessToken: 'secret-access-token', ByokKey: 'sk-super-secret' } as any),
    });
    const serialised = JSON.stringify(reply);
    expect(serialised).not.toContain('secret-access-token');
    expect(serialised).not.toContain('sk-super-secret');
  });

  it('tolerates a malformed / empty body as an empty fresh request', () => {
    expect(handleTurnBody('').status).toBe(200);
    expect(handleTurnBody('not json{{').status).toBe(200);
    expect((handleTurnBody('').body as { TreeJson: string }).TreeJson).toBe(PLACEHOLDER_TREE_JSON);
  });
});
