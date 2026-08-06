// ============================================================================
//  `canonical-json-sha256-v1` — a registered JSON canonicalisation, and the
//  SHA-256 content address minted over its output.
//
//  The rule, in three steps:
//
//    1. PARSE the rendering into values (see `json.ts` for why not `JSON.parse`).
//    2. SERIALISE those values with no insignificant whitespace, UTF-8, JSON
//       string escaping, ECMAScript number serialisation, and TWO rules specific
//       to this algorithm:
//         - every object's members are ordered ordinally ascending BY KEY,
//           recursively. A document's interior here is not a versioned record
//           with a published field order; there is nothing to preserve, and
//           sorting is precisely what makes two authoring orders mint one hash.
//         - arrays KEEP their order. An array's order is data: two renderings
//           that differ in it are two different documents and MUST mint
//           different hashes.
//    3. DIGEST the resulting bytes with SHA-256 and form `sha256:{lowercase hex}`.
//
//  Three renderings are OUTSIDE the rule's domain and are refused rather than
//  resolved arbitrarily: duplicate member names within one object; a number not
//  exactly representable as an IEEE-754 binary64; and ill-formed Unicode.
//
//  Two notes on why so little of this delegates to the platform, given that
//  JavaScript's own number type IS binary64:
//
//    - `String(n)` IS the ECMAScript `Number::toString` algorithm the rule cites,
//      so number formatting genuinely is free here — the one part of this file
//      that a host in another language has to write out by hand. It is still
//      wrapped, because negative zero must collapse to `0` and `String(-0)`
//      already does while `(-0).toFixed(0)` and JSON.stringify(-0) do not agree
//      with each other about much else.
//    - `JSON.stringify` is NOT usable for the whole job: it cannot sort members
//      recursively (its replacer sees values, not orders), and it escapes lone
//      surrogates into `\udXXX` rather than refusing them.
// ============================================================================

import { parseJson, type JsonValue } from './json.js';

/** The identifier a party declares when it addresses content this way. */
export const ALGORITHM_ID = 'canonical-json-sha256-v1';

/**
 * A rendering the rule declines rather than resolving arbitrarily. Each case is
 * outside the algorithm's DOMAIN — a party whose renderings can carry one of these
 * registers its own algorithm identifier, which is an ordinary use of an open
 * registry rather than a failure to conform.
 */
export type MintRefusal =
  /** Not a JSON document at all. */
  | { readonly kind: 'not-json'; readonly detail: string }
  /**
   * Duplicate member names within one object. RFC 8259 permits them and no ordering
   * makes them deterministic, so the only safe rule is to refuse.
   */
  | { readonly kind: 'duplicate-members'; readonly path: string; readonly name: string }
  /**
   * A number that is not exactly representable as an IEEE-754 binary64. Rounding it
   * silently collides two different documents onto one identity; the shape the rule
   * requires instead is a string.
   */
  | { readonly kind: 'number-not-representable'; readonly path: string; readonly token: string }
  /** An unpaired surrogate — no UTF-8 encoding, so no bytes to hash. */
  | { readonly kind: 'ill-formed-unicode'; readonly path: string };

export type MintOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: MintRefusal };

export const describeRefusal = (r: MintRefusal): string => {
  switch (r.kind) {
    case 'not-json':
      return `not a JSON rendering: ${r.detail}`;
    case 'duplicate-members':
      return `duplicate member '${r.name}' at '${r.path}' — no ordering of duplicates is deterministic`;
    case 'number-not-representable':
      return `the number '${r.token}' at '${r.path}' is not exactly representable as a binary64; render it as a string`;
    case 'ill-formed-unicode':
      return `ill-formed Unicode at '${r.path}' — an unpaired surrogate has no bytes to hash`;
  }
};

// ---- strings ---------------------------------------------------------------

/**
 * Escape `"`, `\`, and characters below U+0020 — using JSON's short escape where one
 * exists and `\u00xx` where none does. Characters at or above U+0020, including all
 * non-ASCII, are emitted literally.
 */
export const escapeString = (s: string): string => {
  let out = '';
  for (const ch of splitCodeUnits(s)) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\b':
        out += '\\b';
        break;
      case '\f':
        out += '\\f';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default:
        out += ch < ' ' ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}` : ch;
    }
  }
  return out;
};

/**
 * Iterate CODE UNITS, not code points. `for…of` over a string yields code points,
 * which would silently repair a lone surrogate into a well-formed pair-shaped chunk
 * — and repairing is the one thing this file must not do.
 */
function* splitCodeUnits(s: string): Generator<string> {
  for (let i = 0; i < s.length; i += 1) yield s.charAt(i);
}

/**
 * Is every surrogate in this string paired? An unpaired surrogate has no UTF-8
 * encoding, so it has no bytes to hash — which is why the rule puts it outside its
 * domain rather than encoding it as a replacement character.
 */
export const isWellFormedUnicode = (s: string): boolean => {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
};

// ---- numbers ---------------------------------------------------------------

/**
 * The ECMAScript `Number::toString` algorithm — the shortest decimal that round-trips
 * to the same IEEE-754 double. In JavaScript that is `String(n)` verbatim; the only
 * adjustment the rule asks for is that negative zero serialises as `0`.
 */
export const formatNumber = (value: number): string => {
  if (!Number.isFinite(value)) throw new RangeError('a non-finite real cannot be encoded');
  if (value === 0) return '0'; // collapses -0 as well as 0
  return String(value);
};

/**
 * Is this integer token exactly representable as a double?
 *
 * Judged on the TOKEN rather than on the parsed value: 2^53 + 1 rounds to 2^53, so a
 * range check on the double would wrongly accept exactly the case that motivates the
 * rule. JSON forbids leading zeros, so for equal length a lexical comparison of the
 * digits IS the numeric order.
 */
const integerTokenIsExact = (token: string): boolean => {
  const digits = token.startsWith('-') ? token.slice(1) : token;
  return digits.length < 16 || (digits.length === 16 && digits <= '9007199254740992');
};

// ---- the domain check -------------------------------------------------------

/**
 * Walk the value, refusing anything outside the rule's domain. The first refusal wins,
 * and it names its path — a party debugging a hash disagreement needs to know WHERE,
 * not only that.
 */
const firstDomainRefusal = (path: string, v: JsonValue): MintRefusal | undefined => {
  const here = path === '' ? '/' : path;
  switch (v.kind) {
    case 'null':
    case 'bool':
      return undefined;
    case 'string':
      return isWellFormedUnicode(v.value) ? undefined : { kind: 'ill-formed-unicode', path };
    case 'number': {
      const isInteger = !(v.token.includes('.') || v.token.includes('e') || v.token.includes('E'));
      return isInteger && !integerTokenIsExact(v.token)
        ? { kind: 'number-not-representable', path, token: v.token }
        : undefined;
    }
    case 'array': {
      for (let i = 0; i < v.items.length; i += 1) {
        const refusal = firstDomainRefusal(`${path}/${String(i)}`, v.items[i] as JsonValue);
        if (refusal) return refusal;
      }
      return undefined;
    }
    case 'object': {
      const seen = new Set<string>();
      for (const m of v.members) {
        if (seen.has(m.key)) return { kind: 'duplicate-members', path: here, name: m.key };
        seen.add(m.key);
      }
      for (const m of v.members) {
        if (!isWellFormedUnicode(m.key)) return { kind: 'ill-formed-unicode', path: here };
      }
      for (const m of v.members) {
        const refusal = firstDomainRefusal(`${path}/${m.key}`, m.value);
        if (refusal) return refusal;
      }
      return undefined;
    }
  }
};

// ---- the writer -------------------------------------------------------------

/**
 * Ordinal comparison — by UTF-16 CODE UNIT, which is what JavaScript's relational
 * operators already do on strings. `localeCompare` would be culture-sensitive and
 * `Intl.Collator` code-point-ordered; either puts an astral-plane key after U+FFFD
 * instead of before it, and mints a different hash for the same document.
 */
const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const write = (v: JsonValue): string => {
  switch (v.kind) {
    case 'null':
      return 'null';
    case 'bool':
      return v.value ? 'true' : 'false';
    case 'string':
      return `"${escapeString(v.value)}"`;
    case 'number':
      return formatNumber(v.value);
    case 'array':
      return `[${v.items.map(write).join(',')}]`;
    case 'object':
      return `{${[...v.members]
        .sort((a, b) => ordinal(a.key, b.key))
        .map((m) => `"${escapeString(m.key)}":${write(m.value)}`)
        .join(',')}}`;
  }
};

// ---- the rule ---------------------------------------------------------------

/**
 * The canonical bytes of a rendering — the intermediate of step 2, exposed because a
 * party debugging a hash disagreement needs to SEE where it diverged rather than only
 * that it did.
 *
 * The transmitted payload is not required to be these bytes: the canonical form exists
 * only to be hashed. Two renderings differing only in member order or insignificant
 * whitespace therefore differ byte-for-byte and carry the same hash, which is the whole
 * property, stated the other way round.
 */
export const canonicalise = (rendered: string): MintOutcome<string> => {
  const parsed = parseJson(rendered);
  if (!parsed.ok) return { ok: false, refusal: { kind: 'not-json', detail: parsed.detail } };
  const refusal = firstDomainRefusal('', parsed.value);
  if (refusal) return { ok: false, refusal };
  return { ok: true, value: write(parsed.value) };
};

/**
 * Mint a content address from a rendering, given a digest function.
 *
 * The digest is a parameter so the rule itself stays free of any platform binding —
 * `mint` in `./index.js` supplies the Node one. `sha256Hex` MUST hash the UTF-8 bytes
 * of its argument and return LOWERCASE hex with no prefix.
 */
export const mintWith = (
  sha256Hex: (utf8Text: string) => string,
  rendered: string,
): MintOutcome<string> => {
  const canonical = canonicalise(rendered);
  if (!canonical.ok) return canonical;
  return { ok: true, value: `sha256:${sha256Hex(canonical.value)}` };
};
