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

const parseStringRaw = (s: ParseState): Result<string, ParseError> => {
  const open = expectChar(s, '"');
  if (!open.ok) return open;

  let out = '';
  for (;;) {
    if (s.pos >= s.text.length) return fail(s, 'unterminated string');
    const c = s.text[s.pos]!;
    advance(s);

    if (c === '"') {
      return { ok: true, value: out };
    }

    // §21.1 max string length. Checked inside the accumulation loop rather
    // than on the finished string, so a hostile 100 MB literal is refused
    // partway through rather than after it has been built in memory — the
    // same on-the-way-down principle rule 4 states for depth.
    if (out.length > MAX_STRING_LENGTH) {
      return failLimit(
        s,
        `string is longer than the wire limit MAX_STRING_LENGTH = ${MAX_STRING_LENGTH}`,
      );
    }

    if (c === '\\') {
      if (s.pos >= s.text.length) return fail(s, 'unterminated escape');
      const esc = s.text[s.pos]!;
      advance(s);
      switch (esc) {
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
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
          out += String.fromCharCode(parseInt(hex, 16));
          break;
        }
        default:
          return fail(s, `unknown escape '\\${esc}'`);
      }
    } else {
      out += c;
    }
  }
};

const isNumberChar = (c: string): boolean =>
  c === '-' || c === '+' || c === '.' || c === 'e' || c === 'E' || (c >= '0' && c <= '9');

const parseNumberRaw = (s: ParseState): Result<number, ParseError> => {
  const start = s.pos;
  while (s.pos < s.text.length && isNumberChar(s.text[s.pos]!)) {
    advance(s);
  }
  const slice = s.text.substring(start, s.pos);
  if (slice.length === 0) {
    return fail(s, `invalid number '${slice}'`);
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
 * Parse a JSON document into the local AST. Mirrors the F# `tryParse`: empty /
 * whitespace-only input is a structural error; otherwise a single top-level
 * value is parsed (trailing content after the first value is not inspected,
 * matching the F# parser).
 */
export const parse = (input: string): Result<JsonAst, ParseError> => {
  const s: ParseState = { text: input, pos: 0, depth: 0 };
  skipWs(s);
  if (s.pos >= s.text.length) {
    return { ok: false, error: { message: 'input is empty', offset: 0 } };
  }
  return parseValue(s);
};

// ─── AST field-lookup helpers (used by decode.ts) ────────────────────────────

/** Look up an object field by key (key-order tolerant per WIRE_FORMAT.md §2). */
export const field = (fields: ReadonlyMap<string, JsonAst>, key: string): JsonAst | undefined =>
  fields.get(key);
