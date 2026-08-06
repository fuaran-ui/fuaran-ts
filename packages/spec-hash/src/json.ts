// ============================================================================
//  A JSON reader for a canonicalisation, which is not the same thing as a JSON
//  reader for a program.
//
//  `JSON.parse` cannot be used here, for two reasons that are each silent:
//
//    1. it collapses DUPLICATE members, keeping the last. The minting rule puts
//       a rendering with duplicates outside its domain precisely because no
//       ordering of them is deterministic — so a parser that resolves them has
//       already made the choice the rule refuses to make, and the refusal can
//       never fire.
//    2. it discards each number's TOKEN. The rule's domain is stated in terms
//       of what the RENDERING contains: an integer literal beyond exact
//       binary64 range is refused, and that is a fact about the token, not
//       about the double it rounded to. `9007199254740993` parses to
//       `9007199254740992` without complaint.
//
//  So the reader below is small, total, and deliberately lossless about the two
//  things the rule asks about.
// ============================================================================

/** A JSON value as READ — order-preserving, duplicate-preserving, token-preserving. */
export type JsonValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: string }
  /** The parsed double AND the token it was written as. See note 2 above. */
  | { readonly kind: 'number'; readonly value: number; readonly token: string }
  | { readonly kind: 'array'; readonly items: readonly JsonValue[] }
  | { readonly kind: 'object'; readonly members: readonly JsonMember[] };

export interface JsonMember {
  readonly key: string;
  readonly value: JsonValue;
}

export const jsonNull: JsonValue = { kind: 'null' };

class ParseFailure extends Error {}

/**
 * Parse a JSON document (RFC 8259).
 *
 * Returns the value, or an error string describing where it stopped. Nothing here
 * is lenient: trailing content, a bad escape and a malformed number are all
 * failures, because a rendering this reader had to guess about is a rendering two
 * implementations can guess about differently.
 */
export const parseJson = (
  input: string,
): { ok: true; value: JsonValue } | { ok: false; detail: string } => {
  const n = input.length;
  let i = 0;

  const fail = (message: string): never => {
    throw new ParseFailure(`${message} at offset ${String(i)}`);
  };

  const peek = (): string => (i < n ? (input[i] as string) : '\0');

  const skipWs = (): void => {
    while (i < n) {
      const c = input[i] as string;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i += 1;
      else break;
    }
  };

  const expect = (c: string): void => {
    skipWs();
    if (i < n && input[i] === c) i += 1;
    else fail(`expected '${c}'`);
  };

  const hexDigit = (c: string): number => {
    if (c >= '0' && c <= '9') return c.charCodeAt(0) - 0x30;
    if (c >= 'a' && c <= 'f') return c.charCodeAt(0) - 0x61 + 10;
    if (c >= 'A' && c <= 'F') return c.charCodeAt(0) - 0x41 + 10;
    return fail('bad hex digit');
  };

  const parseString = (): string => {
    expect('"');
    let out = '';
    for (;;) {
      if (i >= n) fail('unterminated string');
      const c = input[i] as string;
      i += 1;
      if (c === '"') return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      if (i >= n) fail('unterminated escape');
      const e = input[i] as string;
      i += 1;
      switch (e) {
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
          if (i + 4 > n) fail('truncated \\u escape');
          const code =
            (hexDigit(input[i] as string) << 12) +
            (hexDigit(input[i + 1] as string) << 8) +
            (hexDigit(input[i + 2] as string) << 4) +
            hexDigit(input[i + 3] as string);
          i += 4;
          // A lone surrogate is BUILT here rather than replaced. It is the rule's
          // job to refuse it (§4.5, ill-formed Unicode); a reader that substituted
          // U+FFFD would hash a document nobody wrote.
          out += String.fromCharCode(code);
          break;
        }
        default:
          fail(`bad escape '\\${e}'`);
      }
    }
  };

  const parseNumber = (): JsonValue => {
    const start = i;
    if (peek() === '-') i += 1;
    while (i < n && (input[i] as string) >= '0' && (input[i] as string) <= '9') i += 1;
    if (peek() === '.') {
      i += 1;
      while (i < n && (input[i] as string) >= '0' && (input[i] as string) <= '9') i += 1;
    }
    if (peek() === 'e' || peek() === 'E') {
      i += 1;
      if (peek() === '+' || peek() === '-') i += 1;
      while (i < n && (input[i] as string) >= '0' && (input[i] as string) <= '9') i += 1;
    }
    const token = input.slice(start, i);
    // `Number()` is deliberate over `parseFloat`: it rejects a partial parse, so a
    // token this scanner sliced wrongly fails here rather than silently truncating.
    const value = Number(token);
    if (token === '' || !Number.isFinite(value)) fail(`malformed number '${token}'`);
    return { kind: 'number', value, token };
  };

  const literal = (text: string, value: JsonValue): JsonValue => {
    if (input.startsWith(text, i)) {
      i += text.length;
      return value;
    }
    return fail(`expected '${text}'`);
  };

  const parseValue = (): JsonValue => {
    skipWs();
    if (i >= n) fail('unexpected end of input');
    const c = input[i] as string;
    if (c === '"') return { kind: 'string', value: parseString() };
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === 't') return literal('true', { kind: 'bool', value: true });
    if (c === 'f') return literal('false', { kind: 'bool', value: false });
    if (c === 'n') return literal('null', jsonNull);
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    return fail(`unexpected character '${c}'`);
  };

  function parseObject(): JsonValue {
    expect('{');
    const members: JsonMember[] = [];
    skipWs();
    if (peek() === '}') {
      i += 1;
      return { kind: 'object', members };
    }
    for (;;) {
      skipWs();
      const key = parseString();
      expect(':');
      // Duplicates are KEPT — see note 1 at the head of this file.
      members.push({ key, value: parseValue() });
      skipWs();
      if (peek() === ',') {
        i += 1;
      } else {
        expect('}');
        return { kind: 'object', members };
      }
    }
  }

  function parseArray(): JsonValue {
    expect('[');
    const items: JsonValue[] = [];
    skipWs();
    if (peek() === ']') {
      i += 1;
      return { kind: 'array', items };
    }
    for (;;) {
      items.push(parseValue());
      skipWs();
      if (peek() === ',') {
        i += 1;
      } else {
        expect(']');
        return { kind: 'array', items };
      }
    }
  }

  try {
    const value = parseValue();
    skipWs();
    if (i !== n)
      return { ok: false, detail: `trailing content after the document at offset ${String(i)}` };
    return { ok: true, value };
  } catch (error) {
    if (error instanceof ParseFailure) return { ok: false, detail: error.message };
    throw error;
  }
};
