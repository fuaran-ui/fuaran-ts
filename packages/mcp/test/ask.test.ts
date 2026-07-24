// Phase 467 — fuaran_ask elicitation tool.
//
// Certifies the tool's validate-before-render path against the Phase 465
// elicitation fixture family, and exercises the answer host end to end
// (question render, contract-conforming resolution, decline) over loopback.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  decodeElicitation,
  decodeElicitationOutcome,
  encodeElicitationOutcome,
} from '@fuaran-ui/ops';

import {
  buildAnswerPage,
  coerceAnswer,
  resolveOutcome,
  startElicitationServer,
} from '../src/tools/ask.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const corpusRoot = join(here, '..', '..', '..', '..', 'wire-format-fixtures');
const readFixture = (relPath: string): string => readFileSync(join(corpusRoot, relPath), 'utf8');

interface ManifestFixture {
  readonly id: string;
  readonly kind: string;
  readonly decoder?: string;
  readonly inputFile: string;
  readonly expectedFile?: string;
  readonly expectedErrorCode?: string;
  readonly expectedPath?: string;
}
interface Manifest {
  readonly fixtures: readonly ManifestFixture[];
}

const manifest = JSON.parse(readFixture('manifest.json')) as Manifest;
const roundTrips = manifest.fixtures.filter(
  (f) => f.kind === 'elicitation-round-trip' && f.decoder === 'elicitation',
);
const rejects = manifest.fixtures.filter(
  (f) => f.kind === 'elicitation-reject' && f.decoder === 'elicitation',
);

const minimalEnv = (() => {
  const decoded = decodeElicitation(readFixture('elicitation/elc-minimal.json'));
  if (!decoded.ok) throw new Error('elc-minimal fixture failed to decode');
  return decoded.value;
})();

describe('fuaran_ask — envelope codec is fixture-certified', () => {
  it('has fixtures to certify against', () => {
    expect(roundTrips.length).toBeGreaterThan(0);
    expect(rejects.length).toBeGreaterThan(0);
  });

  it.each(roundTrips.map((f) => [f.id, f] as const))(
    'accepts the valid envelope %s (validate-before-render)',
    (_id, f) => {
      const decoded = decodeElicitation(readFixture(f.inputFile));
      expect(decoded.ok).toBe(true);
    },
  );

  it.each(rejects.map((f) => [f.id, f] as const))(
    'refuses the malformed envelope %s with the declared code',
    (_id, f) => {
      const decoded = decodeElicitation(readFixture(f.inputFile));
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) {
        expect(decoded.error.code).toBe(f.expectedErrorCode);
        expect(decoded.error.path.startsWith(f.expectedPath ?? '$')).toBe(true);
      }
    },
  );
});

describe('fuaran_ask — answer host', () => {
  it('renders the question and an input per contract field', () => {
    const page = buildAnswerPage(minimalEnv);
    expect(page).toContain('Which environment');
    expect(page).toContain('name="choice"');
    expect(page).toContain('staging');
  });

  it('resolves a conforming answer to Answered and refuses a non-conforming one', () => {
    const good = resolveOutcome(minimalEnv, coerceAnswer(minimalEnv, { choice: 'staging' }));
    expect(good.ok).toBe(true);

    const bad = resolveOutcome(minimalEnv, coerceAnswer(minimalEnv, { choice: 'nope' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('ANSWER_OUT_OF_SPACE');
  });

  it('serves the question, accepts a POSTed answer, and returns one typed outcome', async () => {
    const handle = await startElicitationServer(minimalEnv);

    const pageRes = await fetch(handle.url);
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain('name="choice"');

    const postRes = await fetch(`${handle.url}resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: { choice: 'production' } }),
    });
    expect(postRes.status).toBe(200);

    const outcome = await handle.done;
    expect(outcome.outcome.kind).toBe('Answered');
    if (outcome.outcome.kind === 'Answered') {
      expect(outcome.outcome.answer.get('choice')).toBe('production');
    }

    // The outcome round-trips through the public codec.
    const re = decodeElicitationOutcome(encodeElicitationOutcome(outcome));
    expect(re.ok).toBe(true);
  });

  it('refuses a non-conforming POST (422) without resolving, then a decline settles Declined', async () => {
    const handle = await startElicitationServer(minimalEnv);

    const badRes = await fetch(`${handle.url}resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: { choice: 'nope' } }),
    });
    expect(badRes.status).toBe(422);

    const declineRes = await fetch(`${handle.url}decline`, { method: 'POST' });
    expect(declineRes.status).toBe(200);

    const outcome = await handle.done;
    expect(outcome.outcome.kind).toBe('Declined');
  });
});
