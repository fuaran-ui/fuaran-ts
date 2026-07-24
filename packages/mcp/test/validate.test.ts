// fuaran_validate agrees with the canonical schema — driven by the shared
// wire-format fixture corpus, so "agrees" is asserted against the same
// executable contract every conformant host certifies with.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runValidate } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/mcp/test → workspace-root/wire-format-fixtures
const corpusRoot = join(here, '..', '..', '..', '..', 'wire-format-fixtures');

interface ManifestFixture {
  readonly id: string;
  readonly kind: 'node-round-trip' | 'op-round-trip' | 'reject' | 'lenient-accept';
  readonly decoder: 'node' | 'op';
  readonly inputFile: string;
  readonly expectedErrorCode?: string;
  readonly expectedPath?: string;
}

const manifest = JSON.parse(readFileSync(join(corpusRoot, 'manifest.json'), 'utf8')) as {
  readonly fixtures: readonly ManifestFixture[];
};

const readFixture = (relPath: string): string => readFileSync(join(corpusRoot, relPath), 'utf8');

const accepts = manifest.fixtures.filter(
  (f) => f.kind === 'node-round-trip' || f.kind === 'op-round-trip',
);
const rejects = manifest.fixtures.filter((f) => f.kind === 'reject');

describe('fuaran_validate vs the canonical corpus', () => {
  it.each(accepts.map((f) => [f.id, f] as const))('%s validates', (_id, f) => {
    const result = runValidate({ json: readFixture(f.inputFile), kind: f.decoder });
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it.each(rejects.map((f) => [f.id, f] as const))('%s is rejected with diagnostics', (_id, f) => {
    const result = runValidate({ json: readFixture(f.inputFile), kind: f.decoder });
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    const diag = result.diagnostics[0]!;
    if (f.expectedErrorCode !== undefined) {
      expect(diag.code).toBe(f.expectedErrorCode);
    }
    if (f.expectedPath !== undefined) {
      // The corpus contract is prefix-match on the path (a host may report a
      // deeper position within the offending value) — same assertion the
      // canonical conformance suite makes.
      expect(diag.path.startsWith(f.expectedPath)).toBe(true);
    }
  });

  it('defaults to node validation and reports invalid JSON structurally', () => {
    const result = runValidate({ json: 'not json at all' });
    expect(result.kind).toBe('node');
    expect(result.valid).toBe(false);
    expect(result.diagnostics[0]!.code).toBe('INVALID_JSON');
    expect(result.diagnostics[0]!.path).toBe('$');
  });
});
