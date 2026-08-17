// ============================================================================
//  The shared `sanitization/` corpus family, run against this host's render-time
//  safety floor (`WIRE_FORMAT.md` §22; §19 for the URL group).
//
//  Unlike every other corpus family this one is NOT byte-parity: the markup a
//  host wraps around a payload differs legitimately between this React renderer,
//  a static-HTML emitter and a native render projection, so comparing those bytes
//  would pin accidents rather than the contract. Each case states an INVARIANT
//  instead — `reject`, `accept`, or `inert` — and this suite asserts that THIS
//  host satisfies it.
//
//  The url-floor group's claims are verified by the corpus itself against a real
//  WHATWG parser (`sanitization/verify-against-url-parser.mjs`), so what is
//  checked here is agreement with an invariant established independently, rather
//  than agreement between two of our own assertions.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { toHtml } from '../src/markdown.js';
import {
  isAllowedExtraAttributeKey,
  isSafeExtraAttributeValue,
  sanitizeMarkdownHtml,
  sanitizeUrl,
  sanitizeUrlOrBlank,
} from '../src/sanitize.js';

interface Case {
  id: string;
  input: string;
  invariant: 'reject' | 'accept' | 'inert';
  expected?: string;
  /** `inert` only — regexes that must NOT match the rendered output. */
  forbiddenPattern?: string[];
  /** `inert` only — substrings that MUST appear (the legitimate cases). */
  required?: string[];
  /** `extra-attributes` only — which predicate the case addresses. */
  target?: 'key' | 'value';
}

interface Group {
  id: string;
  cases: Case[];
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

const loadGroups = (): Group[] => {
  const path = findManifest();
  if (path === undefined) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as { groups: Group[] }).groups;
};

const groups = loadGroups();
const casesOf = (id: string): Case[] => groups.find((g) => g.id === id)?.cases ?? [];

/**
 * The `inert` check. A PATTERN rather than a substring, deliberately: an escaped
 * payload still contains the text `onclick=`, harmlessly, so a substring check
 * would fail a correct host. What must not exist is a live tag carrying the
 * handler. `required` is the other half, catching a host that satisfies every
 * forbidden pattern by discarding the content entirely.
 */
const expectInert = (rendered: string, c: Case): void => {
  for (const p of c.forbiddenPattern ?? []) {
    expect(
      new RegExp(p, 'i').test(rendered),
      `${c.id}: output matches forbidden pattern ${JSON.stringify(p)} — payload ${JSON.stringify(c.input)} survived as live markup`,
    ).toBe(false);
  }
  for (const r of c.required ?? []) {
    expect(
      rendered.includes(r),
      `${c.id}: output is missing required ${JSON.stringify(r)} — the payload was stripped rather than escaped`,
    ).toBe(true);
  }
};

describe('sanitization corpus — the §22 render-time floor', () => {
  it('every group in the family is claimed by a block below', () => {
    expect(
      groups.length,
      'wire-format-fixtures/sanitization/manifest.json not found',
    ).toBeGreaterThan(0);
    // A group added to the corpus that no block runs would be silently untested
    // here while reading as covered in the family — the exact shape §22.2
    // refuses. Fail rather than pass by omission.
    const known = new Set(['url-floor', 'markdown-body', 'text-source', 'extra-attributes']);
    const unclaimed = groups.map((g) => g.id).filter((id) => !known.has(id));
    expect(
      unclaimed,
      `the corpus carries group(s) this host neither runs nor declares not-applicable: ${unclaimed.join(', ')}`,
    ).toEqual([]);
  });

  describe('url-floor — the URL-scheme floor (§19)', () => {
    it.each(casesOf('url-floor').map((c) => [c.id, c] as const))('%s', (_id, c) => {
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

  describe('markdown-body — no payload survives as live markup (§22.1 rule 2)', () => {
    // The render path in order: the deterministic GFM renderer, which escapes by
    // construction, then the defence-in-depth sweep. The obligation is on the
    // pair, so the pair is what is asserted.
    it.each(casesOf('markdown-body').map((c) => [c.id, c] as const))('%s', (_id, c) => {
      expectInert(sanitizeMarkdownHtml(toHtml(c.input)), c);
    });
  });

  describe('text-source — a text slot arrives as text (§22.1 rule 1)', () => {
    // The markdown renderer is the seam a text-bearing string reaches on this
    // host, and it escapes by construction — which is what makes the legitimate
    // `a < b && c > d` case survive intact rather than stripped.
    it.each(casesOf('text-source').map((c) => [c.id, c] as const))('%s', (_id, c) => {
      expectInert(toHtml(c.input), c);
    });
  });

  describe('extra-attributes — the key allowlist and the value floor (§22.1 rules 3-4)', () => {
    it.each(casesOf('extra-attributes').map((c) => [c.id, c] as const))('%s', (_id, c) => {
      const admitted =
        c.target === 'key'
          ? isAllowedExtraAttributeKey(c.input)
          : isSafeExtraAttributeValue(c.input);
      expect(admitted, `${c.id}: payload ${JSON.stringify(c.input)}`).toBe(
        c.invariant === 'accept',
      );
    });
  });
});
