// ============================================================================
//  @fuaran-ui/ops — hand-rolled JSON parser.
//
//  Port of the local-private `Json` DU + recursive-descent parser inside the
//  F# decoder (Fuaran.UI.Ops.JsonDecode). The F# tier hand-rolls its parser
//  because Fable.SimpleJson / Newtonsoft / System.Text.Json are each pipeline-
//  incompatible (see fuaran-dotnet/docs/migrations/12-E-0-json-decoder.md). TypeScript
//  has `JSON.parse`, but the decoder hand-rolls its own for the same reason the
//  F# tier does: bit-identical handling of the number-edge string sentinels
//  ("NaN" / "Infinity" / "-Infinity"), key-order tolerance, and structural
//  error reporting (path + offset) that `JSON.parse` flattens into an opaque
//  SyntaxError. The AST DU mirrors the F# shape exactly
//  (JNull | JBool | JNumber | JString | JArray | JObject) so the per-NodeKind
//  dispatch in decode.ts stays a straight port.
//
//  WIRE_FORMAT.md §2 conventions the parser must honour:
//   - object keys arrive in any order (decoder tolerates; encoder sorts) — the
//     AST stores fields in a Map keyed by name, lookups are by key.
//   - number sentinels arrive as quoted strings, so they parse to JString here
//     and decode.ts maps them to the IEEE-754 specials at float slots.
// ============================================================================

import {
  MAX_ARRAY_LENGTH,
  MAX_DOCUMENT_BYTES,
  MAX_JSON_DEPTH,
  MAX_STRING_LENGTH,
  type Result,
} from '@fuaran-ui/schema';

/** Local JSON AST. Shape-for-shape port of the F# decoder's private `Json` DU. */
export type JsonAst =
  | { readonly kind: 'JNull' }
  | { readonly kind: 'JBool'; readonly value: boolean }
  | { readonly kind: 'JNumber'; readonly value: number }
  | { readonly kind: 'JString'; readonly value: string }
  | { readonly kind: 'JArray'; readonly items: readonly JsonAst[] }
  | { readonly kind: 'JObject'; readonly fields: ReadonlyMap<string, JsonAst> };

/** Structural parse failure carrying the byte offset where it was detected. */
export interface ParseError {
  readonly message: string;
  readonly offset: number;
  /**
   * True when this failure is a WIRE_FORMAT.md §21 resource-limit breach rather
   * than a syntax error. It exists because the two must not be reported the
   * same way: §21.2 rule 2 forbids reporting a limit breach as `INVALID_JSON`,
   * since the input is well-formed and merely too large to walk, and calling it
   * malformed sends the author to repair the wrong thing. `decodeNode` reads
   * this flag to choose between `INVALID_JSON` and `LIMIT_EXCEEDED`.
   */
  readonly limit?: boolean;
}

// ─── Mutable cursor over the source text ─────────────────────────────────────

interface ParseState {
  readonly text: string;
  pos: number;
  /**
   * Current SYNTACTIC nesting depth (§21.1 max JSON depth). Incremented on the
   * way DOWN — before the recursion that would breach it, per §21.2 rule 4 —
   * never measured afterwards from the structure that was built. A check that
   * runs after the walk it is meant to bound has already paid the cost it
   * exists to refuse, and on a host with a hard stack limit it never runs.
   */
  depth: number;
}

const peek = (s: ParseState): string => (s.pos < s.text.length ? s.text[s.pos]! : ' ');

const advance = (s: ParseState): void => {
  s.pos += 1;
};

const skipWs = (s: ParseState): void => {
  while (s.pos < s.text.length) {
    const c = s.text[s.pos]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      advance(s);
    } else {
      break;
    }
  }
};

/**
 * A §21 resource-limit refusal. Distinct from `fail` only in carrying the
 * `limit` flag, which is what stops the breach being reported as a syntax
 * error two layers up.
 */
const failLimit = (s: ParseState, message: string): Result<never, ParseError> => ({
  ok: false,
  error: { message, offset: s.pos, limit: true },
});

const fail = (s: ParseState, message: string): Result<never, ParseError> => ({
  ok: false,
  error: { message, offset: s.pos },
});

const expectChar = (s: ParseState, ch: string): Result<true, ParseError> => {
  if (peek(s) === ch) {
    advance(s);
    return { ok: true, value: true };
  }
  return fail(s, `expected '${ch}' but found '${peek(s)}'`);
};

// ─── Primitive parsers ───────────────────────────────────────────────────────

const HEX_DIGIT = /[0-9a-fA-F]/;

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

const parseStringRaw = (s: ParseState): Result<string, ParseError> => {
  const open = expectChar(s, '"');
  if (!open.ok) return open;

  let out = '';
  // §21.6 — the bound counts Unicode CODE POINTS, so a surrogate pair counts
  // once. `out.length` is UTF-16 units and is a DIFFERENT number for any
  // document above the BMP; using it made this host's limit a property of its
  // own string type rather than of the format.
  let codePoints = 0;
  // §20.2 row 6 — a `\uD800`-`\uDBFF` unit has been appended and its low half
  // is owed. The pairing check has to run on the way down: once the string is
  // assembled, a high followed by a low and a lone high followed by a lone low
  // are the same two units in the same order.
  let pendingHigh = false;

  /** Append one UTF-16 unit, maintaining §20.2 row 6 and §21.6. */
  const append = (unit: string): ParseError | undefined => {
    const code = unit.charCodeAt(0);
    const isHigh = code >= HIGH_SURROGATE_FIRST && code <= HIGH_SURROGATE_LAST;
    const isLow = code >= LOW_SURROGATE_FIRST && code <= LOW_SURROGATE_LAST;

    if (isHigh) {
      if (pendingHigh) {
        return {
          message: 'unpaired high surrogate: it must be followed by a low surrogate',
          offset: s.pos,
        };
      }
      pendingHigh = true;
      codePoints += 1;
    } else if (isLow) {
      if (!pendingHigh) {
        return {
          message: 'unpaired low surrogate: it must be preceded by a high surrogate',
          offset: s.pos,
        };
      }
      pendingHigh = false;
    } else if (pendingHigh) {
      return {
        message: 'unpaired high surrogate: it must be followed by a low surrogate',
        offset: s.pos,
      };
    } else {
      codePoints += 1;
    }

    // §21.6 / §21.2 rule 4 — bound the string ON THE WAY DOWN, in code points,
    // and check AFTER the increment. The check used to sit at the top of the
    // accumulation loop, which is one append too late: the final character was
    // appended after the last check, so a string of exactly MAX+1 passed.
    if (codePoints > MAX_STRING_LENGTH) {
      return {
        message: `string is longer than the wire limit MAX_STRING_LENGTH = ${MAX_STRING_LENGTH}`,
        offset: s.pos,
        limit: true,
      };
    }

    out += unit;
    return undefined;
  };

  for (;;) {
    if (s.pos >= s.text.length) return fail(s, 'unterminated string');
    const c = s.text[s.pos]!;
    advance(s);

    if (c === '"') {
      if (pendingHigh) {
        return fail(s, 'unpaired high surrogate at the end of a string');
      }
      return { ok: true, value: out };
    }

    if (c === '\\') {
      if (s.pos >= s.text.length) return fail(s, 'unterminated escape');
      const esc = s.text[s.pos]!;
      advance(s);
      let unit: string;
      switch (esc) {
        case '"':
          unit = '"';
          break;
        case '\\':
          unit = '\\';
          break;
        case '/':
          unit = '/';
          break;
        case 'b':
          unit = '\b';
          break;
        case 'f':
          unit = '\f';
          break;
        case 'n':
          unit = '\n';
          break;
        case 'r':
          unit = '\r';
          break;
        case 't':
          unit = '\t';
          break;
        case 'u': {
          if (s.pos + 4 > s.text.length) return fail(s, 'incomplete \\u escape');
          const hex = s.text.substring(s.pos, s.pos + 4);
          if (
            !HEX_DIGIT.test(hex[0]!) ||
            !HEX_DIGIT.test(hex[1]!) ||
            !HEX_DIGIT.test(hex[2]!) ||
            !HEX_DIGIT.test(hex[3]!)
          ) {
            return fail(s, `invalid \\u escape '${hex}'`);
          }
          s.pos += 4;
          unit = String.fromCharCode(parseInt(hex, 16));
          break;
        }
        default:
          return fail(s, `unknown escape '\\${esc}'`);
      }
      const bad = append(unit);
      if (bad) return { ok: false, error: bad };
    } else if (c.charCodeAt(0) < 0x20) {
      // §20.2 row 5 — RFC 8259 requires a C0 control character to be escaped
      // and §2 rule 6 requires a conformant encoder to escape it, so accepting
      // the raw byte admits input this host's own encoder cannot produce. The
      // escaped spelling stays legal: it is the specified one.
      return fail(
        s,
        `raw control character U+${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()} in a string must be escaped`,
      );
    } else {
      const bad = append(c);
      if (bad) return { ok: false, error: bad };
    }
  }
};

const isNumberChar = (c: string): boolean =>
  c === '-' || c === '+' || c === '.' || c === 'e' || c === 'E' || (c >= '0' && c <= '9');

/**
 * The RFC 8259 number grammar, exactly:
 *
 *     number = [ '-' ] int [ frac ] [ exp ]
 *     int    = '0' | digit1-9 *digit
 *     frac   = '.' 1*digit
 *     exp    = ('e' | 'E') [ '+' | '-' ] 1*digit
 *
 * Written out rather than delegated to `Number(...)`, and that IS the fix
 * (WIRE_FORMAT §20.2 row 3): `Number` accepts a leading `+`, a leading zero,
 * `.5`, `1.`, `0x1f`, `Infinity` and the empty string, and which superset a
 * platform's own parser accepts is a property of that platform rather than of
 * this format. Asking `Number` "is this a number" was asking about JavaScript.
 *
 * A regular expression would do it in one line; a hand-rolled scan is used for
 * the same reason the parser around it is hand-rolled — no backtracking cost on
 * a hostile token, and it is trivially portable to the other hosts, which is
 * where the identical check has to appear.
 */
const isRfc8259Number = (slice: string): boolean => {
  const n = slice.length;
  let i = 0;
  const digit = (k: number): boolean => k < n && slice[k]! >= '0' && slice[k]! <= '9';

  if (i < n && slice[i] === '-') i += 1;

  // int: a single '0', or a non-zero digit followed by any digits.
  if (!digit(i)) return false;
  if (slice[i] === '0') {
    i += 1;
  } else {
    while (digit(i)) i += 1;
  }

  // frac: the point must be followed by at least one digit.
  if (i < n && slice[i] === '.') {
    i += 1;
    if (!digit(i)) return false;
    while (digit(i)) i += 1;
  }

  // exp: at least one digit after the optional sign.
  if (i < n && (slice[i] === 'e' || slice[i] === 'E')) {
    i += 1;
    if (i < n && (slice[i] === '+' || slice[i] === '-')) i += 1;
    if (!digit(i)) return false;
    while (digit(i)) i += 1;
  }

  // Trailing characters inside the token ('1..2') are a refusal, not a prefix
  // match: the caller has already consumed the whole run.
  return i === n;
};

const parseNumberRaw = (s: ParseState): Result<number, ParseError> => {
  const start = s.pos;
  while (s.pos < s.text.length && isNumberChar(s.text[s.pos]!)) {
    advance(s);
  }
  const slice = s.text.substring(start, s.pos);
  if (!isRfc8259Number(slice)) {
    return fail(s, `'${slice}' is not a JSON number (RFC 8259 grammar)`);
  }
  const n = Number(slice);
  if (Number.isNaN(n)) {
    return fail(s, `invalid number '${slice}'`);
  }
  return { ok: true, value: n };
};

// ─── Recursive-descent value parser ──────────────────────────────────────────

const parseValue = (s: ParseState): Result<JsonAst, ParseError> => {
  skipWs(s);
  const c = peek(s);
  switch (c) {
    case '{':
      return parseObjectValue(s);
    case '[':
      return parseArrayValue(s);
    case '"': {
      const r = parseStringRaw(s);
      return r.ok ? { ok: true, value: { kind: 'JString', value: r.value } } : r;
    }
    case 't':
      if (s.text.substring(s.pos, s.pos + 4) === 'true') {
        s.pos += 4;
        return { ok: true, value: { kind: 'JBool', value: true } };
      }
      return fail(s, "expected 'true'");
    case 'f':
      if (s.text.substring(s.pos, s.pos + 5) === 'false') {
        s.pos += 5;
        return { ok: true, value: { kind: 'JBool', value: false } };
      }
      return fail(s, "expected 'false'");
    case 'n':
      if (s.text.substring(s.pos, s.pos + 4) === 'null') {
        s.pos += 4;
        return { ok: true, value: { kind: 'JNull' } };
      }
      return fail(s, "expected 'null'");
    default: {
      const r = parseNumberRaw(s);
      return r.ok ? { ok: true, value: { kind: 'JNumber', value: r.value } } : r;
    }
  }
};

const parseObjectValue = (s: ParseState): Result<JsonAst, ParseError> => {
  // §21.2 rule 4 — refuse BEFORE descending, not after.
  if (s.depth >= MAX_JSON_DEPTH) {
    return failLimit(
      s,
      `JSON nesting deeper than the wire limit MAX_JSON_DEPTH = ${MAX_JSON_DEPTH}`,
    );
  }
  const open = expectChar(s, '{');
  if (!open.ok) return open;
  skipWs(s);

  const fields = new Map<string, JsonAst>();
  if (peek(s) === '}') {
    advance(s);
    return { ok: true, value: { kind: 'JObject', fields } };
  }

  s.depth += 1;
  let count = 0;

  for (;;) {
    skipWs(s);
    const keyR = parseStringRaw(s);
    if (!keyR.ok) {
      s.depth -= 1;
      return keyR;
    }
    skipWs(s);
    const colon = expectChar(s, ':');
    if (!colon.ok) {
      s.depth -= 1;
      return colon;
    }
    const valR = parseValue(s);
    if (!valR.ok) {
      s.depth -= 1;
      return valR;
    }
    count += 1;
    if (count > MAX_ARRAY_LENGTH) {
      s.depth -= 1;
      return failLimit(
        s,
        `object has more members than the wire limit MAX_ARRAY_LENGTH = ${MAX_ARRAY_LENGTH}`,
      );
    }
    if (fields.has(keyR.value)) {
      // §20.2 row 1. The one §20 row that changes what a document MEANS rather
      // than whether it is accepted: this host kept the LAST occurrence and the
      // reference host the first, so `{"href":"https://ok","href":"javascript:…"}`
      // was a different tree on a vetting host than on a rendering one, with no
      // error anywhere. Rejection is the only answer two hosts cannot silently
      // differ on, and it costs nothing: no conformant encoder can emit a
      // repeated member.
      s.depth -= 1;
      return fail(s, `duplicate object member '${keyR.value}'`);
    }
    fields.set(keyR.value, valR.value);
    skipWs(s);
    const c = peek(s);
    if (c === ',') {
      advance(s);
    } else if (c === '}') {
      advance(s);
      s.depth -= 1;
      return { ok: true, value: { kind: 'JObject', fields } };
    } else {
      s.depth -= 1;
      return fail(s, `expected ',' or '}' but found '${c}'`);
    }
  }
};

const parseArrayValue = (s: ParseState): Result<JsonAst, ParseError> => {
  // §21.2 rule 4 — refuse BEFORE descending, not after.
  if (s.depth >= MAX_JSON_DEPTH) {
    return failLimit(
      s,
      `JSON nesting deeper than the wire limit MAX_JSON_DEPTH = ${MAX_JSON_DEPTH}`,
    );
  }
  const open = expectChar(s, '[');
  if (!open.ok) return open;
  skipWs(s);

  const items: JsonAst[] = [];
  if (peek(s) === ']') {
    advance(s);
    return { ok: true, value: { kind: 'JArray', items } };
  }

  s.depth += 1;

  for (;;) {
    const valR = parseValue(s);
    if (!valR.ok) {
      s.depth -= 1;
      return valR;
    }
    items.push(valR.value);
    if (items.length > MAX_ARRAY_LENGTH) {
      s.depth -= 1;
      return failLimit(
        s,
        `array is longer than the wire limit MAX_ARRAY_LENGTH = ${MAX_ARRAY_LENGTH}`,
      );
    }
    skipWs(s);
    const c = peek(s);
    if (c === ',') {
      advance(s);
    } else if (c === ']') {
      advance(s);
      s.depth -= 1;
      return { ok: true, value: { kind: 'JArray', items } };
    } else {
      s.depth -= 1;
      return fail(s, `expected ',' or ']' but found '${c}'`);
    }
  }
};

/**
 * UTF-8 byte length of a JavaScript string, computed from its UTF-16 units.
 *
 * Derived rather than delegated because `TextEncoder` is not universally
 * present in the runtimes this package targets, and derived rather than
 * SUBSTITUTED because `String.length` is UTF-16 units, which under-counts a CJK
 * document threefold — and under-counting is the direction that ADMITS a
 * document §21.7 requires the host to refuse.
 *
 * The bounds short-circuit is the difference between an O(n) walk on every
 * decode and one on the rare large document: every UTF-16 unit costs at least
 * one byte and at most three (a surrogate PAIR costs four across two units, so
 * two per unit), so a string shorter than a third of the ceiling cannot breach
 * it and one longer than the ceiling must.
 */
const documentBytes = (input: string): number => {
  if (input.length > MAX_DOCUMENT_BYTES) return input.length;
  if (input.length <= MAX_DOCUMENT_BYTES / 3) return input.length;

  let total = 0;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    if (c < 0x80) {
      total += 1;
    } else if (c < 0x800) {
      total += 2;
    } else if (c >= HIGH_SURROGATE_FIRST && c <= HIGH_SURROGATE_LAST && i + 1 < input.length) {
      total += 4;
      i += 1;
    } else {
      total += 3;
    }
  }
  return total;
};

/**
 * Parse a JSON document into the local AST. Mirrors the F# `tryParse`: empty /
 * whitespace-only input is a structural error; a document past the §21.7
 * ceiling is refused BEFORE the parse; and per §20.2 row 2 the root value must
 * be followed by nothing but whitespace — §1 makes a wire artefact a single
 * JSON document, and this parser used to stop at the first value and ignore the
 * remainder, which is a framing ambiguity rather than a tolerance.
 */
export const parse = (input: string): Result<JsonAst, ParseError> => {
  const bytes = documentBytes(input);
  if (bytes > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      error: {
        message: `document of ${bytes} UTF-8 bytes exceeds the wire limit MAX_DOCUMENT_BYTES = ${MAX_DOCUMENT_BYTES}`,
        offset: 0,
        limit: true,
      },
    };
  }

  const s: ParseState = { text: input, pos: 0, depth: 0 };
  skipWs(s);
  if (s.pos >= s.text.length) {
    return { ok: false, error: { message: 'input is empty', offset: 0 } };
  }
  const value = parseValue(s);
  if (!value.ok) return value;

  skipWs(s);
  if (s.pos < s.text.length) {
    return fail(
      s,
      `unexpected content after the root value ('${s.text[s.pos]!}'); a wire artefact is a single JSON document`,
    );
  }
  return value;
};

// ─── AST field-lookup helpers (used by decode.ts) ────────────────────────────

/** Look up an object field by key (key-order tolerant per WIRE_FORMAT.md §2). */
export const field = (fields: ReadonlyMap<string, JsonAst>, key: string): JsonAst | undefined =>
  fields.get(key);
