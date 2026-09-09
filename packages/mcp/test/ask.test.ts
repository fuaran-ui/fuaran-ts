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
      headers: { 'content-type': 'application/json', 'x-fuaran-nonce': handle.nonce },
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
      headers: { 'content-type': 'application/json', 'x-fuaran-nonce': handle.nonce },
      body: JSON.stringify({ answer: { choice: 'nope' } }),
    });
    expect(badRes.status).toBe(422);

    const declineRes = await fetch(`${handle.url}decline`, {
      method: 'POST',
      headers: { 'x-fuaran-nonce': handle.nonce },
    });
    expect(declineRes.status).toBe(200);

    const outcome = await handle.done;
    expect(outcome.outcome.kind).toBe('Declined');
  });
});

describe('fuaran_ask — the loopback host refuses what it is not being asked by the human', () => {
  // The host binds to loopback, which keeps it off the network and does NOT make
  // it private: any page in any browser on this machine can reach 127.0.0.1 on a
  // guessed port, and a POST with a simple content type is sent with no
  // preflight — so before Phase 1652 a hostile page could ANSWER or DECLINE the
  // human's elicitation, and never needed to read the reply to do it. Each case
  // below is one of those requests.

  it('refuses a POST carrying no nonce', async () => {
    const handle = await startElicitationServer(minimalEnv);
    try {
      const res = await fetch(`${handle.url}resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: { choice: 'production' } }),
      });
      expect(res.status).toBe(403);
    } finally {
      handle.close();
    }
  });

  it('refuses a POST carrying the WRONG nonce', async () => {
    const handle = await startElicitationServer(minimalEnv);
    try {
      const res = await fetch(`${handle.url}resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fuaran-nonce': 'f'.repeat(32) },
        body: JSON.stringify({ answer: { choice: 'production' } }),
      });
      expect(res.status).toBe(403);
    } finally {
      handle.close();
    }
  });

  it('refuses a DECLINE carrying no nonce — the cheaper of the two to abuse', async () => {
    // No body, no contract to satisfy, and it settles the elicitation just as
    // finally as an answer does. It had no check at all.
    const handle = await startElicitationServer(minimalEnv);
    try {
      const res = await fetch(`${handle.url}decline`, { method: 'POST' });
      expect(res.status).toBe(403);
    } finally {
      handle.close();
    }
  });

  it('refuses a request a browser reports as cross-site, nonce or no nonce', async () => {
    const handle = await startElicitationServer(minimalEnv);
    try {
      const res = await fetch(`${handle.url}decline`, {
        method: 'POST',
        headers: { 'x-fuaran-nonce': handle.nonce, 'sec-fetch-site': 'cross-site' },
      });
      expect(res.status).toBe(403);
    } finally {
      handle.close();
    }
  });

  it('refuses a request whose Origin is not this host', async () => {
    const handle = await startElicitationServer(minimalEnv);
    try {
      const res = await fetch(`${handle.url}decline`, {
        method: 'POST',
        headers: { 'x-fuaran-nonce': handle.nonce, origin: 'https://example.invalid' },
      });
      expect(res.status).toBe(403);
    } finally {
      handle.close();
    }
  });

  it('caps the answer body it will read', async () => {
    const handle = await startElicitationServer(minimalEnv);
    try {
      // Well past the cap. The host destroys the socket rather than reading on,
      // so `fetch` may reject with a transport error OR see a 413 — both are the
      // refusal, and asserting only one would make the test flaky about which
      // side noticed first. What must NOT happen is a 200.
      const huge = JSON.stringify({ answer: { choice: 'x'.repeat(2_000_000) } });
      const status = await fetch(`${handle.url}resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fuaran-nonce': handle.nonce },
        body: huge,
      }).then(
        (r) => r.status,
        () => 'transport-refused' as const,
      );
      expect(status).not.toBe(200);
    } finally {
      handle.close();
    }
  });

  it('still serves the question page to a plain GET', async () => {
    // The guard is on the MUTATING routes only. A check that also refused the
    // GET would be "working" by making the tool useless.
    const handle = await startElicitationServer(minimalEnv);
    try {
      const res = await fetch(handle.url);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('name="choice"');
      // The page carries the nonce — that is how the human's own browser gets it,
      // and reading this page is exactly what the same-origin policy denies to
      // every other origin.
      expect(html).toContain(handle.nonce);
    } finally {
      handle.close();
    }
  });
});
