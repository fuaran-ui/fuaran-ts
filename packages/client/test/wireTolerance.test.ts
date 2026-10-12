// Phase 2077 — the wire mapping's tolerance defects.
//
//   - A retired PascalCase stage (`Apply`) used to read as `provider`, which the
//     repair loop treats as terminal, so the shape the header promises to
//     tolerate silently disabled repair. Its rows now live in the cross-host
//     stage table, `turnStage.test.ts` (Phase 2134).
//   - An object `tree` used to be re-serialised with `JSON.stringify`, so the
//     caller held bytes the endpoint never sent (`1.0` became `1`, an escape
//     became its character) — and the repair loop sends those bytes back.

import { describe, expect, it } from 'vitest';

import { parseProducedDetail, parseTurnResponse } from '../src/index.js';

describe('readTree — an object tree keeps the bytes the reply carried', () => {
  const tree = '{ "id": "root", "n": 1.0, "s": "\\u00e9", "nested": { "a": [1, {"b": "}"}] } }';
  const body = `{"version":"1.6.0","tree":${tree},"opsApplied":0}`;

  it('returns the tree member verbatim, not re-serialised', () => {
    const result = parseTurnResponse(200, body);
    expect(result.kind === 'produced' && result.treeJson).toBe(tree);
    expect(parseProducedDetail(200, body)?.opsApplied).toBe(0);
  });

  it('takes the member JSON.parse keeps when a key repeats, and the retired TreeJson', () => {
    const repeated = `{"tree":{"id":"old"},"tree":${tree}}`;
    const r1 = parseTurnResponse(200, repeated);
    expect(r1.kind === 'produced' && r1.treeJson).toBe(tree);

    const retired = `{"Version":"1.2.0","TreeJson":${tree}}`;
    const r2 = parseTurnResponse(200, retired);
    expect(r2.kind === 'produced' && r2.treeJson).toBe(tree);
  });

  it('is not confused by a "tree" key nested inside another member', () => {
    const decoy = `{"meta":{"tree":{"id":"decoy"}},"tree":${tree}}`;
    const result = parseTurnResponse(200, decoy);
    expect(result.kind === 'produced' && result.treeJson).toBe(tree);
  });
});
