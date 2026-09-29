// ============================================================================
//  @fuaran-ui/ui/schemaForm — JSON Schema -> `Form`, as a DERIVATION (Phase 1914).
//
//  The TypeScript mirror of the reference host's `Fuaran.UI.SchemaForm`
//  (Phase 1816): the same mapping table, the same options and the same typed
//  refusals, so a TypeScript emitter or MCP client derives a form from a
//  schema it already holds without routing to another host. Wherever a form
//  is wanted there is very often a JSON Schema already — a tool's input
//  schema, an API's request body, an elicitation contract — and writing the
//  `Form` node by hand from it is transcription, which is where
//  required-ness, bounds and enums get lost. `deriveForm` is a pure function:
//  schema in, `Form` node out, over vocabulary that already exists (no new
//  node kind, no wire change).
//
//  ── Reading the schema ─────────────────────────────────────────────────────
//
//  The schema is read as ORDERED JSON (`SchemaJson`), the twin of the
//  reference host's `JVal`, because the plain JavaScript object model cannot
//  carry three facts the derivation depends on:
//
//    - member ORDER: field order is the schema's `properties` order, and a
//      JavaScript object enumerates integer-like keys (`"2"`, `"10"`) first,
//      in numeric order, whatever the document said;
//    - DUPLICATE members: two `properties` of one name are two fields (and a
//      `duplicate-field-id` refusal), not the last one silently winning;
//    - integer vs float literals: `maxLength: 5.0` is not a count.
//
//  `parseSchemaJson` is a port of the reference host's null-tolerant reader
//  (`Json.parseTolerantOfNull`) — same grammar, same member-null erasure, same
//  rejections, same messages and positions — so `deriveFormFromText` refuses
//  exactly the text the reference host refuses, byte for byte.
//  `schemaJsonOf` lifts an already-parsed JavaScript value for callers that
//  hold one; it carries the object model's key order, so text is the input to
//  prefer whenever order matters.
//
//  ── The mapping table (identical to the reference host's) ──────────────────
//
//  | Schema                                          | Control                                   |
//  |-------------------------------------------------|-------------------------------------------|
//  | `string`                                        | `Text`                                    |
//  | `string`, `maxLength` > `textAreaThreshold`,    | `TextArea` (`textAreaRows` rows)          |
//  |   no `format`                                   |                                           |
//  | `string`, `format: date` / `time` / `date-time` | `DateTime`, variant `Date`/`Time`/`DateTime` |
//  | `string`, `format: color`                       | `Color`                                   |
//  | `string`, `format: email` / `uri`               | `Text` + rule `format` `email` / `url`    |
//  | `number` / `integer`, no bound, no step         | `Number`                                  |
//  | `number` / `integer` with ANY of `minimum`,     | `RangedNumber` (min / max / step)         |
//  |   `maximum`, `multipleOf`, or `integer`         |   `integer` steps by 1 (or `multipleOf`)  |
//  | `boolean`                                       | `Checkbox`, or `Toggle` by option         |
//  | `enum` (strings), count <= `segmentedMax`       | `SegmentedChoice` (horizontal)            |
//  | `enum` (strings), count <= `choiceMax`          | `Choice`                                  |
//  | `enum` (strings), count > `choiceMax`           | `Combobox`, no free text                  |
//  | `array` whose `items` is a string `enum`        | `Tokens`, no free text, enum as suggestions |
//  | `object` one level below the root               | its fields, in place, as a labelled group: |
//  |                                                 |   id `<parent>.<child>`, label `<Parent>: <Child>` |
//  | `required`                                      | `FormField.required`                      |
//  | `minLength` / `maxLength` / `pattern`           | the Phase 864 `FieldRule` slots           |
//  | `minimum` / `maximum`                           | the control's own bound (never a rule)    |
//  | `title` / `description`                         | label (property name when absent) / help  |
//  | `default`                                       | the value binding `State(<field id>, default)` |
//  | `integer` `exclusiveMinimum` / `exclusiveMaximum` | the next whole number inside the bound  |
//  | local `$ref` (`#/...`)                          | resolved; sibling `title` / `description` win |
//  | `type: [T, "null"]`                             | `T` (the form's absence is the null)      |
//  | `additionalProperties: true / false`            | accepted — a form emits declared keys only |
//  | `$schema` `$id` `$comment` `examples` `$defs` `definitions` | annotations: read, not rendered |
//
//  A nested object's own `description`, and the root's `title` /
//  `description`, have nowhere to go: `FormSpec` has no group or heading slot,
//  and adding one is a vocabulary change this derivation deliberately does not
//  make.
//
//  ── Refuse by name, never guess ────────────────────────────────────────────
//
//  Every construct the table does not cover is a typed `SchemaFormRefusal`
//  naming the schema path (RFC 6901 JSON Pointer), and EVERY refusal in the
//  schema is reported, in the reference host's order, not just the first.
//
//  ── Parity ─────────────────────────────────────────────────────────────────
//
//  `test/fixtures/schema-form-parity.json` is a paired table of schemas with
//  the wire each one must derive to (or the refusals it must produce),
//  generated by the reference host; this host's suite holds `deriveForm`, the
//  canonical encoder and `renderSchemaFormRefusals` to those exact bytes.
//
//  The one host difference is the reserved-name rule: the reference host
//  refuses a field id under the `host.` prefix AND any name a host has
//  declared reserved at runtime (`StateKeyPolicy.declareReserved`). The
//  TypeScript tier has no runtime declaration registry, so this module
//  applies the prefix rule alone — the rule every tier shares.
// ============================================================================

import {
  type Action,
  type Binding,
  type DateTimeVariant,
  type FieldRule,
  type FormField,
  type FormFieldKind,
  type Node,
  type SelectOption,
  type TextFormat,
  type TextSource,
  controlValueDefaults,
} from '@fuaran-ui/schema';
import { formatFiniteDouble } from '@fuaran-ui/core-twins';

import { fuaran } from './smartCtors.js';

// ─── The ordered JSON model ──────────────────────────────────────────────────

/**
 * An ordered JSON value — the twin of the reference host's `JVal`. There is no
 * null: an object member whose value is `null` reads as an absent member, and a
 * `null` anywhere else is refused (a schema has no use for one).
 */
export type SchemaJson =
  | { readonly kind: 'str'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'arr'; readonly items: readonly SchemaJson[] }
  | { readonly kind: 'obj'; readonly members: readonly (readonly [string, SchemaJson])[] };

/** The result shape every derivation entry point returns. */
export type SchemaFormResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: readonly SchemaFormRefusal[] };

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** The reference host's default nesting cap for the reader. */
const MAX_DEPTH = 512;

class SchemaJsonError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

/**
 * Parse schema TEXT into the ordered model — a port of the reference host's
 * null-tolerant reader, so an accepted document reads identically and a
 * refused one is refused with the same message at the same position. The
 * error string is the reference host's `not valid JSON: <why> at position <n>`.
 */
export const parseSchemaJson = (
  input: string,
):
  | { readonly ok: true; readonly value: SchemaJson }
  | { readonly ok: false; readonly error: string } => {
  const n = input.length;
  let i = 0;

  const fail = (message: string): never => {
    throw new SchemaJsonError(message, i);
  };
  const peek = (): string => (i < n ? input.charAt(i) : '\u0000');
  const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const skipWs = (): void => {
    while (i < n && isWs(input.charAt(i))) i += 1;
  };
  const expect = (c: string): void => {
    if (i < n && input.charAt(i) === c) i += 1;
    else fail(`expected '${c}'`);
  };
  const isDigit = (c: string): boolean => c >= '0' && c <= '9';
  const hexDigit = (c: string): number => {
    if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
    if (c >= 'a' && c <= 'f') return c.charCodeAt(0) - 97 + 10;
    if (c >= 'A' && c <= 'F') return c.charCodeAt(0) - 65 + 10;
    return fail('bad hex digit in \\u escape');
  };

  const parseString = (): string => {
    expect('"');
    let out = '';
    for (;;) {
      if (i >= n) fail('unterminated string');
      const c = input.charAt(i);
      i += 1;
      if (c === '"') return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      if (i >= n) fail('unterminated escape');
      const e = input.charAt(i);
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
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'u': {
          if (i + 4 > n) fail('truncated \\u escape');
          const code =
            (hexDigit(input.charAt(i)) << 12) +
            (hexDigit(input.charAt(i + 1)) << 8) +
            (hexDigit(input.charAt(i + 2)) << 4) +
            hexDigit(input.charAt(i + 3));
          i += 4;
          out += String.fromCharCode(code);
          break;
        }
        default:
          fail(`bad escape '\\${e}'`);
      }
    }
  };

  // The reference host's float grammar is `Double.TryParse(Float, Invariant)`
  // over the scanned token; the scanned token is always digits, one optional
  // leading '-', '.', and an exponent, which `Number` reads identically — with
  // two spellings it rejects and TryParse accepts (a bare trailing '.', and a
  // '.' with no digits before it), normalised here.
  const readFloat = (tok: string): number => {
    let t = tok;
    const eAt = t.search(/[eE]/);
    const mantissa = eAt < 0 ? t : t.slice(0, eAt);
    const exponent = eAt < 0 ? '' : t.slice(eAt);
    let m = mantissa;
    if (m.endsWith('.')) m = m.slice(0, -1);
    if (m === '' || m === '-') return Number.NaN;
    if (m.startsWith('.')) m = '0' + m;
    else if (m.startsWith('-.')) m = '-0' + m.slice(1);
    t = m + exponent;
    if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number.NaN;
    return Number(t);
  };

  const parseNumber = (): SchemaJson => {
    const start = i;
    let isFloat = false;
    if (peek() === '-') i += 1;
    while (i < n && isDigit(input.charAt(i))) i += 1;
    if (peek() === '.') {
      isFloat = true;
      i += 1;
      while (i < n && isDigit(input.charAt(i))) i += 1;
    }
    if (peek() === 'e' || peek() === 'E') {
      isFloat = true;
      i += 1;
      if (peek() === '+' || peek() === '-') i += 1;
      while (i < n && isDigit(input.charAt(i))) i += 1;
    }
    const tok = input.slice(start, i);

    const asFloat = (): SchemaJson => {
      const v = readFloat(tok);
      if (Number.isNaN(v)) return fail(`malformed number: ${tok}`);
      if (!Number.isFinite(v))
        return fail(
          `number outside the finite double range; it cannot round-trip on the wire: ${tok}`,
        );
      return { kind: 'float', value: v };
    };

    if (isFloat) return asFloat();
    // Integer literal: Int32 is `int`; beyond it, only the int53-safe range is
    // admitted (judged on the TOKEN, as the reference host does), as a float.
    const digits = tok.startsWith('-') ? tok.slice(1) : tok;
    if (digits !== '' && /^\d+$/.test(digits)) {
      const asInt = Number(tok);
      // `| 0` folds `-0` to `0`, as an Int32 parse does.
      if (asInt >= INT32_MIN && asInt <= INT32_MAX) return { kind: 'int', value: asInt | 0 };
    }
    const int53Safe = digits.length < 16 || (digits.length === 16 && digits <= '9007199254740992');
    if (!int53Safe)
      return fail(
        `integer literal outside the int53 safe range (|n| > 2^53); it cannot round-trip without precision loss: ${tok}`,
      );
    const v = readFloat(tok);
    if (Number.isNaN(v)) return fail(`malformed number: ${tok}`);
    return { kind: 'float', value: v };
  };

  const parseLiteral = (lit: string, v: SchemaJson): SchemaJson => {
    if (i + lit.length <= n && input.slice(i, i + lit.length) === lit) {
      i += lit.length;
      return v;
    }
    return fail(`expected '${lit}'`);
  };

  const parseValue = (depth: number): SchemaJson => {
    skipWs();
    if (i >= n) fail('unexpected end of input');
    const c = input.charAt(i);
    if (c === '"') return { kind: 'str', value: parseString() };
    if (c === '{') return parseObject(depth);
    if (c === '[') return parseArray(depth);
    if (c === 't') return parseLiteral('true', { kind: 'bool', value: true });
    if (c === 'f') return parseLiteral('false', { kind: 'bool', value: false });
    if (c === 'n')
      return fail(
        'null is not representable in the Fuaran wire JVal model, and this position has no absence to erase it to (only an object-member null is erased)',
      );
    if (c === '-' || isDigit(c)) return parseNumber();
    return fail(`unexpected character '${c}'`);
  };

  const parseObject = (depth: number): SchemaJson => {
    if (depth >= MAX_DEPTH) fail(`max nesting depth ${MAX_DEPTH} exceeded`);
    expect('{');
    skipWs();
    const members: (readonly [string, SchemaJson])[] = [];
    if (peek() === '}') {
      i += 1;
      return { kind: 'obj', members };
    }
    for (;;) {
      skipWs();
      const key = parseString();
      skipWs();
      expect(':');
      skipWs();
      // A member whose value is exactly the `null` token reads as absent.
      if (i + 4 <= n && input.slice(i, i + 4) === 'null') i += 4;
      else members.push([key, parseValue(depth + 1)]);
      skipWs();
      const c = peek();
      if (c === ',') i += 1;
      else if (c === '}') {
        i += 1;
        return { kind: 'obj', members };
      } else fail("expected ',' or '}'");
    }
  };

  const parseArray = (depth: number): SchemaJson => {
    if (depth >= MAX_DEPTH) fail(`max nesting depth ${MAX_DEPTH} exceeded`);
    expect('[');
    skipWs();
    const items: SchemaJson[] = [];
    if (peek() === ']') {
      i += 1;
      return { kind: 'arr', items };
    }
    for (;;) {
      items.push(parseValue(depth + 1));
      skipWs();
      const c = peek();
      if (c === ',') i += 1;
      else if (c === ']') {
        i += 1;
        return { kind: 'arr', items };
      } else fail("expected ',' or ']'");
    }
  };

  try {
    const v = parseValue(0);
    skipWs();
    if (i !== n) throw new SchemaJsonError('trailing characters', i);
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof SchemaJsonError)
      return { ok: false, error: `not valid JSON: ${e.message} at position ${e.position}` };
    throw e;
  }
};

/**
 * Lift an already-parsed JavaScript value into the ordered model: an object
 * member whose value is `null` or `undefined` reads as absent, a whole number
 * in the Int32 range is an `int`, any other finite number a `float`. Returns
 * `undefined` for a value JSON cannot hold (a `null` outside member position, a
 * non-finite number, a function). Key order is the JavaScript object's — so
 * integer-like property names enumerate first; pass TEXT where that matters.
 */
export const schemaJsonOf = (value: unknown): SchemaJson | undefined => {
  if (typeof value === 'string') return { kind: 'str', value };
  if (typeof value === 'boolean') return { kind: 'bool', value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX
      ? { kind: 'int', value: value | 0 }
      : { kind: 'float', value };
  }
  if (Array.isArray(value)) {
    const items: SchemaJson[] = [];
    for (const item of value) {
      const v = schemaJsonOf(item);
      if (v === undefined) return undefined;
      items.push(v);
    }
    return { kind: 'arr', items };
  }
  if (typeof value === 'object' && value !== null) {
    const members: (readonly [string, SchemaJson])[] = [];
    for (const [k, raw] of Object.entries(value)) {
      if (raw === null || raw === undefined) continue;
      const v = schemaJsonOf(raw);
      if (v === undefined) return undefined;
      members.push([k, v]);
    }
    return { kind: 'obj', members };
  }
  return undefined;
};

// ─── Options ─────────────────────────────────────────────────────────────────

/** Which control a `boolean` property derives to. */
export type SchemaFormBooleanControl = 'Checkbox' | 'Toggle';

/**
 * The knobs of the derivation. Every threshold is inclusive on the smaller
 * control: an enum of exactly `segmentedMax` members is a `SegmentedChoice`.
 */
export interface SchemaFormOptions<TMsg> {
  /** The `Form` node's id. */
  readonly formId: string;
  readonly submitLabel: TextSource;
  readonly onSubmit: Action<TMsg>;
  /** A `string` whose `maxLength` exceeds this becomes a `TextArea`. */
  readonly textAreaThreshold: number;
  readonly textAreaRows: number;
  /** An enum of at most this many members is a `SegmentedChoice`. */
  readonly segmentedMax: number;
  /**
   * An enum of at most this many members (and more than `segmentedMax`) is a
   * `Choice`; a larger one is a `Combobox`.
   */
  readonly choiceMax: number;
  readonly booleanControl: SchemaFormBooleanControl;
}

/**
 * The defaults the AI tool uses — the reference host's defaults. The submit
 * action is the empty `Chain`: wire-representable and inert, for the host to
 * bind, because a derivation has no way to know what submitting means.
 */
export const schemaFormDefaults = <TMsg>(): SchemaFormOptions<TMsg> => ({
  formId: 'schema-form',
  submitLabel: { kind: 'Literal', value: 'Submit' },
  onSubmit: { kind: 'Chain', actions: [] },
  textAreaThreshold: 200,
  textAreaRows: 4,
  segmentedMax: 4,
  choiceMax: 12,
  booleanControl: 'Checkbox',
});

// ─── Refusals ────────────────────────────────────────────────────────────────

/**
 * Why a schema (or a part of it) was not derived. Each case names the thing
 * it refused; the path is carried beside it on `SchemaFormRefusal`.
 */
export type SchemaFormRefusalCode =
  /** The input text is not JSON the reader accepts. */
  | { readonly kind: 'SchemaNotJson'; readonly message: string }
  /** The root is not an object schema. */
  | { readonly kind: 'RootNotObject' }
  /** The root object declares no properties, so there is no form. */
  | { readonly kind: 'NoFields' }
  /** `oneOf` / `anyOf` / `allOf` / `not` / `if` / `then` / `else` / `dependent*`. */
  | { readonly kind: 'Combinator'; readonly keyword: string }
  /** A `$ref` that reaches itself. */
  | { readonly kind: 'RefCycle'; readonly reference: string }
  /** A `$ref` that is not a local pointer, or points at nothing. */
  | { readonly kind: 'RefUnresolved'; readonly reference: string }
  /** An `object` more than one level below the root. */
  | { readonly kind: 'NestingTooDeep' }
  /** A `type` the table has no control for. */
  | { readonly kind: 'UnsupportedType'; readonly typeName: string }
  /** A string `format` the table has no control or rule for. */
  | { readonly kind: 'UnsupportedFormat'; readonly format: string }
  /** A keyword the table does not read at all for this type. */
  | { readonly kind: 'UnsupportedKeyword'; readonly keyword: string }
  /** A keyword the table reads, but the derived control cannot carry it. */
  | { readonly kind: 'KeywordNotCarried'; readonly keyword: string; readonly control: string }
  /** A keyword whose value is malformed or contradicts another. */
  | { readonly kind: 'InvalidKeywordValue'; readonly keyword: string }
  /** An `enum` with a member that is not a string. */
  | { readonly kind: 'EnumNotStrings' }
  /** A property name that cannot be a field id (empty, or host-reserved). */
  | { readonly kind: 'InvalidPropertyName'; readonly name: string }
  /** Two properties derive to the same field id. */
  | { readonly kind: 'DuplicateFieldId'; readonly fieldId: string }
  /** A child listed in `required` under a nested object that is itself optional. */
  | { readonly kind: 'RequiredUnderOptionalObject'; readonly property: string };

/** A refusal and the schema path it is about (RFC 6901 JSON Pointer; `""` is the root). */
export interface SchemaFormRefusal {
  readonly path: string;
  readonly code: SchemaFormRefusalCode;
}

/** The stable kebab-case code a refusal carries on the wire. */
export const schemaFormRefusalCodeName = (code: SchemaFormRefusalCode): string => {
  switch (code.kind) {
    case 'SchemaNotJson':
      return 'schema-not-json';
    case 'RootNotObject':
      return 'root-not-object';
    case 'NoFields':
      return 'no-fields';
    case 'Combinator':
      return 'combinator';
    case 'RefCycle':
      return 'ref-cycle';
    case 'RefUnresolved':
      return 'ref-unresolved';
    case 'NestingTooDeep':
      return 'nesting-too-deep';
    case 'UnsupportedType':
      return 'unsupported-type';
    case 'UnsupportedFormat':
      return 'unsupported-format';
    case 'UnsupportedKeyword':
      return 'unsupported-keyword';
    case 'KeywordNotCarried':
      return 'keyword-not-carried';
    case 'InvalidKeywordValue':
      return 'invalid-keyword-value';
    case 'EnumNotStrings':
      return 'enum-not-strings';
    case 'InvalidPropertyName':
      return 'invalid-property-name';
    case 'DuplicateFieldId':
      return 'duplicate-field-id';
    case 'RequiredUnderOptionalObject':
      return 'required-under-optional-object';
  }
};

/** A one-sentence account of the refusal (the reference host's wording). */
export const schemaFormRefusalMessage = (code: SchemaFormRefusalCode): string => {
  switch (code.kind) {
    case 'SchemaNotJson':
      return 'the schema is not JSON: ' + code.message;
    case 'RootNotObject':
      return 'the root schema is not an object schema';
    case 'NoFields':
      return 'the root object declares no properties';
    case 'Combinator':
      return `'${code.keyword}' has no single form; it is refused rather than guessed`;
    case 'RefCycle':
      return `'$ref' ${code.reference} reaches itself`;
    case 'RefUnresolved':
      return `'$ref' ${code.reference} is not a local pointer to a schema in this document`;
    case 'NestingTooDeep':
      return 'an object more than one level below the root has no form; only one nested level lowers to a group';
    case 'UnsupportedType':
      return `type ${code.typeName} has no form control`;
    case 'UnsupportedFormat':
      return `format '${code.format}' has no form control or rule`;
    case 'UnsupportedKeyword':
      return `keyword '${code.keyword}' is not read by this derivation`;
    case 'KeywordNotCarried':
      return `keyword '${code.keyword}' cannot be carried by a ${code.control} field`;
    case 'InvalidKeywordValue':
      return `keyword '${code.keyword}' has a malformed or contradictory value`;
    case 'EnumNotStrings':
      return 'an enum member is not a string; a choice field submits strings';
    case 'InvalidPropertyName':
      return `property name '${code.name}' cannot be a field id (empty, or a host-reserved state key)`;
    case 'DuplicateFieldId':
      return `two properties derive to field id '${code.fieldId}'`;
    case 'RequiredUnderOptionalObject':
      return `'${code.property}' is required only when its optional parent object is present, which a flat form cannot say`;
  }
};

/** The canonical wire string escape (WIRE_FORMAT §2 rule 6). */
const canonString = (s: string): string => {
  let out = '"';
  for (let k = 0; k < s.length; k += 1) {
    const c = s.charCodeAt(k);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += s.charAt(k);
  }
  return out + '"';
};

/**
 * The canonical JSON of a refusal list — `{"refusals":[{"code","message","path"}]}`,
 * byte-identical to the reference host's envelope.
 */
export const renderSchemaFormRefusals = (refusals: readonly SchemaFormRefusal[]): string =>
  '{"refusals":[' +
  refusals
    .map(
      (r) =>
        `{"code":${canonString(schemaFormRefusalCodeName(r.code))},"message":${canonString(
          schemaFormRefusalMessage(r.code),
        )},"path":${canonString(r.path)}}`,
    )
    .join(',') +
  ']}';

// ─── Schema reading helpers ──────────────────────────────────────────────────

const memberOf = (name: string, v: SchemaJson): SchemaJson | undefined => {
  if (v.kind !== 'obj') return undefined;
  for (const [k, m] of v.members) if (k === name) return m;
  return undefined;
};

const membersOf = (v: SchemaJson): readonly (readonly [string, SchemaJson])[] =>
  v.kind === 'obj' ? v.members : [];

const escapeToken = (t: string): string => t.replaceAll('~', '~0').replaceAll('/', '~1');
const unescapeToken = (t: string): string => t.replaceAll('~1', '/').replaceAll('~0', '~');
const child = (path: string, token: string): string => path + '/' + escapeToken(token);

const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'examples',
  '$defs',
  'definitions',
]);

const COMBINATOR_KEYWORDS: ReadonlySet<string> = new Set([
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'dependentRequired',
  'dependencies',
]);

/** The State-key prefix every tier reserves to the host. */
const HOST_RESERVED_PREFIX = 'host.';

const isWhole = (f: number): boolean => f === Math.floor(f);

/** The reference host's `max` / `min` (the left operand wins a tie, `-0` included). */
const fmax = (a: number, b: number): number => (a < b ? b : a);
const fmin = (a: number, b: number): number => (a < b ? a : b);

const asFloat = (v: SchemaJson): number | undefined =>
  v.kind === 'int' || v.kind === 'float' ? v.value : undefined;

/** `Int32.TryParse` over a pointer token: optional ASCII whitespace, one sign, digits. */
const tryParseIndex = (token: string): number | undefined => {
  if (!/^[\t\n\v\f\r ]*[+-]?\d+[\t\n\v\f\r ]*$/.test(token)) return undefined;
  const v = Number(token.trim());
  return v >= INT32_MIN && v <= INT32_MAX ? v : undefined;
};

/** The reference host's compact author-ordered render, for naming a bad `type`. */
const describe = (v: SchemaJson): string => {
  const esc = (s: string): string => {
    let out = '';
    for (let k = 0; k < s.length; k += 1) {
      const c = s.charCodeAt(k);
      if (c === 0x22) out += '\\"';
      else if (c === 0x5c) out += '\\\\';
      else if (c === 0x0a) out += '\\n';
      else if (c === 0x0d) out += '\\r';
      else if (c === 0x09) out += '\\t';
      else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
      else out += s.charAt(k);
    }
    return out;
  };
  switch (v.kind) {
    case 'str':
      return '"' + esc(v.value) + '"';
    case 'int':
      return String(v.value);
    case 'float':
      return formatFiniteDouble(v.value);
    case 'bool':
      return v.value ? 'true' : 'false';
    case 'arr':
      return '[' + v.items.map(describe).join(',') + ']';
    case 'obj':
      return '{' + v.members.map(([k, m]) => '"' + esc(k) + '":' + describe(m)).join(',') + '}';
  }
};

/** Resolve a local JSON Pointer (`#`, `#/a/b`) against the root. */
const resolvePointer = (root: SchemaJson, reference: string): SchemaJson | undefined => {
  if (reference === '#') return root;
  if (!reference.startsWith('#/')) return undefined;
  let node: SchemaJson | undefined = root;
  for (const raw of reference.slice(2).split('/')) {
    if (node === undefined) return undefined;
    const token = unescapeToken(raw);
    if (node.kind === 'obj') node = memberOf(token, node);
    else if (node.kind === 'arr') {
      const idx = tryParseIndex(token);
      node = idx !== undefined && idx >= 0 && idx < node.items.length ? node.items[idx] : undefined;
    } else node = undefined;
  }
  return node;
};

// ─── The derivation ──────────────────────────────────────────────────────────

interface Ctx<TMsg> {
  readonly root: SchemaJson;
  readonly options: SchemaFormOptions<TMsg>;
  readonly refusals: SchemaFormRefusal[];
}

const refuse = <TMsg>(ctx: Ctx<TMsg>, path: string, code: SchemaFormRefusalCode): void => {
  ctx.refusals.push({ path, code });
};

/**
 * Follow `$ref` (chained) to a concrete schema. `stack` is the refs already
 * being expanded on this descent, which is what a cycle is. A sibling `title`
 * / `description` overrides the target's; any other sibling is refused.
 */
const resolveRefs = <TMsg>(
  ctx: Ctx<TMsg>,
  path: string,
  stack: readonly string[],
  schema: SchemaJson,
): readonly [SchemaJson, readonly string[]] | undefined => {
  const ref = memberOf('$ref', schema);
  if (ref === undefined) return [schema, stack];
  if (ref.kind !== 'str') {
    refuse(ctx, child(path, '$ref'), { kind: 'InvalidKeywordValue', keyword: '$ref' });
    return undefined;
  }
  const reference = ref.value;
  const siblings = membersOf(schema).filter(([k]) => k !== '$ref');
  const foreign = siblings.filter(([k]) => !ANNOTATION_KEYWORDS.has(k));
  for (const [k] of foreign)
    refuse(ctx, child(path, k), { kind: 'UnsupportedKeyword', keyword: k });
  if (foreign.length > 0) return undefined;
  if (stack.includes(reference)) {
    refuse(ctx, child(path, '$ref'), { kind: 'RefCycle', reference });
    return undefined;
  }
  const target = resolvePointer(ctx.root, reference);
  if (target === undefined) {
    refuse(ctx, child(path, '$ref'), { kind: 'RefUnresolved', reference });
    return undefined;
  }
  const resolved = resolveRefs(ctx, path, [reference, ...stack], target);
  if (resolved === undefined) return undefined;
  const [concrete, stack2] = resolved;
  if (concrete.kind !== 'obj') {
    refuse(ctx, child(path, '$ref'), { kind: 'RefUnresolved', reference });
    return undefined;
  }
  const overriding = new Set(siblings.map(([k]) => k));
  return [
    {
      kind: 'obj',
      members: [...siblings, ...concrete.members.filter(([k]) => !overriding.has(k))],
    },
    stack2,
  ];
};

/** The effective `type`, with `[T, "null"]` read as `T`. */
const effectiveType = <TMsg>(
  ctx: Ctx<TMsg>,
  path: string,
  schema: SchemaJson,
): string | undefined => {
  const t = memberOf('type', schema);
  if (t !== undefined) {
    if (t.kind === 'str' && t.value !== 'null') return t.value;
    if (t.kind === 'arr' && t.items.length === 2) {
      const [a, b] = t.items;
      if (a?.kind === 'str' && b?.kind === 'str') {
        if (b.value === 'null' && a.value !== 'null') return a.value;
        if (a.value === 'null' && b.value !== 'null') return b.value;
      }
    }
    refuse(ctx, child(path, 'type'), { kind: 'UnsupportedType', typeName: describe(t) });
    return undefined;
  }
  const combinators = membersOf(schema)
    .map(([k]) => k)
    .filter((k) => COMBINATOR_KEYWORDS.has(k));
  if (combinators.length > 0) {
    // An untyped `oneOf` / `anyOf` IS the combinator: name it, rather than
    // reporting a missing type the combinator was standing in for.
    for (const k of combinators) refuse(ctx, child(path, k), { kind: 'Combinator', keyword: k });
    return undefined;
  }
  if (memberOf('enum', schema) !== undefined) return 'string';
  if (memberOf('properties', schema) !== undefined) return 'object';
  refuse(ctx, path, { kind: 'UnsupportedType', typeName: '(absent)' });
  return undefined;
};

const allowedFor = (typeName: string): ReadonlySet<string> => {
  switch (typeName) {
    case 'string':
      return new Set(['type', 'enum', 'default', 'minLength', 'maxLength', 'pattern', 'format']);
    case 'number':
    case 'integer':
      return new Set([
        'type',
        'default',
        'minimum',
        'maximum',
        'exclusiveMinimum',
        'exclusiveMaximum',
        'multipleOf',
      ]);
    case 'boolean':
      return new Set(['type', 'default']);
    case 'array':
      return new Set(['type', 'items', 'default', 'uniqueItems']);
    case 'object':
      return new Set(['type', 'properties', 'required', 'additionalProperties']);
    default:
      return new Set();
  }
};

/** Refuse every keyword the table does not read for this type. False when anything was refused. */
const checkKeywords = <TMsg>(
  ctx: Ctx<TMsg>,
  path: string,
  typeName: string,
  schema: SchemaJson,
): boolean => {
  const allowed = allowedFor(typeName);
  let ok = true;
  for (const [k] of membersOf(schema)) {
    if (ANNOTATION_KEYWORDS.has(k) || allowed.has(k)) continue;
    if (COMBINATOR_KEYWORDS.has(k)) refuse(ctx, child(path, k), { kind: 'Combinator', keyword: k });
    else refuse(ctx, child(path, k), { kind: 'UnsupportedKeyword', keyword: k });
    ok = false;
  }
  return ok;
};

const nonEmptyString = (v: SchemaJson | undefined): string | undefined =>
  v?.kind === 'str' && v.value !== '' ? v.value : undefined;

const readCount = <TMsg>(
  ctx: Ctx<TMsg>,
  path: string,
  keyword: string,
  schema: SchemaJson,
): number | undefined => {
  const v = memberOf(keyword, schema);
  if (v === undefined) return undefined;
  if (v.kind === 'int' && v.value >= 0) return v.value;
  refuse(ctx, child(path, keyword), { kind: 'InvalidKeywordValue', keyword });
  return undefined;
};

const readNumber = <TMsg>(
  ctx: Ctx<TMsg>,
  path: string,
  keyword: string,
  schema: SchemaJson,
): number | undefined => {
  const v = memberOf(keyword, schema);
  if (v === undefined) return undefined;
  const f = asFloat(v);
  if (f !== undefined) return f;
  refuse(ctx, child(path, keyword), { kind: 'InvalidKeywordValue', keyword });
  return undefined;
};

/** The enum members, when every one is a string and there is at least one and no duplicate. */
const readEnum = <TMsg>(ctx: Ctx<TMsg>, path: string, schema: SchemaJson): string[] | undefined => {
  const e = memberOf('enum', schema);
  if (e === undefined) return undefined;
  if (e.kind !== 'arr') {
    refuse(ctx, child(path, 'enum'), { kind: 'InvalidKeywordValue', keyword: 'enum' });
    return undefined;
  }
  const strings = e.items.flatMap((item) => (item.kind === 'str' ? [item.value] : []));
  if (strings.length !== e.items.length) {
    refuse(ctx, child(path, 'enum'), { kind: 'EnumNotStrings' });
    return undefined;
  }
  if (strings.length === 0 || new Set(strings).size !== strings.length) {
    refuse(ctx, child(path, 'enum'), { kind: 'InvalidKeywordValue', keyword: 'enum' });
    return undefined;
  }
  return strings;
};

const optionsOf = (values: readonly string[]): readonly SelectOption[] =>
  values.map((v) => ({ label: { kind: 'Literal', value: v }, value: v }));

/**
 * The value binding a field carries: a declared schema `default` is
 * `State(<field id>, default)`; no default is the form field's auto-binding —
 * `State(<field id>, <the control's typed placeholder>)`, which the canonical
 * encoder omits (WIRE_FORMAT §1, the symmetric form-field auto-bind).
 */
const valueBinding = <T>(
  fieldId: string,
  declared: { readonly value: T } | undefined,
  placeholder: T,
): Binding<T> =>
  declared !== undefined
    ? { kind: 'State', key: fieldId, defaultValue: declared.value, defaultDeclared: true }
    : { kind: 'State', key: fieldId, defaultValue: placeholder };

type Derived<TMsg> = readonly [FormFieldKind<TMsg>, FieldRule | undefined];

/** The control a property derives to, or `undefined` when it was refused (already recorded). */
const deriveControl = <TMsg>(
  ctx: Ctx<TMsg>,
  path: string,
  fieldId: string,
  typeName: string,
  schema: SchemaJson,
): Derived<TMsg> | undefined => {
  const defaultValue = memberOf('default', schema);
  const badDefault = (): void =>
    refuse(ctx, child(path, 'default'), { kind: 'InvalidKeywordValue', keyword: 'default' });

  const enumControl = (values: readonly string[]): Derived<TMsg> | undefined => {
    let declared: { value: string } | undefined;
    if (defaultValue !== undefined) {
      if (defaultValue.kind === 'str' && values.includes(defaultValue.value))
        declared = { value: defaultValue.value };
      else {
        badDefault();
        return undefined;
      }
    }
    const value = valueBinding<string | undefined>(fieldId, declared, controlValueDefaults.choice);
    const options: Binding<readonly SelectOption[]> = { kind: 'Static', value: optionsOf(values) };
    if (values.length <= ctx.options.segmentedMax)
      return [{ kind: 'SegmentedChoice', options, value, orientation: 'Horizontal' }, undefined];
    if (values.length <= ctx.options.choiceMax)
      return [{ kind: 'Choice', options, value }, undefined];
    return [{ kind: 'Combobox', allowFreeText: false, options, value }, undefined];
  };

  const refuseTextKeywords = (control: string): boolean => {
    const present = ['minLength', 'maxLength', 'pattern'].filter(
      (k) => memberOf(k, schema) !== undefined,
    );
    for (const k of present)
      refuse(ctx, child(path, k), { kind: 'KeywordNotCarried', keyword: k, control });
    return present.length === 0;
  };

  switch (typeName) {
    case 'string': {
      if (memberOf('enum', schema) !== undefined) {
        const values = readEnum(ctx, path, schema);
        if (values === undefined) return undefined;
        const control =
          values.length <= ctx.options.segmentedMax
            ? 'SegmentedChoice'
            : values.length <= ctx.options.choiceMax
              ? 'Choice'
              : 'Combobox';
        const carried = refuseTextKeywords(control);
        if (memberOf('format', schema) !== undefined) {
          refuse(ctx, child(path, 'format'), {
            kind: 'KeywordNotCarried',
            keyword: 'format',
            control,
          });
          return undefined;
        }
        return carried ? enumControl(values) : undefined;
      }

      const formatMember = memberOf('format', schema);
      const formatOk = formatMember === undefined || formatMember.kind === 'str';
      const fmt = formatMember?.kind === 'str' ? formatMember.value : undefined;

      let declared: { value: string } | undefined;
      let defaultOk = true;
      if (defaultValue !== undefined) {
        if (defaultValue.kind === 'str') declared = { value: defaultValue.value };
        else {
          badDefault();
          defaultOk = false;
        }
      }

      if (!formatOk) {
        refuse(ctx, child(path, 'format'), { kind: 'InvalidKeywordValue', keyword: 'format' });
        return undefined;
      }
      if (!defaultOk) return undefined;

      const temporal = (variant: DateTimeVariant): Derived<TMsg> | undefined =>
        refuseTextKeywords('DateTime')
          ? [
              {
                kind: 'DateTime',
                value: valueBinding(fieldId, declared, controlValueDefaults.dateTime),
                variant,
                constraints: {},
              },
              undefined,
            ]
          : undefined;

      if (fmt === 'date') return temporal('Date');
      if (fmt === 'time') return temporal('Time');
      if (fmt === 'date-time') return temporal('DateTime');
      if (fmt === 'color')
        return refuseTextKeywords('Color')
          ? [
              { kind: 'Color', value: valueBinding(fieldId, declared, controlValueDefaults.color) },
              undefined,
            ]
          : undefined;
      if (fmt !== undefined && fmt !== 'email' && fmt !== 'uri') {
        refuse(ctx, child(path, 'format'), { kind: 'UnsupportedFormat', format: fmt });
        return undefined;
      }

      const minLength = readCount(ctx, path, 'minLength', schema);
      const maxLength = readCount(ctx, path, 'maxLength', schema);
      const patternMember = memberOf('pattern', schema);
      const patternOk = patternMember === undefined || patternMember.kind === 'str';
      const pattern = patternMember?.kind === 'str' ? patternMember.value : undefined;

      let lengthsOk = true;
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
        refuse(ctx, child(path, 'minLength'), {
          kind: 'InvalidKeywordValue',
          keyword: 'minLength',
        });
        lengthsOk = false;
      }

      if (!patternOk) {
        refuse(ctx, child(path, 'pattern'), { kind: 'InvalidKeywordValue', keyword: 'pattern' });
        return undefined;
      }
      if (!lengthsOk) return undefined;

      const textFormat: TextFormat | undefined =
        fmt === 'email' ? 'email' : fmt === 'uri' ? 'url' : undefined;
      const rule: FieldRule | undefined =
        textFormat === undefined &&
        maxLength === undefined &&
        minLength === undefined &&
        pattern === undefined
          ? undefined
          : {
              ...(textFormat !== undefined ? { format: textFormat } : {}),
              ...(maxLength !== undefined ? { maxLength } : {}),
              ...(minLength !== undefined ? { minLength } : {}),
              ...(pattern !== undefined ? { pattern } : {}),
            };
      const value = valueBinding(fieldId, declared, controlValueDefaults.text);
      const long =
        maxLength !== undefined &&
        maxLength > ctx.options.textAreaThreshold &&
        textFormat === undefined;
      return long
        ? [{ kind: 'TextArea', value, rows: ctx.options.textAreaRows }, rule]
        : [{ kind: 'Text', value }, rule];
    }

    case 'number':
    case 'integer': {
      const isInteger = typeName === 'integer';
      if (memberOf('enum', schema) !== undefined) {
        refuse(ctx, child(path, 'enum'), { kind: 'EnumNotStrings' });
        return undefined;
      }
      const refusalsBefore = ctx.refusals.length;
      const minimum = readNumber(ctx, path, 'minimum', schema);
      const maximum = readNumber(ctx, path, 'maximum', schema);
      const exMin = readNumber(ctx, path, 'exclusiveMinimum', schema);
      const exMax = readNumber(ctx, path, 'exclusiveMaximum', schema);
      const multipleOf = readNumber(ctx, path, 'multipleOf', schema);

      if (!isInteger) {
        if (exMin !== undefined)
          refuse(ctx, child(path, 'exclusiveMinimum'), {
            kind: 'KeywordNotCarried',
            keyword: 'exclusiveMinimum',
            control: 'RangedNumber',
          });
        if (exMax !== undefined)
          refuse(ctx, child(path, 'exclusiveMaximum'), {
            kind: 'KeywordNotCarried',
            keyword: 'exclusiveMaximum',
            control: 'RangedNumber',
          });
      }

      if (multipleOf !== undefined && (multipleOf <= 0 || (isInteger && !isWhole(multipleOf))))
        refuse(ctx, child(path, 'multipleOf'), {
          kind: 'InvalidKeywordValue',
          keyword: 'multipleOf',
        });

      const exLower = isInteger && exMin !== undefined ? Math.floor(exMin) + 1 : undefined;
      const lower =
        minimum !== undefined && exLower !== undefined
          ? fmax(minimum, exLower)
          : (exLower ?? minimum);
      const exUpper = isInteger && exMax !== undefined ? Math.ceil(exMax) - 1 : undefined;
      const upper =
        maximum !== undefined && exUpper !== undefined
          ? fmin(maximum, exUpper)
          : (exUpper ?? maximum);

      if (lower !== undefined && upper !== undefined && lower > upper)
        refuse(ctx, child(path, 'minimum'), { kind: 'InvalidKeywordValue', keyword: 'minimum' });

      let declared: { value: number } | undefined;
      if (defaultValue !== undefined) {
        const f = asFloat(defaultValue);
        if (
          f !== undefined &&
          (!isInteger || isWhole(f)) &&
          (lower === undefined || f >= lower) &&
          (upper === undefined || f <= upper)
        )
          declared = { value: f };
        else {
          badDefault();
          return undefined;
        }
      }

      if (ctx.refusals.length !== refusalsBefore) return undefined;

      const value = valueBinding(fieldId, declared, controlValueDefaults.number);
      const step = isInteger ? (multipleOf ?? 1) : multipleOf;
      if (lower === undefined && upper === undefined && step === undefined)
        return [{ kind: 'Number', value }, undefined];
      return [
        {
          kind: 'RangedNumber',
          value,
          constraints: {
            ...(lower !== undefined ? { min: lower } : {}),
            ...(upper !== undefined ? { max: upper } : {}),
            ...(step !== undefined ? { step } : {}),
          },
        },
        undefined,
      ];
    }

    case 'boolean': {
      let declared: { value: boolean } | undefined;
      if (defaultValue !== undefined) {
        if (defaultValue.kind === 'bool') declared = { value: defaultValue.value };
        else {
          badDefault();
          return undefined;
        }
      }
      const value = valueBinding(fieldId, declared, controlValueDefaults.checkbox);
      return ctx.options.booleanControl === 'Toggle'
        ? [{ kind: 'Toggle', value }, undefined]
        : [{ kind: 'Checkbox', value }, undefined];
    }

    case 'array': {
      const itemsPath = child(path, 'items');
      const itemsMember = memberOf('items', schema);
      if (itemsMember === undefined) {
        refuse(ctx, path, { kind: 'UnsupportedType', typeName: 'array without items' });
        return undefined;
      }
      const resolved = resolveRefs(ctx, itemsPath, [], itemsMember);
      if (resolved === undefined) return undefined;
      const [items] = resolved;
      const itemType = effectiveType(ctx, itemsPath, items);
      if (itemType === undefined) return undefined;
      if (itemType !== 'string' || memberOf('enum', items) === undefined) {
        refuse(ctx, itemsPath, { kind: 'UnsupportedType', typeName: 'array of ' + itemType });
        return undefined;
      }
      // The text keywords are read off the ARRAY schema here, as the reference
      // host does (the items' own are admitted by the string keyword check).
      if (!(checkKeywords(ctx, itemsPath, 'string', items) && refuseTextKeywords('Tokens')))
        return undefined;
      if (memberOf('format', items) !== undefined) {
        refuse(ctx, child(itemsPath, 'format'), {
          kind: 'KeywordNotCarried',
          keyword: 'format',
          control: 'Tokens',
        });
        return undefined;
      }
      const values = readEnum(ctx, itemsPath, items);
      if (values === undefined) return undefined;
      let declared: { value: readonly string[] } | undefined;
      if (defaultValue !== undefined) {
        if (defaultValue.kind !== 'arr') {
          badDefault();
          return undefined;
        }
        const strings = defaultValue.items.flatMap((d) =>
          d.kind === 'str' && values.includes(d.value) ? [d.value] : [],
        );
        if (
          strings.length !== defaultValue.items.length ||
          new Set(strings).size !== strings.length
        ) {
          badDefault();
          return undefined;
        }
        declared = { value: strings };
      }
      return [
        {
          kind: 'Tokens',
          allowFreeText: false,
          suggestions: { kind: 'Static', value: optionsOf(values) },
          value: valueBinding(fieldId, declared, controlValueDefaults.tokens),
        },
        undefined,
      ];
    }

    default:
      refuse(ctx, child(path, 'type'), { kind: 'UnsupportedType', typeName });
      return undefined;
  }
};

/** The `required` list of an object schema, checked against its properties. */
const readRequired = <TMsg>(
  ctx: Ctx<TMsg>,
  path: string,
  schema: SchemaJson,
  names: readonly string[],
): ReadonlySet<string> => {
  const r = memberOf('required', schema);
  if (r === undefined) return new Set();
  if (r.kind !== 'arr') {
    refuse(ctx, child(path, 'required'), { kind: 'InvalidKeywordValue', keyword: 'required' });
    return new Set();
  }
  const strings = r.items.flatMap((item) => (item.kind === 'str' ? [item.value] : []));
  if (strings.length !== r.items.length || strings.some((s) => !names.includes(s)))
    refuse(ctx, child(path, 'required'), { kind: 'InvalidKeywordValue', keyword: 'required' });
  return new Set(strings);
};

const checkAdditional = <TMsg>(ctx: Ctx<TMsg>, path: string, schema: SchemaJson): void => {
  const a = memberOf('additionalProperties', schema);
  if (a === undefined || a.kind === 'bool') return;
  refuse(ctx, child(path, 'additionalProperties'), {
    kind: 'KeywordNotCarried',
    keyword: 'additionalProperties',
    control: 'Form',
  });
};

const propertiesOf = <TMsg>(
  ctx: Ctx<TMsg>,
  path: string,
  schema: SchemaJson,
): readonly (readonly [string, SchemaJson])[] | undefined => {
  const p = memberOf('properties', schema);
  if (p === undefined) return [];
  if (p.kind === 'obj') return p.members;
  refuse(ctx, child(path, 'properties'), { kind: 'InvalidKeywordValue', keyword: 'properties' });
  return undefined;
};

/**
 * Derive the fields of one object's properties. `depth` 0 is the root; a
 * property that is itself an object at depth 0 lowers to a group (its children
 * at depth 1); an object at depth 1 is refused.
 */
const deriveFields = <TMsg>(
  ctx: Ctx<TMsg>,
  path: string,
  stack: readonly string[],
  depth: number,
  prefix: readonly [string, string] | undefined,
  parentRequired: boolean,
  schema: SchemaJson,
): FormField<TMsg>[] => {
  const props = propertiesOf(ctx, path, schema);
  if (props === undefined) return [];
  const required = readRequired(
    ctx,
    path,
    schema,
    props.map(([name]) => name),
  );
  checkAdditional(ctx, path, schema);

  return props.flatMap(([name, propSchema]): FormField<TMsg>[] => {
    const propPath = child(child(path, 'properties'), name);
    const fieldId = prefix !== undefined ? prefix[0] + '.' + name : name;
    if (name === '' || fieldId.startsWith(HOST_RESERVED_PREFIX)) {
      refuse(ctx, propPath, { kind: 'InvalidPropertyName', name });
      return [];
    }
    const resolved = resolveRefs(ctx, propPath, stack, propSchema);
    if (resolved === undefined) return [];
    const [concrete, stack2] = resolved;
    const typeName = effectiveType(ctx, propPath, concrete);
    if (typeName === undefined) return [];
    const isRequired = required.has(name);
    if (isRequired && !parentRequired)
      refuse(ctx, propPath, { kind: 'RequiredUnderOptionalObject', property: name });
    if (!checkKeywords(ctx, propPath, typeName, concrete)) return [];
    const title = nonEmptyString(memberOf('title', concrete)) ?? name;
    const label = prefix !== undefined ? prefix[1] + ': ' + title : title;
    if (typeName === 'object') {
      if (depth >= 1) {
        refuse(ctx, propPath, { kind: 'NestingTooDeep' });
        return [];
      }
      return deriveFields(ctx, propPath, stack2, depth + 1, [fieldId, label], isRequired, concrete);
    }
    const derived = deriveControl(ctx, propPath, fieldId, typeName, concrete);
    if (derived === undefined) return [];
    const [kind, rule] = derived;
    const help = nonEmptyString(memberOf('description', concrete));
    return [
      {
        id: fieldId,
        kind,
        label: { kind: 'Literal', value: label },
        required: isRequired && parentRequired,
        ...(help !== undefined ? { help: { kind: 'Literal', value: help } as TextSource } : {}),
        ...(rule !== undefined ? { rule } : {}),
      },
    ];
  });
};

/**
 * Derive a `Form` node from a JSON Schema. `ok` carries the node; `error`
 * carries EVERY refusal in the schema (not only the first), each naming its
 * path. Pure and deterministic: field order is the schema's `properties`
 * order, and the same schema and options always yield the same tree.
 */
export const deriveForm = <TMsg>(
  options: SchemaFormOptions<TMsg>,
  schema: SchemaJson,
): SchemaFormResult<Node<TMsg>> => {
  const ctx: Ctx<TMsg> = { root: schema, options, refusals: [] };

  let fields: FormField<TMsg>[] = [];
  if (schema.kind !== 'obj') refuse(ctx, '', { kind: 'RootNotObject' });
  else {
    const resolved = resolveRefs(ctx, '', [], schema);
    if (resolved !== undefined) {
      const [root, stack] = resolved;
      const typeName = effectiveType(ctx, '', root);
      if (typeName === 'object') {
        if (checkKeywords(ctx, '', 'object', root)) {
          const props = memberOf('properties', root);
          if (props === undefined || (props.kind === 'obj' && props.members.length === 0))
            refuse(ctx, '', { kind: 'NoFields' });
          else fields = deriveFields(ctx, '', stack, 0, undefined, true, root);
        }
      } else if (typeName !== undefined) refuse(ctx, '', { kind: 'RootNotObject' });
    }
  }

  // Two properties that derive to one id (`a.b` at the root beside `a: {b}`),
  // reported in first-occurrence order.
  const counts = new Map<string, number>();
  for (const f of fields) counts.set(f.id, (counts.get(f.id) ?? 0) + 1);
  for (const [fieldId, count] of counts)
    if (count > 1) refuse(ctx, '', { kind: 'DuplicateFieldId', fieldId });

  if (ctx.refusals.length > 0) return { ok: false, error: ctx.refusals };
  return {
    ok: true,
    value: fuaran.form<TMsg>({
      id: options.formId,
      fields,
      onSubmit: options.onSubmit,
      submitLabel: options.submitLabel,
    }),
  };
};

/**
 * `deriveForm` over schema TEXT. The read is null-tolerant (`"default": null`
 * is member absence); text the reader refuses is a `schema-not-json` refusal,
 * in the same envelope.
 */
export const deriveFormFromText = <TMsg>(
  options: SchemaFormOptions<TMsg>,
  text: string,
): SchemaFormResult<Node<TMsg>> => {
  const parsed = parseSchemaJson(text);
  return parsed.ok
    ? deriveForm(options, parsed.value)
    : { ok: false, error: [{ path: '', code: { kind: 'SchemaNotJson', message: parsed.error } }] };
};
