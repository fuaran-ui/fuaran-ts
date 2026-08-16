// ============================================================================
//  The shared `sanitization/` corpus family, run against this host's URL floor.
//
//  Unlike every other corpus family this one is NOT byte-parity: the markup a
//  host wraps around a URL differs legitimately between this React renderer, a
//  static-HTML emitter and a WASM client, so comparing those bytes would pin
//  accidents rather than the contract. Each case states an INVARIANT instead —
//  `reject` (refuse it) or `accept` (take it, and emit the normalised form) —
//  plus the reason the URL parser gives, which is what makes the case meaningful.
//
//  The corpus verifies its own `reason` claims against a real WHATWG parser
//  (`sanitization/verify-against-url-parser.mjs`); this suite verifies that THIS
//  host agrees with the resulting invariants.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sanitizeUrl, sanitizeUrlOrBlank } from '../src/sanitize.js';

interface Case {
  id: string;
  input: string;
  invariant: 'reject' | 'accept';
  expected?: string;
}

const findManifest = (): string | undefined => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'wire-format-fixtures', 'sanitization', 'manifest.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

const loadCases = (): Case[] => {
  const path = findManifest();
  if (path === undefined) return [];
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { groups: { cases: Case[] }[] };
  return manifest.groups.flatMap((g) => g.cases);
};

const cases = loadCases();

describe('sanitization corpus — the §19 URL floor', () => {
  it('the corpus family is present', () => {
    // A loader that silently found nothing would make every case below vacuous,
    // so the count is asserted rather than assumed.
    expect(
      cases.length,
      'wire-format-fixtures/sanitization/manifest.json not found',
    ).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const got = sanitizeUrl(c.input);
    if (c.invariant === 'reject') {
      expect(got).toBeUndefined();
      // §19 rule 6 — the or-blank variant substitutes about:blank.
      expect(sanitizeUrlOrBlank(c.input)).toBe('about:blank');
    } else {
      expect(got).toBe(c.expected);
    }
  });
});
