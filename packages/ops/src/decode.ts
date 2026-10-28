// ============================================================================
//  @fuaran-ui/ops — structural decoder for the canonical-JSON wire form.
//
//  Port of Fuaran.UI.Ops.JsonDecode (decodeNode / decodeOp). The inverse of
//  encode.ts: parses the hand-rolled JSON AST (parse.ts) into the typed tree,
//  storage-shape erased to `Node<unknown>` / `TreeOp<unknown>` (the wire carries
//  no typed-`'Msg` information — every `'Msg` payload encoded as "<closure>").
//
//  Every wire-shape violation surfaces a structured, recoverable `DecodeError`
//  (never a throw) carrying one of the six `DecodeErrorCode`s + a `$`-rooted
//  dotted path, byte-identical to the F# decoder's codes/paths (WIRE_FORMAT.md
//  §6). The six codes are the stable AI-recovery surface.
//
//  Closure-bearing slots (§4) decode to placeholders that re-encode to
//  "<closure>"; opaque `Binding.Static` payloads (§5) decode to the literal
//  string "<opaque>", which re-encodes to "<opaque>" — keeping the round-trip
//  byte-stable. Typed re-attachment of the erased payloads is the host's job.
// ============================================================================

import {
  COLUMN_TYPES,
  ENUM_CASES,
  TIMESTAMP_UNIT_DIGITS,
  FORM_FIELD_KIND_NAMES,
  KIND_FIELDS,
  KINDS_BY_CATEGORY,
  NODE_KIND_GROUPS,
  NODE_KIND_NAMES,
  RECORD_FIELDS,
  defaultValue,
  wireRows,
  controlValueDefaults,
  defaults,
  projectSelectionField,
  MAX_EXPR_NODES,
  MAX_NODES,
  MAX_NODE_DEPTH,
  MAX_SKELETON_ROWS,
  // WIRE_FORMAT §23 — the host-declared kind admission policy. The type and its
  // combinators live in `@fuaran-ui/schema` because `ops` and `ui` are peers
  // that both need them; see `kindPolicy.ts` for the placement argument.
  admitAll,
  admits,
  narrows,
  policyHint,
  type DecodePolicy,
} from '@fuaran-ui/schema';
import type {
  Accessibility,
  Action,
  Agg,
  EnumCase,
  EnumName,
  FieldRow,
  FragmentRefSpec,
  IdlRecord,
  IdlSpec,
  IdlType,
  KindCategory,
  NodeKindName,
  Optionality,
  RecordName,
  AggFn,
  AriaRole,
  BinOp,
  Cell,
  ColExpr,
  ColPair,
  ColumnData,
  ColumnType,
  DataColumn,
  DataSource,
  InvokeArg,
  JoinKind,
  ScalarFn,
  SchemaEntry,
  SortKey,
  Transform,
  TransformParam,
  TransformSource,
  WindowFn,
  BadgeVariant,
  Binding,
  BoxLayout,
  BoxRole,
  CallResultTarget,
  ButtonVariant,
  CellFormat,
  CellKindErased,
  ChartAnnotation,
  ChartAnnotationRange,
  ChartAnnotationX,
  ColumnErased,
  ColumnWidth,
  ContentHash,
  DateTimeVariant,
  DeterminismSource,
  DisplayKind,
  EffectClass,
  Emphasis,
  NavigateTarget,
  MediaKind,
  TrackEntry,
  TreeItem,
  CurveCommand,
  DrawPoint,
  DrawStyle,
  Shape,
  ViewBox,
  ErrorPayload,
  FileUploadSpec,
  FilterSpec,
  FragmentArg,
  FragmentScalar,
  Format,
  FormField,
  FormFieldKind,
  FieldRule,
  CompareRule,
  CompareOp,
  TextFormat,
  HashStrictness,
  HeadingVariant,
  HoleDecl,
  HoleValueSpace,
  HostEffect,
  IconSource,
  InputKind,
  JsonValue,
  MapMarker,
  MountSpec,
  LayoutKind,
  LocaleSource,
  LocalBinding,
  LocalFlushTrigger,
  Node,
  NodeId,
  NodeKind,
  Orientation,
  Result,
  SelectOption,
  SelectSpec,
  SrcSetEntry,
  SemanticStyle,
  IconSize,
  StateBehaviour,
  SwitchCase,
  StepperSpec,
  StyleWeight,
  DefaultSort,
  TabHeader,
  Table,
  TextSource,
  ToneVariant,
  VisKind,
  TrendPolarity,
} from '@fuaran-ui/schema';

import {
  dateDays,
  instantParts,
  isInt32,
  parseIsoDay,
  validityOfMask,
  type InstantParts,
} from '@fuaran-ui/core-twins';
// Phase 2001 — the exact decimal: its canonical text and the rounding policy's seven modes.
import { decimalCanonical } from '@fuaran-ui/core-twins';
import { ROUNDING_MODES, type Rounding, type RoundingMode } from '@fuaran-ui/schema';

import {
  DECODED_COMPUTED_MESSAGE,
  WireSurvivabilityError,
  identityFormat,
  numberText,
  scalarOfText,
  tryNumberText,
} from './localCodec.js';
import { type JsonAst, parse } from './parse.js';
import type { StyleDelta, TreeOp } from './treeOp.js';

// ─── DecodeError surface ─────────────────────────────────────────────────────

/** Stable AI-friendly discriminator for decode-time failures (WIRE_FORMAT.md §6). */
export type DecodeErrorCode =
  | 'INVALID_JSON'
  | 'MISSING_FIELD'
  | 'WRONG_TYPE'
  | 'UNKNOWN_DU_CASE'
  | 'WRONG_NODE_KIND'
  | 'EMPTY_NODE_ID'
  /**
   * A WIRE_FORMAT.md §21 resource limit was exceeded — the document is
   * well-formed and merely too large to walk. Deliberately distinct from
   * `INVALID_JSON`, which §21.2 rule 2 forbids using for this: calling a
   * well-formed document malformed sends the author to repair the wrong thing.
   */
  | 'LIMIT_EXCEEDED'
  /**
   * The document names a kind the HOST'S DECLARED decode policy does not admit
   * (WIRE_FORMAT.md §23).
   *
   * Deliberately distinct from `WRONG_NODE_KIND`, which says the vocabulary has
   * no such kind. This one says the kind exists and THIS DEPLOYMENT does not
   * take it — a different fact with a different remedy, and conflating them
   * would send a repairing author to invent a spelling that is already correct.
   *
   * Raised ONLY when a caller supplied a narrowing policy. With no policy the
   * code is unreachable, which is what keeps §22's "a decoder owes nothing"
   * true of the default decoder.
   */
  | 'KIND_NOT_ADMITTED';

/** AI-recoverable decode-time failure. Mirrors the F# `DecodeError` record. */
export interface DecodeError {
  readonly code: DecodeErrorCode;
  readonly path: string;
  readonly message: string;
  readonly expectedShape?: string;
}

/**
 * What a refusal establishes: the defects, never empty. Every decoder below
 * returns this LIST (WIRE_FORMAT.md §29), and the public single-error entry
 * points take its head — so an error is a value that flows up through the
 * combinators, never a note left in a module-level collector.
 */
type Defects = readonly DecodeError[];

type R<T> = Result<T, Defects>;

/** A decoder of the `(walk, path, ast)` shape — the one shape every member decoder has. */
type Decoder<T> = (w: Walk, path: string, j: JsonAst) => R<T>;

const ok = <T>(value: T): R<T> => ({ ok: true, value });

const fail = (error: Defects): R<never> => ({ ok: false, error });

// ─── The walk (WIRE_FORMAT.md §21, §23) ───────────────────────────────────────
//
// Everything one decode carries besides the value under its cursor: the §21
// counters along the three recursive axes — nodes, ops (`Batch`) and tree
// items — and the §23 admission policy. It is the first argument of every
// decoder, so two decodes never share a counter: a decode started from inside
// another (through a custom AST, a callback, a tolerant reader) gets its own
// and leaves the outer one exactly where it was. Bounding the PARSER is not
// sufficient (§21.5, which the reference host learned on 2.6 KB of nested
// `Batch`); each axis counts its own, against the same ceiling.
interface Walk {
  readonly policy: DecodePolicy;
  depth: number;
  nodes: number;
  opDepth: number;
  itemDepth: number;
}

const newWalk = (policy: DecodePolicy = admitAll): Walk => ({
  policy,
  depth: 0,
  nodes: 0,
  opDepth: 0,
  itemDepth: 0,
});

// ─── The defect walk (WIRE_FORMAT.md §29; Phase 1935, Phase 2072) ─────────────
//
// A node decode reports EVERY independent defect, and it gets there the way the
// reference host does — by construction. Each member of an object is decoded on
// its own and the failures are JOINED at the combine (`failed`); each element
// of an array likewise (`traverseIndexed`); a rule relating members sits after
// the guard that joins them, so it runs only once every member it reads has
// decoded (§29.1 rule 5); a member read in the context of a sibling is decoded
// under a good sibling and presence-checked under a bad one (`underSibling`,
// rule 6). A consequence of a defect is therefore never constructed, and nothing
// has to be suppressed afterwards: the §29.1 rules fall out of each decoder's
// shape rather than being retrofitted onto it.
//
// The list stays in decode order on the way up. `decodeNodeWithDefects` puts it
// in the §29.3 canonical order at the root (`defectList`), where a §21 breach,
// which ends the walk's meaning, is reported alone. The op decoder keeps its
// single-error form (§29.6) by taking the head of the same list.

const makeError = (
  code: DecodeErrorCode,
  path: string,
  message: string,
  expectedShape?: string,
): R<never> =>
  fail([
    expectedShape === undefined ? { code, path, message } : { code, path, message, expectedShape },
  ]);

/**
 * The applicative combine over an error type: the failures among `rs`, joined in
 * order by `join`. Generic over the error so the compute layer's first-error
 * results and this decoder's defect lists are two instances of one combinator.
 */
const joinFailures = <E>(
  join: (a: E, b: E) => E,
  rs: readonly Result<unknown, E>[],
): E | undefined => {
  let acc: E | undefined;
  for (const r of rs) if (!r.ok) acc = acc === undefined ? r.error : join(acc, r.error);
  return acc;
};

const concatDefects = (a: Defects, b: Defects): Defects => [...a, ...b];

/**
 * The failures among the members `rs`, every defect kept, in decode order. The
 * record combinator: a decoder names its members, then guards on all of them at
 * once — `if (!a.ok || !b.ok) return failed(a, b);` — so a defect in `a` never
 * hides one in `b` (§29.1 rule 1). Called only once at least one has failed.
 */
const failed = (...rs: readonly R<unknown>[]): R<never> => fail(joinFailures(concatDefects, rs)!);

/** A member's own further check (§29.1 rule 4): run `f` over a decoded value; a failure passes through. */
const andThen = <A, B>(r: R<A>, f: (a: A) => R<B>): R<B> => (r.ok ? f(r.value) : r);

/** The same failure with every defect rewritten — a more didactic wording for one member. */
const mapErrors = <T>(r: R<T>, rewrite: (e: DecodeError) => DecodeError): R<T> =>
  r.ok ? r : fail(r.error.map(rewrite));

/**
 * The list combinator: every element decoded, each failure kept at its index in
 * order (§29.1 rule 2). Generic over the error type like `joinFailures`.
 */
const traverseWith = <E, T>(
  join: (a: E, b: E) => E,
  items: readonly JsonAst[],
  f: (i: number, j: JsonAst) => Result<T, E>,
): Result<T[], E> => {
  const out: T[] = [];
  const rs: Result<T, E>[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const r = f(i, items[i]!);
    rs.push(r);
    if (r.ok) out.push(r.value);
  }
  const error = joinFailures(join, rs);
  return error === undefined ? { ok: true, value: out } : { ok: false, error };
};

const traverseIndexed = <T>(
  items: readonly JsonAst[],
  f: (i: number, j: JsonAst) => R<T>,
): R<T[]> => traverseWith(concatDefects, items, f);
/** One segment of a §6 path — a member name or an array index (§29.3). */
type PathSegment = { readonly index: string } | { readonly name: string };

const isDigits = (t: string): boolean => t.length > 0 && /^[0-9]+$/.test(t);

/**
 * Split a `$`-rooted §6 path into its segments exactly as the reference host
 * does: `.name` runs to the next `.` or `[`; `[digits]` is an index; anything
 * else in brackets is read as a name.
 */
const pathSegments = (path: string): PathSegment[] => {
  const n = path.length;
  const segs: PathSegment[] = [];
  let i = n > 0 && path[0] === '$' ? 1 : 0;
  const readName = (start: number): number => {
    let k = start;
    while (k < n && path[k] !== '.' && path[k] !== '[') k += 1;
    return k;
  };
  while (i < n) {
    const c = path[i];
    if (c === '.') {
      const e = readName(i + 1);
      segs.push({ name: path.slice(i + 1, e) });
      i = e;
    } else if (c === '[') {
      const close = path.indexOf(']', i + 1);
      if (close >= 0 && isDigits(path.slice(i + 1, close))) {
        segs.push({ index: path.slice(i + 1, close) });
        i = close + 1;
      } else {
        const e = readName(i + 1);
        segs.push({ name: path.slice(i, e) });
        i = e;
      }
    } else {
      const e = readName(i);
      segs.push({ name: path.slice(i, e) });
      i = e;
    }
  }
  return segs;
};

/** Ordinal (UTF-16 code unit) comparison — the §2 rule-2 member order. */
const compareOrdinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareSegment = (a: PathSegment, b: PathSegment): number => {
  if ('index' in a && 'index' in b) {
    const x = a.index.replace(/^0+/, '');
    const y = b.index.replace(/^0+/, '');
    return x.length !== y.length ? (x.length < y.length ? -1 : 1) : compareOrdinal(x, y);
  }
  if ('index' in a) return -1;
  if ('index' in b) return 1;
  return compareOrdinal(a.name, b.name);
};

const compareDefectPaths = (a: string, b: string): number => {
  const xs = pathSegments(a);
  const ys = pathSegments(b);
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i += 1) {
    const c = compareSegment(xs[i]!, ys[i]!);
    if (c !== 0) return c;
  }
  return xs.length - ys.length < 0 ? -1 : xs.length === ys.length ? 0 : 1;
};

/**
 * A defect list in the WIRE_FORMAT §29.3 canonical order: by path (segment by
 * segment, an index numerically, a member name Ordinally, an ancestor before its
 * descendants), then by code; one entry per (code, path), the LAST constructed
 * kept. Exported so a consumer holding defects from elsewhere orders them
 * exactly as the decoder does.
 */
export const orderDefects = (defects: readonly DecodeError[]): DecodeError[] => {
  const latest = new Map<string, DecodeError>();
  for (const d of defects) {
    const key = `${d.code}\u0000${d.path}`;
    latest.delete(key);
    latest.set(key, d);
  }
  return [...latest.values()].sort((a, b) => {
    const c = compareDefectPaths(a.path, b.path);
    return c !== 0 ? c : compareOrdinal(a.code, b.code);
  });
};

/**
 * A refusal's §29 list at the root: a §21 breach alone — the first one the walk
 * reached, as the list is in decode order — else every defect in the canonical
 * order.
 */
const defectList = (errors: Defects): readonly DecodeError[] => {
  const breach = errors.find((d) => d.code === 'LIMIT_EXCEEDED');
  return breach !== undefined ? [breach] : orderDefects(errors);
};

const missingField = (path: string, key: string, expected: string): R<never> =>
  makeError('MISSING_FIELD', `${path}.${key}`, `missing required field '${key}'`, expected);
const wrongType = (path: string, expected: string): R<never> =>
  makeError('WRONG_TYPE', path, `expected ${expected}`, expected);

/**
 * An unrecognised case at a `$type`-DISCRIMINATED position: the document carries a
 * literal `"$type"` member and its value is not a known case. WIRE_FORMAT.md §6 —
 * "`$type` appears literally in the path when the discriminator is at fault" — so
 * the reported path names that member.
 */
const unknownDuCase = (path: string, got: string, expected: string): R<never> =>
  makeError('UNKNOWN_DU_CASE', `${path}.$type`, `unknown discriminator '${got}'`, expected);

/**
 * An unrecognised case at a BARE ENUM position: a plain JSON string in a named
 * field, with no `$type` member anywhere in the document (`style.tone`,
 * `kind.trendPolarity`, `accessibility.liveRegion`, …). Same code — §6's
 * `UNKNOWN_DU_CASE` covers "a `$type` discriminator (or bare-enum string)" — but
 * the path is the FIELD's own, with no suffix.
 *
 * Phase 1073: this helper did not exist, so every bare enum reported
 * `$.style.tone.$type`, naming a JSON member the document does not contain and
 * cannot be repaired at. It went unnoticed because the conformance harness
 * prefix-matches `expectedPath`, so the corpus's (correct) bare expectation matched
 * the (wrong) suffixed emission. Do not route a bare enum through `unknownDuCase` —
 * the two positions are different and the corpus distinguishes them.
 */
const unknownEnumCase = (path: string, got: string, expected: string): R<never> =>
  makeError('UNKNOWN_DU_CASE', path, `unknown discriminator '${got}'`, expected);

const CLOSURE = '<closure>';
const OPAQUE = '<opaque>';

// ─── AST require-helpers ─────────────────────────────────────────────────────

type Fields = ReadonlyMap<string, JsonAst>;

const requireObject = (w: Walk, path: string, j: JsonAst): R<Fields> =>
  j.kind === 'JObject' ? ok(j.fields) : wrongType(path, 'JSON object');

// Lenient AI-ingest (WIRE_FORMAT.md 3.6, generalised 2026-07-18): a Static
// envelope wrapped around a PLAIN scalar unwraps before the scalar readers —
// the inverse of the bare-scalar-in-Binding-slot confusion, applied at every
// plain-scalar position in one place. Mirror of F# unwrapStaticEnvelope.
const unwrapStaticEnvelope = (j: JsonAst): JsonAst => {
  if (j.kind === 'JObject') {
    const t = j.fields.get('$type');
    const inner = j.fields.get('value');
    if (t !== undefined && t.kind === 'JString' && t.value === 'Static' && inner !== undefined) {
      return inner;
    }
  }
  return j;
};

const requireString = (w: Walk, path: string, jRaw: JsonAst): R<string> => {
  const j = unwrapStaticEnvelope(jRaw);
  return j.kind === 'JString' ? ok(j.value) : wrongType(path, 'JSON string');
};

const requireBool = (w: Walk, path: string, jRaw: JsonAst): R<boolean> => {
  const j = unwrapStaticEnvelope(jRaw);
  return j.kind === 'JBool' ? ok(j.value) : wrongType(path, 'JSON boolean');
};

const requireFloat = (w: Walk, path: string, jRaw: JsonAst): R<number> => {
  const j = unwrapStaticEnvelope(jRaw);
  if (j.kind === 'JNumber') return ok(j.value);
  if (j.kind === 'JString') {
    if (j.value === 'NaN') return ok(NaN);
    if (j.value === 'Infinity') return ok(Infinity);
    if (j.value === '-Infinity') return ok(-Infinity);
  }
  return wrongType(path, "JSON number (or 'NaN' / 'Infinity' / '-Infinity' sentinel string)");
};

/**
 * A value admissible at a typed INT32 slot (WIRE_FORMAT §7.1): finite, no
 * fractional part, inside the signed 32-bit range.
 */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const isInt32Slot = (n: number): boolean =>
  Number.isFinite(n) && Number.isInteger(n) && n >= INT32_MIN && n <= INT32_MAX;

/**
 * WIRE_FORMAT §7.1 — a typed integer slot admits a finite number with no
 * fractional part inside the signed 32-bit range, and nothing else.
 *
 * `Math.trunc` retired two silent behaviours. It TRUNCATED, so `2.5` at an
 * integer slot decoded as `2` — the author's value discarded at a slot the
 * author typed — and it silently absorbed `Infinity` (as `Infinity`) and any
 * magnitude at all, so `1e10` reached an int32 slot whose other hosts wrapped
 * it to two different numbers from the same bytes. A refusal is the only answer
 * that neither invents data nor discards it.
 */
const requireInt = (w: Walk, path: string, jRaw: JsonAst): R<number> => {
  const j = unwrapStaticEnvelope(jRaw);
  if (j.kind !== 'JNumber') return wrongType(path, 'JSON number (integer)');
  if (!Number.isFinite(j.value)) {
    return wrongType(
      path,
      "JSON number (a finite 32-bit integer; the non-finite sentinels are a float slot's, not an integer slot's)",
    );
  }
  if (!Number.isInteger(j.value)) {
    return wrongType(
      path,
      'JSON number (a 32-bit integer; a fractional value is not truncated at an integer slot)',
    );
  }
  if (!isInt32Slot(j.value)) {
    return wrongType(
      path,
      'JSON number (a 32-bit integer; the value is outside the range this slot can hold)',
    );
  }
  return ok(j.value);
};

const requireArray = (w: Walk, path: string, j: JsonAst): R<readonly JsonAst[]> =>
  j.kind === 'JArray' ? ok(j.items) : wrongType(path, 'JSON array');

const tryField = (fields: Fields, key: string): JsonAst | undefined => fields.get(key);

/** A required member's presence (§29.1 rule 3): a defect of the member, whatever its siblings hold. */
const requireField = (path: string, fields: Fields, key: string, expected: string): R<JsonAst> => {
  const v = fields.get(key);
  return v === undefined ? missingField(path, key, expected) : ok(v);
};

const requireDiscriminator = (path: string, fields: Fields): R<string> => {
  const v = fields.get('$type');
  if (v === undefined)
    return missingField(path, '$type', "DU object must carry a '$type' discriminator string");
  return v.kind === 'JString'
    ? ok(v.value)
    : wrongType(`${path}.$type`, 'JSON string discriminator');
};

/** Decode a required field through `dec` at `path.key`. */
const reqField = <T>(
  w: Walk,
  path: string,
  fields: Fields,
  key: string,
  expected: string,
  dec: Decoder<T>,
): R<T> => andThen(requireField(path, fields, key, expected), (v) => dec(w, `${path}.${key}`, v));

/** Decode an optional field; absent → `undefined` (None per WIRE_FORMAT.md §2 rule 4). */
const optField = <T>(
  w: Walk,
  path: string,
  fields: Fields,
  key: string,
  dec: Decoder<T>,
): R<T | undefined> => {
  const v = tryField(fields, key);
  return v === undefined ? ok(undefined) : dec(w, `${path}.${key}`, v);
};

/**
 * A required member decoded in the context of a sibling (§29.1 rule 6): under a
 * good sibling it is decoded with that value; under a defective one only its
 * presence is checked (rule 3), and the sibling's failure is what comes back.
 */
const underSibling = <S, T>(
  w: Walk,
  path: string,
  fields: Fields,
  key: string,
  expected: string,
  sibling: R<S>,
  dec: (s: S) => Decoder<T>,
  aliases: readonly string[] = [],
): R<T> => {
  if (sibling.ok)
    return reqFieldAliased(w, path, fields, key, aliases, expected, dec(sibling.value));
  const present =
    fieldAliased(fields, key, aliases) === undefined
      ? missingField(path, key, expected)
      : ok(undefined);
  return present.ok ? sibling : failed(sibling, present);
};

/** A member holding a JSON array of `dec`: every element decoded, each defect at its index. */
const listOf =
  <T>(dec: Decoder<T>): Decoder<readonly T[]> =>
  (w, path, j) =>
    andThen(requireArray(w, path, j), (items) =>
      traverseIndexed(items, (i, el) => dec(w, `${path}[${i}]`, el)),
    );

/**
 * An open map (§29.1 rule 1 names it beside the declared object): every member
 * decoded at its own key, each defect kept, into a prototype-free record.
 */
const traverseMembers = <T>(
  path: string,
  fields: Fields,
  f: (p: string, k: string, v: JsonAst) => R<T>,
): R<Record<string, T>> => {
  const out = wireKeyedRecord<T>();
  const rs: R<T>[] = [];
  for (const [k, v] of fields) {
    const r = f(`${path}.${k}`, k, v);
    rs.push(r);
    if (r.ok) out[k] = r.value;
  }
  const error = joinFailures(concatDefects, rs);
  return error === undefined ? ok(out) : fail(error);
};

// 2026-07-17 - lenient-ingest FIELD-NAME aliases (decode-only; WIRE_FORMAT 3.6).
// Mirrors the F# requireFieldAliased/optFieldAliased: the canonical name wins
// when both are present; faithful same-concept mappings only (href->route);
// re-encode always normalises. Pinned by the lenient/lenient-alias-* fixtures.
const fieldAliased = (
  fields: Fields,
  canonical: string,
  aliases: readonly string[],
): JsonAst | undefined => {
  const v = tryField(fields, canonical);
  if (v !== undefined) return v;
  for (const a of aliases) {
    const under = tryField(fields, a);
    if (under !== undefined) return under;
  }
  return undefined;
};

/** `reqField` with decode-only field-name aliases; the error names the canonical key. */
const reqFieldAliased = <T>(
  w: Walk,
  path: string,
  fields: Fields,
  canonical: string,
  aliases: readonly string[],
  expected: string,
  dec: Decoder<T>,
): R<T> => {
  const v = fieldAliased(fields, canonical, aliases);
  if (v === undefined) return missingField(path, canonical, expected);
  return dec(w, `${path}.${canonical}`, v);
};

/** `optField` with decode-only field-name aliases. */
const optFieldAliased = <T>(
  w: Walk,
  path: string,
  fields: Fields,
  canonical: string,
  aliases: readonly string[],
  dec: Decoder<T>,
): R<T | undefined> => {
  const v = fieldAliased(fields, canonical, aliases);
  return v === undefined ? ok(undefined) : dec(w, `${path}.${canonical}`, v);
};

// ─── obj-erased value decode (port of decodeObj) ─────────────────────────────

/**
 * Phase 1931 — every record this decoder builds from WIRE-CHOSEN keys starts
 * with no prototype. On a `{}` literal a `"__proto__"` member hits the
 * prototype SETTER and vanishes (decode→encode was not byte-identical with the
 * F# host, whose `Map` round-trips it), and every key inherits `Object`'s
 * members, so `constructor` read as present. A null-prototype record holds
 * `__proto__` as an ordinary own key and inherits nothing.
 */
const wireKeyedRecord = <V>(): Record<string, V> => Object.create(null) as Record<string, V>;

const decodeAstValue = (j: JsonAst): unknown => {
  switch (j.kind) {
    case 'JNull':
      return null;
    case 'JString':
      return j.value;
    case 'JBool':
      return j.value;
    case 'JNumber':
      return j.value;
    case 'JArray':
      return j.items.map(decodeAstValue);
    case 'JObject': {
      const o = wireKeyedRecord<unknown>();
      for (const [k, v] of j.fields) o[k] = decodeAstValue(v);
      return o;
    }
  }
};

// ─── strict JVal decode (port of jsonToJValStrict / decodeJVal / decodeJValMap) ─
//
// The JSON-valued PAYLOAD positions — NodeKind.Custom props, Action.Notify /
// SetState / AiTool payloads, TextSource.I18n args, and a wire-form UpdateProp
// value — decode null-REJECTING at any depth: the Fuaran wire model has no null
// (omit the field instead), and F# `JVal` makes that unrepresentable by
// construction. Mirrors the F# `jsonToJValStrict` position-for-position — same
// WRONG_TYPE code + message + `$`-rooted path — so an AI author recovers by
// omission, not by re-encoding null. This is DISTINCT from `decodeAstValue`
// above (the Binding.Static / obj seam), which faithfully accepts JNull -> null
// per the F# `decodeObj`; those positions are left permissive on purpose.

const nullNotRepresentable = (path: string): R<never> =>
  makeError(
    'WRONG_TYPE',
    path,
    'null is not representable in the Fuaran wire model — omit the field instead',
  );

const decodeJVal = (w: Walk, path: string, j: JsonAst): R<JsonValue> => {
  switch (j.kind) {
    case 'JNull':
      return nullNotRepresentable(path);
    case 'JString':
      return ok(j.value);
    case 'JBool':
      return ok(j.value);
    case 'JNumber':
      return ok(j.value);
    case 'JArray':
      return traverseIndexed(j.items, (i, el) => decodeJVal(w, `${path}[${i}]`, el));
    case 'JObject':
      return traverseMembers(path, j.fields, (p, _k, v) => decodeJVal(w, p, v));
  }
};

const decodeJValMap = (w: Walk, path: string, j: JsonAst): R<Record<string, JsonValue>> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  return traverseMembers(path, fo.value, (p, _k, v) => decodeJVal(w, p, v));
};

// ─── Bare-string enum decoders ───────────────────────────────────────────────

const bareEnum = <T extends string>(
  path: string,
  j: JsonAst,
  valid: readonly T[],
  label: string,
): R<T> => {
  if (j.kind !== 'JString') return wrongType(path, `JSON string (${label})`);
  if ((valid as readonly string[]).includes(j.value)) return ok(j.value as T);
  return unknownEnumCase(path, j.value, valid.join(' | '));
};

/** A bare-string enum read against its generated case table (Phase 2073): every enum with no lenient alias. */
const enumOf = <N extends EnumName>(name: N): Decoder<EnumCase<N>> => {
  const cases = ENUM_CASES[name];
  return (_w, p, j) => bareEnum(p, j, cases, name);
};

const ORIENTATION_ALIASES: Readonly<Record<string, Orientation>> = {
  // CSS flex-direction prior: a row lays out horizontally, a column vertically.
  Row: 'Horizontal',
  row: 'Horizontal',
  Column: 'Vertical',
  column: 'Vertical',
};

const decodeOrientation = (w: Walk, p: string, j: JsonAst): R<Orientation> => {
  if (j.kind === 'JString' && j.value in ORIENTATION_ALIASES)
    return ok(ORIENTATION_ALIASES[j.value]!);
  return bareEnum(p, j, ['Vertical', 'Horizontal'] as const, 'Orientation');
};

const decodeBadgeVariant = (w: Walk, p: string, j: JsonAst): R<BadgeVariant> => {
  // Default -> the identity case; Danger -> the Bootstrap prior (WIRE_FORMAT 3.6).
  if (j.kind === 'JString' && j.value === 'Default') return ok('Neutral');
  if (j.kind === 'JString' && j.value === 'Danger') return ok('Critical');
  return bareEnum(
    p,
    j,
    ['Neutral', 'Brand', 'Success', 'Warning', 'Critical', 'Info'] as const,
    'BadgeVariant',
  );
};

const decodeButtonVariant = (w: Walk, p: string, j: JsonAst): R<ButtonVariant> => {
  // Bootstrap's Danger names the same concept as Destructive (WIRE_FORMAT 3.6).
  if (j.kind === 'JString' && j.value === 'Danger') return ok('Destructive');
  return bareEnum(
    p,
    j,
    ['Primary', 'Secondary', 'Tertiary', 'Destructive'] as const,
    'ButtonVariant',
  );
};

const decodeHeadingVariant = (w: Walk, p: string, j: JsonAst): R<HeadingVariant> => {
  // Default -> the identity case; Title/Page/Section stay rejects (ambiguous mapping).
  if (j.kind === 'JString' && j.value === 'Default') return ok('Standard');
  return bareEnum(p, j, ['Standard', 'Eyebrow', 'Caption', 'Lead'] as const, 'HeadingVariant');
};

// Phase 1077 — the three `Image` presentation vocabularies. Bare enums, so an
// unrecognised case reports at the field's own path with no `.$type` suffix.

// Phase 1119 — `ModalSpec.modality`. Two cases and no lenient spelling: the
// member decides whether the surface BLOCKS the page, and absence already
// spells the safe answer (`Modal`, the pre-1119 behaviour), so a value the
// decoder cannot read must be refused rather than recovered from.

// Phase 1536 — `Action.Navigate.target`. Two cases, closed, and NO lenient
// spelling: HTML's `_self` / `_blank` / `_parent` / `_top` are not accepted as
// aliases. Two of them are frame-busting gestures a hosted tree must not be
// able to ask for, and accepting the two harmless ones would teach an emitter
// that the HTML vocabulary is the one in force here. Absence is `Self`, the
// pre-1536 behaviour and the safe answer, so an unknown token is
// UNKNOWN_DU_CASE and never a fallback.
const decodeNavigateTarget = enumOf('NavigateTarget');

// Phase 1111 — one embed sandbox relaxation. A bare enum inside a LIST, so an
// unrecognised case reports at the ELEMENT's own path with no `.$type` suffix.
// The refusal is doing real work rather than merely being consistent: a decoder
// that silently dropped an unrecognised permission would turn a document asking
// for something this vocabulary has no name for into one asking for less, which
// reads as success — and a decoder that guessed would be worse.

// Phase 1110 — a track's kind. `metadata` is deliberately NOT a member: its cues
// are rendered by no user agent and read only by script.
const decodeTrackKind = enumOf('TrackKind');

// Phase 1116 — the recording device. A BARE enum, so an unknown token reports at
// the member's own path with no `.$type` suffix (WIRE_FORMAT.md §6): the near
// miss an emitter will actually write is `"Screen"`, and it is refused rather
// than reserved.

// Phase 1472 — the declared base direction. LOWER-CASE on the wire, spelled in
// the values the isolation is ultimately expressed in. An unrecognised token is
// REFUSED, never coerced to the default: a document that meant `rtl` and
// misspelled it would otherwise render as reordered digits with nothing said
// anywhere, which is the failure the member exists to prevent.
const decodeTextDirection = enumOf('TextDirection');

const decodeDateTimeVariant = enumOf('DateTimeVariant');

/**
 * Phase 1811 — the `variant` of a `DateTime` / `DateTimeRange` field, read through the §16
 * `Time` / `TimeRange` alias rule. Under the canonical tag (or the pre-rename alias) `variant` is
 * required as it always was. Under the time-alias tag the alias SUPPLIES `Time` when the member is
 * absent, and an explicit member beside it must agree — `{"$type":"Time","variant":"Date"}` is
 * refused as ambiguous rather than resolved to either (the 0.28.0 column-member posture).
 */
const decodeTemporalVariant = (
  w: Walk,
  path: string,
  f: ReadonlyMap<string, JsonAst>,
  tag: string,
  timeAlias: string,
): R<DateTimeVariant> => {
  if (tag !== timeAlias)
    return reqField(w, path, f, 'variant', 'DateTimeVariant', decodeDateTimeVariant);
  const v = optField(w, path, f, 'variant', decodeDateTimeVariant);
  if (!v.ok) return v;
  if (v.value === undefined || v.value === 'Time') return ok<DateTimeVariant>('Time');
  return wrongType(
    `${path}.variant`,
    `the variant Time, or no variant at all — a $type of ${timeAlias} already fixes the variant to Time, and a different one beside it is ambiguous`,
  );
};

// Phase 460 — lenient-ingest aliases (decode-only; never encoded — canonical
// re-encode normalises to the DU case names). Faithful semantic mappings only,
// documented in WIRE_FORMAT.md §3.6; mirrors the F# `decodeTone`/`decodeEmphasis`.
const TONE_ALIASES: Readonly<Record<string, ToneVariant>> = {
  Positive: 'Success',
  Danger: 'Critical',
  Negative: 'Critical',
  Neutral: 'Default',
};

const EMPHASIS_ALIASES: Readonly<Record<string, Emphasis>> = {
  Strong: 'Loud',
  Bold: 'Loud',
  Subtle: 'Quiet',
  Muted: 'Quiet',
};

/**
 * The legal `ToneVariant` names, in one place because two positions now teach them — a
 * `tone` field and (Phase 750) a `TonedPill` tone-map value. A second inline copy is
 * exactly how one of them comes to name six tones. Parity-locked with the F#
 * `toneVariantNames`.
 */
const TONE_NAMES = [
  'Default',
  'Subdued',
  'Brand',
  'Success',
  'Warning',
  'Critical',
  'Info',
] as const;

const decodeTone = (w: Walk, p: string, j: JsonAst): R<ToneVariant> => {
  if (j.kind === 'JString' && j.value in TONE_ALIASES) return ok(TONE_ALIASES[j.value]!);
  return bareEnum(p, j, TONE_NAMES, 'ToneVariant');
};

const decodeWeight = (w: Walk, p: string, j: JsonAst): R<StyleWeight> =>
  // StyleWeight deliberately not aliased — `Bold`/`Heavy` is font-weight intent, but
  // Compact|Standard|Spacious means density (WIRE_FORMAT.md §3.6).
  bareEnum(p, j, ['Compact', 'Standard', 'Spacious'] as const, 'StyleWeight');

// Phase 867 - `Neutral` is RESERVED, not admitted, so it is refused here like
// any other unknown case rather than silently reading as the default.
const decodeTrendPolarity = enumOf('TrendPolarity');

const decodeEmphasis = (w: Walk, p: string, j: JsonAst): R<Emphasis> => {
  if (j.kind === 'JString' && j.value in EMPHASIS_ALIASES) return ok(EMPHASIS_ALIASES[j.value]!);
  // 0.2.8 (2026-07-19 collision sweep) — `emphasis` is a same-name
  // cross-vocabulary collision (style ENUM here vs behavioural BOOL on
  // Fact/LabelValueRow); models cross it in both directions. A bool in the
  // enum slot projects one-to-one: true ⇒ Loud, false ⇒ Normal. The bool
  // sites' direction lives in `decodeEmphasisFlag`.
  if (j.kind === 'JBool') return ok(j.value ? 'Loud' : 'Normal');
  return bareEnum(p, j, ['Quiet', 'Normal', 'Loud'] as const, 'Emphasis');
};

/**
 * The behavioural `emphasis` BOOL (Fact / LabelValueRow) — the other half of
 * the same-name collision with the `Emphasis` style enum. ONE shared reader
 * for every bool site (the 0.2.2 coercion lived only on LabelValueRow and
 * only for the exact enum spellings — Fact hard-failed, and the Phase-460
 * alias set never carried over; the 2026-07-19 sweep closed the asymmetry):
 * booleans pass through; the enum AND its aliases project one-to-one
 * (Loud/Strong/Bold ⇒ true, Normal/Quiet/Subtle/Muted ⇒ false); any other
 * string is the didactic reject naming both vocabularies.
 */
const decodeEmphasisFlag = (w: Walk, p: string, j: JsonAst): R<boolean> => {
  if (j.kind === 'JBool') return ok(j.value);
  if (j.kind === 'JString') {
    if (j.value === 'Loud' || j.value === 'Strong' || j.value === 'Bold') return ok(true);
    if (j.value === 'Normal' || j.value === 'Quiet' || j.value === 'Subtle' || j.value === 'Muted')
      return ok(false);
    return makeError(
      'WRONG_TYPE',
      p,
      `expected JSON boolean, got '${j.value}' — this \`emphasis\` is a BOOL (is this an emphasised row/fact?); the Emphasis style enum (Quiet|Normal|Loud) lives on style/Metric.emphasis. Write true or false`,
      'JSON boolean',
    );
  }
  return requireBool(w, p, j);
};

// Phase 528.1 — SVG text-anchor for DrawStyle (Shape.Label alignment).
const decodeTextAnchor = enumOf('TextAnchor');

// Phase 147 — the additive style-role / font-voice DUs. Optional on the wire
// (omitted at default); the style decoder restores the default on absence.
const decodeStyleRole = enumOf('StyleRole');

const decodeFontVoice = enumOf('FontVoice');

// ─── Chart annotations (Phase 1490/1491/1492 — §4l) ──────────────────────────

/**
 * `true` when `text` is a canonical ISO-8601 date the temporal axis can place —
 * `YYYY-MM-DD`, optionally followed by `T…` whose time-of-day is discarded.
 *
 * STRICT by shape AND by calendar: four digits, two, two, both hyphens, a month
 * in 1–12 and a day the month actually has. A locale spelling (`15/01/2026`)
 * and a bare year are both refused — admitting either would be the
 * string-sniffing the temporal axis exists to avoid. The gate is the host's one
 * calendar module (`parseIsoDay`), the same one the chart lowering parses with,
 * so the decoder cannot admit a day the axis would misplace.
 */
const isCanonicalIsoDay = (text: string): boolean => parseIsoDay(text) !== undefined;

/**
 * An annotation's X ADDRESS (Phase 1491, §4l "The three addressing forms").
 * Two cases, matching the two forms the x axis already distinguishes: a
 * `Category` key on a band axis, an ISO-8601 `Date` under `xScale: 'Temporal'`.
 *
 * THE DATE MUST BE A DATE, and this refusal is the twin of `ReferenceLine`'s
 * finite-value narrowing rather than a new posture. The lowering's calendar is
 * deliberately TOTAL — an unparseable x CELL reads as 1970-01-01, because
 * FUARAN097 makes a non-date COLUMN loud upstream and refusing per-cell would be
 * worse. An annotation has no column to be loud about: the string is authored
 * directly, so nothing upstream can catch it. And because §4l rule 3 has a
 * temporal address ENTER the axis extent before the ticks are chosen, a typo
 * does not misplace one marker — it drags the domain back to the epoch and
 * rescales the whole picture.
 */
const decodeChartAnnotationX = (w: Walk, path: string, j: JsonAst): R<ChartAnnotationX> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const disc = requireDiscriminator(path, f);
  if (!disc.ok) return disc;
  switch (disc.value) {
    case 'Category': {
      const key = reqField(w, path, f, 'key', "category key (the band's own label)", requireString);
      if (!key.ok) return key;
      return ok({ kind: 'Category', key: key.value });
    }
    case 'Date': {
      // The member's own check (§29.1 rule 4).
      const iso = andThen(
        reqField(w, path, f, 'iso', 'ISO-8601 date (YYYY-MM-DD)', requireString),
        (day) =>
          isCanonicalIsoDay(day)
            ? ok(day)
            : wrongType(
                `${path}.iso`,
                'a canonical ISO-8601 date (YYYY-MM-DD, optionally followed by a time) naming a real calendar day — an event marker’s date is the address it is drawn at, and an unreadable one would place the marker at 1970-01-01 and drag the axis back with it',
              ),
      );
      if (!iso.ok) return iso;
      return ok({ kind: 'Date', iso: iso.value });
    }
    default:
      return unknownDuCase(path, disc.value, 'Category, Date');
  }
};

/**
 * A range band's PAIR (Phase 1492, §4l "The three addressing forms"). The case
 * carries the AXIS as well as the pair, so a value axis addressed by category
 * keys is not a document this decoder has to refuse — it is one no encoder can
 * write.
 *
 * TWO REFUSALS, and they are the pair rules the WIRE can decide by itself. A
 * non-finite endpoint is `ReferenceLine`'s narrowing at two slots instead of
 * one, for its reason exactly: §4l rule 3 has both ends enter the value domain,
 * so a NaN takes the nice-domain, every gridline and every mark with it. An
 * UNORDERED pair is refused at the pair's own slot — the defect is the pair's,
 * not either end's — rather than silently swapped.
 *
 * A CATEGORY pair's order is NOT decided here: the order of two band keys is
 * the ROWS' order, a cross-reference rather than a local property of the
 * address, and pre-emit owns it.
 */
const decodeChartAnnotationRange = (w: Walk, path: string, j: JsonAst): R<ChartAnnotationRange> => {
  const finite = (slot: string, v: JsonAst): R<number> => {
    const r = requireFloat(w, `${path}.${slot}`, v);
    if (!r.ok) return r;
    return Number.isFinite(r.value)
      ? r
      : wrongType(
          `${path}.${slot}`,
          "a FINITE JSON number — a range band's end names a place on the value axis, and NaN / Infinity names none; give the value in the axis's own units, or drop the annotation",
        );
  };
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const disc = requireDiscriminator(path, f);
  if (!disc.ok) return disc;
  switch (disc.value) {
    case 'ValueRange': {
      const from = andThen(
        requireField(path, f, 'from', 'range-band lower value (a finite JSON number)'),
        (v) => finite('from', v),
      );
      const to = andThen(
        requireField(path, f, 'to', 'range-band upper value (a finite JSON number)'),
        (v) => finite('to', v),
      );
      if (!from.ok || !to.ok) return failed(from, to);
      if (from.value > to.value)
        return wrongType(
          path,
          'an ORDERED pair — a range band runs from its lower value to its upper one, and this pair runs backwards; swapping the ends silently would draw a band the author did not describe',
        );
      return ok({ kind: 'ValueRange', from: from.value, to: to.value });
    }
    case 'XRange': {
      const from = reqField(
        w,
        path,
        f,
        'from',
        'range-band lower x address (a ChartAnnotationX)',
        decodeChartAnnotationX,
      );
      const to = reqField(
        w,
        path,
        f,
        'to',
        'range-band upper x address (a ChartAnnotationX)',
        decodeChartAnnotationX,
      );
      if (!from.ok || !to.ok) return failed(from, to);
      // Both dates are already known canonical and calendar-valid (the address
      // decoder refused anything else), and a canonical `YYYY-MM-DD` sorts
      // lexicographically exactly as it sorts chronologically — so no calendar
      // arithmetic is needed to decide the order at this boundary.
      if (from.value.kind === 'Date' && to.value.kind === 'Date' && from.value.iso > to.value.iso)
        return wrongType(
          path,
          'an ORDERED pair — a range band runs from its earlier date to its later one, and this pair runs backwards; swapping the ends silently would draw a band the author did not describe',
        );
      return ok({ kind: 'XRange', from: from.value, to: to.value });
    }
    default:
      return unknownDuCase(path, disc.value, 'ValueRange, XRange');
  }
};

/**
 * A chart's data-addressed annotation (Phase 1490, §4l). One closed
 * `$type`-discriminated union.
 *
 * THE REFERENCE LINE'S VALUE MUST BE FINITE, and that is a slot-specific
 * NARROWING of §7 rather than a disagreement with it. §7 admits the quoted
 * `"NaN"` / `"Infinity"` / `"-Infinity"` sentinels at every float slot and the
 * float reader reads them — the widening is deliberate and stays. But a
 * reference line addresses a place on the VALUE AXIS, and a non-finite value
 * names no such place: it would enter the domain computation and put every
 * gridline, tick and mark on the chart at a NaN coordinate. The picture is not
 * merely wrong at the annotation, it is wrong everywhere.
 */
const decodeChartAnnotation = (w: Walk, path: string, j: JsonAst): R<ChartAnnotation> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const disc = requireDiscriminator(path, f);
  if (!disc.ok) return disc;
  const label = optField(w, path, f, 'label', decodeTextSource);
  if (!label.ok) return label;
  const withLabel = label.value !== undefined ? { label: label.value } : {};
  switch (disc.value) {
    case 'ReferenceLine': {
      const value = reqField(
        w,
        path,
        f,
        'value',
        'reference-line value (a finite JSON number)',
        (w2, p, j) =>
          andThen(requireFloat(w2, p, j), (n) =>
            Number.isFinite(n)
              ? ok(n)
              : wrongType(
                  p,
                  "a FINITE JSON number — a reference line names a place on the value axis, and NaN / Infinity names none; give the value in the axis's own units, or drop the annotation",
                ),
          ),
      );
      if (!value.ok) return value;
      return ok({ kind: 'ReferenceLine', value: value.value, ...withLabel });
    }
    case 'EventMarker': {
      const at = reqField(
        w,
        path,
        f,
        'at',
        'event-marker x address (a ChartAnnotationX)',
        decodeChartAnnotationX,
      );
      if (!at.ok) return at;
      return ok({ kind: 'EventMarker', at: at.value, ...withLabel });
    }
    case 'RangeBand': {
      const range = reqField(
        w,
        path,
        f,
        'range',
        'range-band pair (a ChartAnnotationRange)',
        decodeChartAnnotationRange,
      );
      if (!range.ok) return range;
      return ok({ kind: 'RangeBand', range: range.value, ...withLabel });
    }
    default:
      return unknownDuCase(path, disc.value, 'ReferenceLine, EventMarker, RangeBand');
  }
};

const decodeFileReadEncoding = enumOf('FileReadEncoding');

const decodeAriaRole = (w: Walk, p: string, j: JsonAst): R<AriaRole> => {
  // Any string is accepted — named roles or the AriaRole.Custom raw escape
  // (WIRE_FORMAT.md §10.2: both encode as the raw string, decode prefers it).
  if (j.kind !== 'JString') return wrongType(p, 'JSON string (ARIA role)');
  return ok(j.value as AriaRole);
};

const decodeLiveRegion = enumOf('LiveRegionKind');

// ─── CellFormat / ColumnWidth / IconSource ───────────────────────────────────

// Phase 819 — the Duration / RelativeTime format enums. Defined ahead of
// `decodeCellFormat` (which references them); `decodeFormat` below shares them.
const decodeDurationUnit = enumOf('DurationUnit');

const decodeDurationStyle = enumOf('DurationStyle');

const decodeRelativeTimeUnit = enumOf('RelativeTimeUnit');

/**
 * Phase 1533 — the `Binding.Now` grain: a strict SUBSET of `RelativeTimeUnit`.
 * `Week` / `Month` / `Year` are refused rather than quietly accepted, because a
 * calendar instant has no truncation to those that every host agrees on.
 */
const decodeTimeGrain = enumOf('TimeGrain');

const decodeCellFormat = (w: Walk, path: string, j: JsonAst): R<CellFormat> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'None':
      return ok({ kind: 'None' });
    // Phase 2490 — the figure cases' optional `locale`; absent decodes absent.
    case 'Number':
    case 'Percent': {
      const kind = d.value;
      const dec = optField(w, path, f, 'decimals', requireInt);
      const loc = optField(w, path, f, 'locale', decodeLocaleSource);
      if (!dec.ok || !loc.ok) return failed(dec, loc);
      return ok<CellFormat>({
        kind,
        ...(dec.value !== undefined ? { decimals: dec.value } : {}),
        ...(loc.value !== undefined ? { locale: loc.value } : {}),
      });
    }
    case 'Currency': {
      const r = reqField(w, path, f, 'code', 'ISO currency code string', requireString);
      const loc = optField(w, path, f, 'locale', decodeLocaleSource);
      if (!r.ok || !loc.ok) return failed(r, loc);
      return ok<CellFormat>({
        kind: 'Currency',
        code: r.value,
        ...(loc.value !== undefined ? { locale: loc.value } : {}),
      });
    }
    case 'SignificantDigits': {
      const r = reqField(w, path, f, 'digits', 'integer digit count', requireInt);
      return r.ok ? ok({ kind: 'SignificantDigits', digits: r.value }) : r;
    }
    // Phase 1811 — `DateTime` is canonical; `Date` is its §16 lenient alias (the pre-rename
    // spelling), decoded to the same value and re-encoded canonical. Never emitted.
    case 'DateTime':
    case 'Date': {
      const r = reqField(w, path, f, 'format', 'format string', requireString);
      return r.ok ? ok({ kind: 'DateTime', format: r.value }) : r;
    }
    case 'Duration': {
      // Phase 819 — trendable duration cells: raw float counts `unit`s,
      // rendered per `style`.
      const unit = reqField(w, path, f, 'unit', 'DurationUnit string', decodeDurationUnit);
      const style = reqField(w, path, f, 'style', 'DurationStyle string', decodeDurationStyle);
      if (!unit.ok || !style.ok) return failed(unit, style);
      return ok<CellFormat>({ kind: 'Duration', unit: unit.value, style: style.value });
    }
    case 'RelativeTime': {
      // Phase 819 — cell-vocabulary parity with `Format.RelativeTime`.
      const r = reqField(w, path, f, 'unit', 'RelativeTimeUnit string', decodeRelativeTimeUnit);
      return r.ok ? ok<CellFormat>({ kind: 'RelativeTime', unit: r.value }) : r;
    }
    case 'Custom':
      return ok({ kind: 'Custom', format: () => CLOSURE });
    default:
      return unknownDuCase(
        path,
        d.value,
        'None | Number | Currency | Percent | SignificantDigits | DateTime | Duration | RelativeTime | Custom',
      );
  }
};

// ─── Format / LocaleSource (Phase 102) ───────────────────────────────────────

const decodeFormat = (w: Walk, path: string, j: JsonAst): R<Format> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Number': {
      const dec = tryField(f, 'decimals');
      if (dec === undefined) return ok({ kind: 'Number' });
      const r = requireInt(w, `${path}.decimals`, dec);
      return r.ok ? ok({ kind: 'Number', decimals: r.value }) : r;
    }
    case 'Currency': {
      const r = reqField(w, path, f, 'isoCode', 'ISO-4217 currency code string', requireString);
      return r.ok ? ok<Format>({ kind: 'Currency', isoCode: r.value }) : r;
    }
    case 'Percent': {
      const dec = tryField(f, 'decimals');
      if (dec === undefined) return ok({ kind: 'Percent' });
      const r = requireInt(w, `${path}.decimals`, dec);
      return r.ok ? ok({ kind: 'Percent', decimals: r.value }) : r;
    }
    // Phase 1811 — `DateTime` is canonical (an honest name once 1810 made the formatter render a
    // time of day); `Date` is its §16 lenient alias, decoded to the same value. Never emitted.
    case 'DateTime':
    case 'Date': {
      // Phase 1810 — both style slots are OPTIONAL: `timeStyle` alone is a
      // time of day, both together a date-time, `dateStyle` alone the shape
      // every pre-1810 document carries. Present-but-unreadable is still a
      // refusal; neither present decodes and is FUARAN155's subject upstream.
      const d = optField(w, path, f, 'dateStyle', (_w, p, v) =>
        bareEnum(p, v, ['Short', 'Medium', 'Long', 'Full'] as const, 'DateStyle'),
      );
      const t = optField(w, path, f, 'timeStyle', (_w, p, v) =>
        bareEnum(p, v, ['Short', 'Medium', 'Long', 'Full'] as const, 'TimeStyle'),
      );
      if (!d.ok || !t.ok) return failed(d, t);
      return ok<Format>({
        kind: 'DateTime',
        ...(d.value !== undefined ? { dateStyle: d.value } : {}),
        ...(t.value !== undefined ? { timeStyle: t.value } : {}),
      });
    }
    case 'RelativeTime': {
      const r = reqField(w, path, f, 'unit', 'RelativeTimeUnit string', decodeRelativeTimeUnit);
      return r.ok ? ok<Format>({ kind: 'RelativeTime', unit: r.value }) : r;
    }
    case 'Duration': {
      // Phase 819 — locale-independent duration formatting.
      const unit = reqField(w, path, f, 'unit', 'DurationUnit string', decodeDurationUnit);
      const style = reqField(w, path, f, 'style', 'DurationStyle string', decodeDurationStyle);
      if (!unit.ok || !style.ok) return failed(unit, style);
      return ok<Format>({ kind: 'Duration', unit: unit.value, style: style.value });
    }
    case 'Since': {
      // Phase 1533 — `unit` is OPTIONAL and its absence is the auto-selection
      // request, not a default. Present-but-unreadable is still a refusal.
      const u = tryField(f, 'unit');
      if (u === undefined) return ok<Format>({ kind: 'Since' });
      const r = decodeRelativeTimeUnit(w, `${path}.unit`, u);
      return r.ok ? ok<Format>({ kind: 'Since', unit: r.value }) : r;
    }
    default:
      return unknownDuCase(
        path,
        d.value,
        'Number | Currency | Percent | DateTime | RelativeTime | Duration | Since',
      );
  }
};

const decodeLocaleSource = (w: Walk, path: string, j: JsonAst): R<LocaleSource> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Ambient':
      return ok({ kind: 'Ambient' });
    case 'Explicit': {
      const r = reqField(w, path, f, 'tag', 'BCP-47 locale tag string', requireString);
      return r.ok ? ok<LocaleSource>({ kind: 'Explicit', tag: r.value }) : r;
    }
    default:
      return unknownDuCase(path, d.value, 'Ambient | Explicit');
  }
};

const decodeColumnWidth = (w: Walk, path: string, j: JsonAst): R<ColumnWidth> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Auto':
      return ok({ kind: 'Auto' });
    case 'Fixed': {
      const r = reqField(w, path, f, 'pixels', 'integer pixel count', requireInt);
      return r.ok ? ok({ kind: 'Fixed', pixels: r.value }) : r;
    }
    case 'Flex': {
      const r = reqField(w, path, f, 'weight', 'float weight', requireFloat);
      return r.ok ? ok({ kind: 'Flex', weight: r.value }) : r;
    }
    default:
      return unknownDuCase(path, d.value, 'Auto | Fixed | Flex');
  }
};

const decodeIconSource = (w: Walk, path: string, j: JsonAst): R<IconSource> => {
  const r = requireString(w, path, j);
  return r.ok ? ok(r.value as IconSource) : r;
};

// ─── LocalFlushTrigger / Binding (recursive) ─────────────────────────────────

const decodeLocalFlushTrigger = (w: Walk, path: string, j: JsonAst): R<LocalFlushTrigger> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'OnBlur':
      return ok({ kind: 'OnBlur' });
    case 'OnSubmit':
      return ok({ kind: 'OnSubmit' });
    case 'OnCommitAction':
      return ok({ kind: 'OnCommitAction' });
    case 'OnDebounce': {
      const r = reqField(w, path, f, 'milliseconds', 'debounce milliseconds integer', requireInt);
      return r.ok ? ok({ kind: 'OnDebounce', milliseconds: r.value }) : r;
    }
    default:
      return unknownDuCase(path, d.value, 'OnBlur | OnSubmit | OnDebounce | OnCommitAction');
  }
};

// ─── Compute layer (Phase 282 / 284) — DataSource / Transform / ColExpr / Cell ─
//
// Structural decoders mirroring the Fuaran.Core codecs (`ColumnCodec.decodeJson`
// / `DataFrameCodec.decodeTransform` / `decodeExpr` / `cellOfJson`). They surface
// a Core-style string error (matching `ColumnCodec.errorString`); the
// `Binding.Transform` arm of `decodeBinding` wraps that into a `WRONG_TYPE`
// `DecodeError` rooted at `$….source` / `$….pipeline` — byte-identical to the F#
// UI host's `coreError` wrapping.

type CR<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };
const cok = <T>(value: T): CR<T> => ({ ok: true, value });
const cerr = (error: string): CR<never> => ({ ok: false, error });

const BIN_OPS = [
  'add',
  'sub',
  'mul',
  'div',
  'mod',
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'and',
  'or',
  'contains',
  'startsWith',
  'endsWith',
] as const;
const SCALAR_FNS = [
  'abs',
  'round',
  'floor',
  'ceil',
  'length',
  'lower',
  'upper',
  'substr',
  'datePart',
  'concat',
  'trim',
  'replace',
  'dateDiffDays',
  'pow',
  'exp',
  'ln',
  'log10',
] as const;
const AGG_FNS = [
  'sum',
  'mean',
  'min',
  'max',
  'count',
  'median',
  'stddev',
  'first',
  'last',
  'countDistinct',
] as const;
const JOIN_KINDS = ['inner', 'left', 'right', 'outer'] as const;
const WINDOW_FNS = ['rowNumber', 'rank', 'lag', 'lead', 'cumulSum', 'rollingMean'] as const;

const astKind = (j: JsonAst): string => {
  switch (j.kind) {
    case 'JString':
      return 'string';
    case 'JNumber':
      return 'number';
    case 'JBool':
      return 'bool';
    case 'JArray':
      return 'array';
    case 'JObject':
      return 'object';
    case 'JNull':
      return 'null';
  }
};

const cFields = (j: JsonAst): CR<Fields> =>
  j.kind === 'JObject' ? cok(j.fields) : cerr('malformed: expected object, got ' + astKind(j));
const cField = (f: Fields, k: string): CR<JsonAst> => {
  const v = f.get(k);
  return v === undefined ? cerr('missing field: ' + k) : cok(v);
};
// fuaran-core#92 — accept exactly one of the canonical field or its observed alias (the
// SQL/pandas prior); both present is ambiguous, neither reports the canonical name.
const cFieldAliased = (f: Fields, canonical: string, alias: string): CR<JsonAst> => {
  const c = f.get(canonical);
  const a = f.get(alias);
  if (c !== undefined && a !== undefined)
    return cerr(`malformed: give "${canonical}" (canonical) or "${alias}" (alias), not both`);
  const v = c ?? a;
  return v === undefined ? cerr('missing field: ' + canonical) : cok(v);
};
const cStr = (j: JsonAst): CR<string> =>
  j.kind === 'JString' ? cok(j.value) : cerr('malformed: expected string, got ' + astKind(j));
const cArr = (j: JsonAst): CR<readonly JsonAst[]> =>
  j.kind === 'JArray' ? cok(j.items) : cerr('malformed: expected array, got ' + astKind(j));
/**
 * The data-frame codec's integer reader. §7.1 applies here for the same reason
 * it applies at a node slot — a column declared `Int` holds integers — and the
 * defect was the same `Math.trunc`.
 */
const cInt = (j: JsonAst): CR<number> => {
  if (j.kind !== 'JNumber') return cerr('malformed: expected int, got ' + astKind(j));
  if (!isInt32Slot(j.value)) {
    return cerr(`malformed: expected a 32-bit integer, got ${j.value}`);
  }
  return cok(j.value);
};

const cMapM = <A, B>(xs: readonly A[], fn: (a: A) => CR<B>): CR<B[]> => {
  const out: B[] = [];
  for (const x of xs) {
    const r = fn(x);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return cok(out);
};

const cStrField = (f: Fields, k: string): CR<string> => {
  const v = cField(f, k);
  return v.ok ? cStr(v.value) : v;
};
const cStrList = (j: JsonAst): CR<string[]> => {
  const a = cArr(j);
  return a.ok ? cMapM(a.value, cStr) : a;
};

/** A type-tagged literal `Cell` — port of F# `DataFrameCodec.cellOfJson`. */
const decodeCellLit = (j: JsonAst): CR<Cell> => {
  const fo = cFields(j);
  if (!fo.ok) return cerr('malformed: lit: expected object');
  const f = fo.value;
  const dt = f.get('$type');
  if (dt === undefined || dt.kind !== 'JString') return cerr('missing field: lit.$type');
  const t = dt.value;
  if (t === 'Null') return cok({ kind: 'Null' });
  const v = f.get('value');
  const mismatch = cerr(`column 'lit': expected ${t} value, got value`);
  if (v === undefined) return mismatch;
  switch (t) {
    case 'Int':
      // §7.1 again — a literal cell declared `Int` is not a place to truncate.
      return v.kind === 'JNumber' && isInt32Slot(v.value)
        ? cok({ kind: 'Int', value: v.value })
        : mismatch;
    case 'Float':
      return v.kind === 'JNumber' ? cok({ kind: 'Float', value: v.value }) : mismatch;
    case 'Bool':
      return v.kind === 'JBool' ? cok({ kind: 'Bool', value: v.value }) : mismatch;
    case 'Str':
      return v.kind === 'JString' ? cok({ kind: 'Str', value: v.value }) : mismatch;
    case 'Date':
      return v.kind === 'JString' ? cok({ kind: 'Date', value: v.value }) : mismatch;
    case 'Timestamp':
      return v.kind === 'JString' ? cok({ kind: 'Timestamp', value: v.value }) : mismatch;
    case 'Decimal': {
      // Phase 2001 — decimal text, canonicalised on read; an integer token is exact and read too;
      // anything else (a fractional number token included) is refused.
      if (v.kind === 'JString') {
        const c = decimalCanonical(v.value);
        return c !== undefined ? cok({ kind: 'Decimal', value: c }) : mismatch;
      }
      return v.kind === 'JNumber' && isInt32Slot(v.value)
        ? cok({ kind: 'Decimal', value: String(v.value) })
        : mismatch;
    }
    default:
      return mismatch;
  }
};

/** Phase 2001 — 2^53, the largest whole number token a decimal column reads exactly. */
const DECIMAL_INT53_MAX = 9007199254740992;

/**
 * Phase 2001 — one present decimal-column value: a JSON STRING of decimal text,
 * canonicalised; or a whole number token within ±2^53, read as its digits. A
 * fractional token, or a whole one past 2^53, has been through a float by the
 * time it arrives and is refused — a type whose purpose is exactness cannot
 * vouch for it.
 */
const decodeDecimalColumnValue = (colName: string, v: JsonAst): CR<string> => {
  if (v.kind === 'JString') {
    const c = decimalCanonical(v.value);
    return c !== undefined
      ? cok(c)
      : cerr(
          `malformed: column '${colName}': a decimal value must be decimal text — an optional '-', digits, and an optional '.' followed by digits, with no exponent, sign '+', separator or white space`,
        );
  }
  if (v.kind === 'JNumber' && Number.isInteger(v.value) && Math.abs(v.value) <= DECIMAL_INT53_MAX) {
    return cok(BigInt(v.value).toString());
  }
  return cerr(`column '${colName}': expected decimal value, got ${astKind(v)}`);
};

/**
 * A column's present values decoded straight into its typed storage (Phase 2205; port of F#
 * `decodeCell` over Core's typed column). Each type reads its exact JSON kind, except that a float
 * column accepts an integer token (lossless widening) and a timestamp column of any unit reads
 * through `decodeInstant`. Two values the typed storage cannot hold are refused by name, as the
 * reference's codec refuses them: an int outside 32 bits, and a date that is not canonical
 * `YYYY-MM-DD` text naming a day that exists. An absent row's value is never read.
 */
const decodeColumnData = (
  colName: string,
  ty: ColumnType,
  values: readonly JsonAst[],
  present: Uint8Array,
): CR<ColumnData> => {
  const n = values.length;
  const validity = validityOfMask(present);
  const mismatch = (v: JsonAst): CR<never> =>
    cerr(`column '${colName}': expected ${ty} value, got ${astKind(v)}`);
  switch (ty) {
    case 'int': {
      const out = new Int32Array(n);
      for (let i = 0; i < n; i += 1) {
        if (present[i] === 0) continue;
        const v = values[i]!;
        if (v.kind !== 'JNumber') return mismatch(v);
        const x = Math.trunc(v.value);
        if (!isInt32(x))
          return cerr(
            `malformed: ${colName}: an int column holds 32-bit integers, and ${String(x)} is outside them`,
          );
        out[i] = x;
      }
      return cok({ kind: 'Ints', values: out, validity });
    }
    case 'float': {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        if (present[i] === 0) continue;
        const v = values[i]!;
        if (v.kind !== 'JNumber') return mismatch(v);
        out[i] = v.value;
      }
      return cok({ kind: 'Floats', values: out, validity });
    }
    case 'bool': {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) {
        if (present[i] === 0) continue;
        const v = values[i]!;
        if (v.kind !== 'JBool') return mismatch(v);
        out[i] = v.value ? 1 : 0;
      }
      return cok({ kind: 'Bools', values: out, validity });
    }
    case 'string': {
      const out = new Array<string>(n).fill('');
      for (let i = 0; i < n; i += 1) {
        if (present[i] === 0) continue;
        const v = values[i]!;
        if (v.kind !== 'JString') return mismatch(v);
        out[i] = v.value;
      }
      return cok({ kind: 'Strs', values: out, validity });
    }
    case 'date': {
      const out = new Int32Array(n);
      for (let i = 0; i < n; i += 1) {
        if (present[i] === 0) continue;
        const v = values[i]!;
        if (v.kind !== 'JString') return mismatch(v);
        const d = dateDays(v.value);
        if (d === undefined)
          return cerr(
            `malformed: ${colName}: a date value must be canonical ISO-8601 text, YYYY-MM-DD, naming a day that exists`,
          );
        out[i] = d;
      }
      return cok({ kind: 'Dates', values: out, validity });
    }
    case 'decimal': {
      const out = new Array<string>(n).fill('0');
      for (let i = 0; i < n; i += 1) {
        if (present[i] === 0) continue;
        const d = decodeDecimalColumnValue(colName, values[i]!);
        if (!d.ok) return d;
        out[i] = d.value;
      }
      return cok({ kind: 'Decimals', values: out, validity });
    }
    case 'timestamp':
    case 'timestamp_ms':
    case 'timestamp_us':
    case 'timestamp_ns': {
      const digits = TIMESTAMP_UNIT_DIGITS[ty] ?? 0;
      const seconds = new Float64Array(n);
      const fraction = new Int32Array(n);
      let anyFraction = false;
      for (let i = 0; i < n; i += 1) {
        if (present[i] === 0) continue;
        const v = values[i]!;
        const p = decodeInstant(colName, ty, digits, v, mismatch(v));
        if (!p.ok) return p;
        seconds[i] = p.value.second;
        fraction[i] = p.value.fraction;
        if (p.value.fraction !== 0) anyFraction = true;
      }
      return cok({
        kind: 'Timestamps',
        seconds,
        fraction: anyFraction ? fraction : undefined,
        validity,
      });
    }
    default:
      return cerr(`column '${colName}': unknown column type '${String(ty)}'`);
  }
};

// Phase 2206 — the timestamp unit (fuaran-core#422; WIRE_FORMAT §3.6.25).
// The epoch seconds the canonical instant text spells: 0000-01-01T00:00:00Z
// and 9999-12-31T23:59:59Z.
const MIN_EPOCH_SECOND = -62_167_219_200;
const MAX_EPOCH_SECOND = 253_402_300_799;

const timestampTagOfDigits = (d: number): ColumnType =>
  d === 0 ? 'timestamp' : d <= 3 ? 'timestamp_ms' : d <= 6 ? 'timestamp_us' : 'timestamp_ns';

/**
 * The fraction digits of a CANONICAL instant text (`YYYY-MM-DDThh:mm:ssZ`, or
 * `YYYY-MM-DDThh:mm:ss.FZ` with one to nine digits and no trailing zero,
 * naming a moment that exists), or `undefined` for any other text.
 */
const instantFractionDigits = (s: string): number | undefined => {
  if (s.length < 20 || s[10] !== 'T' || s[13] !== ':' || s[16] !== ':') return undefined;
  if (parseIsoDay(s) === undefined) return undefined;
  const two = (at: number): number | undefined => {
    const a = s.charCodeAt(at) - 48;
    const b = s.charCodeAt(at + 1) - 48;
    return a >= 0 && a <= 9 && b >= 0 && b <= 9 ? a * 10 + b : undefined;
  };
  const h = two(11);
  const mi = two(14);
  const se = two(17);
  if (h === undefined || mi === undefined || se === undefined || h > 23 || mi > 59 || se > 59)
    return undefined;
  if (s.length === 20) return s[19] === 'Z' ? 0 : undefined;
  if (s.length > 30 || s[19] !== '.' || s[s.length - 1] !== 'Z' || s[s.length - 2] === '0')
    return undefined;
  for (let k = 20; k < s.length - 1; k += 1) {
    const c = s.charCodeAt(k);
    if (c < 48 || c > 57) return undefined;
  }
  return s.length - 21;
};

/**
 * A timestamp column's cell at a unit holding `digits` fraction digits. TEXT is
 * read only in its canonical form, with a fraction no finer than the unit (a
 * coarser instant widens in unchanged — one instant has one text). An EPOCH
 * NUMBER (whole-valued, |x| < 9e15) is read in a `timestamp` column by
 * magnitude, as fuaran-core#94 pinned it (≥ 1e11 ⇒ milliseconds, truncated to
 * the second), and in a sub-second column in its own unit with no guess; either
 * way it must name an instant in the years 0000–9999.
 */
const decodeInstant = (
  colName: string,
  ty: ColumnType,
  digits: number,
  v: JsonAst,
  mismatch: CR<never>,
): CR<InstantParts> => {
  if (v.kind === 'JString') {
    const n = instantFractionDigits(v.value);
    if (n === undefined)
      return cerr(
        `malformed: ${colName}: a ${ty} value must be canonical ISO-8601 text, YYYY-MM-DDThh:mm:ssZ or YYYY-MM-DDThh:mm:ss.FZ, naming a moment that exists`,
      );
    if (n > digits)
      return cerr(
        `malformed: ${colName}: a ${ty} value's fraction is finer than the column's unit holds: ${timestampTagOfDigits(n)} or finer is needed`,
      );
    const p = instantParts(v.value, digits);
    return typeof p === 'object' ? cok(p) : mismatch;
  }
  // The F# JInt path and its whole-JFloat path, unified — TS has one number kind.
  if (v.kind !== 'JNumber' || v.value !== Math.floor(v.value) || Math.abs(v.value) >= 9e15)
    return mismatch;
  let second: number;
  let fraction = 0;
  if (digits === 0) {
    second = Math.abs(v.value) >= 100_000_000_000 ? Math.trunc(v.value / 1000) : v.value;
  } else {
    // Floor division in exact integers: |v| < 9e15, so every product is exact.
    const scale = 10 ** digits;
    second = Math.floor(v.value / scale);
    fraction = v.value - second * scale;
    if (fraction < 0) {
      second -= 1;
      fraction += scale;
    } else if (fraction >= scale) {
      second += 1;
      fraction -= scale;
    }
  }
  if (second < MIN_EPOCH_SECOND || second > MAX_EPOCH_SECOND)
    return cerr(
      `malformed: ${colName}: the epoch ${v.value} names an instant outside the years 0000-9999 the canonical timestamp spells`,
    );
  return cok({ second, fraction });
};

const decodeColSchema = (j: JsonAst): CR<SchemaEntry[]> => {
  const a = cArr(j);
  if (!a.ok) return a;
  return cMapM(a.value, (e) => {
    const fo = cFields(e);
    if (!fo.ok) return fo;
    const name = cStrField(fo.value, 'name');
    if (!name.ok) return name;
    const ty = cStrField(fo.value, 'type');
    if (!ty.ok) return ty;
    if (!COLUMN_TYPES.includes(ty.value as ColumnType)) {
      return cerr(`unknown column type '${ty.value}'; expected one of: ${COLUMN_TYPES.join(', ')}`);
    }
    return cok<SchemaEntry>({ name: name.value, type: ty.value as ColumnType });
  });
};

// Phase 88 (fuaran-core, mirrored) — a bare-array column is the "just the
// data" shorthand: values = the array, validity all-present (the wire has no
// JSON null, so the shape is unambiguous). Wrapped form stays canonical.
const columnParts = (
  name: string,
  colEl: JsonAst,
): CR<[readonly JsonAst[], readonly JsonAst[]]> => {
  if (colEl.kind === 'JArray') {
    return cok<[readonly JsonAst[], readonly JsonAst[]]>([
      colEl.items,
      colEl.items.map(() => ({ kind: 'JBool', value: true }) as JsonAst),
    ]);
  }
  const fo = cFields(colEl);
  if (!fo.ok) return fo;
  const valuesJ = cField(fo.value, 'values');
  if (!valuesJ.ok) return valuesJ;
  const values = cArr(valuesJ.value);
  if (!values.ok) return values;
  // fuaran-core#94 (lenient-ingest) — a wrapped column object carrying
  // `values` but NO `validity` mask is the same all-present statement as the
  // Phase-88 bare array (the wire has no JSON null, so omission cannot mean
  // absent cells): models reproduce the canonical object shape minus the
  // mask. Synthesize all-present; absent cells still require the full
  // wrapped form, which stays canonical.
  const validityJ = fo.value.get('validity');
  if (validityJ === undefined) {
    return cok<[readonly JsonAst[], readonly JsonAst[]]>([
      values.value,
      values.value.map(() => ({ kind: 'JBool', value: true }) as JsonAst),
    ]);
  }
  const validity = cArr(validityJ);
  if (!validity.ok) return validity;
  return cok<[readonly JsonAst[], readonly JsonAst[]]>([values.value, validity.value]);
};

const decodeDataColumn = (columnsObj: Fields, name: string, ty: ColumnType): CR<DataColumn> => {
  const colEl = columnsObj.get(name);
  if (colEl === undefined) return cerr('missing field: columns.' + name);
  const parts = columnParts(name, colEl);
  if (!parts.ok) return parts;
  const [values, validity] = parts.value;
  if (values.length !== validity.length) {
    return cerr(
      `column '${name}': values/validity length mismatch (${values.length} vs ${validity.length})`,
    );
  }
  const present = new Uint8Array(values.length);
  for (let i = 0; i < validity.length; i += 1) {
    const p = validity[i]!;
    if (p.kind !== 'JBool') {
      return cerr(`malformed: ${name}.validity: expected bool, got ${astKind(p)}`);
    }
    present[i] = p.value ? 1 : 0;
  }
  const data = decodeColumnData(name, ty, values, present);
  return data.ok ? cok<DataColumn>({ name, type: ty, data: data.value }) : data;
};

// Phase 88 (fuaran-core, mirrored) — infer a column's type from its cells.
// PINNED rules: all-int -> int, any fractional -> float, all-bool -> bool,
// all-string -> string, NEVER date/timestamp; empty/mixed = didactic reject.
const inferColumnType = (name: string, values: readonly JsonAst[]): CR<ColumnType> => {
  if (values.length === 0)
    return cerr(
      `malformed: ${name}: cannot infer a column type from an empty / all-null column — declare it in an explicit "schema" array`,
    );
  const tag = (v: JsonAst): string =>
    v.kind === 'JNumber'
      ? Number.isInteger(v.value)
        ? 'int'
        : 'float'
      : v.kind === 'JBool'
        ? 'bool'
        : v.kind === 'JString'
          ? 'string'
          : 'other';
  const tags = [...new Set(values.map(tag))];
  if (tags.length === 1 && tags[0] === 'int') return cok<ColumnType>('int');
  if (tags.every((t) => t === 'int' || t === 'float')) return cok<ColumnType>('float');
  if (tags.length === 1 && tags[0] === 'bool') return cok<ColumnType>('bool');
  if (tags.length === 1 && tags[0] === 'string') return cok<ColumnType>('string');
  return cerr(
    `malformed: ${name}: cannot infer a single column type from mixed cell kinds (${tags.join(', ')}) — declare it in an explicit "schema" array`,
  );
};

/** A `DataSource` — port of F# `ColumnCodec.decodeJson` (Phase 88: `schema`
 *  may be omitted on an embedded source; inferred in Ordinal column order). */
export const decodeDataSource = (j: JsonAst): CR<DataSource> => {
  const fo = cFields(j);
  if (!fo.ok) return fo;
  const schemaJ = fo.value.get('schema');
  let schema: CR<SchemaEntry[]> | undefined;
  if (schemaJ !== undefined) {
    schema = decodeColSchema(schemaJ);
    if (!schema.ok) return schema;
  }
  const refEl = fo.value.get('ref');
  if (refEl !== undefined) {
    if (schema === undefined)
      return cerr(
        'malformed: a ref source requires an explicit "schema" array — there are no cells to infer column types from',
      );
    const r = cStr(refEl);
    return r.ok ? cok<DataSource>({ kind: 'Ref', name: r.value }) : r;
  }
  const colsJ = cField(fo.value, 'columns');
  if (!colsJ.ok) return colsJ;
  const colsFo = cFields(colsJ.value);
  if (!colsFo.ok) return colsFo;
  if (schema === undefined) {
    const names = [...colsFo.value.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const entries: SchemaEntry[] = [];
    for (const name of names) {
      const colEl = colsFo.value.get(name)!;
      const parts = columnParts(name, colEl);
      if (!parts.ok) return parts;
      const ty = inferColumnType(name, parts.value[0]);
      if (!ty.ok) return ty;
      entries.push({ name, type: ty.value });
    }
    schema = cok(entries);
  }
  if (!schema.ok) return schema;
  const resolved = schema.value;
  const cols = cMapM(resolved, (e) => decodeDataColumn(colsFo.value, e.name, e.type));
  if (!cols.ok) return cols;
  return cok<DataSource>({
    kind: 'Embedded',
    table: { schema: resolved, columns: cols.value },
  });
};

/**
 * Phase 2001 — a rounding policy `{"mode":…,"scale":…}`: `mode` one of the
 * seven spellings (anything else is refused naming them), `scale` an integer.
 */
const decodeRoundingCore = (j: JsonAst): CR<Rounding> => {
  const fo = cFields(j);
  if (!fo.ok) return fo;
  const mode = cStrField(fo.value, 'mode');
  if (!mode.ok) return mode;
  if (!(ROUNDING_MODES as readonly string[]).includes(mode.value)) {
    return cerr(
      `unknown column type '${mode.value}'; expected one of: ${ROUNDING_MODES.join(', ')}`,
    );
  }
  const sj = cField(fo.value, 'scale');
  if (!sj.ok) return sj;
  const scale = cInt(sj.value);
  return scale.ok ? cok<Rounding>({ mode: mode.value as RoundingMode, scale: scale.value }) : scale;
};

/** A `ColExpr` — port of F# `DataFrameCodec.decodeExpr`. */
const decodeColExprCore = (j: JsonAst): CR<ColExpr> => {
  const fo = cFields(j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const k = cStrField(f, '$type');
  if (!k.ok) return k;
  switch (k.value) {
    case 'col': {
      const name = cStrField(f, 'name');
      return name.ok ? cok<ColExpr>({ kind: 'col', name: name.value }) : name;
    }
    case 'param': {
      // fuaran-core#77 — a named param resolved from the host env at evaluation time.
      const name = cStrField(f, 'name');
      return name.ok ? cok<ColExpr>({ kind: 'param', name: name.value }) : name;
    }
    case 'lit': {
      const cj = cField(f, 'cell');
      if (!cj.ok) return cj;
      const cell = decodeCellLit(cj.value);
      return cell.ok ? cok<ColExpr>({ kind: 'lit', cell: cell.value }) : cell;
    }
    case 'binary': {
      const op = cStrField(f, 'op');
      if (!op.ok) return op;
      if (!(BIN_OPS as readonly string[]).includes(op.value)) {
        return cerr(`unknown column type '${op.value}'; expected one of: ${BIN_OPS.join(', ')}`);
      }
      const lj = cField(f, 'left');
      if (!lj.ok) return lj;
      const left = decodeColExprCore(lj.value);
      if (!left.ok) return left;
      const rj = cField(f, 'right');
      if (!rj.ok) return rj;
      const right = decodeColExprCore(rj.value);
      if (!right.ok) return right;
      return cok<ColExpr>({
        kind: 'binary',
        op: op.value as BinOp,
        left: left.value,
        right: right.value,
      });
    }
    case 'not': {
      const ej = cField(f, 'expr');
      if (!ej.ok) return ej;
      const e = decodeColExprCore(ej.value);
      return e.ok ? cok<ColExpr>({ kind: 'not', expr: e.value }) : e;
    }
    case 'coalesce': {
      const ej = cField(f, 'exprs');
      if (!ej.ok) return ej;
      const a = cArr(ej.value);
      if (!a.ok) return a;
      const exprs = cMapM(a.value, decodeColExprCore);
      return exprs.ok ? cok<ColExpr>({ kind: 'coalesce', exprs: exprs.value }) : exprs;
    }
    case 'case': {
      const cj = cField(f, 'cases');
      if (!cj.ok) return cj;
      const ca = cArr(cj.value);
      if (!ca.ok) return ca;
      const cases = cMapM(ca.value, (c) => {
        const cfo = cFields(c);
        if (!cfo.ok) return cfo;
        const wj = cField(cfo.value, 'when');
        if (!wj.ok) return wj;
        const w = decodeColExprCore(wj.value);
        if (!w.ok) return w;
        const tj = cField(cfo.value, 'then');
        if (!tj.ok) return tj;
        const t = decodeColExprCore(tj.value);
        if (!t.ok) return t;
        return cok({ when: w.value, then: t.value });
      });
      if (!cases.ok) return cases;
      const ej = cField(f, 'else');
      if (!ej.ok) return ej;
      const e = decodeColExprCore(ej.value);
      return e.ok ? cok<ColExpr>({ kind: 'case', cases: cases.value, else: e.value }) : e;
    }
    case 'cast': {
      const ty = cStrField(f, 'type');
      if (!ty.ok) return ty;
      if (!COLUMN_TYPES.includes(ty.value as ColumnType)) {
        return cerr(
          `unknown column type '${ty.value}'; expected one of: ${COLUMN_TYPES.join(', ')}`,
        );
      }
      const ej = cField(f, 'expr');
      if (!ej.ok) return ej;
      const e = decodeColExprCore(ej.value);
      return e.ok ? cok<ColExpr>({ kind: 'cast', type: ty.value as ColumnType, expr: e.value }) : e;
    }
    // fuaran-core#93 — `call` aliases `apply` (same fn/args fields);
    // fuaran-core#94 adds the third observed spelling `fn`
    // ({"$type":"fn","fn":"lower","args":[…]}).
    case 'apply':
    case 'call':
    case 'fn': {
      const fn = cStrField(f, 'fn');
      if (!fn.ok) return fn;
      if (!(SCALAR_FNS as readonly string[]).includes(fn.value)) {
        return cerr(`unknown column type '${fn.value}'; expected one of: ${SCALAR_FNS.join(', ')}`);
      }
      const aj = cField(f, 'args');
      if (!aj.ok) return aj;
      const a = cArr(aj.value);
      if (!a.ok) return a;
      const args = cMapM(a.value, decodeColExprCore);
      return args.ok
        ? cok<ColExpr>({ kind: 'apply', fn: fn.value as ScalarFn, args: args.value })
        : args;
    }
    case 'in': {
      // fuaran-core#90 — SQL three-valued membership; #91 — exactly one of `items` (literal
      // list) / `param` (a bound multi-select list param).
      const ej = cField(f, 'expr');
      if (!ej.ok) return ej;
      const subject = decodeColExprCore(ej.value);
      if (!subject.ok) return subject;
      const ij = f.get('items');
      const pj = f.get('param');
      if (ij !== undefined && pj !== undefined)
        return cerr(
          'malformed: in: give exactly ONE of "items" (a literal list) or "param" (a multi-select list param), not both',
        );
      if (pj !== undefined) {
        const p = cStr(pj);
        return p.ok ? cok<ColExpr>({ kind: 'inParam', expr: subject.value, param: p.value }) : p;
      }
      if (ij === undefined) return cerr('missing field: items');
      const ia = cArr(ij);
      if (!ia.ok) return ia;
      const items = cMapM(ia.value, decodeColExprCore);
      return items.ok
        ? cok<ColExpr>({ kind: 'in', expr: subject.value, items: items.value })
        : items;
    }
    case 'isNull': {
      // fuaran-core#90 — the honest presence test.
      const ej = cField(f, 'expr');
      if (!ej.ok) return ej;
      const e = decodeColExprCore(ej.value);
      return e.ok ? cok<ColExpr>({ kind: 'isNull', expr: e.value }) : e;
    }
    case 'quotient': {
      // Phase 2001 — exact division, correctly rounded once.
      const aj = cField(f, 'dividend');
      if (!aj.ok) return aj;
      const dividend = decodeColExprCore(aj.value);
      if (!dividend.ok) return dividend;
      const bj = cField(f, 'divisor');
      if (!bj.ok) return bj;
      const divisor = decodeColExprCore(bj.value);
      if (!divisor.ok) return divisor;
      const rj = cField(f, 'rounding');
      if (!rj.ok) return rj;
      const rounding = decodeRoundingCore(rj.value);
      return rounding.ok
        ? cok<ColExpr>({
            kind: 'quotient',
            dividend: dividend.value,
            divisor: divisor.value,
            rounding: rounding.value,
          })
        : rounding;
    }
    case 'rounded': {
      // Phase 2001 — an exact operand brought to a scale under a mode.
      const ej = cField(f, 'expr');
      if (!ej.ok) return ej;
      const e = decodeColExprCore(ej.value);
      if (!e.ok) return e;
      const rj = cField(f, 'rounding');
      if (!rj.ok) return rj;
      const rounding = decodeRoundingCore(rj.value);
      return rounding.ok
        ? cok<ColExpr>({ kind: 'rounded', expr: e.value, rounding: rounding.value })
        : rounding;
    }
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      // fuaran-core#93 — expression-level string-predicate spellings denote exactly
      // Binary(op, left|expr, right|other); canonical stays the 'binary' form.
      const lj = cFieldAliased(f, 'left', 'expr');
      if (!lj.ok) return lj;
      const left = decodeColExprCore(lj.value);
      if (!left.ok) return left;
      const rj = cFieldAliased(f, 'right', 'other');
      if (!rj.ok) return rj;
      const right = decodeColExprCore(rj.value);
      if (!right.ok) return right;
      return cok<ColExpr>({
        kind: 'binary',
        op: k.value as BinOp,
        left: left.value,
        right: right.value,
      });
    }
    // fuaran-core#94 — flat logical spellings (pilot-5 census): SQL-prior models
    // emit {"$type":"or","exprs":[e1,e2,…]} (variadic) or
    // {"$type":"and","left":X,"right":Y} instead of the canonical nested
    // "binary". A variadic list left-folds into the nested form (and/or are
    // associative); canonical stays "binary" — these normalise on re-encode.
    case 'and':
    case 'or': {
      const op: BinOp = k.value as BinOp;
      const exprsEl = f.get('exprs');
      if (exprsEl !== undefined) {
        const a = cArr(exprsEl);
        if (!a.ok) return a;
        const exprs = cMapM(a.value, decodeColExprCore);
        if (!exprs.ok) return exprs;
        if (exprs.value.length === 0)
          return cerr(`malformed: ${k.value}.exprs: expected a non-empty array`);
        const [first, ...rest] = exprs.value;
        return cok<ColExpr>(
          rest.reduce<ColExpr>((acc, e) => ({ kind: 'binary', op, left: acc, right: e }), first!),
        );
      }
      const lj = cFieldAliased(f, 'left', 'expr');
      if (!lj.ok) return lj;
      const left = decodeColExprCore(lj.value);
      if (!left.ok) return left;
      const rj = cFieldAliased(f, 'right', 'other');
      if (!rj.ok) return rj;
      const right = decodeColExprCore(rj.value);
      if (!right.ok) return right;
      return cok<ColExpr>({ kind: 'binary', op, left: left.value, right: right.value });
    }
    // fuaran-core#94 — flat comparison spellings, the same class:
    // {"$type":"eq","left":X,"right":Y} denotes exactly Binary(eq, X, Y);
    // same for ne/lt/le/gt/ge.
    case 'eq':
    case 'ne':
    case 'lt':
    case 'le':
    case 'gt':
    case 'ge': {
      const lj = cFieldAliased(f, 'left', 'expr');
      if (!lj.ok) return lj;
      const left = decodeColExprCore(lj.value);
      if (!left.ok) return left;
      const rj = cFieldAliased(f, 'right', 'other');
      if (!rj.ok) return rj;
      const right = decodeColExprCore(rj.value);
      if (!right.ok) return right;
      return cok<ColExpr>({
        kind: 'binary',
        op: k.value as BinOp,
        left: left.value,
        right: right.value,
      });
    }
    default: {
      // fuaran-core#94 — flat scalar-fn spellings: {"$type":"lower","expr":X} /
      // {"$type":"concat","args":[…]} denote ApplyFn(fn, args). The scalar-fn
      // name vocabulary is disjoint from the node-kind vocabulary, so the
      // mapping is one-to-one; canonical stays "apply".
      if ((SCALAR_FNS as readonly string[]).includes(k.value)) {
        const fn = k.value as ScalarFn;
        const argsEl = f.get('args');
        if (argsEl !== undefined) {
          const a = cArr(argsEl);
          if (!a.ok) return a;
          const args = cMapM(a.value, decodeColExprCore);
          return args.ok ? cok<ColExpr>({ kind: 'apply', fn, args: args.value }) : args;
        }
        const ej = cField(f, 'expr');
        if (!ej.ok) return ej;
        const e = decodeColExprCore(ej.value);
        return e.ok ? cok<ColExpr>({ kind: 'apply', fn, args: [e.value] }) : e;
      }
      return cerr(
        `unknown column type '${k.value}'; expected one of: col, lit, param, binary, not, coalesce, case, cast, apply, in, isNull`,
      );
    }
  }
};

const decodePairCore = (j: JsonAst): CR<ColPair> => {
  const fo = cFields(j);
  if (!fo.ok) return fo;
  const a = cStrField(fo.value, 'a');
  if (!a.ok) return a;
  const b = cStrField(fo.value, 'b');
  return b.ok ? cok<ColPair>({ a: a.value, b: b.value }) : b;
};

const decodeAggCore = (j: JsonAst): CR<Agg> => {
  // fuaran-core#92 — aggregate-entry aliases: `as` for `name`, `op` for `fn`, `column` for `of`;
  // AggFn alias `avg` -> `mean`.
  const fo = cFields(j);
  if (!fo.ok) return fo;
  const nameEl = cFieldAliased(fo.value, 'name', 'as');
  if (!nameEl.ok) return nameEl;
  const name = cStr(nameEl.value);
  if (!name.ok) return name;
  const fnEl = cFieldAliased(fo.value, 'fn', 'op');
  if (!fnEl.ok) return fnEl;
  const fnStr = cStr(fnEl.value);
  if (!fnStr.ok) return fnStr;
  const fnv = fnStr.value === 'avg' ? 'mean' : fnStr.value;
  if (!(AGG_FNS as readonly string[]).includes(fnv)) {
    return cerr(`unknown column type '${fnv}'; expected one of: ${AGG_FNS.join(', ')}`);
  }
  const ofEl = cFieldAliased(fo.value, 'of', 'column');
  if (!ofEl.ok) return ofEl;
  const of = cStr(ofEl.value);
  return of.ok ? cok<Agg>({ name: name.value, fn: fnv as AggFn, of: of.value }) : of;
};

const decodeOrderCore = (j: JsonAst): CR<SortKey> => {
  // fuaran-core#92 admitted `column` as an alias of `col`; 0.28.0 SWAPPED which of the two is
  // canonical — a member whose only honest name is "the column" is spelled out in full — so both
  // spellings still decode, `column` is what re-encodes, and giving both is refused as ambiguous.
  // Boolean `descending` remains an alias for `dir`.
  const fo = cFields(j);
  if (!fo.ok) return fo;
  const colEl = cFieldAliased(fo.value, 'column', 'col');
  if (!colEl.ok) return colEl;
  const col = cStr(colEl.value);
  if (!col.ok) return col;
  // fuaran-core#93 — `direction` is a third spelling; a directionless entry is asc (SQL default).
  const dirEl = fo.value.get('dir') ?? fo.value.get('direction');
  const descEl = fo.value.get('descending');
  const spellings = [fo.value.get('dir'), fo.value.get('direction'), descEl].filter(
    (x) => x !== undefined,
  ).length;
  if (spellings > 1)
    return cerr(
      'malformed: give ONE of "dir" (canonical: asc|desc), "descending" (alias boolean), or "direction" (alias: asc|desc)',
    );
  if (descEl !== undefined) {
    if (descEl.kind !== 'JBool') return cerr('malformed: "descending" must be a JSON boolean');
    return cok<SortKey>({ col: col.value, dir: descEl.value ? 'desc' : 'asc' });
  }
  if (dirEl === undefined) return cok<SortKey>({ col: col.value, dir: 'asc' });
  const dir = cStr(dirEl);
  if (!dir.ok) return dir;
  // Port of F# `dirOf`: only "desc" → Desc; anything else → Asc.
  return cok<SortKey>({ col: col.value, dir: dir.value === 'desc' ? 'desc' : 'asc' });
};

/** A `Transform` step — port of F# `DataFrameCodec.decodeTransform`. */
const decodeTransformCore = (j: JsonAst): CR<Transform> => {
  const fo = cFields(j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const k = cStrField(f, '$type');
  if (!k.ok) return k;
  switch (k.value) {
    case 'filter': {
      // Phase 89 (fuaran-core, mirrored) — the flat filter-step prior
      // {column, op, param|value} coerces to the canonical nested predicate.
      // fuaran-core#93 — `predicate` aliases `pred`.
      const pj0 = f.get('pred');
      const pj1 = f.get('predicate');
      if (pj0 !== undefined && pj1 !== undefined)
        return cerr('malformed: give "pred" (canonical) or "predicate" (alias), not both');
      const pj = pj0 ?? pj1;
      if (pj !== undefined) {
        const pred = decodeColExprCore(pj);
        return pred.ok ? cok<Transform>({ kind: 'filter', pred: pred.value }) : pred;
      }
      const colEl = f.get('column');
      const opEl = f.get('op');
      if (colEl !== undefined && opEl !== undefined) {
        const col = cStr(colEl);
        if (!col.ok) return col;
        const op = cStr(opEl);
        if (!op.ok) return op;
        if (!(BIN_OPS as readonly string[]).includes(op.value))
          return cerr(`unknown column type '${op.value}'; expected one of: ${BIN_OPS.join(', ')}`);
        const paramEl = f.get('param');
        const valueEl = f.get('value');
        if (paramEl !== undefined && valueEl !== undefined)
          return cerr(
            'malformed: flat filter step: give exactly ONE of "param" (a pipeline param name) or "value" (a scalar literal), not both',
          );
        let rhs: ColExpr;
        if (paramEl !== undefined) {
          const pName = cStr(paramEl);
          if (!pName.ok) return pName;
          rhs = { kind: 'param', name: pName.value };
        } else if (valueEl !== undefined) {
          if (valueEl.kind === 'JString')
            rhs = { kind: 'lit', cell: { kind: 'Str', value: valueEl.value } };
          else if (valueEl.kind === 'JNumber')
            rhs = Number.isInteger(valueEl.value)
              ? { kind: 'lit', cell: { kind: 'Int', value: valueEl.value } }
              : { kind: 'lit', cell: { kind: 'Float', value: valueEl.value } };
          else if (valueEl.kind === 'JBool')
            rhs = { kind: 'lit', cell: { kind: 'Bool', value: valueEl.value } };
          else
            return cerr(
              'malformed: flat filter step: "value" must be a scalar (string/int/float/bool)',
            );
        } else
          return cerr(
            'malformed: flat filter step: {column, op} needs "param" (a pipeline param name) or "value" (a scalar literal) as the right-hand side',
          );
        return cok<Transform>({
          kind: 'filter',
          pred: {
            kind: 'binary',
            op: op.value as BinOp,
            left: { kind: 'col', name: col.value },
            right: rhs,
          },
        });
      }
      return cerr(
        'malformed: a filter step carries "pred" (a $type-discriminated expression: binary/col/param/lit/apply) — or the flat short form {"column":…,"op":…,"param":…|"value":…}',
      );
    }
    case 'project': {
      // 0.28.0 — `cols` is the pre-rename spelling, kept as a decode alias; giving both is the
      // same ambiguity refusal every other aliased member of this algebra makes.
      const cj = cFieldAliased(f, 'columns', 'cols');
      if (!cj.ok) return cj;
      const a = cArr(cj.value);
      if (!a.ok) return a;
      const cols = cMapM(a.value, decodePairCore);
      return cols.ok ? cok<Transform>({ kind: 'project', cols: cols.value }) : cols;
    }
    case 'derive': {
      const name = cStrField(f, 'name');
      if (!name.ok) return name;
      const ej = cField(f, 'expr');
      if (!ej.ok) return ej;
      const expr = decodeColExprCore(ej.value);
      return expr.ok
        ? cok<Transform>({ kind: 'derive', name: name.value, expr: expr.value })
        : expr;
    }
    case 'groupBy': {
      // fuaran-core#92 — `by` (pandas prior) aliases `keys`; `aggregations` aliases `aggs`.
      const kj = cFieldAliased(f, 'keys', 'by');
      if (!kj.ok) return kj;
      const keys = cStrList(kj.value);
      if (!keys.ok) return keys;
      const aj = cFieldAliased(f, 'aggs', 'aggregations');
      if (!aj.ok) return aj;
      const aa = cArr(aj.value);
      if (!aa.ok) return aa;
      const aggs = cMapM(aa.value, decodeAggCore);
      return aggs.ok
        ? cok<Transform>({ kind: 'groupBy', keys: keys.value, aggs: aggs.value })
        : aggs;
    }
    case 'join': {
      const sj = cField(f, 'source');
      if (!sj.ok) return sj;
      const source = decodeDataSource(sj.value);
      if (!source.ok) return source;
      const oj = cField(f, 'on');
      if (!oj.ok) return oj;
      const oa = cArr(oj.value);
      if (!oa.ok) return oa;
      const on = cMapM(oa.value, decodePairCore);
      if (!on.ok) return on;
      const how = cStrField(f, 'how');
      if (!how.ok) return how;
      if (!(JOIN_KINDS as readonly string[]).includes(how.value)) {
        return cerr(
          `unknown column type '${how.value}'; expected one of: ${JOIN_KINDS.join(', ')}`,
        );
      }
      return cok<Transform>({
        kind: 'join',
        source: source.value,
        on: on.value,
        how: how.value as JoinKind,
      });
    }
    case 'window': {
      const pj = cField(f, 'partitionBy');
      if (!pj.ok) return pj;
      const partitionBy = cStrList(pj.value);
      if (!partitionBy.ok) return partitionBy;
      const oj = cField(f, 'orderBy');
      if (!oj.ok) return oj;
      const oa = cArr(oj.value);
      if (!oa.ok) return oa;
      const orderBy = cMapM(oa.value, decodeOrderCore);
      if (!orderBy.ok) return orderBy;
      const fnRaw = cStrField(f, 'fn');
      if (!fnRaw.ok) return fnRaw;
      // Legacy alias — the pre-rename wire tag (2026-07-19); normalises on re-encode.
      const fn = { ok: true as const, value: fnRaw.value === 'cumSum' ? 'cumulSum' : fnRaw.value };
      if (!(WINDOW_FNS as readonly string[]).includes(fn.value)) {
        return cerr(`unknown column type '${fn.value}'; expected one of: ${WINDOW_FNS.join(', ')}`);
      }
      const of = cStrField(f, 'of');
      if (!of.ok) return of;
      const asField = cStrField(f, 'as');
      if (!asField.ok) return asField;
      return cok<Transform>({
        kind: 'window',
        spec: {
          partitionBy: partitionBy.value,
          orderBy: orderBy.value,
          fn: fn.value as WindowFn,
          of: of.value,
          as: asField.value,
        },
      });
    }
    case 'pivot': {
      const ij = cField(f, 'index');
      if (!ij.ok) return ij;
      const index = cStrList(ij.value);
      if (!index.ok) return index;
      const on = cStrField(f, 'on');
      if (!on.ok) return on;
      const values = cStrField(f, 'values');
      if (!values.ok) return values;
      const agg = cStrField(f, 'agg');
      if (!agg.ok) return agg;
      if (!(AGG_FNS as readonly string[]).includes(agg.value)) {
        return cerr(`unknown column type '${agg.value}'; expected one of: ${AGG_FNS.join(', ')}`);
      }
      return cok<Transform>({
        kind: 'pivot',
        spec: { index: index.value, on: on.value, values: values.value, agg: agg.value as AggFn },
      });
    }
    case 'unpivot': {
      const ij = cField(f, 'idVars');
      if (!ij.ok) return ij;
      const idVars = cStrList(ij.value);
      if (!idVars.ok) return idVars;
      const vj = cField(f, 'valueVars');
      if (!vj.ok) return vj;
      const valueVars = cStrList(vj.value);
      return valueVars.ok
        ? cok<Transform>({ kind: 'unpivot', idVars: idVars.value, valueVars: valueVars.value })
        : valueVars;
    }
    case 'sort': {
      // fuaran-core#92 — `keys` (SQL ORDER-BY-list prior) aliases `by`.
      const bj = cFieldAliased(f, 'by', 'keys');
      if (!bj.ok) return bj;
      const ba = cArr(bj.value);
      if (!ba.ok) return ba;
      const by = cMapM(ba.value, decodeOrderCore);
      return by.ok ? cok<Transform>({ kind: 'sort', by: by.value }) : by;
    }
    case 'distinct':
      return cok<Transform>({ kind: 'distinct' });
    case 'limit': {
      // fuaran-core#92 — `count` aliases `n`; an absent `offset` is unambiguously 0.
      const nj = cFieldAliased(f, 'n', 'count');
      if (!nj.ok) return nj;
      const n = cInt(nj.value);
      if (!n.ok) return n;
      const oj = f.get('offset');
      const offset = oj === undefined ? cok(0) : cInt(oj);
      return offset.ok
        ? cok<Transform>({ kind: 'limit', n: n.value, offset: offset.value })
        : offset;
    }
    case 'union': {
      const sj = cField(f, 'source');
      if (!sj.ok) return sj;
      const source = decodeDataSource(sj.value);
      return source.ok ? cok<Transform>({ kind: 'union', source: source.value }) : source;
    }
    case 'intersect':
    case 'except': {
      // The multiset set-ops: keep the left rows whose full row does (not) appear in `source`.
      const sj = cField(f, 'source');
      if (!sj.ok) return sj;
      const source = decodeDataSource(sj.value);
      return source.ok
        ? cok<Transform>({ kind: k.value as 'intersect' | 'except', source: source.value })
        : source;
    }
    default:
      return cerr(
        `unknown column type '${k.value}'; expected one of: filter, project, derive, groupBy, join, window, pivot, unpivot, sort, distinct, limit, union`,
      );
  }
};

export const decodePipelineCore = (j: JsonAst): CR<Transform[]> => {
  if (j.kind !== 'JArray') {
    return cerr('malformed: pipeline: expected a JSON array of transform steps');
  }
  return cMapM(j.items, decodeTransformCore);
};

/**
 * Decode the `args` array of a `Binding.Invoke` / `Action.Invoke` (Phase 283) —
 * `[{"addr","value"}]` scalar pairs. Shared by both decoders; surfaces the
 * standard `DecodeError` surface (byte-identical paths/codes to the F# decoder).
 */
const decodeInvokeArgs = (w: Walk, path: string, j: JsonAst): R<InvokeArg[]> => {
  if (j.kind !== 'JArray') return wrongType(path, 'JSON array of invoke args');
  return traverseIndexed(j.items, (i, el) => {
    const p = `${path}[${i}]`;
    const m = requireObject(w, p, el);
    if (!m.ok) return m;
    const addr = reqField(w, p, m.value, 'addr', 'invoke arg addr string', requireString);
    const value = reqField(w, p, m.value, 'value', 'invoke arg value string', requireString);
    if (!addr.ok || !value.ok) return failed(addr, value);
    return ok<InvokeArg>({ addr: addr.value, value: value.value });
  });
};

/**
 * Phase 1534 / 1662 — one walk over a `ColExpr`, answering both questions this
 * wire asks of an expression: how many nodes it carries, and whether it names a
 * `col`.
 *
 * Written here rather than taken from the compute layer because neither
 * question is the ALGEBRA's: `col` is perfectly ordinary in a pipeline
 * expression, and the node ceiling is this WIRE's limit. One traversal answers
 * both.
 *
 * The count is CAPPED — the walk stops descending once it passes
 * MAX_EXPR_NODES — so a returned count above the ceiling means "over it" and is
 * not a true total. Neither caller wants the true figure, and a hostile
 * expression is exactly the input that must not be walked to the end.
 *
 * Phase 1662 split this out of `exprAdmissible` because §21.8's node bound now
 * covers the expressions a `Transform` pipeline embeds as well, where a `col`
 * is perfectly ordinary: the two verdicts have two callers now, and only one of
 * them wants the second. That is also why the walk no longer stops on `sawCol`
 * — short-circuiting on it would UNDER-count, which on the pipeline caller
 * would silently admit a bypass vector rather than refuse it.
 */
const scanExpr = (root: ColExpr): { count: number; sawCol: boolean } => {
  let count = 0;
  let sawCol = false;
  const walk = (e: ColExpr): void => {
    count += 1;
    if (count > MAX_EXPR_NODES) return;
    switch (e.kind) {
      case 'col':
        sawCol = true;
        return;
      case 'lit':
      case 'param':
        return;
      case 'binary':
        walk(e.left);
        walk(e.right);
        return;
      case 'not':
      case 'cast':
      case 'isNull':
        walk(e.expr);
        return;
      case 'coalesce':
        e.exprs.forEach(walk);
        return;
      case 'apply':
        e.args.forEach(walk);
        return;
      case 'case':
        for (const c of e.cases) {
          walk(c.when);
          walk(c.then);
        }
        walk(e.else);
        return;
      case 'in':
        walk(e.expr);
        e.items.forEach(walk);
        return;
      case 'inParam':
        walk(e.expr);
        return;
      case 'quotient':
        walk(e.dividend);
        walk(e.divisor);
        return;
      case 'rounded':
        walk(e.expr);
        return;
    }
  };
  walk(root);
  return { count, sawCol };
};

/**
 * Phase 1534 — the two structural rules a `Binding.Expr`'s expression must
 * satisfy, checked once at decode over the whole tree. The refusal ORDER is
 * unchanged from the pre-1662 shape (col first, then the limit).
 */
const exprAdmissible = (root: ColExpr): 'ok' | 'col' | 'limit' => {
  const { count, sawCol } = scanExpr(root);
  if (sawCol) return 'col';
  if (count > MAX_EXPR_NODES) return 'limit';
  return 'ok';
};

/**
 * Phase 1662 — §21.8's node bound over the expressions a `Binding.Transform`
 * PIPELINE embeds. MAX_EXPR_NODES bounded `Binding.Expr` alone until now, which
 * made it bypassable by wrapping the expression in a Transform: a `derive`'s
 * expression and a `filter`'s predicate reach the same evaluator and carried no
 * ceiling on any host.
 *
 * `filter` and `derive` are the whole surface — the only pipeline steps
 * carrying an expression; a `join` / `union` / `intersect` / `except` operand is
 * a data source (embedded table or named ref), never another pipeline — so
 * there is no recursive axis to descend.
 *
 * Same budget, counted per EMBEDDED EXPRESSION, refused with LIMIT_EXCEEDED at
 * the path of the offending `pred` / `expr` member so an author is told which
 * STEP to come back under. The first breach wins.
 */
const pipelineExprBreach = (
  path: string,
  pipeline: readonly Transform[],
): { readonly path: string } | undefined => {
  for (let i = 0; i < pipeline.length; i += 1) {
    const step = pipeline[i]!;
    const embedded =
      step.kind === 'filter'
        ? ({ slot: 'pred', expr: step.pred } as const)
        : step.kind === 'derive'
          ? ({ slot: 'expr', expr: step.expr } as const)
          : undefined;
    if (embedded === undefined) continue;
    if (scanExpr(embedded.expr).count > MAX_EXPR_NODES) {
      return { path: `${path}.pipeline[${i}].${embedded.slot}` };
    }
  }
  return undefined;
};

/** Phase 1534 — every `param` / `inParam` name an expression reads, in order of first sight. */
const colExprParamNames = (root: ColExpr): readonly string[] => {
  const seen: string[] = [];
  const push = (n: string): void => {
    if (!seen.includes(n)) seen.push(n);
  };
  const walk = (e: ColExpr): void => {
    switch (e.kind) {
      case 'col':
      case 'lit':
        return;
      case 'param':
        push(e.name);
        return;
      case 'binary':
        walk(e.left);
        walk(e.right);
        return;
      case 'not':
      case 'cast':
      case 'isNull':
        walk(e.expr);
        return;
      case 'coalesce':
        e.exprs.forEach(walk);
        return;
      case 'apply':
        e.args.forEach(walk);
        return;
      case 'case':
        for (const c of e.cases) {
          walk(c.when);
          walk(c.then);
        }
        walk(e.else);
        return;
      case 'in':
        walk(e.expr);
        e.items.forEach(walk);
        return;
      case 'inParam':
        walk(e.expr);
        push(e.param);
        return;
      case 'quotient':
        walk(e.dividend);
        walk(e.divisor);
        return;
      case 'rounded':
        walk(e.expr);
        return;
    }
  };
  walk(root);
  return seen;
};

/**
 * Phase 1534 — the optional `params` slot, shared by `Binding.Transform` (Phase
 * 424, where it started) and `Binding.Expr`. Absent yields `undefined`, which
 * is byte-identical to the Phase-282 shape; the §3.6 name->binding MAP
 * coercion rides along, so the leniency an author gets on one case they get on
 * the other.
 */
const decodeExprParams = (
  w: Walk,
  path: string,
  f: ReadonlyMap<string, JsonAst>,
): R<readonly TransformParam[] | undefined> => {
  const paramsField = tryField(f, 'params');
  if (paramsField === undefined) return ok(undefined);
  if (paramsField.kind === 'JObject') {
    // Lenient AI-ingest (WIRE_FORMAT.md 3.6, 2026-07-17): the name->binding MAP
    // form coerces to the canonical [{name, from}] array — params are a
    // name-keyed set, so key order carries no meaning. Mirror of F#
    // (Map.toList = sorted keys; sorted here to match).
    const entries = [...paramsField.fields.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return traverseIndexed(
      entries.map(([, v]) => v),
      (i, v) =>
        andThen(decodeBinding(w, `${path}.params.${entries[i]![0]}.from`, v), (from) =>
          ok<TransformParam>({ name: entries[i]![0], from }),
        ),
    );
  }
  const arr = requireArray(w, `${path}.params`, paramsField);
  if (!arr.ok) return arr;
  return traverseIndexed(arr.value, (i, el) => {
    // Each element's path carries its index (§29.3), as on the reference host.
    const ep = `${path}.params[${i}]`;
    const po = requireObject(w, ep, el);
    if (!po.ok) return po;
    const name = reqField(w, ep, po.value, 'name', 'param name string', requireString);
    // Field alias: value — the observed repair-attempt shape ({name, value}).
    // The binding is located by the param's NAME (`params.<name>.from`), as on
    // the reference host and as in the map form above. Its presence is checked
    // whatever the name holds; its value is decoded only under a good name
    // (WIRE_FORMAT §29.1 rule 6).
    const fromJ = fieldAliased(po.value, 'from', ['value']);
    const from =
      fromJ === undefined
        ? missingField(ep, 'from', 'param source Binding')
        : andThen(name, (n) => decodeBinding(w, `${path}.params.${n}.from`, fromJ));
    if (!name.ok || !from.ok) return failed(name, from);
    return ok<TransformParam>({ name: name.value, from: from.value });
  });
};

/**
 * Phase 429 — the typed-static-payload seam (mirror of F# `bindingGeneric`'s
 * `parseStatic` / `placeholder` parameters). `parseStatic` decodes the slot's
 * `Static.value` / `State.defaultValue` payload; `placeholder` is the typed
 * fallback for an absent / unparseable `State` default. The defaults preserve
 * the generic behaviour exactly (faithful AST value; `"<opaque>"` fallback);
 * the enumerated slot-typed wrappers below supply the typed pair.
 */
const decodeBinding = (
  w: Walk,
  path: string,
  j: JsonAst,
  parseStatic: Decoder<unknown> = (_w, _p, v) => ok(decodeAstValue(v)),
  placeholder: unknown = OPAQUE,
): R<Binding<unknown>> => {
  // Lenient AI-ingest shape coercion (WIRE_FORMAT.md §3.6): a bare JSON array
  // where a Binding is expected is accepted as `Static` with the array as its
  // value — `options: ["A","B"]` (the HTML select prior) and `data: [1,2,3]`
  // (the Chart.js prior). Unambiguous: every Binding case is a
  // `$type`-discriminated object, so an array can only mean Static.
  // Decode-only — the canonical encoder still emits the envelope. Bare
  // scalars/objects stay strict: an object without `$type` is more plausibly
  // a mistyped binding than a Static value. Mirror of F# `bindingGeneric`.
  // Extended 2026-07-17 second wave: bare SCALARS coerce too (fraction: 0.9,
  // activeStep: 1 — launch-eval evidence); null / untyped objects stay strict.
  if (j.kind === 'JArray' || j.kind === 'JString' || j.kind === 'JNumber' || j.kind === 'JBool') {
    const parsed = parseStatic(w, path, j);
    return parsed.ok ? ok({ kind: 'Static', value: parsed.value }) : parsed;
  }
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Static': {
      // Phase 677 — absence is structural: a MISSING `value` means the binding
      // carries none. The legacy `"value": null` form still decodes (§16
      // shorthand) by routing to the very same per-slot absent handling, so the
      // two spellings cannot disagree.
      const raw = f.get('value') ?? ({ kind: 'JNull' } as const);
      const parsed = parseStatic(w, `${path}.value`, raw);
      return parsed.ok ? ok({ kind: 'Static', value: parsed.value }) : parsed;
    }
    case 'Query': {
      const r = reqField(w, path, f, 'name', 'query name string', requireString);
      // Phase 421 — optional `dependsOn` string array (the declared filter edge); absent → omitted.
      const dependsOnField = fieldAliased(f, 'dependsOn', ['deps', 'dependencies']);
      const dependsOn =
        dependsOnField === undefined
          ? ok(undefined)
          : listOf(requireString)(w, `${path}.dependsOn`, dependsOnField);
      if (!r.ok || !dependsOn.ok) return failed(r, dependsOn);
      // Phase 421 identity-accessor fix: project the host's queryResults value straight through
      // (`(raw) => raw`) instead of discarding it, so host-fed data flows through decoded trees.
      return ok({
        kind: 'Query',
        name: r.value,
        accessor: (raw: unknown) => raw,
        ...(dependsOn.value !== undefined ? { dependsOn: dependsOn.value } : {}),
      });
    }
    case 'Filter': {
      const r = reqField(w, path, f, 'name', 'filter name string', requireString);
      if (!r.ok) return r;
      // 0.2.0 — optional `defaultValue`: the value the resolver yields (and
      // the renderer seeds the store with) before the filter is first
      // written. Decoded through the slot's typed static parser, mirroring
      // `State.defaultValue`; an absent / unparseable default stays omitted.
      const dv = tryField(f, 'defaultValue');
      let defaultValue: unknown;
      let hasDefault = false;
      if (dv !== undefined) {
        const parsed = parseStatic(w, `${path}.defaultValue`, dv);
        if (parsed.ok) {
          defaultValue = parsed.value;
          hasDefault = true;
        }
      }
      const b: Binding<unknown> = {
        kind: 'Filter',
        name: r.value,
        ...(hasDefault ? { defaultValue } : {}),
      };
      return ok(b);
    }
    case 'Selection': {
      const r = reqField(w, path, f, 'nodeId', 'selection NodeId string', requireString);
      if (!r.ok) return r;
      // 0.2.9 (Phase 629) — optional `defaultValue`, the `Filter.defaultValue`
      // convention: yielded until the user first selects a row on `nodeId`.
      const dv = tryField(f, 'defaultValue');
      let defaultValue: unknown;
      let hasDefault = false;
      if (dv !== undefined) {
        const parsed = parseStatic(w, `${path}.defaultValue`, dv);
        if (parsed.ok) {
          defaultValue = parsed.value;
          hasDefault = true;
        }
      }
      // Phase 427 identity-accessor fix (the 421 `Query` fix replayed): a
      // decoded `Selection` projects the stored row straight through instead
      // of a value-discarding placeholder, so a written selection flows to
      // decoded readers.
      //
      // 0.2.10 (Phase 632) — optional `field`: the declarative row-field
      // projection. Present ⇒ the accessor projects that field off the
      // clicked row (the grid writes the FULL row), so the binding stays
      // scalar after a real click; absent ⇒ the 427 identity, pre-632
      // behaviour byte-for-byte. A missing field / non-row value throws in
      // the accessor — the resolver's loud path, never silent.
      const fv = tryField(f, 'field');
      let field: string | undefined;
      if (fv !== undefined) {
        const s = requireString(w, `${path}.field`, fv);
        if (s.ok) field = s.value;
      }
      const accessor: (raw: unknown) => unknown =
        field !== undefined ? projectSelectionField(field) : (raw: unknown) => raw;
      const b: Binding<unknown> = {
        kind: 'Selection',
        nodeId: r.value as NodeId,
        accessor,
        ...(hasDefault ? { defaultValue } : {}),
        ...(field !== undefined ? { field } : {}),
      };
      return ok(b);
    }
    case 'State': {
      const key = reqField(w, path, f, 'key', 'state key string', requireString);
      if (!key.ok) return key;
      // §5's absent-`State.defaultValue` posture (Phase 1656): absence OMITS,
      // and ABSENCE HAS THREE SPELLINGS — the member missing, the member
      // present as JSON `null`, and either lenient alias present as `null`.
      // All three yield no default at all, so the encoder writes no member and
      // a bare `{"$type":"State","key":k}` re-encodes as itself at every slot.
      //
      // The null arm has to be decided HERE and cannot be delegated to
      // `parseStatic`, which is what this arm did until 1656 and what made it
      // wrong on two counts. §5's read-compat rule maps a `null` Static payload
      // to the slot's TYPED EMPTY, so at every collection slot
      // (`parseStaticSelectOptions` / `StringList` / `FloatSeq` / `Rows` /
      // `MarkerSeq`, each `ok([])` on `JNull`) an ABSENT default came back as
      // `[]` and re-encoded as `"defaultValue":[]` — respelling "I read this
      // key and carry nothing of my own" as a declaration that the collection
      // is empty, which the seeding lattice reads as a different claim. And an
      // explicitly-written `null` came back as the slot's PLACEHOLDER (`0` at a
      // numeric slot), which is sharper still: a member the document wrote as
      // nothing re-encoded as a number. That read-compat belongs to
      // `Static.value` and stays there, pinned by `lenient-null-static-options`;
      // this position is pinned by `lenient-1656-state-default-null`.
      //
      // The RESOLVED value is untouched, and that separation is the whole point
      // of `defaultDeclared`. `defaultValue` stays what an unwritten key
      // resolves to (§3.3) — the slot's typed default, which the read-compat
      // mapping is the right way to obtain — and the new field carries the wire
      // fact the encoder needs. Collapsing the two into one field is what made
      // this arm wrong: with only the value, "the author declared the empty
      // collection" and "the author declared nothing, and the empty collection
      // is what an unwritten key yields" are the same state, and the encoder
      // has to guess. The reference host expresses the pair as a `'T option`
      // plus its generic `defaultof<'T>`; the sibling Rust host carries it as
      // this explicit second field, which is where the shape is borrowed from.
      //
      // The typed placeholder also survives as the fallback for a default the
      // document CARRIED and this slot's parser could not read — a different
      // fact again, and one §5 deliberately leaves unsettled across the hosts:
      // it keeps a usable value where the document said something unreadable,
      // where synthesising one where the document said NOTHING re-emits a
      // member nobody wrote. That case stays DECLARED, so its bytes do not
      // move. Corpus: `nodes/state-absent-default` (the five typed slots),
      // `lenient-1656-state-default-null` (both null spellings),
      // `reject-state-default-without-key` (the optionality, the right way
      // round — the DEFAULT may be omitted, the KEY may not).
      const dvRaw = fieldAliased(f, 'defaultValue', ['initialValue', 'default']);
      const declared = dvRaw !== undefined && dvRaw.kind !== 'JNull';
      const dv = dvRaw ?? ({ kind: 'JNull' } as const);
      let defaultValue: unknown = dvRaw === undefined ? undefined : placeholder;
      const parsed = parseStatic(w, `${path}.defaultValue`, dv);
      if (parsed.ok) defaultValue = parsed.value;
      // The field is set only for the NEGATIVE, so a declared default's decoded
      // shape is byte-for-byte what it was: `defaultDeclared` says "this
      // document declared nothing", and a binding that carries no such claim is
      // read by the encoder exactly as it always was.
      return ok(
        declared
          ? { kind: 'State', key: key.value, defaultValue }
          : { kind: 'State', key: key.value, defaultValue, defaultDeclared: false },
      );
    }
    case 'Computed':
      // The encoder writes the fn as `<closure>`, and there is nothing else in
      // the case — so a decoded `Computed` cannot compute.
      //
      // It used to decode to `() => undefined`, which the resolver reported as
      // `Resolved undefined` and the slot rendered as its empty state: a wrong
      // answer indistinguishable at the slot from a right one. The stand-in now
      // THROWS, the resolver catches it into an `Errored` naming the cases that
      // do cross the wire, and the reader sees the slot's error surface. The
      // decode itself still succeeds — the document is well-formed, and refusing
      // the whole tree for a binding nothing may ever read would be a larger
      // claim than the evidence supports.
      return ok({
        kind: 'Computed',
        compute: () => {
          throw new WireSurvivabilityError(DECODED_COMPUTED_MESSAGE);
        },
      });
    // The projection decodes to the IDENTITY (the Phase 427 Selection fix
    // replayed): the host-furnished instant is already the wire-shaped string,
    // so a decoded reader receives it as-is. A value-discarding placeholder
    // here would make every decoded `Now` resolve to nothing even when the
    // host furnishes the instant.
    case 'Now': {
      // Phase 1533 — `grain` is the ONE wire field, optional, absent meaning
      // `Second`. Absence is the default; PRESENT and unreadable is a refusal,
      // never a silent fallback, because a document that names a grain the host
      // cannot honour would otherwise render at a resolution it did not ask for
      // and say nothing about it.
      const g = tryField(f, 'grain');
      if (g === undefined) return ok({ kind: 'Now', project: (iso) => iso });
      const r = decodeTimeGrain(w, `${path}.grain`, g);
      return r.ok ? ok({ kind: 'Now', project: (iso) => iso, grain: r.value }) : r;
    }
    case 'I18n': {
      const key = reqField(w, path, f, 'key', 'i18n key string', requireString);
      const args = optField(w, path, f, 'args', decodeBindingArgs);
      if (!key.ok || !args.ok) return failed(key, args);
      const b: Binding<unknown> =
        args.value === undefined
          ? { kind: 'I18n', key: key.value }
          : { kind: 'I18n', key: key.value, args: args.value };
      return ok(b);
    }
    case 'Local': {
      // The three closure slots stop being holes here (WIRE_FORMAT.md Section
      // 3.3.3). Before: `format` decoded to nothing, `parse` to a function that
      // ALWAYS returned an error, and `onCommit` to a no-op — so a wire-authored
      // debounced input rendered empty and could never commit a keystroke. The
      // fixture said so verbatim, in three sentinels.
      //
      //  1. `format` / `parse` restore to the IDENTITY, `parse` reading the
      //     reader's text back through `parseStatic` — the slot's OWN decoder,
      //     which this function already carries — so a text slot takes the
      //     string verbatim and a numeric slot takes the number the text
      //     denotes, with no host-side type dispatch to diverge on.
      //  2. `codec`, when declared, REPLACES both.
      //  3. `commitTo` is the State-key alternative to the `onCommit` closure.
      //     Declaring both is refused rather than resolved by a precedence rule:
      //     the wire cannot carry the closure, so a host honouring `onCommit`
      //     and a host honouring `commitTo` would write to different places from
      //     identical bytes.
      // `codec`, `commitTo`, `initialFrom` and `flushOn` are sibling members
      // (§29.1): each decoded on its own, with its own check, joined once.
      const codecR = optField(w, path, f, 'codec', (w2, p, j2) =>
        andThen(decodeFormat(w2, p, j2), (c) =>
          // The admitted set is the `Format` cases with a TOTAL,
          // LOCALE-INDEPENDENT inverse, and today that is `Number` alone.
          // `Currency` prepends a locale-chosen symbol; `Date`'s four styles are
          // all locale renditions; `RelativeTime` / `Since` / `Duration` render a
          // phrase. `Percent` is refused for a narrower reason worth stating: its
          // inverse needs a x100 scale whose IEEE round-trip is not exact.
          c.kind !== 'Number'
            ? makeError(
                'WRONG_TYPE',
                p,
                "Binding.Local 'codec' must be a Format case with a total, locale-independent inverse — only 'Number' has one",
                'use {"$type":"Number","decimals":2}, or drop the codec and let the buffer use the identity; a locale-rendered format (Currency / Date / RelativeTime / Since / Duration) cannot be parsed back from what the reader typed',
              )
            : ok(c),
        ),
      );

      const onCommitPresent = tryField(f, 'onCommit') !== undefined;
      const commitToR = optField(w, path, f, 'commitTo', (w2, p, j2) =>
        onCommitPresent
          ? makeError(
              'WRONG_TYPE',
              p,
              "Binding.Local carries both 'onCommit' and 'commitTo' — exactly one commit destination is allowed",
              'either onCommit (a host closure, which crosses the wire only as the closure sentinel) or commitTo (the State key the flush writes); a decoding host can honour only the second, so keeping both makes the same document commit to two different places depending on who read it',
            )
          : requireString(w2, p, j2),
      );

      // `initialFrom` recurses with the same typed pair (mirror of the F#
      // `bindingGeneric` recursion).
      const initial = reqField(w, path, f, 'initialFrom', 'Local InitialFrom Binding', (w2, p, v) =>
        decodeBinding(w2, p, v, parseStatic, placeholder),
      );
      const flushJ = tryField(f, 'flushOn');
      const flush =
        flushJ === undefined
          ? ok<LocalFlushTrigger>({ kind: 'OnBlur' })
          : decodeLocalFlushTrigger(w, `${path}.flushOn`, flushJ);
      if (!codecR.ok || !commitToR.ok || !initial.ok || !flush.ok)
        return failed(codecR, commitToR, initial, flush);
      const codec = codecR.value;
      const commitTo = commitToR.value;

      const refusalOf = (raw: string): string =>
        `Binding.Local: '${raw}' is not a value this field accepts`;

      const identityParse = (raw: string): Result<unknown, string> => {
        const asText = parseStatic(w, `${path}.parse`, { kind: 'JString', value: raw } as JsonAst);
        if (asText.ok) return { ok: true, value: asText.value };
        const scalar = scalarOfText(raw);
        if (scalar === undefined) return { ok: false, error: refusalOf(raw) };
        const asScalar = parseStatic(
          w,
          `${path}.parse`,
          typeof scalar === 'number'
            ? ({ kind: 'JNumber', value: scalar } as JsonAst)
            : ({ kind: 'JBool', value: scalar } as JsonAst),
        );
        return asScalar.ok
          ? { ok: true, value: asScalar.value }
          : { ok: false, error: refusalOf(raw) };
      };

      const decimals = codec !== undefined && codec.kind === 'Number' ? codec.decimals : undefined;

      const codecParse = (raw: string): Result<unknown, string> => {
        const n = tryNumberText(raw);
        if (n === undefined) return { ok: false, error: refusalOf(raw) };
        const parsed = parseStatic(w, `${path}.parse`, { kind: 'JNumber', value: n } as JsonAst);
        return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: refusalOf(raw) };
      };

      const local: LocalBinding<unknown> = {
        initialFrom: initial.value,
        flushOn: flush.value,
        format:
          codec !== undefined
            ? (v: unknown) => numberText(decimals, v)
            : (v: unknown) => identityFormat(v),
        parse: codec !== undefined ? codecParse : identityParse,
        ...(onCommitPresent ? { onCommit: () => undefined } : {}),
        ...(codec !== undefined ? { codec } : {}),
        ...(commitTo !== undefined ? { commitTo } : {}),
      };
      const b: Binding<unknown> = { kind: 'Local', local };
      return ok(b);
    }
    case 'Format': {
      // Phase 102: source is always a numeric Binding; format / locale are
      // bounded DUs. The case is structurally independent of the slot type.
      const source = reqField(w, path, f, 'source', 'Binding<number> source object', decodeBinding);
      const fmt = reqField(w, path, f, 'format', 'Format DU object', decodeFormat);
      const loc = reqField(w, path, f, 'locale', 'LocaleSource DU object', decodeLocaleSource);
      if (!source.ok || !fmt.ok || !loc.ok) return failed(source, fmt, loc);
      const b: Binding<unknown> = {
        kind: 'Format',
        source: source.value as Binding<number>,
        format: fmt.value,
        locale: loc.value,
      };
      return ok(b);
    }
    case 'Transform': {
      // Phase 282 — the Compute layer. `source` (a DataSource) and `pipeline` (a
      // Transform list) decode through the Core-style structural decoders; a Core
      // decode failure wraps to WRONG_TYPE at `.source` / `.pipeline`, byte-
      // identical to the F# UI host's `coreError` wrapping.
      // Phase 818 — a binding-shaped source (State / Selection / Query `$type`)
      // is PRESERVED as `TransformSource.Live`: the decoded binding re-encodes
      // verbatim (one wire dialect) and the runtime re-evaluates the pipeline
      // against it, with the decode-time `initial` snapshot derived from the
      // binding's carried default data through the same 815 normalisation.
      // Phase 1085 — a State wrapper carrying NO data is a live source over the
      // EMPTY initial snapshot, exactly as a Selection / Query source already
      // was. It used to error through the columnar codec (the 815 posture,
      // correct when nothing could fill the slot); under the 1075 seeding rule
      // a sibling reader's declaration fills it, so the bare
      // `{"$type":"State","key":k}` is the direct spelling of "I read this key
      // and carry no data of my own" — and the one FUARAN106's remedy text
      // tells an author to write.
      // `source`, `pipeline` and `params` are sibling members: each is decoded on
      // its own, so a defect in one does not hide the others (§29.1).
      const sourceR = andThen(
        requireField(path, f, 'source', 'Transform DataSource object'),
        (srcV): R<TransformSource> => {
          const liveTagAst = srcV.kind === 'JObject' ? srcV.fields.get('$type') : undefined;
          const liveTag =
            liveTagAst !== undefined &&
            liveTagAst.kind === 'JString' &&
            (liveTagAst.value === 'State' ||
              liveTagAst.value === 'Selection' ||
              liveTagAst.value === 'Query')
              ? liveTagAst.value
              : undefined;
          let source: TransformSource;
          if (liveTag === undefined) {
            // The pre-818 path: canonical columnar / `ref` and the 815 leniencies
            // (Static/Bound wrapper unwrap; row-major transpose).
            const src = decodeDataSource(normaliseTransformSource(srcV));
            if (!src.ok) return makeError('WRONG_TYPE', `${path}.source`, src.error);
            source = { kind: 'Data', source: src.value };
          } else {
            // The carried default decodes FAITHFULLY (the structured decodeJVal),
            // so the preserved binding round-trips byte-for-byte.
            const b = decodeBinding(w, `${path}.source`, srcV, decodeJVal, undefined);
            if (!b.ok) return b as R<never>;
            // Phase 1085 — an ABSENT `defaultValue` must stay ABSENT on the decoded
            // binding, or the SEEDING pass reads a source that DECLARES NOTHING as
            // a declaration of the slot's typed placeholder (here the `"<opaque>"`
            // sentinel): seeding the slot with a sentinel on this tier and with
            // nothing on the other, from one document. Measured, not reasoned — the
            // first run of that pin returned `{"members":"<opaque>"}`.
            //
            // Phase 1656 — it reads the DECODER'S OWN wire fact now instead of
            // re-inspecting the raw member, so the two places stop being two
            // decisions over one thing. That duplication is how they came to
            // disagree about the `null` spelling: this one asked whether the member
            // was PRESENT, where the arm above asks whether anything was DECLARED,
            // and an explicit `null` is present without declaring anything.
            //
            // The clearing is still needed and is not the encoder's business: the
            // encoder reads `defaultDeclared` and omits either way. What this
            // clears is the value the SEEDING walk reads, which at this slot must
            // be nothing rather than the sentinel.
            const liveBinding = (() => {
              const raw = b.value as Binding<JsonValue>;
              return raw.kind === 'State' && raw.defaultDeclared === false
                ? ({ ...raw, defaultValue: undefined } as unknown as Binding<JsonValue>)
                : raw;
            })();
            if (liveTag === 'State') {
              // An EMPTY array default is the empty table, exactly as a
              // Selection / Query live source starts. An initially-empty live
              // collection ("count the requests in an empty log") is a correct,
              // complete intent with zero rows and no columns to infer, and the
              // columnar codec's "expected object, got array" didactic was
              // refusing a shape with nothing wrong in it.
              //
              // The F# reference host has read it this way since 0.23.1; this tier
              // never did, and nothing in the corpus or the specification said so,
              // so one document decoded on one host and was refused on the other.
              // Found by Phase 1075 — `"defaultValue":[]` is how a Transform's
              // source slot spells "I read this key and carry no data of my own",
              // which is precisely the shape the seeding rule exists to make work.
              // `WIRE_FORMAT.md` §16 now carries the rule and the corpus pins it.
              //
              // Phase 1085 — an ABSENT `defaultValue` takes the same arm. The two
              // spellings say one thing; the empty array stays the answer for a
              // genuinely empty live collection rather than a workaround for a
              // wrapper the decoder would not accept bare.
              //
              // Phase 1656 — the `null` spelling of absence takes it too, which it
              // did not before: a raw `JNull` is neither undefined nor an empty
              // array, so it fell to the snapshot branch and was decoded as carried
              // data. The reference host never had the bug because it reads the
              // DECODED binding's default, where every spelling of absence is
              // already one value; this reads the raw member, so it must name them.
              const carriedJ =
                srcV.kind === 'JObject' ? srcV.fields.get('defaultValue') : undefined;
              const carriesNoData =
                carriedJ === undefined ||
                carriedJ.kind === 'JNull' ||
                (carriedJ.kind === 'JArray' && carriedJ.items.length === 0);

              if (carriesNoData) {
                source = {
                  kind: 'Live',
                  binding: liveBinding,
                  initial: { kind: 'Embedded', table: { schema: [], columns: [] } },
                };
              } else {
                // The carried data IS the initial snapshot; a decode failure
                // (ragged / mixed-type rows) surfaces the same didactic the 815
                // snapshot decode raised.
                const snap = decodeDataSource(normaliseTransformSource(srcV));
                if (!snap.ok) return makeError('WRONG_TYPE', `${path}.source`, snap.error);
                source = {
                  kind: 'Live',
                  binding: liveBinding,
                  initial: snap.value,
                };
              }
            } else {
              // Selection / Query — a tabular carried default seeds the initial
              // snapshot; anything else starts from the empty table (runtime
              // evaluation stays loud on a non-tabular live value, never here).
              const dv = srcV.kind === 'JObject' ? srcV.fields.get('defaultValue') : undefined;
              const snap =
                dv !== undefined ? decodeDataSource(normaliseTransformSource(dv)) : undefined;
              source = {
                kind: 'Live',
                binding: liveBinding,
                initial:
                  snap !== undefined && snap.ok
                    ? snap.value
                    : { kind: 'Embedded', table: { schema: [], columns: [] } },
              };
            }
          }
          return ok(source);
        },
      );
      const pipe = andThen(
        requireField(path, f, 'pipeline', 'Transform pipeline array'),
        (pipeV): R<Transform[]> => {
          const decoded = decodePipelineCore(pipeV);
          if (!decoded.ok) return makeError('WRONG_TYPE', `${path}.pipeline`, decoded.error);
          // Phase 1662 — §21.8's expression-node bound over the pipeline's own
          // embedded expressions, at DECODE and not at validation: a document that
          // decodes must not be able to name an unbounded evaluation.
          const breach = pipelineExprBreach(path, decoded.value);
          return breach !== undefined
            ? makeError(
                'LIMIT_EXCEEDED',
                breach.path,
                `expression exceeds the maximum of ${MAX_EXPR_NODES} expression nodes (WIRE_FORMAT 21.8)`,
                `at most ${MAX_EXPR_NODES} ColExpr nodes in one pipeline expression`,
              )
            : ok(decoded.value);
        },
      );
      // Phase 424 — the optional `params` slot, shared with `Binding.Expr` since
      // Phase 1534 (see `decodeExprParams`).
      const paramsR = decodeExprParams(w, path, f);
      if (!sourceR.ok || !pipe.ok || !paramsR.ok) return failed(sourceR, pipe, paramsR);
      const source = sourceR.value;
      const params = paramsR.value;
      const b: Binding<unknown> = {
        kind: 'Transform',
        source,
        pipeline: pipe.value,
        ...(params !== undefined ? { params } : {}),
      };
      return ok(b);
    }
    case 'Expr': {
      // Phase 1534 — the scalar expression binding (WIRE_FORMAT §3.3.2). `expr`
      // is one `ColExpr` in Core's own encoding; `params` is the same
      // name->binding list `Transform` carries, decoded by the same helper.
      //
      // Three refusals, all here because each wants a $-rooted path and a code:
      // a `col` reference (an Expr has no row, so `col` names nothing — the
      // remedy is a different BINDING, and the message says so), a `param` this
      // binding's own `params` does not bind (decidable statically here where
      // it is NOT for `Transform`, whose unbound filter params are pruned under
      // the deliberate unset-chip leniency), and an expression over
      // MAX_EXPR_NODES.
      // `expr` (with its own admissibility) and `params` are sibling members,
      // each decoded on its own; the unbound-param rule relates the two and sits
      // after the guard that joins them, so it runs only when both decoded (§29.1).
      const expr = andThen(requireField(path, f, 'expr', 'ColExpr object'), (exprV): R<ColExpr> => {
        const decoded = decodeColExprCore(exprV);
        if (!decoded.ok) return makeError('WRONG_TYPE', `${path}.expr`, decoded.error);
        const verdict = exprAdmissible(decoded.value);
        if (verdict === 'col') {
          return makeError(
            'WRONG_TYPE',
            `${path}.expr`,
            'a `col` reference is not admitted inside an Expr binding — an Expr evaluates against its params alone and has no row for a column name to read. Use `Binding.Transform`, whose source supplies the frame, and put the column expression in a `derive` step',
            'a ColExpr over `param` / `lit` / operators only (no `col`)',
          );
        }
        if (verdict === 'limit') {
          return makeError(
            'LIMIT_EXCEEDED',
            `${path}.expr`,
            `expression exceeds the maximum of ${MAX_EXPR_NODES} expression nodes (WIRE_FORMAT 21)`,
            `at most ${MAX_EXPR_NODES} ColExpr nodes in one Expr binding`,
          );
        }
        return ok(decoded.value);
      });
      const exprParams = decodeExprParams(w, path, f);
      if (!expr.ok || !exprParams.ok) return failed(expr, exprParams);
      const bound = new Set((exprParams.value ?? []).map((p) => p.name));
      const missing = colExprParamNames(expr.value).filter((n) => !bound.has(n));
      if (missing.length > 0) {
        return makeError(
          'WRONG_TYPE',
          `${path}.expr`,
          `the expression reads param(s) ${missing.map((n) => `'${n}'`).join(', ')} that this binding's \`params\` does not bind — an Expr has no rows and no filter to prune, so an unbound param has no value to take; add a params entry naming each, or drop the reference`,
          '{"$type":"Expr","expr":{…},"params":[{"name":"<name>","from":<Binding>}]}',
        );
      }
      const b: Binding<unknown> = {
        kind: 'Expr',
        expr: expr.value,
        ...(exprParams.value !== undefined ? { params: exprParams.value } : {}),
      };
      return ok(b);
    }
    case 'Invoke': {
      // Phase 283 — host-registered capability dispatched for a value.
      const cid = reqField(w, path, f, 'capabilityId', 'capability id string', requireString);
      const args = reqField(w, path, f, 'args', 'invoke args array', decodeInvokeArgs);
      if (!cid.ok || !args.ok) return failed(cid, args);
      const b: Binding<unknown> = { kind: 'Invoke', capabilityId: cid.value, args: args.value };
      return ok(b);
    }
    // 0.2.12 (Phase 633) — the `TextSource.Bound` wrapper convention
    // transferred to a bare-Binding slot: models emit
    // {"$type":"Bound","binding":X} in Metric.value / LabelValueRow etc.
    // `Bound` carries exactly one payload field, so the unwrap is one-to-one:
    // decode the inner binding in place. Decode-only — the canonical encoder
    // never wraps bare-Binding slots.
    case 'Bound': {
      const inner = requireField(path, f, 'binding', 'the wrapped Binding object');
      if (!inner.ok) return inner;
      return decodeBinding(w, `${path}.binding`, inner.value, parseStatic, placeholder);
    }
    default:
      return unknownDuCase(
        path,
        d.value,
        'Static | Query | Filter | Selection | State | Computed | I18n | Local | Format | Transform | Invoke',
      );
  }
};

// Phase 815 — organic-demand leniencies for the Transform `source` slot, both
// observed cross-family (claude, gemini, kimi — the Tier-D pilot, 2026-08-13):
// models bind a derived value to a Transform whose source is
// `{"$type":"State","defaultValue":[{row},…]}`. Two universal priors,
// accommodated as typed data at THIS host bridge, before the columnar codec
// sees the value (the fuaran#633 `Bound`-unwrap precedent — no Core change,
// no wire-spec change, no new key). Mirror of the F# `normaliseTransformSource`:
//   1. a `State`/`Static`/`Bound` binding WRAPPER around the data unwraps to
//      its `defaultValue`/`value` (initial-snapshot semantics — a LIVE
//      state-sourced Transform is the 032/c6 charter, deliberately not this);
//   2. ROW-MAJOR data (an array of row objects) transposes to the canonical
//      columnar `{"columns": …}` shape — FIRST-row key set (sorted, the F#
//      Map ordering), absent cells null. Canonical columnar and `ref` sources
//      pass through untouched, so existing fixtures stay byte-identical.
// Ragged / mixed-type rows may still fail downstream (the mixed-type
// didactic) — deliberately not special-cased.
const normaliseTransformSource = (j: JsonAst): JsonAst => {
  let unwrapped = j;
  if (j.kind === 'JObject') {
    const t = j.fields.get('$type');
    if (
      t !== undefined &&
      t.kind === 'JString' &&
      (t.value === 'State' || t.value === 'Static' || t.value === 'Bound')
    ) {
      const inner = j.fields.get('defaultValue') ?? j.fields.get('value');
      if (inner !== undefined) unwrapped = inner;
    }
  }
  if (
    unwrapped.kind === 'JArray' &&
    unwrapped.items.length > 0 &&
    unwrapped.items[0]!.kind === 'JObject'
  ) {
    const rows = unwrapped.items;
    const first = unwrapped.items[0] as { readonly fields: ReadonlyMap<string, JsonAst> };
    const keys = [...first.fields.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const cols = new Map<string, JsonAst>();
    for (const k of keys) {
      const cells = rows.map((row): JsonAst => {
        if (row.kind !== 'JObject') return { kind: 'JNull' };
        return row.fields.get(k) ?? { kind: 'JNull' };
      });
      cols.set(k, { kind: 'JArray', items: cells });
    }
    return {
      kind: 'JObject',
      fields: new Map<string, JsonAst>([['columns', { kind: 'JObject', fields: cols }]]),
    };
  }
  return unwrapped;
};

/**
 * Phase 818 — materialise a LIVE Transform source's resolved store value as the
 * evaluation input table: row-major rows transpose through the same 815
 * normalisation the decode-time snapshot used, then decode through the
 * columnar codec (schema inference included). `ok: false` for any value that
 * cannot be read as data — callers surface that loudly, never silently
 * (the Phase-427 mismatch posture). Exported for the renderers' shared
 * `evalTransformFrame` live leg.
 */
export const liveValueToTable = (
  v: unknown,
):
  | { readonly ok: true; readonly value: Table }
  | { readonly ok: false; readonly error: string } => {
  if (v === undefined) return { ok: false, error: 'Transform live source resolved to no value' };
  let text: string;
  try {
    text = JSON.stringify(v);
  } catch {
    return {
      ok: false,
      error: 'Transform live source resolved to a value with no JSON representation',
    };
  }
  if (text === undefined) {
    return { ok: false, error: 'Transform live source resolved to no value' };
  }
  const parsed = parse(text);
  if (!parsed.ok) {
    return { ok: false, error: 'Transform live source resolved to unreadable data' };
  }
  const src = decodeDataSource(normaliseTransformSource(parsed.value));
  if (!src.ok) return { ok: false, error: src.error };
  if (src.value.kind !== 'Embedded') {
    return {
      ok: false,
      error: `Transform live source resolved to a 'ref' source ('${src.value.name}'), which is not host-resolved`,
    };
  }
  return { ok: true, value: src.value.table };
};

const decodeBindingArgs = (
  w: Walk,
  path: string,
  j: JsonAst,
): R<Record<string, Binding<JsonValue>>> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  return traverseMembers(
    path,
    fo.value,
    (p, _k, v) => decodeBinding(w, p, v) as R<Binding<JsonValue>>,
  );
};

/**
 * Phase 1661 — a `TextSource.I18n` argument bag, discriminated BY INSPECTION
 * (WIRE_FORMAT.md §5). An object carrying a `$type` member is a BINDING; every
 * other JSON value is the LITERAL argument and decodes to `Static` carrying it.
 *
 * Distinct from `decodeBindingArgs` above (`Binding.I18n`'s bag), whose every
 * entry is a `$type` envelope — the two slots carry the same argument type and
 * differ in the canonical spelling of one argument, which is the asymmetry §5
 * states rather than leaves to be inferred.
 *
 * The `Static` arm is read HERE rather than left to `decodeBinding`, on two
 * counts. A missing or null `value` is Phase 677's structural absence and must
 * stay `{"$type":"Static"}` — `decodeBinding`'s untyped parser would give it the
 * slot's placeholder, which at an argument is a character a reader sees. And the
 * tagged spelling of a PRESENT literal takes the rule-12 strict decoder, the
 * same one the bare spelling takes below: one payload position under two
 * spellings cannot have two null postures, and the permissive path would map a
 * nested null to a value where the bare path refuses it.
 */
const decodeI18nArgMap = (
  w: Walk,
  path: string,
  j: JsonAst,
): R<Record<string, Binding<JsonValue>>> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  return traverseMembers(path, fo.value, (argPath, _k, v): R<Binding<JsonValue>> => {
    if (v.kind === 'JObject' && v.fields.has('$type')) {
      const tag = v.fields.get('$type');
      const raw = v.fields.get('value');
      if (tag !== undefined && tag.kind === 'JString' && tag.value === 'Static') {
        if (raw === undefined || raw.kind === 'JNull')
          return ok<Binding<JsonValue>>({ kind: 'Static', value: null });
        return andThen(decodeJVal(w, `${argPath}.value`, raw), (lit) =>
          ok<Binding<JsonValue>>({ kind: 'Static', value: lit }),
        );
      }
      return decodeBinding(w, argPath, v) as R<Binding<JsonValue>>;
    }
    return andThen(decodeJVal(w, argPath, v), (lit) =>
      ok<Binding<JsonValue>>({ kind: 'Static', value: lit }),
    );
  });
};

// The typed SCALAR Static payloads. These two were CASTS over the untyped
// `decodeBinding` — they named a type and checked none, so `{"hidden": "yes"}`
// and `{"href": 7}` decoded as `Static` carrying the wrong-typed scalar. That
// is not the §3.6 leniency: the scalar coercion is about SHAPE (a bare scalar
// can only mean `Static`), and the slot's own `'T` still governs the VALUE.
// The reference host has always passed `requireString` / `requireBool` here
// (`bindingGeneric<string> path requireString ""`), which is why it alone
// refused `reject-a11y-hidden-nonbool`; the placeholders match its typed
// fallbacks for an absent / unparseable `State.defaultValue`, so the two hosts
// agree byte-for-byte on that arm too.
const decodeBindingString = (w: Walk, p: string, j: JsonAst): R<Binding<string>> =>
  decodeBinding(w, p, j, requireString, '') as R<Binding<string>>;
const decodeBindingBool = (w: Walk, p: string, j: JsonAst): R<Binding<boolean>> =>
  decodeBinding(w, p, j, requireBool, false) as R<Binding<boolean>>;

// The typed NUMERIC scalar Static payloads (Phase 1064) — the other half of the
// defect the two above fixed. These slots had no typed decoder at all: every
// numeric position (`Metric.value` / `.trend`, `LabelValueRow.value`,
// `Progress.fraction`, `Drawing.strokeWidth` / `.opacity`, the Number and
// RangedNumber control values, `Tabs.activeIndex`, `Stepper.activeStep`) passed
// the bare `decodeBinding` and then CAST the result to `Binding<number>`, so
// `{"fraction": true}` decoded as a Static carrying a boolean and the cast made
// it a lie the type system could not see.
//
// The two parsers already encode §7 correctly and are simply routed here: a
// float slot takes a JSON number or exactly `"NaN"` / `"Infinity"` /
// `"-Infinity"`, an integer slot takes a number alone and truncates. That
// asymmetry is the whole reason these are two functions and not one — pinned by
// `reject-binding-int-sentinel-string`, which carries a correctly-spelled
// sentinel at an integer slot. The placeholders mirror the reference host's
// typed fallbacks for an absent or unparseable `State.defaultValue` (`0.0` /
// `0`), so the two hosts agree byte-for-byte on that arm too.
const decodeBindingFloat = (w: Walk, p: string, j: JsonAst): R<Binding<number>> =>
  decodeBinding(w, p, j, requireFloat, 0) as R<Binding<number>>;
const decodeBindingInt = (w: Walk, p: string, j: JsonAst): R<Binding<number>> =>
  decodeBinding(w, p, j, requireInt, 0) as R<Binding<number>>;

// ─── Typed Static payload decoders (Phase 429) ───────────────────────────────
//
// Mirrors of the F# `decodeBinding*` family: the typed wire form is preferred
// (the encoder emits it since 429), the legacy `"<opaque>"` sentinel decodes
// to a tagged placeholder (whose typed re-encode is byte-stable across both
// hosts), and JSON `null` — the pre-429 F# boxes-to-null empty-collection
// form — decodes to the typed empty. fuaran#665 retired the last generic slot:
// grid/chart row seqs decode through `decodeBindingRows` below.

const OPTIONS_PLACEHOLDER: readonly SelectOption[] = [
  { value: OPAQUE, label: { kind: 'Literal', value: OPAQUE } },
];

const decodeSelectOption = (w: Walk, path: string, j: JsonAst): R<SelectOption> => {
  // Lenient AI-ingest shape coercion (WIRE_FORMAT.md §3.6): a bare string
  // element coerces to `{value: s, label: Literal s}` — the HTML `<select>`
  // prior. The value→label map form (`{"A":"A"}`) is deliberately NOT
  // coerced: JSON key order is not contractual, so it could silently reorder
  // visible options. Mirror of F# `decodeSelectOption`.
  if (j.kind === 'JString') {
    return ok<SelectOption>({ value: j.value, label: { kind: 'Literal', value: j.value } });
  }
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const value = reqField(w, path, fo.value, 'value', 'option value string', requireString);
  const label = reqField(w, path, fo.value, 'label', 'option label TextSource', decodeTextSource);
  if (!value.ok || !label.ok) return failed(value, label);
  return ok<SelectOption>({ value: value.value, label: label.value });
};

const parseStaticSelectOptions = (w: Walk, p: string, v: JsonAst): R<unknown> => {
  if (v.kind === 'JNull') return ok([]); // pre-429 read-compat: empty list boxed to `null`
  if (v.kind === 'JString' && v.value === OPAQUE) return ok(OPTIONS_PLACEHOLDER);
  const arr = requireArray(w, p, v);
  if (!arr.ok) return arr;
  return traverseIndexed(arr.value, (i, el) => decodeSelectOption(w, `${p}[${i}]`, el));
};

const decodeBindingSelectOptions = (
  w: Walk,
  p: string,
  j: JsonAst,
): R<Binding<readonly SelectOption[]>> =>
  decodeBinding(w, p, j, parseStaticSelectOptions, OPTIONS_PLACEHOLDER) as R<
    Binding<readonly SelectOption[]>
  >;

const parseStaticStringOpt = (w: Walk, p: string, v: JsonAst): R<unknown> => {
  if (v.kind === 'JNull') return ok(undefined);
  if (v.kind === 'JString') return ok(v.value); // includes the opaque sentinel (read-compat)
  return wrongType(p, 'JSON string or null (string option)');
};

const decodeBindingStringOpt = (w: Walk, p: string, j: JsonAst): R<Binding<string | undefined>> =>
  decodeBinding(w, p, j, parseStaticStringOpt, OPAQUE) as R<Binding<string | undefined>>;

const parseStaticFloatPair = (w: Walk, p: string, v: JsonAst): R<unknown> => {
  // 0.2.0 — the dual-thumb Range control's [min, max] pair. Static forms:
  // the object `{min, max}` (canonical) or a two-element array (lenient).
  if (v.kind === 'JObject') {
    const mn = v.fields.get('min');
    const mx = v.fields.get('max');
    if (mn !== undefined && mx !== undefined) {
      const a = requireFloat(w, `${p}.min`, mn);
      const b = requireFloat(w, `${p}.max`, mx);
      if (!a.ok || !b.ok) return failed(a, b);
      return ok([a.value, b.value] as const);
    }
    return wrongType(p, 'object with min and max numbers');
  }
  if (v.kind === 'JArray' && v.items.length === 2) {
    const a = requireFloat(w, `${p}[0]`, v.items[0] as JsonAst);
    const b = requireFloat(w, `${p}[1]`, v.items[1] as JsonAst);
    if (!a.ok || !b.ok) return failed(a, b);
    return ok([a.value, b.value] as const);
  }
  return wrongType(p, 'range pair ({min, max} object or [min, max] array)');
};

const decodeBindingFloatPair = (
  w: Walk,
  p: string,
  j: JsonAst,
): R<Binding<readonly [number, number]>> => {
  // The canonical Static pair rides as the BARE `{min, max}` object (the
  // Phase-423 range shape, no envelope) — accept it before the generic
  // binding dispatch, which would otherwise demand a `$type`.
  if (
    j.kind === 'JObject' &&
    j.fields.get('$type') === undefined &&
    j.fields.get('min') !== undefined &&
    j.fields.get('max') !== undefined
  ) {
    const parsed = parseStaticFloatPair(w, p, j);
    return parsed.ok
      ? ok({ kind: 'Static', value: parsed.value as readonly [number, number] })
      : parsed;
  }
  return decodeBinding(w, p, j, parseStaticFloatPair, [0, 0] as const) as R<
    Binding<readonly [number, number]>
  >;
};

const parseStaticStringPair = (w: Walk, p: string, v: JsonAst): R<unknown> => {
  // Phase 725 — the DateTimeRange control's (from, to) ISO-8601 pair. Mirrors
  // `parseStaticFloatPair`: the bare `{from, to}` object is canonical, a
  // two-element `[from, to]` array is the §3.6 lenient coercion.
  //
  // Didactic domain rule: a LITERAL pair must be ordered. Same-variant ISO-8601
  // strings sort lexicographically in chronological order, so an ordinal
  // compare is total here — no date parsing, no locale. Only a literal pair is
  // checked; a bound pair's ordering is a runtime concern.
  const ordered = (a: string, b: string): R<readonly [string, string]> =>
    a > b
      ? makeError(
          'WRONG_TYPE',
          p,
          `date-range start '${a}' is after end '${b}' — a DateTimeRange pair is ordered (from <= to); ISO-8601 strings of one variant compare lexicographically, so swap the two values`,
          'ordered ISO-8601 pair ({"from": <iso>, "to": <iso>} with from <= to)',
        )
      : ok([a, b] as const);
  if (v.kind === 'JObject') {
    const from = v.fields.get('from');
    const to = v.fields.get('to');
    if (from !== undefined && to !== undefined) {
      const a = requireString(w, `${p}.from`, from);
      const b = requireString(w, `${p}.to`, to);
      if (!a.ok || !b.ok) return failed(a, b);
      return ordered(a.value, b.value);
    }
    return wrongType(p, 'object with from and to ISO-8601 strings');
  }
  if (v.kind === 'JArray' && v.items.length === 2) {
    const a = requireString(w, `${p}[0]`, v.items[0] as JsonAst);
    const b = requireString(w, `${p}[1]`, v.items[1] as JsonAst);
    if (!a.ok || !b.ok) return failed(a, b);
    return ordered(a.value, b.value);
  }
  return wrongType(p, 'date-range pair ({from, to} object or [from, to] array)');
};

const decodeBindingStringPair = (
  w: Walk,
  p: string,
  j: JsonAst,
): R<Binding<readonly [string, string]>> => {
  // The canonical Static pair rides as the BARE `{from, to}` object (the
  // `Range` posture, no envelope) — accept it before the generic binding
  // dispatch, which would otherwise demand a `$type`.
  if (
    j.kind === 'JObject' &&
    j.fields.get('$type') === undefined &&
    j.fields.get('from') !== undefined &&
    j.fields.get('to') !== undefined
  ) {
    const parsed = parseStaticStringPair(w, p, j);
    return parsed.ok
      ? ok({ kind: 'Static', value: parsed.value as readonly [string, string] })
      : parsed;
  }
  return decodeBinding(w, p, j, parseStaticStringPair, ['', ''] as const) as R<
    Binding<readonly [string, string]>
  >;
};

const parseStaticStringList = (w: Walk, p: string, v: JsonAst): R<unknown> => {
  if (v.kind === 'JNull') return ok([]);
  if (v.kind === 'JString' && v.value === OPAQUE) return ok([OPAQUE]);
  const arr = requireArray(w, p, v);
  if (!arr.ok) return arr;
  return traverseIndexed(arr.value, (i, el) => requireString(w, `${p}[${i}]`, el));
};

const decodeBindingStringList = (w: Walk, p: string, j: JsonAst): R<Binding<readonly string[]>> =>
  decodeBinding(w, p, j, parseStaticStringList, [OPAQUE]) as R<Binding<readonly string[]>>;

const parseStaticFloatSeq = (w: Walk, p: string, v: JsonAst): R<unknown> => {
  if (v.kind === 'JNull') return ok([]); // pre-429 read-compat: empty list-backed seq boxed to `null`
  if (v.kind === 'JString' && v.value === OPAQUE) return ok([]);
  const arr = requireArray(w, p, v);
  if (!arr.ok) return arr;
  return traverseIndexed(arr.value, (i, el) => requireFloat(w, `${p}[${i}]`, el));
};

const decodeBindingFloatSeq = (w: Walk, p: string, j: JsonAst): R<Binding<readonly number[]>> =>
  decodeBinding(w, p, j, parseStaticFloatSeq, []) as R<Binding<readonly number[]>>;

// fuaran#665 — the typed rows decoder: a grid/chart rows payload is an array
// of row objects (faithful record cells via `decodeAstValue`, the F# `decodeObj`
// mirror), with the legacy `"<opaque>"` sentinel accepted indefinitely
// (read-compat → the empty feed, exactly the pre-typed behaviour). A non-object
// row element is a named decode error. Mirror of F# `decodeRowSeq`.
const parseStaticRows = (w: Walk, p: string, v: JsonAst): R<unknown> => {
  if (v.kind === 'JNull') return ok([]); // lenient shorthand for absence (rule 4 decode-accept)
  if (v.kind === 'JString' && v.value === OPAQUE) return ok([]);
  const arr = requireArray(w, p, v);
  if (!arr.ok) return arr;
  return traverseIndexed(arr.value, (i, el) =>
    el.kind === 'JObject' ? ok(decodeAstValue(el)) : wrongType(`${p}[${i}]`, 'row object'),
  );
};

const decodeBindingRows = (w: Walk, p: string, j: JsonAst): R<Binding<readonly unknown[]>> =>
  decodeBinding(w, p, j, parseStaticRows, []) as R<Binding<readonly unknown[]>>;

const decodeMapMarker = (w: Walk, path: string, j: JsonAst): R<MapMarker> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const label = reqField(w, path, fo.value, 'label', 'marker label TextSource', decodeTextSource);
  const latitude = reqField(w, path, fo.value, 'latitude', 'marker latitude float', requireFloat);
  const longitude = reqField(
    w,
    path,
    fo.value,
    'longitude',
    'marker longitude float',
    requireFloat,
  );
  if (!label.ok || !latitude.ok || !longitude.ok) return failed(label, latitude, longitude);
  return ok<MapMarker>({
    label: label.value,
    latitude: latitude.value,
    longitude: longitude.value,
  });
};

const parseStaticMarkerSeq = (w: Walk, p: string, v: JsonAst): R<unknown> => {
  if (v.kind === 'JNull') return ok([]); // pre-429 read-compat: empty list-backed seq boxed to `null`
  if (v.kind === 'JString' && v.value === OPAQUE) return ok([]);
  const arr = requireArray(w, p, v);
  if (!arr.ok) return arr;
  return traverseIndexed(arr.value, (i, el) => decodeMapMarker(w, `${p}[${i}]`, el));
};

const decodeBindingMarkerSeq = (w: Walk, p: string, j: JsonAst): R<Binding<readonly MapMarker[]>> =>
  decodeBinding(w, p, j, parseStaticMarkerSeq, []) as R<Binding<readonly MapMarker[]>>;

// ─── TextSource / SelectOption ───────────────────────────────────────────────

const decodeTextSource = (w: Walk, path: string, j: JsonAst): R<TextSource> => {
  // 0.2.0 — the bare JSON string IS the canonical Literal form (the encoder
  // emits it); the `{"$type":"Literal"}` envelope stays decode-accepted, so
  // pre-0.2.0 trees keep parsing. Byte-for-byte with the F# decoder.
  if (j.kind === 'JString') return ok({ kind: 'Literal', value: j.value });
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Literal': {
      const r = reqField(w, path, f, 'text', 'literal text string', requireString);
      return r.ok ? ok({ kind: 'Literal', value: r.value }) : r;
    }
    case 'Bound': {
      const r = reqField(w, path, f, 'binding', 'Binding<string> object', decodeBindingString);
      if (!r.ok) return r;
      const t: TextSource = { kind: 'Bound', binding: r.value };
      return ok(t);
    }
    case 'I18n': {
      const key = reqField(w, path, f, 'key', 'i18n key string', requireString);
      const args = optField(w, path, f, 'args', decodeI18nArgMap);
      if (!key.ok || !args.ok) return failed(key, args);
      const t: TextSource = { kind: 'I18n', key: key.value, args: args.value ?? {} };
      return ok(t);
    }
    default:
      return unknownDuCase(path, d.value, 'Literal | Bound | I18n');
  }
};

// ─── Action ──────────────────────────────────────────────────────────────────

const decodeAction = (w: Walk, path: string, j: JsonAst): R<Action<unknown>> => {
  // 0.2.2 DIDACTIC — a bare string in an Action slot (the "<closure>"
  // sentinel written as the value). Never coerced (a sentinel action would
  // be a dead control passing the gate); the error names the fix.
  if (j.kind === 'JString') {
    const s = j.value.length > 24 ? j.value.slice(0, 24) + '…' : j.value;
    return wrongType(
      path,
      `JSON object, got the string '${s}' — an action is a $type-discriminated object (SetState | Navigate | Call | Notify | Chain | AiTool | WriteToClipboard | Print | Invoke); "<closure>" is not authorable. Pick a real action, e.g. {"$type":"SetState","key":…,"value":…}`,
    );
  }
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Dispatch':
      return ok({ kind: 'Dispatch', msg: CLOSURE });
    case 'Call': {
      const r = reqFieldAliased(
        w,
        path,
        f,
        'endpoint',
        ['url'],
        'ApiEndpoint string',
        requireString,
      );
      // Phase 428: a present `"<closure>"` onResult → the inert placeholder;
      // absent → omitted. `into` is the optional declarative result target.
      // `into` is a sibling of `endpoint` (§29.1).
      const intoR = optField(w, path, f, 'into', (w2, p, j2): R<CallResultTarget> => {
        const io = requireObject(w2, p, j2);
        if (!io.ok) return io;
        const id = requireDiscriminator(p, io.value);
        if (!id.ok) return id;
        if (id.value === 'State') {
          const key = reqField(w2, p, io.value, 'key', 'state key string', requireString);
          return key.ok ? ok<CallResultTarget>({ kind: 'State', key: key.value }) : key;
        }
        if (id.value === 'Query') {
          const name = reqField(w2, p, io.value, 'name', 'query name string', requireString);
          return name.ok ? ok<CallResultTarget>({ kind: 'Query', name: name.value }) : name;
        }
        return unknownDuCase(p, id.value, 'State | Query');
      });
      if (!r.ok || !intoR.ok) return failed(r, intoR);
      const into = intoR.value;
      return ok({
        kind: 'Call',
        endpoint: r.value as import('@fuaran-ui/schema').ApiEndpoint,
        ...(tryField(f, 'onResult') !== undefined ? { onResult: () => CLOSURE } : {}),
        ...(into !== undefined ? { into } : {}),
      });
    }
    case 'Notify': {
      const channel = reqField(w, path, f, 'channel', 'notification channel string', requireString);
      const payloadJ = requireField(path, f, 'payload', 'JsonValue payload');
      if (!channel.ok || !payloadJ.ok) return failed(channel, payloadJ);
      const payload = decodeJVal(w, `${path}.payload`, payloadJ.value);
      return payload.ok
        ? ok({ kind: 'Notify', channel: channel.value, payload: payload.value })
        : payload;
    }
    case 'Navigate': {
      // Phase 1536 — the route is a `TextSource`. `decodeTextSource` already
      // accepts a bare JSON string as `Literal` (the §16 shorthand every text
      // slot shares), so every pre-1536 document — including one using an
      // alias — decodes unchanged and re-encodes to the same bytes. The
      // aliases are resolved before the value is decoded, so there is still
      // exactly one canonical field a router can be reached through.
      const r = reqFieldAliased(
        w,
        path,
        f,
        'route',
        ['href', 'url', 'to'],
        'route TextSource',
        decodeTextSource,
      );
      const targetJ = tryField(f, 'target');
      // `target` is omitted at `Self`, so absence is the pre-1536 behaviour.
      const target =
        targetJ === undefined
          ? ok<NavigateTarget>('Self')
          : decodeNavigateTarget(w, `${path}.target`, targetJ);
      if (!r.ok || !target.ok) return failed(r, target);
      return ok({ kind: 'Navigate', route: r.value, target: target.value });
    }
    case 'SetState': {
      // Phase 818 — `value` (a literal JSON value, written verbatim) XOR
      // `valueFrom` (a Binding evaluated at dispatch time inside the existing
      // gate). Exactly one must be present; both / neither error didactically
      // naming both fields.
      const key = reqField(w, path, f, 'key', 'state key string', requireString);
      const valueJ = tryField(f, 'value');
      const fromJ = tryField(f, 'valueFrom');
      // The written value is a sibling of `key`, decoded on its own (§29.1).
      const written = ((): R<
        { readonly valueFrom: Binding<JsonValue> } | { readonly value: JsonValue }
      > => {
        if (valueJ !== undefined && fromJ !== undefined) {
          return makeError(
            'WRONG_TYPE',
            `${path}.valueFrom`,
            "SetState carries both 'value' and 'valueFrom' — exactly one is allowed: 'value' is a literal JSON value written verbatim; 'valueFrom' derives the written value from a Binding at dispatch time; remove one",
          );
        }
        if (valueJ === undefined && fromJ === undefined) {
          return makeError(
            'MISSING_FIELD',
            `${path}.value`,
            "missing required field 'value' — provide 'value' (a literal JSON value) or 'valueFrom' (a Binding evaluated at dispatch time)",
          );
        }
        if (fromJ !== undefined) {
          const from = decodeBinding(w, `${path}.valueFrom`, fromJ, decodeJVal, undefined);
          if (!from.ok) return from;
          return ok({ valueFrom: from.value as Binding<JsonValue> });
        }
        const value = decodeJVal(w, `${path}.value`, valueJ as JsonAst);
        return value.ok ? ok({ value: value.value }) : value;
      })();
      if (!key.ok || !written.ok) return failed(key, written);
      return ok({ kind: 'SetState', key: key.value, ...written.value });
    }
    case 'AiTool': {
      const name = reqField(w, path, f, 'toolName', 'AI tool name string', requireString);
      const argsJ = requireField(path, f, 'args', 'JsonValue args');
      if (!name.ok || !argsJ.ok) return failed(name, argsJ);
      const args = decodeJVal(w, `${path}.args`, argsJ.value);
      return args.ok ? ok({ kind: 'AiTool', toolName: name.value, args: args.value }) : args;
    }
    case 'Chain': {
      const inner = reqField(w, path, f, 'ops', 'Action list (Chain)', listOf(decodeAction));
      return inner.ok ? ok({ kind: 'Chain', actions: inner.value }) : inner;
    }
    case 'CommitLocal': {
      const r = reqField(w, path, f, 'nodeId', 'Local-bound input NodeId string', requireString);
      return r.ok ? ok({ kind: 'CommitLocal', nodeId: r.value }) : r;
    }
    case 'WriteToClipboard': {
      // Phase 1126 — the payload is a `TextSource`. The bare JSON string IS
      // `Literal`'s canonical form, so every document written before the
      // widening decodes exactly as it did; the explicit `Literal` envelope
      // normalises down to it here as it does at every other text slot (§16).
      // A `text` that is neither a string nor a `$type`-tagged `TextSource` is
      // WRONG_TYPE and is never coerced — a host that read the widening as
      // "this member is now open" would put a JSON literal on the reader's
      // clipboard, and a clipboard is a channel the reader later pastes
      // somewhere with authority.
      const r = reqField(w, path, f, 'text', 'clipboard payload TextSource', decodeTextSource);
      return r.ok ? ok({ kind: 'WriteToClipboard', text: r.value }) : r;
    }
    case 'Print': {
      // Phase 1124 — the payload-free case. This is the ONE `Action` arm that is
      // strict about unrecognised members, and the asymmetry is deliberate:
      // everywhere else in this format an unknown member is one the reading host
      // has not learned yet, and dropping it is the forward-compatible answer.
      // Here there is nothing to learn, and a host that accepted
      // `{"$type":"Print","pageRange":"1-3"}` would leave the emitter believing
      // it had constrained a printing it had not, with no error anywhere saying
      // otherwise. The refusal names the offending member's own path.
      // One refusal, at the Ordinal-first extra member, as on the reference host.
      for (const key of [...f.keys()].sort()) {
        if (key !== '$type')
          return wrongType(
            `${path}.${key}`,
            'no member beside $type — Print takes no payload (WIRE_FORMAT.md §3.6.14)',
          );
      }
      return ok({ kind: 'Print' });
    }
    case 'Confirm': {
      // Phase 1537 — ask, then act. `prompt` is a `TextSource` (so the question
      // can name what the reader selected), `onConfirm` is required and
      // `onCancel` optional; an author who declares no cancel branch means
      // "nothing happens", which is what an absent action already expresses.
      //
      // THE DEPTH-ONE REFUSAL is the substance of this arm. A `Confirm`
      // reachable from either continuation is refused, and the check walks the
      // DECODED continuation rather than its immediate `$type`, so
      // `Chain [ ..., Confirm ... ]` is caught by the same line that catches a
      // bare nested one. A dialogue that answers a dialogue is a modal stack the
      // reader cannot escape.
      //
      // `WRONG_TYPE` follows the `SetState` value/valueFrom and Print-with-
      // payload precedents: a decoder POLICY refusal reuses it rather than
      // minting a code every host in the roster would owe an adoption for.
      const nestedConfirmPath = (p: string, a: Action<unknown>): string | undefined => {
        if (a.kind === 'Confirm') return p;
        if (a.kind === 'Chain') {
          for (let i = 0; i < a.actions.length; i++) {
            const found = nestedConfirmPath(`${p}.ops[${i}]`, a.actions[i]!);
            if (found !== undefined) return found;
          }
        }
        return undefined;
      };

      const prompt = reqField(w, path, f, 'prompt', 'confirm prompt TextSource', decodeTextSource);

      // `prompt`, `onConfirm` and `onCancel` are sibling members; each
      // continuation carries its own no-nested-Confirm check (§29.1).
      const continuation: Decoder<Action<unknown>> = (w2, at, aj) =>
        andThen(decodeAction(w2, at, aj), (a) => {
          const nested = nestedConfirmPath(at, a);
          return nested !== undefined
            ? wrongType(
                nested,
                'any action but Confirm — confirmation is bounded at one question (WIRE_FORMAT.md §3.6.22)',
              )
            : ok(a);
        });
      const onConfirm = reqField(
        w,
        path,
        f,
        'onConfirm',
        'Action to dispatch on acceptance',
        continuation,
      );
      const onCancel = optField(w, path, f, 'onCancel', continuation);
      if (!prompt.ok || !onConfirm.ok || !onCancel.ok) return failed(prompt, onConfirm, onCancel);
      return ok({
        kind: 'Confirm',
        prompt: prompt.value,
        onConfirm: onConfirm.value,
        ...(onCancel.value !== undefined ? { onCancel: onCancel.value } : {}),
      });
    }
    case 'Focus': {
      // Phase 1537 — a bare node id, the `CommitLocal` shape above. It addresses
      // a node in THIS document, so there is nothing for a binding to compute
      // and no `TextSource` here.
      const r = reqField(w, path, f, 'nodeId', 'NodeId string of the node to focus', requireString);
      return r.ok ? ok({ kind: 'Focus', nodeId: r.value }) : r;
    }
    case 'ReadFileBody': {
      // Phase 136 — only fileRef (the opaque id) + encoding cross the wire.
      // The decoded FileRef carries no handle (no blob on a decoded tree);
      // onRead reconstructs as a no-op closure that re-encodes to "<closure>".
      const fileId = reqField(w, path, f, 'fileRef', 'FileRef id string', requireString);
      if (!fileId.ok) return fileId;
      const enc = reqField(w, path, f, 'encoding', 'FileReadEncoding', decodeFileReadEncoding);
      return enc.ok
        ? ok({
            kind: 'ReadFileBody',
            file: { id: fileId.value },
            encoding: enc.value,
            onRead: () => CLOSURE,
          })
        : enc;
    }
    case 'Invoke': {
      // Phase 283 — capability invoked as an effect; same wire shape as Binding.Invoke.
      const cid = reqField(w, path, f, 'capabilityId', 'capability id string', requireString);
      const args = reqField(w, path, f, 'args', 'invoke args array', decodeInvokeArgs);
      if (!cid.ok || !args.ok) return failed(cid, args);
      return ok({ kind: 'Invoke', capabilityId: cid.value, args: args.value });
    }
    default:
      return unknownDuCase(
        path,
        d.value,
        'Dispatch | Call | Notify | Navigate | SetState | AiTool | Chain | CommitLocal | WriteToClipboard | Print | ReadFileBody | Invoke',
      );
  }
};

// ─── Display specs ───────────────────────────────────────────────────────────

const placeholderAction: Action<unknown> = { kind: 'Chain', actions: [] };
const onChangePlaceholder = (): Action<unknown> => placeholderAction;

// ─── Spec decoders from the IDL's field tables (Phase 2073) ───────────────────
//
// Every kind spec decoder below is ONE field table folded by `specDecoder`:
// the table is `KIND_FIELDS[kind]` from `@fuaran-ui/schema` (this host's
// projection of the corpus's `idl.json`), and the fold is the §29 defect walk
// — the object's members decoded in IDL order through `reqFieldAliased` /
// `optFieldAliased`, every failure kept and joined (`joinFailures`), an omitted
// `omitDefault` member restored to its declared default, a closure member
// present on the wire read as its placeholder. A member reads through the
// decoder its IDL type implies (`decoderFor`); what this file supplies per
// spec is BEHAVIOUR, declared once beside the kind: a member whose reading is
// not the one its type implies (a lenient alias table, a limit, a didactic
// rewrite), the decode-only field-name aliases (WIRE_FORMAT 3.6), a whole-spec
// check (`also`), and the host-only members the table does not carry
// (`after`). A member the IDL gains therefore decodes with no edit here; a
// member whose type this host has no reading of is a load-time failure naming
// it, never a silent pass-through.
//
// The override keys are typed over the kind's own member names, so an override
// for a member the IDL does not declare fails to compile.

/** How a member's IDL type is spelt in a missing-member message. */
const spellType = (t: IdlType): string => {
  switch (t.$type) {
    case 'str':
      return 'string';
    case 'int':
      return 'integer';
    case 'float':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'node':
      return 'Node';
    case 'json':
      return 'JSON value';
    case 'kind':
      return 'NodeKind';
    case 'op':
      return 'TreeOp';
    case 'list':
      return `${spellType(t.of)} array`;
    case 'map':
      return `map of ${spellType(t.values)}`;
    case 'enum':
    case 'record':
    case 'var':
      return t.name;
    case 'union':
      return t.args.length === 0 ? t.name : `${t.name}<${t.args.map(spellType).join(', ')}>`;
    case 'fn':
      return 'closure';
    case 'hosted':
      return 'JSON payload';
  }
};

/** The one spelling of an IDL type the dialect tables below are keyed by. */
const typeKey = (t: IdlType): string => {
  switch (t.$type) {
    case 'list':
      return `list<${typeKey(t.of)}>`;
    case 'map':
      return `map<${typeKey(t.values)}>`;
    case 'enum':
    case 'record':
    case 'var':
      return `${t.$type}:${t.name}`;
    case 'union':
      return t.args.length === 0
        ? `union:${t.name}`
        : `union:${t.name}<${t.args.map(typeKey).join(',')}>`;
    default:
      return t.$type;
  }
};

/**
 * This host's readers of the IDL's enums, records, unions and `Binding<…>`
 * payloads, by IDL name / argument type. Built on first use: the decoders it names are
 * declared through the rest of this module.
 */
const dialect = (() => {
  let tables:
    | {
        readonly records: Readonly<Record<string, Decoder<unknown>>>;
        readonly unions: Readonly<Record<string, Decoder<unknown>>>;
        readonly bindings: Readonly<Record<string, Decoder<unknown>>>;
        /** The enums whose reading carries lenient aliases (WIRE_FORMAT 3.6) or a didactic refusal; every other enum reads bare. */
        readonly enums: Partial<Record<EnumName, Decoder<string>>>;
      }
    | undefined;
  return () =>
    (tables ??= {
      records: {
        ColumnErased: decodeColumnErased,
        ContentHash: decodeContentHash,
        DefaultSort: decodeDefaultSort,
        DrawStyle: decodeDrawStyle,
        EffectClass: decodeEffectClass,
        FilterSpec: decodeFilterSpec,
        FormField: decodeFormField,
        GuestChannel: decodeGuestChannel,
        MetricComparison: decodeMetricComparison,
        SrcSetEntry: decodeSrcSetEntry,
        StaticRows: decodeStaticRows,
        TabHeader: decodeTabHeader,
        TrackEntry: decodeTrackEntry,
        TreeItem: decodeTreeItem,
        ViewBox: decodeViewBox,
      },
      unions: {
        Action: decodeAction,
        BoxLayout: decodeBoxLayout,
        CellFormat: decodeCellFormat,
        ChartAnnotation: decodeChartAnnotation,
        Format: decodeFormat,
        HoleDecl: decodeHoleDecl,
        MediaKind: decodeMediaKind,
        Shape: decodeShape,
        TextSource: decodeTextSource,
      },
      bindings: {
        str: decodeBindingString,
        bool: decodeBindingBool,
        float: decodeBindingFloat,
        int: decodeBindingInt,
        hosted: decodeBindingRows,
        'list<str>': decodeBindingStringList,
        'list<float>': decodeBindingFloatSeq,
        'list<record:SelectOption>': decodeBindingSelectOptions,
        'list<record:MapMarker>': decodeBindingMarkerSeq,
      },
      enums: {
        BadgeVariant: decodeBadgeVariant,
        BoxRole: decodeBoxRole,
        ButtonVariant: decodeButtonVariant,
        Emphasis: decodeEmphasis,
        HeadingVariant: decodeHeadingVariant,
        Orientation: decodeOrientation,
        StyleWeight: decodeWeight,
        ToneVariant: decodeTone,
      },
    });
})();

/** The decoder a member's IDL type implies, or `undefined` when this host has no reading of it. */
const decoderFor = (t: IdlType): Decoder<unknown> | undefined => {
  switch (t.$type) {
    case 'str':
      return requireString;
    case 'int':
      return requireInt;
    case 'float':
      return requireFloat;
    case 'bool':
      return requireBool;
    case 'node':
      return decodeNodeAst;
    case 'json':
      return decodeJVal;
    case 'list': {
      const inner = decoderFor(t.of);
      return inner === undefined ? undefined : listOf(inner);
    }
    case 'map': {
      const inner = decoderFor(t.values);
      return inner === undefined
        ? undefined
        : (w, path, j) =>
            andThen(requireObject(w, path, j), (f) =>
              traverseMembers(path, f, (p, _k, v) => inner(w, p, v)),
            );
    }
    case 'enum':
      return dialect().enums[t.name as EnumName] ?? enumOf(t.name as EnumName);
    case 'record':
      return dialect().records[t.name];
    case 'union':
      return t.name === 'Binding'
        ? t.args.length === 0
          ? decodeBinding
          : dialect().bindings[typeKey(t.args[0]!)]
        : dialect().unions[t.name];
    default:
      return undefined;
  }
};

/** What a spec declares, once, for one of its members. */
interface FieldOverride {
  /** This member's own reading, in place of the one its IDL type implies. */
  readonly dec?: Decoder<unknown>;
  /** Decode-only field-name aliases (WIRE_FORMAT 3.6); the canonical name wins when both are present. */
  readonly aliases?: readonly string[];
  /** For a closure member: what a present `"<closure>"` sentinel decodes to (an inert placeholder action by default). */
  readonly placeholder?: unknown;
}

type MemberName<K extends NodeKindName> = (typeof KIND_FIELDS)[K][number]['name'];
type Overrides<K extends NodeKindName> = Partial<Record<MemberName<K>, FieldOverride>>;

interface Member {
  readonly name: string;
  readonly opt: Optionality;
  readonly closure: boolean;
  readonly dec: Decoder<unknown>;
  readonly aliases: readonly string[];
  readonly expected: string;
  readonly dflt: (() => unknown) | undefined;
  readonly placeholder: unknown;
}

const closurePlaceholder = (): Action<unknown> => placeholderAction;

const tableMembers = (
  owner: string,
  rows: readonly FieldRow[],
  overrides: Readonly<Record<string, FieldOverride | undefined>>,
): readonly Member[] =>
  wireRows(rows).map((row) => {
    const o = overrides[row.name] ?? {};
    const closure = row.type.$type === 'fn';
    const dec = closure ? requireString : (o.dec ?? decoderFor(row.type));
    if (dec === undefined)
      throw new Error(
        `${owner}.${row.name}: no decoder reads the IDL type ${spellType(row.type)}; add an override`,
      );
    const dflt = row.dflt;
    return {
      name: row.name,
      opt: row.opt,
      closure,
      dec,
      aliases: o.aliases ?? [],
      expected: spellType(row.type),
      dflt: dflt === undefined ? undefined : () => defaultValue(dflt),
      placeholder: o.placeholder ?? closurePlaceholder,
    };
  });

/** The members of one object, each decoded at its own path, every defect kept, in table order. */
const decodeMembers = (
  w: Walk,
  path: string,
  f: Fields,
  members: readonly Member[],
  also: ((w: Walk, path: string, f: Fields) => R<unknown>) | undefined,
): R<Record<string, unknown>> => {
  const out: Record<string, unknown> = {};
  const rs: R<unknown>[] = [];
  for (const m of members) {
    if (m.closure) {
      if (fieldAliased(f, m.name, m.aliases) !== undefined) out[m.name] = m.placeholder;
      continue;
    }
    const r =
      m.opt === 'required'
        ? reqFieldAliased(w, path, f, m.name, m.aliases, m.expected, m.dec)
        : optFieldAliased(w, path, f, m.name, m.aliases, m.dec);
    rs.push(r);
    if (!r.ok) continue;
    if (r.value !== undefined) out[m.name] = r.value;
    else if (m.dflt !== undefined) out[m.name] = m.dflt();
  }
  if (also !== undefined) rs.push(also(w, path, f));
  const error = joinFailures(concatDefects, rs);
  return error === undefined ? ok(out) : fail(error);
};

/**
 * The decoder of one field table. `overrides` is the behaviour per member;
 * `also` a whole-object check joined with the members; `after` adds what the
 * table does not carry (a host-only member) or reshapes the result, once every
 * member has decoded (§29.1 rule 5).
 */
const tableDecoder = <T, S>(
  owner: string,
  rows: readonly FieldRow[],
  overrides: Readonly<Record<string, FieldOverride | undefined>>,
  after: ((value: T, w: Walk, path: string, f: Fields) => R<S>) | undefined,
  also: ((w: Walk, path: string, f: Fields) => R<unknown>) | undefined,
): Decoder<S> => {
  let members: readonly Member[] | undefined;
  return (w, path, j) => {
    const fo = requireObject(w, path, j);
    if (!fo.ok) return fo;
    members ??= tableMembers(owner, rows, overrides);
    const r = decodeMembers(w, path, fo.value, members, also);
    if (!r.ok) return r;
    const value = r.value as unknown as T;
    return after === undefined ? ok(value as unknown as S) : after(value, w, path, fo.value);
  };
};

/** The decoder of a kind's spec, from `KIND_FIELDS`. */
const specDecoder = <K extends NodeKindName, S = IdlSpec<K>>(
  kind: K,
  overrides: Overrides<K> = {},
  after?: (spec: IdlSpec<K>, w: Walk, path: string, f: Fields) => R<S>,
  also?: (w: Walk, path: string, f: Fields) => R<unknown>,
): Decoder<S> => tableDecoder(kind, KIND_FIELDS[kind], overrides, after, also);

type RecordOverrides<N extends RecordName> = Partial<
  Record<(typeof RECORD_FIELDS)[N][number]['name'], FieldOverride>
>;

/** The decoder of a record, from `RECORD_FIELDS`. */
const recordDecoder = <N extends RecordName, S = IdlRecord<N>>(
  name: N,
  overrides: RecordOverrides<N> = {},
  after?: (value: IdlRecord<N>, w: Walk, path: string, f: Fields) => R<S>,
): Decoder<S> => tableDecoder(name, RECORD_FIELDS[name], overrides, after, undefined);

/** A positive whole number, refused otherwise with `expected`. */
const positiveInt =
  (expected: string): Decoder<number> =>
  (_w, p, j) =>
    j.kind !== 'JNumber' || j.value < 1 || !Number.isInteger(j.value)
      ? wrongType(p, expected)
      : ok(j.value);

const decodeMetricSpec = specDecoder('Metric', {
  // 0.2.0 rename law: the scalar displayed value is `value` (clean break — the
  // old `source` name is NOT an accepted alias; `data` is the web prior).
  // DIDACTIC ERROR (2026-07-17): a text value here is the top observed emission
  // error — name the right kind so the structured repair channel self-corrects.
  // Mirror of F#. `mapErrors` rewrites every defect the member reports (§29.4).
  value: {
    aliases: ['data'],
    dec: (w, p, j) =>
      mapErrors(decodeBindingFloat(w, p, j), (e) =>
        e.message.includes('expected JSON number')
          ? {
              ...e,
              message:
                e.message +
                ' — Metric is numeric-only (trendable KPI); a labeled TEXT fact belongs in Fact: {"$type":"Fact","label":\u2026,"value":\u2026}',
            }
          : e,
      ),
  },
});

const decodeHeadingSpec = specDecoder('Heading');

const decodeLabelValueRowSpec = specDecoder('LabelValueRow', {
  value: { aliases: ['data'] },
  emphasis: { dec: decodeEmphasisFlag },
});

const decodeFactSpec = specDecoder('Fact', { emphasis: { dec: decodeEmphasisFlag } });

const decodeMarkdownSpec = specDecoder('Markdown');

const decodeBadgeSpec = specDecoder('Badge');

const decodeLinkSpec = specDecoder('Link');

// Phase 1080 — one `srcSet` candidate. `width` is the intrinsic pixel width of
// this rendition and MUST be a positive integer; zero and negative values are a
// WRONG_TYPE at `<path>.width`, which is what the published schema's
// `minimum: 1` says too, so the two expressions of the contract agree. Zero is
// refused as firmly as a negative and that is the interesting half: a `0w`
// descriptor is not a small image, it is a candidate a client can never select,
// so admitting it would let the wire carry a rendition no host can use.
const decodeSrcSetEntry = (w: Walk, path: string, j: JsonAst): R<SrcSetEntry> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const src = reqField(
    w,
    path,
    fo.value,
    'src',
    'srcSet entry Binding<string> src',
    decodeBindingString,
  );
  // `width` is a sibling of `src` (§29.1).
  const width = andThen(
    requireField(path, fo.value, 'width', 'positive intrinsic pixel width'),
    (wj) =>
      wj.kind !== 'JNumber' || wj.value <= 0 || !Number.isInteger(wj.value)
        ? wrongType(`${path}.width`, 'JSON number (positive integer pixel width)')
        : ok(wj.value),
  );
  if (!src.ok || !width.ok) return failed(src, width);
  return ok<SrcSetEntry>({ src: src.value, width: width.value });
};

const decodeImageSpec = specDecoder('Image');

// Phase 1076 — which media surface this is. A `$type`-DISCRIMINATED union, so
// an unknown case reports at `<path>.$type` (the `Binding` / `TextSource`
// position) rather than at the bare slot.
//
// `Audio` reads no fields and refuses none either — unknown-member tolerance is
// a decoder-wide posture, not this case's business. What matters is that there
// is no autoplay slot to read: `{"$type":"Audio","autoplay":true}` decodes to
// an audio surface that does not autoplay, because the value has nowhere to
// land.
const decodeMediaKind = (w: Walk, path: string, j: JsonAst): R<MediaKind> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Video': {
      // Omit-at-default bool, refused rather than coerced when present and
      // non-boolean — the `Image.expandable` ruling, on the slot where getting
      // it wrong starts playing a video the document says not to.
      const autoplayJ = tryField(f, 'autoplay');
      const autoplay =
        autoplayJ === undefined
          ? ok<boolean>(false)
          : requireBool(w, `${path}.autoplay`, autoplayJ);
      const poster = optField(w, path, f, 'poster', decodeBindingString);
      if (!autoplay.ok || !poster.ok) return failed(autoplay, poster);
      return ok<MediaKind>({
        $type: 'Video',
        autoplay: autoplay.value,
        ...(poster.value !== undefined ? { poster: poster.value } : {}),
      });
    }
    case 'Audio':
      return ok<MediaKind>({ $type: 'Audio' });
    default:
      return unknownDuCase(path, d.value, 'Video | Audio');
  }
};

// Phase 1076 — the media spec. `label` is REQUIRED, which is the a11y floor
// expressed where a decoder can enforce it; `controls` is the second
// omit-at-TRUE slot in the vocabulary, so an absent key is the ACCESSIBLE value
// and the document only spends a key to take the transport away.
const decodeMediaSpec = specDecoder('Media');

// Phase 1110 — one `<track>`. FOUR of the five members are required, which makes
// it the strictest record on the wire; `default` is the one omitted-at-`false`
// slot and a present member of any other type is WRONG_TYPE at the element's own
// indexed path, so a document with four tracks names the one at fault.
const decodeTrackEntry = (w: Walk, path: string, j: JsonAst): R<TrackEntry> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const kind = reqField(w, path, f, 'kind', 'TrackKind', decodeTrackKind);
  const src = reqField(w, path, f, 'src', 'track Binding<string> Src', decodeBindingString);
  // REQUIRED on every kind, where HTML makes `srclang` mandatory only on
  // subtitles: a track with no language is one nothing downstream can route, and
  // there is no value to default to that would not be an invented claim about
  // someone else's recording.
  const srcLang = reqField(w, path, f, 'srcLang', 'track srcLang string', requireString);
  const label = reqField(w, path, f, 'label', 'track label TextSource', decodeTextSource);
  const defaultJ = tryField(f, 'default');
  const dflt =
    defaultJ === undefined ? ok<boolean>(false) : requireBool(w, `${path}.default`, defaultJ);
  if (!kind.ok || !src.ok || !srcLang.ok || !label.ok || !dflt.ok)
    return failed(kind, src, srcLang, label, dflt);
  return ok({
    kind: kind.value,
    src: src.value,
    srcLang: srcLang.value,
    label: label.value,
    default: dflt.value,
  });
};

// Phase 1120 — the tree spec. The two State-slot names are ordinary optional
// strings; the hierarchy is the self-referential part.
const decodeTreeSpec = specDecoder('Tree');

// Phase 1120 — one row. `id` and `label` are required; `children` omits at the
// EMPTY LIST (so a leaf carries two keys and nothing else, which is most of a
// real hierarchy) and `icon` when absent.
//
// The nested walker is the SAME function, deliberately: the corpus's third
// reject vector sits one level DOWN precisely because a host whose child walker
// is looser than its root walker passes the other two.
const decodeTreeItem = (w: Walk, path: string, j: JsonAst): R<TreeItem> => {
  // §21.2 rule 4 — refused on the way DOWN, before the recursion that would
  // breach it, so the reported path names the row at fault.
  if (w.itemDepth >= MAX_NODE_DEPTH) {
    return limitError(
      path,
      `tree-item nesting deeper than the wire limit MAX_NODE_DEPTH = ${MAX_NODE_DEPTH}`,
      `a tree nesting items no more than ${MAX_NODE_DEPTH} levels deep`,
    );
  }
  w.itemDepth += 1;
  const r = decodeTreeItemInner(w, path, j);
  w.itemDepth -= 1;
  return r;
};

const decodeTreeItemInner = (w: Walk, path: string, j: JsonAst): R<TreeItem> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const id = reqField(w, path, f, 'id', 'TreeItem id string', requireString);
  const label = reqField(w, path, f, 'label', 'TreeItem label TextSource', decodeTextSource);
  const childrenJ = tryField(f, 'children');
  const children: R<readonly TreeItem[]> =
    childrenJ === undefined
      ? ok<readonly TreeItem[]>([])
      : (() => {
          const carr = requireArray(w, `${path}.children`, childrenJ);
          if (!carr.ok) return carr;
          return traverseIndexed(carr.value, (i, el) =>
            decodeTreeItem(w, `${path}.children[${i}]`, el),
          );
        })();
  const icon = optField(w, path, f, 'icon', requireString);
  if (!children.ok || !id.ok || !label.ok || !icon.ok) return failed(children, id, label, icon);
  return ok({
    id: id.value,
    label: label.value,
    children: children.value,
    ...(icon.value !== undefined ? { icon: icon.value } : {}),
  });
};

// Phase 1111 — the embed spec. `title` is REQUIRED, the frame a11y floor
// expressed where a decoder can enforce it; `permissions` takes the
// `ImageSpec.srcSet` missing-list class (absent is the EMPTY array, never
// `undefined` and never `null`), and here that rule carries a second meaning
// worth naming — the empty array is TOTAL DENIAL.
//
// Nothing here inspects the `src` STRING: the `embed` egress class is a
// RENDER-time obligation, as every §19-class rule is.
const decodeEmbedSpec = specDecoder('Embed');

const decodeListSpec = specDecoder('List');

const decodeToastSpec = specDecoder('Toast');

const decodeCodeBlockSpec = specDecoder('CodeBlock');

const decodeMathSpec = specDecoder('Math');

const decodeSparklineSpec = specDecoder('Sparkline', { source: { aliases: ['data'] } });

// Phase 1666 — `Skeleton.rows` is bounded by WIRE_FORMAT §21.9.
//
// `requireInt` decides FIRST, so §7.1's slot rule is untouched: a fractional,
// non-finite or out-of-32-bit value is still a `WRONG_TYPE` and never a limit
// breach. The bound then refuses a value the slot CAN hold but the format will
// not carry the work of — a renderer emits one placeholder row per count, so
// `{"rows":100000000}` names 10^8 rendered rows in a handful of bytes. The two
// codes answer different questions and the ORDER is what keeps them apart.
//
// Upper bound only, deliberately: a negative count is an authoring defect
// (FUARAN152 in the pre-emit family), not a resource breach.
const decodeSkeletonSpec = specDecoder('Skeleton', {
  rows: {
    dec: (w, p, j) =>
      andThen(requireInt(w, p, j), (rows) =>
        rows > MAX_SKELETON_ROWS
          ? makeError(
              'LIMIT_EXCEEDED',
              p,
              `skeleton rows ${rows} exceeds the maximum of ${MAX_SKELETON_ROWS} (WIRE_FORMAT 21.9)`,
              `at most ${MAX_SKELETON_ROWS} rows on one Skeleton`,
            )
          : ok(rows),
      ),
  },
});

// Phase 821 — the standalone icon-only display kind.
const decodeIconSize = enumOf('IconSize');

const decodeIconSpec = specDecoder('Icon');

const decodeCalloutSpec = specDecoder('Callout', { heading: { aliases: ['title'] } });

const decodeProgressSpec = specDecoder('Progress');

// ─── Drawing (Phase 524) ─────────────────────────────────────────────────────

const emptyDrawStyle: DrawStyle = {};

const decodeDrawPoint = (w: Walk, path: string, j: JsonAst): R<DrawPoint> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const x = reqField(w, path, fo.value, 'x', 'DrawPoint x float', requireFloat);
  const y = reqField(w, path, fo.value, 'y', 'DrawPoint y float', requireFloat);
  if (!x.ok || !y.ok) return failed(x, y);
  return ok({ x: x.value, y: y.value });
};

const decodeViewBox = (w: Walk, path: string, j: JsonAst): R<ViewBox> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const minX = reqField(w, path, f, 'minX', 'ViewBox minX float', requireFloat);
  const minY = reqField(w, path, f, 'minY', 'ViewBox minY float', requireFloat);
  const width = reqField(w, path, f, 'width', 'ViewBox width float', requireFloat);
  const height = reqField(w, path, f, 'height', 'ViewBox height float', requireFloat);
  if (!minX.ok || !minY.ok || !width.ok || !height.ok) return failed(minX, minY, width, height);
  return ok({ minX: minX.value, minY: minY.value, width: width.value, height: height.value });
};

const decodeDrawStyle = (w: Walk, path: string, j: JsonAst): R<DrawStyle> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const fill = optField(w, path, f, 'fill', decodeBindingString);
  const stroke = optField(w, path, f, 'stroke', decodeBindingString);
  const strokeWidth = optField(w, path, f, 'strokeWidth', decodeBindingFloat);
  const opacity = optField(w, path, f, 'opacity', decodeBindingFloat);
  // Text-only fields (Phase 528.1) — all optional, omitted when unset.
  const textAnchor = optField(w, path, f, 'textAnchor', decodeTextAnchor);
  const fontSize = optField(w, path, f, 'fontSize', requireFloat);
  const emphasis = optField(w, path, f, 'emphasis', decodeEmphasis);
  const fontFamily = optField(w, path, f, 'fontFamily', requireString);
  // Phase 642 — keyed mark identity; optional.
  const markId = optField(w, path, f, 'markId', requireString);
  // Phase 877 — Label text rotation in degrees; optional, no default.
  const rotation = optField(w, path, f, 'rotation', requireFloat);
  // Phase 883 — the per-mark hover readout, a full TextSource (so a `Bound`
  // envelope decodes here as well as the canonical bare-string `Literal`).
  const tip = optField(w, path, f, 'tip', decodeTextSource);
  if (
    !fill.ok ||
    !stroke.ok ||
    !strokeWidth.ok ||
    !opacity.ok ||
    !textAnchor.ok ||
    !fontSize.ok ||
    !emphasis.ok ||
    !fontFamily.ok ||
    !markId.ok ||
    !rotation.ok ||
    !tip.ok
  )
    return failed(
      fill,
      stroke,
      strokeWidth,
      opacity,
      textAnchor,
      fontSize,
      emphasis,
      fontFamily,
      markId,
      rotation,
      tip,
    );
  return ok({
    ...(fill.value !== undefined ? { fill: fill.value } : {}),
    ...(stroke.value !== undefined ? { stroke: stroke.value } : {}),
    ...(strokeWidth.value !== undefined
      ? { strokeWidth: strokeWidth.value as Binding<number> }
      : {}),
    ...(opacity.value !== undefined ? { opacity: opacity.value as Binding<number> } : {}),
    ...(textAnchor.value !== undefined ? { textAnchor: textAnchor.value } : {}),
    ...(fontSize.value !== undefined ? { fontSize: fontSize.value } : {}),
    ...(emphasis.value !== undefined ? { emphasis: emphasis.value } : {}),
    ...(fontFamily.value !== undefined ? { fontFamily: fontFamily.value } : {}),
    ...(markId.value !== undefined ? { markId: markId.value } : {}),
    ...(rotation.value !== undefined ? { rotation: rotation.value } : {}),
    ...(tip.value !== undefined ? { tip: tip.value } : {}),
  });
};

const decodeCurveCommand = (w: Walk, path: string, j: JsonAst): R<CurveCommand> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  const point = (key: string): R<DrawPoint> =>
    reqField(w, path, f, key, `DrawPoint ${key}`, decodeDrawPoint);
  switch (d.value) {
    case 'MoveTo': {
      const to = point('to');
      return to.ok ? ok({ kind: 'MoveTo', to: to.value }) : to;
    }
    case 'LineTo': {
      const to = point('to');
      return to.ok ? ok({ kind: 'LineTo', to: to.value }) : to;
    }
    case 'CubicTo': {
      const c1 = point('control1');
      const c2 = point('control2');
      const to = point('to');
      if (!c1.ok || !c2.ok || !to.ok) return failed(c1, c2, to);
      return ok({ kind: 'CubicTo', control1: c1.value, control2: c2.value, to: to.value });
    }
    case 'QuadraticTo': {
      const c = point('control');
      const to = point('to');
      if (!c.ok || !to.ok) return failed(c, to);
      return ok({ kind: 'QuadraticTo', control: c.value, to: to.value });
    }
    case 'Close':
      return ok({ kind: 'Close' });
    default:
      // Default-deny (WIRE_FORMAT §11 / Phase 524): an unknown command is a typed defect.
      return unknownDuCase(path, d.value, 'MoveTo | LineTo | CubicTo | QuadraticTo | Close');
  }
};

const decodeShape = (w: Walk, path: string, j: JsonAst): R<Shape> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  const flt = (key: string): R<number> =>
    reqField(w, path, f, key, `Shape ${key} float`, requireFloat);
  const styleField = (): R<DrawStyle> => {
    const s = optField(w, path, f, 'style', decodeDrawStyle);
    return s.ok ? ok(s.value ?? emptyDrawStyle) : s;
  };
  const pointArray = (key: string): R<readonly DrawPoint[]> => {
    const arr = reqField(w, path, f, key, `Shape ${key} DrawPoint array`, requireArray);
    if (!arr.ok) return arr;
    return traverseIndexed(arr.value, (i, el) => decodeDrawPoint(w, `${path}.${key}[${i}]`, el));
  };
  const style = styleField();
  if (!style.ok) return style;
  switch (d.value) {
    case 'Group': {
      const arr = reqField(w, path, f, 'children', 'Shape children array', requireArray);
      if (!arr.ok) return arr;
      const children = traverseIndexed(arr.value, (i, el) =>
        decodeShape(w, `${path}.children[${i}]`, el),
      );
      return children.ok
        ? ok({ kind: 'Group', children: children.value, style: style.value })
        : children;
    }
    case 'Rectangle': {
      const x = flt('x');
      const y = flt('y');
      const width = flt('width');
      const height = flt('height');
      const cornerRadius = optField(w, path, f, 'cornerRadius', requireFloat);
      if (!x.ok || !y.ok || !width.ok || !height.ok || !cornerRadius.ok)
        return failed(x, y, width, height, cornerRadius);
      return ok({
        kind: 'Rectangle',
        x: x.value,
        y: y.value,
        width: width.value,
        height: height.value,
        ...(cornerRadius.value !== undefined ? { cornerRadius: cornerRadius.value } : {}),
        style: style.value,
      });
    }
    case 'Line': {
      const x1 = flt('x1');
      const y1 = flt('y1');
      const x2 = flt('x2');
      const y2 = flt('y2');
      if (!x1.ok || !y1.ok || !x2.ok || !y2.ok) return failed(x1, y1, x2, y2);
      return ok({
        kind: 'Line',
        x1: x1.value,
        y1: y1.value,
        x2: x2.value,
        y2: y2.value,
        style: style.value,
      });
    }
    case 'Polyline': {
      const p = pointArray('points');
      return p.ok ? ok({ kind: 'Polyline', points: p.value, style: style.value }) : p;
    }
    case 'Polygon': {
      const p = pointArray('points');
      return p.ok ? ok({ kind: 'Polygon', points: p.value, style: style.value }) : p;
    }
    case 'Curve': {
      const arr = reqField(w, path, f, 'commands', 'Shape Curve commands array', requireArray);
      if (!arr.ok) return arr;
      const commands = traverseIndexed(arr.value, (i, el) =>
        decodeCurveCommand(w, `${path}.commands[${i}]`, el),
      );
      return commands.ok
        ? ok({ kind: 'Curve', commands: commands.value, style: style.value })
        : commands;
    }
    case 'Circle': {
      const cx = flt('cx');
      const cy = flt('cy');
      const r = flt('r');
      if (!cx.ok || !cy.ok || !r.ok) return failed(cx, cy, r);
      return ok({ kind: 'Circle', cx: cx.value, cy: cy.value, r: r.value, style: style.value });
    }
    case 'Ellipse': {
      const cx = flt('cx');
      const cy = flt('cy');
      const rx = flt('rx');
      const ry = flt('ry');
      if (!cx.ok || !cy.ok || !rx.ok || !ry.ok) return failed(cx, cy, rx, ry);
      return ok({
        kind: 'Ellipse',
        cx: cx.value,
        cy: cy.value,
        rx: rx.value,
        ry: ry.value,
        style: style.value,
      });
    }
    case 'Label': {
      const x = flt('x');
      const y = flt('y');
      const text = reqField(w, path, f, 'text', 'Shape Label text TextSource', decodeTextSource);
      if (!x.ok || !y.ok || !text.ok) return failed(x, y, text);
      return ok({ kind: 'Label', x: x.value, y: y.value, text: text.value, style: style.value });
    }
    default:
      // Default-deny (typed-surface guard, Phase 524): an unknown shape is a typed defect.
      return unknownDuCase(
        path,
        d.value,
        'Group | Rectangle | Line | Polyline | Polygon | Curve | Circle | Ellipse | Label',
      );
  }
};

const decodeDrawingSpec = specDecoder('Drawing');

// ─── `$type` dispatch (WIRE_FORMAT.md §3.2) ───────────────────────────────────
//
// A kind object is dispatched on its discriminator through a TABLE of arms, one
// per tag: the tag selects the arm, the arm decodes the spec, and an unknown
// tag is refused at `$type` with nothing beneath it decoded (§29.1 rule 9). Each
// family's table is keyed by exactly the kinds the IDL files under that
// category (`KINDS_BY_CATEGORY`, Phase 2329): a kind the IDL gains, moves or
// drops fails to compile here until its arm follows. The node-level routing
// below is the union of the four tables, so there is no name-set to keep in
// sync with the arms, and the one hint an unknown tag reports is the
// `WRONG_NODE_KIND` hint, projected from the same IDL rows.

/** One arm of a `$type` dispatch: the kind object, with its fields already read. */
type KindArm<T> = (w: Walk, path: string, j: JsonAst, f: Fields) => R<T>;

type KindArms<T> = Readonly<Record<string, KindArm<T>>>;

/** A family's arms: one per kind the IDL files under the category, and no other. */
type FamilyArms<C extends KindCategory, T> = {
  readonly [K in (typeof KINDS_BY_CATEGORY)[C][number]]: KindArm<T>;
};

/** The arm a tag names, or nothing — an own-key lookup, so a wire tag never reaches `Object.prototype`. */
const armFor = <T>(arms: KindArms<T>, tag: string): KindArm<T> | undefined =>
  Object.hasOwn(arms, tag) ? arms[tag] : undefined;

/** The family table lifted to the node level: every arm, its result wrapped as the category. */
const familyOf = <F, T>(arms: KindArms<F>, wrap: (k: F) => T): KindArms<T> => {
  const out: Record<string, KindArm<T>> = Object.create(null) as Record<string, KindArm<T>>;
  for (const [tag, arm] of Object.entries(arms)) {
    out[tag] = (w, path, j, f) => andThen(arm(w, path, j, f), (k) => ok(wrap(k)));
  }
  return out;
};

const DISPLAY_KINDS: FamilyArms<'Display', DisplayKind> = {
  Heading: (w, path, j) =>
    andThen(decodeHeadingSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Heading', spec })),
  Markdown: (w, path, j) =>
    andThen(decodeMarkdownSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Markdown', spec })),
  Metric: (w, path, j) =>
    andThen(decodeMetricSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Metric', spec })),
  Badge: (w, path, j) =>
    andThen(decodeBadgeSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Badge', spec })),
  Sparkline: (w, path, j) =>
    andThen(decodeSparklineSpec(w, path, j), (spec) =>
      ok<DisplayKind>({ kind: 'Sparkline', spec }),
    ),
  Callout: (w, path, j) =>
    andThen(decodeCalloutSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Callout', spec })),
  Progress: (w, path, j) =>
    andThen(decodeProgressSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Progress', spec })),
  Skeleton: (w, path, j) =>
    andThen(decodeSkeletonSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Skeleton', spec })),
  Icon: (w, path, j) =>
    andThen(decodeIconSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Icon', spec })),
  LabelValueRow: (w, path, j) =>
    andThen(decodeLabelValueRowSpec(w, path, j), (spec) =>
      ok<DisplayKind>({ kind: 'LabelValueRow', spec }),
    ),
  Fact: (w, path, j) =>
    andThen(decodeFactSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Fact', spec })),
  Link: (w, path, j) =>
    andThen(decodeLinkSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Link', spec })),
  Image: (w, path, j) =>
    andThen(decodeImageSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Image', spec })),
  Embed: (w, path, j) =>
    andThen(decodeEmbedSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Embed', spec })),
  Media: (w, path, j) =>
    andThen(decodeMediaSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Media', spec })),
  Tree: (w, path, j) =>
    andThen(decodeTreeSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Tree', spec })),
  List: (w, path, j) =>
    andThen(decodeListSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'List', spec })),
  Toast: (w, path, j) =>
    andThen(decodeToastSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Toast', spec })),
  CodeBlock: (w, path, j) =>
    andThen(decodeCodeBlockSpec(w, path, j), (spec) =>
      ok<DisplayKind>({ kind: 'CodeBlock', spec }),
    ),
  Math: (w, path, j) =>
    andThen(decodeMathSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Math', spec })),
  Drawing: (w, path, j) =>
    andThen(decodeDrawingSpec(w, path, j), (spec) => ok<DisplayKind>({ kind: 'Drawing', spec })),
};

// ─── Input specs ─────────────────────────────────────────────────────────────

/**
 * Phase 596 — the auto-bind context for a control's ABSENT `value` slot. One
 * rule across the whole control vocabulary: a filter chip auto-binds
 * `Filter(<its name>)`, a form field auto-binds `State(<its id>, <typed
 * placeholder>)` (placeholders pinned in `controlValueDefaults`); no context
 * keeps `value` required.
 */
type ControlAutoBind =
  | { readonly kind: 'filter'; readonly name: string }
  | { readonly kind: 'form'; readonly id: string }
  | undefined;

/**
 * The `expectedShape` hint on every `UNKNOWN_DU_CASE` a control discriminator
 * raises, projected from the single `FORM_FIELD_KIND_NAMES` vocabulary in
 * `@fuaran-ui/schema` rather than hand-maintained — the same discipline
 * `WRONG_NODE_KIND_HINT` follows, and for the same reason. Pinned against the
 * generated manifest `formFieldKinds` by the corpus test suite
 * (WIRE_FORMAT.md §11.2).
 */
export const WRONG_FORM_FIELD_KIND_HINT: string = FORM_FIELD_KIND_NAMES.join(' | ');

const decodeFormFieldKind = (
  w: Walk,
  autoBind: ControlAutoBind,
  path: string,
  j: JsonAst,
): R<FormFieldKind<unknown>> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  // Handlers are optional (Phase 426, the Phase 423 `filterKind` mechanics
  // generalised): a present `"<closure>"` → the inert placeholder (a decoded
  // handler never dispatches, same dead behaviour as before); an absent key →
  // omitted (exactOptionalPropertyTypes), the shape that arms the renderer's
  // write-back default.
  const onChangeField: { onChange?: () => Action<unknown> } =
    tryField(f, 'onChange') !== undefined ? { onChange: onChangePlaceholder } : {};
  // Value slot: present => typed decode; absent in a FILTER context => the
  // auto `Filter(name)` binding; absent in a Form => MISSING_FIELD as before.
  const valueOr = (
    dec: Decoder<Binding<unknown>>,
    autoDefault: unknown,
    expected: string,
  ): R<Binding<unknown>> => {
    const v = tryField(f, 'value');
    if (v !== undefined) return dec(w, `${path}.value`, v);
    if (autoBind?.kind === 'filter') return ok({ kind: 'Filter', name: autoBind.name });
    if (autoBind?.kind === 'form')
      return ok({ kind: 'State', key: autoBind.id, defaultValue: autoDefault });
    return missingField(path, 'value', expected);
  };
  switch (d.value) {
    case 'Text': {
      const v = valueOr(decodeBinding, controlValueDefaults.text, 'Text value binding');
      return v.ok ? ok({ kind: 'Text', value: v.value as Binding<string>, ...onChangeField }) : v;
    }
    case 'Number': {
      // The decoder is cast to the erased slot signature, as `Choice` and
      // `Range` below already do: `Binding<'T>` is INVARIANT in TypeScript
      // (`Local.onCommit` takes a `'T`), so a `Binding<number>`-returning
      // decoder is not assignable to a `Binding<unknown>` parameter. The cast
      // is on the way IN, and the result is re-narrowed on the way out.
      const v = valueOr(
        decodeBindingFloat as Decoder<Binding<unknown>>,
        controlValueDefaults.number,
        'Number value binding',
      );
      return v.ok ? ok({ kind: 'Number', value: v.value as Binding<number>, ...onChangeField }) : v;
    }
    case 'Checkbox': {
      const v = valueOr(decodeBinding, controlValueDefaults.checkbox, 'Checkbox value binding');
      return v.ok
        ? ok({
            kind: 'Checkbox',
            value: v.value as Binding<boolean>,
            ...onChangeField,
          })
        : v;
    }
    case 'Toggle': {
      const v = valueOr(decodeBinding, controlValueDefaults.checkbox, 'Toggle value binding');
      return v.ok
        ? ok({
            kind: 'Toggle',
            value: v.value as Binding<boolean>,
            ...onChangeField,
          })
        : v;
    }
    case 'Choice': {
      const options = reqField(
        w,
        path,
        f,
        'options',
        'Choice options binding',
        decodeBindingSelectOptions,
      );
      const value = valueOr(
        decodeBindingStringOpt as Decoder<Binding<unknown>>,
        controlValueDefaults.choice,
        'Choice value binding',
      ) as R<Binding<string | undefined>>;
      if (!options.ok || !value.ok) return failed(options, value);
      return ok({
        kind: 'Choice',
        options: options.value,
        value: value.value,
        ...onChangeField,
      });
    }
    case 'Range': {
      // 0.2.0 — dual-thumb numeric range (absorbed FilterKind.RangeFilter).
      const value = valueOr(
        decodeBindingFloatPair as Decoder<Binding<unknown>>,
        controlValueDefaults.range,
        'Binding<[number, number]> value',
      ) as R<Binding<readonly [number, number]>>;
      if (!value.ok) return value;
      return ok({ kind: 'Range', value: value.value, ...onChangeField });
    }
    case 'RangedNumber': {
      const value = valueOr(
        decodeBindingFloat as Decoder<Binding<unknown>>,
        controlValueDefaults.number,
        'RangedNumber value binding',
      );
      const min = optField(w, path, f, 'min', requireFloat);
      const max = optField(w, path, f, 'max', requireFloat);
      const step = optField(w, path, f, 'step', requireFloat);
      if (!value.ok || !min.ok || !max.ok || !step.ok) return failed(value, min, max, step);
      return ok({
        kind: 'RangedNumber',
        value: value.value as Binding<number>,
        ...onChangeField,
        constraints: {
          ...(min.value !== undefined ? { min: min.value } : {}),
          ...(max.value !== undefined ? { max: max.value } : {}),
          ...(step.value !== undefined ? { step: step.value } : {}),
        },
      });
    }
    case 'SegmentedChoice': {
      const options = reqField(
        w,
        path,
        f,
        'options',
        'SegmentedChoice options binding',
        decodeBindingSelectOptions,
      );
      // An absent segmented `orientation` restores the declared default
      // `Horizontal`; since Phase 2300 that omitted form is the canonical one
      // and the encoder omits it too. Mirror of the F# decoder.
      const orientationJ = tryField(f, 'orientation');
      const orientation =
        orientationJ === undefined
          ? ok<Orientation>('Horizontal')
          : decodeOrientation(w, `${path}.orientation`, orientationJ);
      const value = valueOr(
        decodeBindingStringOpt as Decoder<Binding<unknown>>,
        controlValueDefaults.choice,
        'SegmentedChoice value binding',
      ) as R<Binding<string | undefined>>;
      if (!orientation.ok || !options.ok || !value.ok) return failed(orientation, options, value);
      return ok({
        kind: 'SegmentedChoice',
        options: options.value,
        value: value.value,
        ...onChangeField,
        orientation: orientation.value,
      });
    }
    case 'Combobox': {
      // Phase 1113 — wire shape is `Choice`'s (same option source, same value
      // slot, same handler contract) plus `allowFreeText`, which OMITS at
      // `false`. A present member of any other type is WRONG_TYPE and is never
      // coerced: the slot decides whether values outside the option set are
      // admitted, so a lenient truthiness read would widen the field on `"no"`.
      const options = reqField(
        w,
        path,
        f,
        'options',
        'Combobox options binding',
        decodeBindingSelectOptions,
      );
      const allowFreeTextJ = tryField(f, 'allowFreeText');
      const allowFreeText =
        allowFreeTextJ === undefined
          ? ok<boolean>(false)
          : requireBool(w, `${path}.allowFreeText`, allowFreeTextJ);
      const value = valueOr(
        decodeBindingStringOpt as Decoder<Binding<unknown>>,
        controlValueDefaults.choice,
        'Combobox value binding',
      ) as R<Binding<string | undefined>>;
      if (!allowFreeText.ok || !options.ok || !value.ok)
        return failed(allowFreeText, options, value);
      return ok({
        kind: 'Combobox',
        allowFreeText: allowFreeText.value,
        options: options.value,
        value: value.value,
        ...onChangeField,
      });
    }
    case 'Tokens': {
      // Phase 1121 — `allowFreeText` omits at TRUE, the OPPOSITE polarity to
      // `Combobox`'s, and this is the one thing about the case a host is most
      // likely to get wrong. The default follows the required-ness of the set:
      // `Combobox.options` is required so "constrained" is its resting state,
      // where `suggestions` is optional so "open" is this one's.
      const allowFreeTextJ = tryField(f, 'allowFreeText');
      const allowFreeText =
        allowFreeTextJ === undefined
          ? ok<boolean>(true)
          : requireBool(w, `${path}.allowFreeText`, allowFreeTextJ);
      const suggestions = optField(w, path, f, 'suggestions', decodeBindingSelectOptions);
      // THE ONE DECODE REFUSAL, and it is a cross-member one: a closed field
      // with no suggestion source admits nothing typed and offers nothing to
      // pick, so the document names a control that CANNOT EXIST rather than one
      // with a bad value in it. Under the polarity above it is reachable only
      // deliberately, which is what makes refusing it right rather than hostile.
      const value = valueOr(
        decodeBindingStringList as Decoder<Binding<unknown>>,
        controlValueDefaults.tokens,
        'Tokens Binding<string list> value',
      ) as R<Binding<readonly string[]>>;
      if (!allowFreeText.ok || !suggestions.ok || !value.ok)
        return failed(allowFreeText, suggestions, value);
      if (!allowFreeText.value && suggestions.value === undefined)
        return wrongType(
          `${path}.allowFreeText`,
          'a suggestion source alongside allowFreeText:false — a closed token field with nothing to pick from admits no token at all (WIRE_FORMAT.md §3.6.19)',
        );
      return ok({
        kind: 'Tokens',
        allowFreeText: allowFreeText.value,
        value: value.value,
        ...(suggestions.value !== undefined ? { suggestions: suggestions.value } : {}),
        ...onChangeField,
      });
    }
    case 'Rating': {
      // Phase 1130 — `max` is the case's only REQUIRED member: it is the scale,
      // and a rating with no declared ceiling is not a scale. A `max` below 1 is
      // REFUSED, not clamped — a scale with no positions has nothing to draw,
      // nothing to announce and no keystroke that could change anything, so the
      // document names a control that cannot exist.
      const max = andThen(requireField(path, f, 'max', 'Rating max integer of 1 or more'), (mj) =>
        mj.kind !== 'JNumber' || mj.value < 1 || !Number.isInteger(mj.value)
          ? wrongType(`${path}.max`, 'JSON number (an integer scale of 1 or more)')
          : ok(mj.value),
      );
      // Omits at `false`, and the polarity is load-bearing: the SHORTEST rating
      // document is the whole-star one. It governs ENTRY, never DISPLAY.
      const allowHalfJ = tryField(f, 'allowHalf');
      const allowHalf =
        allowHalfJ === undefined
          ? ok<boolean>(false)
          : requireBool(w, `${path}.allowHalf`, allowHalfJ);
      // A FLOAT even where nothing can type a fraction: the commonest rating a
      // reader sees is an AVERAGE arriving through a Query binding. The VALUE's
      // bounds are deliberately NOT checked here — a bound value is invisible to
      // a decoder, and a rule enforced only on literals would be two rules
      // wearing one name.
      const value = valueOr(
        decodeBindingFloat as Decoder<Binding<unknown>>,
        controlValueDefaults.number,
        'Rating value binding',
      ) as R<Binding<number>>;
      if (!max.ok || !allowHalf.ok || !value.ok) return failed(max, allowHalf, value);
      return ok({
        kind: 'Rating',
        max: max.value,
        allowHalf: allowHalf.value,
        value: value.value,
        ...onChangeField,
      });
    }
    case 'Color': {
      // Phase 1130 — `#rrggbb` and nothing else, because that is the one form a
      // native colour input can hold or return. Only the `Static` case is judged
      // here, and the split is recorded rather than hidden: a State / Query /
      // Selection binding carries its text from outside the document, where a
      // decoder cannot see it. CASE IS PRESERVED, never normalised — a codec
      // that lower-cased it would fail the round-trip this corpus exists to pin.
      const value = valueOr(
        decodeBinding as Decoder<Binding<unknown>>,
        controlValueDefaults.color,
        'Color value binding',
      ) as R<Binding<string>>;
      if (!value.ok) return value;
      const bound = value.value as { kind: string; value?: unknown };
      if (
        bound.kind === 'Static' &&
        !(typeof bound.value === 'string' && /^#[0-9a-fA-F]{6}$/.test(bound.value))
      )
        return wrongType(
          `${path}.value`,
          'a #rrggbb colour literal — six hexadecimal digits after a #, the one form a native colour input can hold (WIRE_FORMAT.md §3.6.17)',
        );
      return ok({ kind: 'Color', value: value.value, ...onChangeField });
    }
    case 'TextArea': {
      const rows = reqField(w, path, f, 'rows', 'textarea row count integer', requireInt);
      const value = valueOr(decodeBinding, controlValueDefaults.text, 'TextArea value binding');
      if (!rows.ok || !value.ok) return failed(rows, value);
      return ok({
        kind: 'TextArea',
        value: value.value as Binding<string>,
        ...onChangeField,
        rows: rows.value,
      });
    }
    // Phase 1811 — `DateTime` is canonical. `Date` is the pre-rename spelling, kept as a §16
    // lenient alias by the reference host's D8 ruling; `Time` is the invented spelling the rename
    // exists to make findable — a `DateTime{variant:"Time"}` an emitter reached for by intent, so
    // the alias SUPPLIES the variant when absent and REFUSES a disagreeing one beside it. All
    // three re-encode canonical.
    case 'DateTime':
    case 'Date':
    case 'Time': {
      const value = valueOr(decodeBinding, controlValueDefaults.dateTime, 'DateTime value binding');
      const variant = decodeTemporalVariant(w, path, f, d.value, 'Time');
      const min = optField(w, path, f, 'min', requireString);
      const max = optField(w, path, f, 'max', requireString);
      const step = optField(w, path, f, 'step', requireFloat);
      if (!value.ok || !variant.ok || !min.ok || !max.ok || !step.ok)
        return failed(value, variant, min, max, step);
      return ok({
        kind: 'DateTime',
        value: value.value as Binding<string>,
        ...onChangeField,
        variant: variant.value,
        constraints: {
          ...(min.value !== undefined ? { min: min.value } : {}),
          ...(max.value !== undefined ? { max: max.value } : {}),
          ...(step.value !== undefined ? { step: step.value } : {}),
        },
      });
    }
    // Phase 1811 — `DateTimeRange` is canonical; `DateRange` (pre-rename) and `TimeRange`
    // (invented, fixes `variant` to `Time`) are its §16 lenient aliases on the `DateTime` rule.
    case 'DateTimeRange':
    case 'DateRange':
    case 'TimeRange': {
      // Phase 725 — single-control date range: `Range`'s pair mechanics with
      // `DateTime`'s value conventions. `min` / `max` / `step` are flat (they bound
      // BOTH ends), same omit-when-absent discipline as `DateTime`.
      const value = valueOr(
        decodeBindingStringPair as Decoder<Binding<unknown>>,
        controlValueDefaults.dateTimeRange,
        'Binding<[from, to]> ISO-8601 pair value',
      ) as R<Binding<readonly [string, string]>>;
      const variant = decodeTemporalVariant(w, path, f, d.value, 'TimeRange');
      const min = optField(w, path, f, 'min', requireString);
      const max = optField(w, path, f, 'max', requireString);
      const step = optField(w, path, f, 'step', requireFloat);
      if (!value.ok || !variant.ok || !min.ok || !max.ok || !step.ok)
        return failed(value, variant, min, max, step);
      return ok({
        kind: 'DateTimeRange',
        value: value.value,
        ...onChangeField,
        variant: variant.value,
        constraints: {
          ...(min.value !== undefined ? { min: min.value } : {}),
          ...(max.value !== undefined ? { max: max.value } : {}),
          ...(step.value !== undefined ? { step: step.value } : {}),
        },
      });
    }
    default:
      return unknownDuCase(path, d.value, WRONG_FORM_FIELD_KIND_HINT);
  }
};

// ─── Phase 864 — the declared per-field constraint ───────────────────────────
//
// `FormFieldKind` names the CONTROL; `FormField.rule` names the ACCEPTED SET.
// Everything here is the POLICY layer above the structural shape: the enum
// didactics, the two well-formedness refusals, and the near-miss set.
// Parity-locked with the F# `decodeFieldRule` / `formFieldNearMisses`.

const TEXT_FORMATS = ['email', 'url', 'tel'] as const;
const COMPARE_OPS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'] as const;

const decodeTextFormat = (w: Walk, path: string, j: JsonAst): R<TextFormat> =>
  bareEnum(path, j, TEXT_FORMATS, 'TextFormat');

const decodeCompareOp = (w: Walk, path: string, j: JsonAst): R<CompareOp> =>
  bareEnum(path, j, COMPARE_OPS, 'CompareOp');

/**
 * The cross-field operand. `against` is a `Binding` — that is the entire
 * cross-field mechanism rather than an accident of typing: any read slot may
 * take a Binding, and the auto-bind rule already puts every form field's value
 * in State under the field's own id, so `{"$type":"State","key":"<sibling id>"}`
 * reads the sibling with no coordination vocabulary at all.
 */
const decodeCompareRule = (w: Walk, path: string, j: JsonAst): R<CompareRule> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const op = reqField(w, path, f, 'op', 'CompareOp', decodeCompareOp);
  const against = reqField(w, path, f, 'against', 'Binding', (w2, p, v) => decodeBinding(w2, p, v));
  if (!op.ok || !against.ok) return failed(op, against);
  return ok({ op: op.value, against: against.value });
};

/**
 * A field's declared constraint. Every slot is optional structurally, and two
 * shapes are refused here as POLICY:
 *
 *  - a rule with every slot absent. A rule that constrains nothing is a defect,
 *    not a no-op: it decodes, validates and renders while declaring nothing,
 *    which is the fake-affordance shape the near-miss rule also forecloses,
 *    arriving through an empty object instead of a wrong key. `message` alone
 *    does not rescue it — the message is the prose shown when some OTHER slot
 *    is unmet, so a message-only rule is the help-text failure wearing the new
 *    vocabulary's clothes.
 *  - `minLength` above `maxLength`. The `DateTimeRange` ordered-pair rule applied to
 *    a length pair: an inverted bound admits no value at all, so the field can
 *    never be submitted and the form is dead on arrival.
 *
 * Neither is a shape — both are relations BETWEEN slots — which is why they
 * live here beside the `from <= to` check rather than in the structural layer.
 */
const decodeFieldRule = (w: Walk, path: string, j: JsonAst): R<FieldRule> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const format = optField(w, path, f, 'format', decodeTextFormat);
  const pattern = optField(w, path, f, 'pattern', requireString);
  const minLength = optField(w, path, f, 'minLength', requireInt);
  const maxLength = optField(w, path, f, 'maxLength', requireInt);
  const compare = optField(w, path, f, 'compare', decodeCompareRule);
  const message = optField(w, path, f, 'message', decodeTextSource);
  if (!format.ok || !pattern.ok || !minLength.ok || !maxLength.ok || !compare.ok || !message.ok)
    return failed(format, pattern, minLength, maxLength, compare, message);

  const constrains =
    format.value !== undefined ||
    pattern.value !== undefined ||
    minLength.value !== undefined ||
    maxLength.value !== undefined ||
    compare.value !== undefined;
  if (!constrains)
    return makeError(
      'WRONG_TYPE',
      path,
      "a rule that constrains nothing is a defect, not a no-op — declare at least one of format / pattern / minLength / maxLength / compare, or omit 'rule' entirely",
      'FieldRule with at least one constraint slot',
    );

  if (
    minLength.value !== undefined &&
    maxLength.value !== undefined &&
    minLength.value > maxLength.value
  )
    return makeError(
      'WRONG_TYPE',
      path,
      `minLength ${minLength.value} is above maxLength ${maxLength.value} — an inverted length bound admits no value at all, so the field could never be submitted`,
      'minLength <= maxLength',
    );

  return ok({
    ...(format.value !== undefined ? { format: format.value } : {}),
    ...(pattern.value !== undefined ? { pattern: pattern.value } : {}),
    ...(minLength.value !== undefined ? { minLength: minLength.value } : {}),
    ...(maxLength.value !== undefined ? { maxLength: maxLength.value } : {}),
    ...(compare.value !== undefined ? { compare: compare.value } : {}),
    ...(message.value !== undefined ? { message: message.value } : {}),
  });
};

// The `FormField` near-miss set (Phase 863's discipline applied to the rule
// slot). Small and enumerated for the same reason the grid's is: rule 2's
// tolerance of unknown keys is right for a field a future profile may add and
// wrong for a near miss of one that exists, because the tree then decodes and
// renders while the constraint does nothing. That silence is worse here than
// anywhere else in the vocabulary — the failure this phase exists to fix is
// authors putting the rule in help text, and a guessed key that no-ops is a
// direct route back to it.
const FORM_FIELD_NEAR_MISSES = [
  ['validation', 'rule'],
  ['constraints', 'rule'],
  ['validate', 'rule'],
] as const;

const checkFormFieldNearMisses = (w: Walk, path: string, f: Fields): R<void> => {
  // Every near miss present is its own defect (WIRE_FORMAT §29.1).
  let first: R<void> | undefined;
  for (const [name, canonical] of FORM_FIELD_NEAR_MISSES) {
    if (tryField(f, name) !== undefined) {
      const r = makeError(
        'WRONG_TYPE',
        `${path}.${name}`,
        `'${name}' is not part of the form vocabulary — it would be ignored, not honoured, and the field would accept anything`,
        canonical,
      );
      first ??= r;
    }
  }
  return first ?? ok(undefined);
};

const decodeFormField = (w: Walk, path: string, j: JsonAst): R<FormField<unknown>> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const id = reqFieldAliased(w, path, f, 'id', ['name'], 'form field id string', requireString);
  // Phase 596 — the kind is decoded IN THE CONTEXT of the id (its auto-bind
  // reads it; the chip-name-first precedent from the filters unification): only
  // under a good id, as on the reference host, and its presence is checked
  // whatever the id holds (WIRE_FORMAT §29.1 rule 6).
  const kind = underSibling(
    w,
    path,
    f,
    'kind',
    'FormFieldKind',
    id,
    (fieldId) => (w2, p, v) => decodeFormFieldKind(w2, { kind: 'form', id: fieldId }, p, v),
  );
  const label = reqField(w, path, f, 'label', 'field label TextSource', decodeTextSource);
  // Phase 2300 — `required` is omitted at its declared default `false`.
  const required = andThen(optField(w, path, f, 'required', requireBool), (v) => ok(v ?? false));
  const help = optField(w, path, f, 'help', decodeTextSource);
  // Phase 864 — the near-miss check runs BEFORE the rule decode, so a field
  // carrying both `validation` and a well-formed `rule` still names the ignored
  // key rather than passing silently.
  const nm = checkFormFieldNearMisses(w, path, f);
  const rule = optField(w, path, f, 'rule', decodeFieldRule);
  if (!kind.ok || !id.ok || !label.ok || !required.ok || !help.ok || !nm.ok || !rule.ok)
    return failed(kind, id, label, required, help, nm, rule);
  return ok({
    id: id.value,
    kind: kind.value,
    label: label.value,
    required: required.value,
    ...(help.value !== undefined ? { help: help.value } : {}),
    ...(rule.value !== undefined ? { rule: rule.value } : {}),
  });
};

const decodeFormSpec = specDecoder('Form');

const decodeFilterSpec = (w: Walk, path: string, j: JsonAst): R<FilterSpec<unknown>> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  // 0.2.0 filters-unification: the chip's control is an ordinary
  // FormFieldKind; its absent `value` auto-binds `Filter(name)` (see
  // decodeFormFieldKind). Name decodes first so the synthesis can use it.
  const name = reqField(w, path, f, 'name', 'filter name string', requireString);
  const label = reqField(w, path, f, 'label', 'filter label TextSource', decodeTextSource);
  // Decoded in the context of the name (the auto-bind reads it): in a defect
  // walk, only under a good name; its presence is checked regardless (§29.1).
  const kind = underSibling(
    w,
    path,
    f,
    'kind',
    'FormFieldKind control',
    name,
    (n) => (w2, p, v) => decodeFormFieldKind(w2, { kind: 'filter', name: n }, p, v),
  );
  if (!name.ok || !label.ok || !kind.ok) return failed(name, label, kind);
  return ok({ name: name.value, label: label.value, field: kind.value });
};

const decodeButtonSpec = specDecoder('Button');

const decodeSelectSpec = specDecoder<'Select', SelectSpec<unknown>>(
  'Select',
  {
    source: { aliases: ['options', 'data'] },
    // An unselected control is a `Static` binding carrying no value (Phase 677).
    value: { dec: decodeBindingStringOpt },
    // Phase 426: a present `"<closure>"` sentinel → the inert placeholder; an
    // absent key → omitted, arming the renderer's write-back default against
    // `value` / `values`.
    onChange: { placeholder: onChangePlaceholder },
    onChangeMulti: { placeholder: onChangePlaceholder },
  },
  // Phase 1962 — the `value` rule (WIRE_FORMAT §3.2), a relation between two
  // sibling keys the per-field table cannot state (the IDL marks `value`
  // optional): a single-select (`multiple` absent or `false`) REQUIRES `value`
  // — `MISSING_FIELD` at `<select>.value`; a multi-select carries `values` and
  // no `value`, so a `value` beside `"multiple":true` — the empty-`Static`
  // placeholder every pre-1962 document carried, or a binding a stored document
  // wrote there — is decoded by the table (a MALFORMED one still refuses as any
  // malformed binding does) and then DROPPED, a §16 lenient accept normalised to
  // absent. A malformed `multiple` is its own defect, reported by the table, so
  // the presence rule is not layered over it.
  (spec, w, path, f) => {
    if (spec.multiple === true) {
      if (spec.value === undefined) return ok(spec as SelectSpec<unknown>);
      const { value, ...clean } = spec;
      void value;
      return ok(clean as SelectSpec<unknown>);
    }
    const multipleKnown =
      tryField(f, 'multiple') === undefined || typeof spec.multiple === 'boolean';
    if (spec.value === undefined && multipleKnown) {
      const missing = reqField(w, path, f, 'value', 'Select value binding', decodeBindingStringOpt);
      if (!missing.ok) return missing;
    }
    return ok(spec as SelectSpec<unknown>);
  },
);

const decodeFileUploadSpec = specDecoder('FileUpload', {
  destination: {
    dec: (w, p, j) =>
      andThen(requireString(w, p, j), (id) =>
        id === '' ? wrongType(p, 'a non-empty host-registered destination id') : ok(id),
      ),
  },
  maxBytes: { dec: positiveInt('a positive integer ceiling') },
  maxFiles: { dec: positiveInt('a positive integer ceiling') },
  // Phase 1962 — `onSelect` is the optional closure slot the IDL declares: a
  // present `"<closure>"` sentinel decodes to the inert placeholder and an
  // absent key stays absent (a declarative upload carries no handler).
  onSelect: { placeholder: closurePlaceholder },
});

const INPUT_KINDS: FamilyArms<'Input', InputKind<unknown>> = {
  Form: (w, path, j) =>
    andThen(decodeFormSpec(w, path, j), (spec) => ok<InputKind<unknown>>({ kind: 'Form', spec })),
  Filters: (w, path, _j, f) =>
    andThen(reqField(w, path, f, 'items', 'Filters item list', listOf(decodeFilterSpec)), (specs) =>
      ok<InputKind<unknown>>({ kind: 'Filters', specs }),
    ),
  Button: (w, path, j) =>
    andThen(decodeButtonSpec(w, path, j), (spec) =>
      ok<InputKind<unknown>>({ kind: 'Button', spec }),
    ),
  FileUpload: (w, path, j) =>
    andThen(decodeFileUploadSpec(w, path, j), (spec) =>
      ok<InputKind<unknown>>({ kind: 'FileUpload', spec }),
    ),
  Select: (w, path, j) =>
    andThen(decodeSelectSpec(w, path, j), (spec) =>
      ok<InputKind<unknown>>({ kind: 'Select', spec }),
    ),
};

// ─── Visualisation specs ─────────────────────────────────────────────────────

/**
 * Phase 750 — a `TonedPill`'s `map`: a string-keyed object whose VALUES are
 * `ToneVariant`s. Routed through `decodeTone` per entry, so the §3.6 tone aliases work
 * inside the map exactly as at a `tone` field. The refusal is RE-ISSUED rather than
 * passed through: `decodeTone` reports at `<path>.$type` with "unknown discriminator",
 * and a map value is neither, so the raw error names a path the document does not
 * contain. Parity-locked with the F# `decodeToneMap`.
 */
const decodeToneMap = (w: Walk, path: string, j: JsonAst): R<Record<string, ToneVariant>> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  return traverseMembers(path, fo.value, (entryPath, k, v) => {
    const got = v.kind === 'JString' ? v.value : '';
    return mapErrors(decodeTone(w, entryPath, v), (e) =>
      e.code === 'UNKNOWN_DU_CASE' && e.path === entryPath
        ? {
            code: 'UNKNOWN_DU_CASE',
            path: entryPath,
            message: `tone-map value '${got}' for '${k}' is not a ToneVariant`,
            expectedShape: TONE_NAMES.join(' | '),
          }
        : e,
    );
  });
};

/** The tone-map field names a `TonedPill` cell accepts (canonical first). */
const TONE_MAP_KEYS = ['map', 'toneMap', 'tones'] as const;

/**
 * The shared body of the canonical `TonedPill` case and the `Pill`-tagged §16 shorthand
 * — one reader, so the two spellings cannot drift apart in what they accept.
 */
const decodeTonedPill = (w: Walk, path: string, f: Fields): R<CellKindErased<unknown>> => {
  const field = reqField(
    w,
    path,
    f,
    'field',
    'TonedPill row-field name (drives the label and the map key)',
    requireString,
  );
  // Field aliases: `toneMap` / `tones` — `map` is the shortest honest name for a
  // value→tone dictionary and the least descriptive one.
  const map = reqFieldAliased(
    w,
    path,
    f,
    'map',
    ['toneMap', 'tones'],
    'TonedPill value→ToneVariant map',
    decodeToneMap,
  );
  // `default` is omitted-when-`Default` (Phase 460); restore the identity on absence.
  const defaultTone = optField(w, path, f, 'default', decodeTone);
  if (!field.ok || !map.ok || !defaultTone.ok) return failed(field, map, defaultTone);
  const k: CellKindErased<unknown> = {
    kind: 'TonedPill',
    field: field.value,
    map: map.value,
    defaultTone: defaultTone.value ?? 'Default',
  };
  return ok(k);
};

const decodeCellKindErased = (
  w: Walk,
  path: string,
  j: JsonAst,
  columnField?: string,
): R<CellKindErased<unknown>> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Text':
      return ok({ kind: 'Text' });
    case 'Numeric':
      return ok({ kind: 'Numeric' });
    case 'Date':
      return ok({ kind: 'Date' });
    case 'Editable':
      return ok({ kind: 'Editable', onEdit: () => placeholderAction });
    case 'Checkbox':
      return ok({ kind: 'Checkbox', get: () => false, onToggle: () => placeholderAction });
    case 'Button': {
      const label = reqField(w, path, f, 'label', 'cell button label TextSource', decodeTextSource);
      return label.ok
        ? ok({ kind: 'Button', label: label.value, onClick: () => placeholderAction })
        : label;
    }
    case 'ButtonGroup': {
      type Btn = readonly [TextSource, (row: unknown) => Action<unknown>];
      const buttons = reqField(
        w,
        path,
        f,
        'buttons',
        'button group list',
        listOf((w2, bp, item): R<Btn> => {
          const bo = requireObject(w2, bp, item);
          if (!bo.ok) return bo;
          const label = reqField(
            w2,
            bp,
            bo.value,
            'label',
            'button label TextSource',
            decodeTextSource,
          );
          return label.ok ? ok<Btn>([label.value, () => placeholderAction]) : label;
        }),
      );
      if (!buttons.ok) return buttons;
      const k: CellKindErased<unknown> = { kind: 'ButtonGroup', buttons: buttons.value };
      return ok(k);
    }
    case 'Link': {
      const k: CellKindErased<unknown> = {
        kind: 'Link',
        href: () => CLOSURE,
        label: () => ({ kind: 'Literal', value: CLOSURE }),
      };
      return ok(k);
    }
    case 'Pill': {
      // Lenient-ingest (WIRE_FORMAT.md §16, Phase 750): `Pill` is the WORD for the
      // thing, so a declarative tone rule arrives tagged `Pill` more often than tagged
      // `TonedPill`. Before this phase those keys were accepted and DISCARDED — the
      // author's whole intent gone, silently, with no error to notice. Presence of a
      // tone map is the unambiguous tell (a closure `Pill` has no such key).
      if (TONE_MAP_KEYS.some((key) => tryField(f, key) !== undefined))
        return decodeTonedPill(w, path, f);
      const k: CellKindErased<unknown> = {
        kind: 'Pill',
        label: () => ({ kind: 'Literal', value: CLOSURE }),
        tone: () => 'Default',
      };
      return ok(k);
    }
    case 'TonedPill':
      return decodeTonedPill(w, path, f);
    case 'Progress': {
      // Phase 425 / cat:Fuaran.UI.ProgressFieldCell (2026-08-10) — the field-driven
      // fraction, parity with the .NET decoder. A decoded `Progress` cell in a
      // `field`-carrying column derives its per-row fill from that row property
      // (clamped to 0..1; missing / non-numeric → 0, never a throw), ending the
      // silent zero-fill class. No new wire key — the driver is the column-level
      // `field`; a columnless or fieldless `Progress` keeps the inert placeholder.
      const field = columnField;
      const k: CellKindErased<unknown> = {
        kind: 'Progress',
        fraction:
          field === undefined
            ? () => 0
            : (row) => {
                const v =
                  row !== null && typeof row === 'object'
                    ? (row as Record<string, unknown>)[field]
                    : undefined;
                const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
                return Math.max(0, Math.min(1, n));
              },
      };
      return ok(k);
    }
    case 'Custom': {
      const k: CellKindErased<unknown> = {
        kind: 'Custom',
        render: () => placeholderClosureNode,
      };
      return ok(k);
    }
    default:
      return unknownDuCase(
        path,
        d.value,
        'Text | Numeric | Date | Editable | Checkbox | Button | ButtonGroup | Link | Pill | TonedPill | Progress | Custom',
      );
  }
};

// Phase 863 — decode-time didactics for the grid-behaviour family's NEAR
// MISSES (Phase 860's charter, its rejected-spellings deliverable).
//
// Every shape below decoded SILENTLY before: rule 2 tolerates unknown keys, so
// a model that reached for the wrong name got a tree that decoded, validated
// and rendered while the declaration did nothing — the fake-affordance failure
// in a new guise, and tolerance is what hid it. The narrowing is an ENUMERATED
// set with an unambiguous canonical form each; rule 2 holds for everything
// else. Parity-locked with F# `nearMiss` / `checkNearMisses`, and mirrored in
// the published schema as `not: { required: [...] }`.
const nearMiss = (path: string, found: string, canonical: string): R<never> =>
  makeError(
    'WRONG_TYPE',
    `${path}.${found}`,
    `'${found}' is not part of the grid vocabulary — it would be ignored, not honoured`,
    canonical,
  );

const checkNearMisses = (
  w: Walk,
  path: string,
  f: Fields,
  candidates: readonly (readonly [string, string])[],
): R<void> => {
  // Every near miss present is its own defect (WIRE_FORMAT §29.1: each stray
  // member is a sibling of the others), so each is constructed; the first is
  // returned.
  let first: R<void> | undefined;
  for (const [name, canonical] of candidates) {
    if (tryField(f, name) !== undefined) {
      const r = nearMiss(path, name, canonical);
      first ??= r;
    }
  }
  return first ?? ok(undefined);
};

const COLUMN_NEAR_MISSES = [
  // Named by the census row itself. Deliberately NOT aliased to
  // `editable: false`: an inverting alias that guesses wrong makes a read-only
  // column editable.
  ['readOnly', "editable: false — the column flag NARROWS the grid's editable capability"],
] as const;

const GRID_NEAR_MISSES = [
  // The sharpest of them: a LITERAL page number is not expressible at all,
  // because the position lives in State so a control can move it. Ignoring it
  // is what produced the ×11 fake-affordance cluster.
  [
    'currentPage',
    'pageStateKey — the page POSITION lives in State as {"page": N} so the pager can move it; a literal page number is not expressible',
  ],
  [
    'page',
    'pageStateKey — the page POSITION lives in State as {"page": N} so the pager can move it; a literal page number is not expressible',
  ],
  [
    'pageIndex',
    'pageStateKey — the page POSITION lives in State as {"page": N}, 1-based (not a zero-based index)',
  ],
  [
    'sortable',
    'sortStateKey on the grid + sortable on each COLUMN — grid-wide sortable is the staticRows spelling; a data-bound grid narrows per column',
  ],
  [
    'onEdit',
    'editStateKey — the edit DESTINATION is a State key on the grid; onEdit is a per-cell host closure and carries no destination across the wire',
  ],
  [
    'behaviour',
    'sibling fields on the grid (sortStateKey / pageStateKey / pageSize / editStateKey / defaultSort) — grid behaviour is not a nested record',
  ],
  [
    'behavior',
    'sibling fields on the grid (sortStateKey / pageStateKey / pageSize / editStateKey / defaultSort) — grid behaviour is not a nested record',
  ],
] as const;

const decodeColumnErased = (w: Walk, path: string, j: JsonAst): R<ColumnErased<unknown>> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  // Phase 460 — `format`/`width` omitted-when-default (`CellFormat.None`/`ColumnWidth.Auto`).
  const format = optField(w, path, f, 'format', decodeCellFormat);
  // The column-level `field` rides into the kind decode so field-driven cell kinds
  // (Phase 425 / cat:Fuaran.UI.ProgressFieldCell — `Progress` first) can synthesize
  // their row projection at decode time.
  // The kind is decoded in the context of `field` (§29.1 rule 6).
  const field = optField(w, path, f, 'field', requireString);
  const kind = underSibling(
    w,
    path,
    f,
    'kind',
    'CellKindErased',
    field,
    (fieldName) => (w2, p, v) => decodeCellKindErased(w2, p, v, fieldName),
    ['type'],
  );
  const label = reqFieldAliased(
    w,
    path,
    f,
    'label',
    ['header', 'title'],
    'column label string',
    requireString,
  );
  const width = optField(w, path, f, 'width', decodeColumnWidth);
  // Phase 425 — `value` (closure) present → placeholder (the closure wins, renders Empty); absent →
  // omitted, and `field` (if present, extracted above) drives the row-field projection
  // with zero host code.
  const hasValue = tryField(f, 'value') !== undefined;
  const colNearMiss = checkNearMisses(w, path, f, COLUMN_NEAR_MISSES);
  // Phase 863 — per-column editability narrowing; absent inherits the
  // grid-level flag.
  const colEditable = optField(w, path, f, 'editable', requireBool);
  // Phase 861 — per-column sort narrowing; absent inherits.
  const sortable = optField(w, path, f, 'sortable', requireBool);
  if (
    !format.ok ||
    !field.ok ||
    !kind.ok ||
    !label.ok ||
    !width.ok ||
    !colNearMiss.ok ||
    !colEditable.ok ||
    !sortable.ok
  )
    return failed(format, field, kind, label, width, colNearMiss, colEditable, sortable);
  return ok({
    format: format.value ?? { kind: 'None' },
    kind: kind.value,
    label: label.value,
    width: width.value ?? { kind: 'Auto' },
    ...(hasValue ? { value: () => ({ kind: 'Empty' as const }) } : {}),
    ...(field.value !== undefined ? { field: field.value } : {}),
    ...(sortable.value !== undefined ? { sortable: sortable.value } : {}),
    ...(colEditable.value !== undefined ? { editable: colEditable.value } : {}),
  });
};

// Phase 393 — decode the `{ headers, rows }` static-rows object of a read-only grid
// (also the shape the legacy `Table` decode-upgrade reads). Cells are `TextSource`.
type StaticRows = {
  readonly headers: readonly TextSource[];
  readonly rows: readonly (readonly TextSource[])[];
  readonly sortable?: boolean;
  readonly defaultSort?: DefaultSort;
};

// Phase 801 — `"asc"` / `"desc"`, closed. Anything else is UNKNOWN_DU_CASE naming both
// legal values, never a silent fallback to ascending: an unrecognised direction is an
// emitter defect the author can fix, and quietly picking one hides it.
const decodeSortDirection = enumOf('SortDirection');

// Phase 801 — the `{ column, direction }` initial-order declaration. `column` is a
// NON-NEGATIVE integer index into `headers`; a negative (or non-integral) value is a
// WRONG_TYPE, which is also what schema.json's `minimum: 0` says. An index PAST the end
// of `headers` is deliberately accepted — a relation between sibling values is not
// something a per-object codec judges.
const decodeDefaultSort = (w: Walk, path: string, j: JsonAst): R<DefaultSort> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  // `column` and `direction` are sibling members (§29.1).
  const column = andThen(requireField(path, f, 'column', 'non-negative header index'), (cv) =>
    cv.kind !== 'JNumber' || cv.value < 0 || !Number.isInteger(cv.value)
      ? wrongType(`${path}.column`, 'JSON number (non-negative integer header index)')
      : ok(cv.value),
  );
  const direction = reqField(w, path, f, 'direction', 'asc | desc', decodeSortDirection);
  if (!column.ok || !direction.ok) return failed(column, direction);
  return ok({ column: column.value, direction: direction.value });
};
const decodeStaticRows = (w: Walk, path: string, j: JsonAst): R<StaticRows> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const headers = reqField(
    w,
    path,
    f,
    'headers',
    'headers TextSource list',
    listOf(decodeTextSource),
  );
  const rows = reqField(
    w,
    path,
    f,
    'rows',
    'rows TextSource matrix',
    listOf((w2, rp, rowJ) =>
      andThen(requireArray(w2, rp, rowJ), (cells) =>
        traverseIndexed(cells, (k, cell) => decodeTextSource(w2, `${rp}[${k}]`, cell)),
      ),
    ),
  );
  const sortable = optField(w, path, f, 'sortable', requireBool);
  const defaultSort = optField(w, path, f, 'defaultSort', decodeDefaultSort);
  if (!headers.ok || !rows.ok || !sortable.ok || !defaultSort.ok)
    return failed(headers, rows, sortable, defaultSort);
  return ok({
    headers: headers.value,
    rows: rows.value,
    ...(sortable.value !== undefined ? { sortable: sortable.value } : {}),
    ...(defaultSort.value !== undefined ? { defaultSort: defaultSort.value } : {}),
  });
};

const decodeGridSpec = specDecoder(
  'DataGrid',
  {
    source: { aliases: ['data', 'rows'] },
    pageSize: { dec: positiveInt('JSON number (integer page size of 1 or more)') },
    rowKey: { placeholder: () => CLOSURE },
  },
  undefined,
  (w, path, f) => checkNearMisses(w, path, f, GRID_NEAR_MISSES),
);

const decodeChartSpec = specDecoder('Chart', { source: { aliases: ['data'] } });

const decodeMapSpec = specDecoder('Map', { source: { aliases: ['data', 'markers'] } });

const VIS_KINDS: FamilyArms<'Visualisation', VisKind<unknown>> = {
  // Wire discriminator 'DataGrid'; in-memory tag stays 'Grid'.
  DataGrid: (w, path, j) =>
    andThen(decodeGridSpec(w, path, j), (spec) => ok<VisKind<unknown>>({ kind: 'Grid', spec })),
  Chart: (w, path, j) =>
    andThen(decodeChartSpec(w, path, j), (spec) => ok<VisKind<unknown>>({ kind: 'Chart', spec })),
  Map: (w, path, j) =>
    andThen(decodeMapSpec(w, path, j), (spec) => ok<VisKind<unknown>>({ kind: 'Map', spec })),
};

// ─── Layout specs ────────────────────────────────────────────────────────────

// ─── Box — the unified container (Phase 390) ─────────────────────────────────

const decodeBoxLayout = (w: Walk, path: string, j: JsonAst): R<BoxLayout> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Flex': {
      const direction = reqField(w, path, f, 'direction', 'Orientation', decodeOrientation);
      // Phase 2300 — `wrap` is omitted at its declared default `false`.
      const wrap = andThen(optField(w, path, f, 'wrap', requireBool), (v) => ok(v ?? false));
      const gap = optField(w, path, f, 'gap', requireInt);
      if (!direction.ok || !wrap.ok || !gap.ok) return failed(direction, wrap, gap);
      return ok({
        kind: 'Flex',
        direction: direction.value,
        wrap: wrap.value,
        ...(gap.value !== undefined ? { gap: gap.value } : {}),
      });
    }
    case 'Grid': {
      // Lenient AI-ingest (WIRE_FORMAT.md 3.6, 2026-07-17): a Grid with NO
      // column spec is the CSS auto-grid prior — accept-and-canonicalise to
      // the language's existing Auto responsive auto-tile. Mirror of F#.
      if (
        tryField(f, 'cols') === undefined &&
        tryField(f, 'columns') === undefined &&
        tryField(f, 'templateColumns') === undefined
      ) {
        return ok({ kind: 'Auto' });
      }
      // templateColumns present => cols is documented-ignored; absence defaults
      // to 1 rather than MISSING_FIELD (0.1.6 pilot residual). Mirror of F#.
      const cols =
        tryField(f, 'cols') === undefined && tryField(f, 'columns') === undefined
          ? ok(1)
          : reqFieldAliased(w, path, f, 'cols', ['columns'], 'cols integer', requireInt);
      const gap = optField(w, path, f, 'gap', requireInt);
      const templateColumns = optField(w, path, f, 'templateColumns', requireString);
      if (!cols.ok || !gap.ok || !templateColumns.ok) return failed(cols, gap, templateColumns);
      return ok({
        kind: 'Grid',
        cols: cols.value,
        ...(gap.value !== undefined ? { gap: gap.value } : {}),
        ...(templateColumns.value !== undefined ? { templateColumns: templateColumns.value } : {}),
      });
    }
    case 'Masonry': {
      // WIRE_FORMAT §3.6.7 — column-fill. `cols` is REQUIRED and POSITIVE, on
      // the srcSet width-floor pattern: `column-count: 0` is invalid CSS, so a
      // container declaring it would fall back to whatever the host stylesheet
      // last said and the wire would carry a host-defined layout.
      //
      // No auto-column leniency here, unlike `Grid` above, and the asymmetry is
      // deliberate rather than an omission: `Grid` canonicalises a column-less
      // spec to `Auto` because the language already owns that concept, whereas
      // `Auto` is a ROW-fill mode — rewriting a masonry into it would discard
      // the author's intent rather than recover it. Mirror of F#.
      // `cols` and `gap` are sibling members (§29.1).
      const masonryCols = reqFieldAliased(
        w,
        path,
        f,
        'cols',
        ['columns'],
        'positive integer column count',
        (_w, p, cj) =>
          cj.kind !== 'JNumber' || cj.value <= 0 || !Number.isInteger(cj.value)
            ? wrongType(p, 'JSON number (positive integer column count)')
            : ok(cj.value),
      );
      const masonryGap = optField(w, path, f, 'gap', requireInt);
      if (!masonryCols.ok || !masonryGap.ok) return failed(masonryCols, masonryGap);
      return ok({
        kind: 'Masonry',
        cols: masonryCols.value,
        ...(masonryGap.value !== undefined ? { gap: masonryGap.value } : {}),
      });
    }
    case 'Auto':
      return ok({ kind: 'Auto' });
    default:
      return unknownDuCase(path, d.value, 'Flex | Grid | Masonry | Auto');
  }
};

const decodeBoxRole = (w: Walk, path: string, j: JsonAst): R<BoxRole> => {
  const s = requireString(w, path, j);
  if (!s.ok) return s;
  switch (s.value) {
    case 'Group':
    case 'Card':
    case 'Dashboard':
    case 'Separator':
      return ok(s.value);
    default:
      return unknownEnumCase(path, s.value, 'Group | Card | Dashboard | Separator');
  }
};

const decodeBox = specDecoder('Box', { heading: { aliases: ['title'] } });

const decodeSplitPanelSpec = specDecoder('SplitPanel');

const decodeTabHeader = (w: Walk, path: string, j: JsonAst): R<TabHeader> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const label = reqField(w, path, f, 'label', 'tab header label TextSource', decodeTextSource);
  const icon = optField(w, path, f, 'icon', decodeIconSource);
  const disabled = optField(w, path, f, 'disabled', decodeBindingBool);
  if (!label.ok || !icon.ok || !disabled.ok) return failed(label, icon, disabled);
  return ok({
    label: label.value,
    ...(icon.value !== undefined ? { icon: icon.value } : {}),
    ...(disabled.value !== undefined ? { disabled: disabled.value } : {}),
  });
};

const decodeTabsSpec = specDecoder('Tabs');

// Phase 1962 — `onSelect` is the optional closure slot the IDL declares: a
// present `"<closure>"` sentinel decodes to the inert placeholder (the table's
// closure rule) and an absent key stays absent, arming the write-back default.
const decodeStepperSpec = specDecoder('Stepper', { onSelect: { placeholder: closurePlaceholder } });

const decodeSummaryListSpec = specDecoder('SummaryList', { heading: { aliases: ['title'] } });

const decodeDisclosureSpec = specDecoder('Disclosure', { heading: { aliases: ['title'] } });

const decodeModalSpec = specDecoder('Modal', { heading: { aliases: ['title'] } });

const decodeScrollAreaSpec = specDecoder('ScrollArea');

// Phase 390 — the unified container + the four legacy decode-upgrades.
const LAYOUT_KINDS: FamilyArms<'Layout', LayoutKind<unknown>> = {
  Box: (w, path, j) =>
    andThen(decodeBox(w, path, j), (spec) => ok<LayoutKind<unknown>>({ kind: 'Box', spec })),
  SplitPanel: (w, path, j) =>
    andThen(decodeSplitPanelSpec(w, path, j), (spec) =>
      ok<LayoutKind<unknown>>({ kind: 'SplitPanel', spec }),
    ),
  Tabs: (w, path, j) =>
    andThen(decodeTabsSpec(w, path, j), (spec) => ok<LayoutKind<unknown>>({ kind: 'Tabs', spec })),
  Stepper: (w, path, j) =>
    andThen(decodeStepperSpec(w, path, j), (spec) =>
      ok<LayoutKind<unknown>>({ kind: 'Stepper', spec }),
    ),
  SummaryList: (w, path, j) =>
    andThen(decodeSummaryListSpec(w, path, j), (spec) =>
      ok<LayoutKind<unknown>>({ kind: 'SummaryList', spec }),
    ),
  Disclosure: (w, path, j) =>
    andThen(decodeDisclosureSpec(w, path, j), (spec) =>
      ok<LayoutKind<unknown>>({ kind: 'Disclosure', spec }),
    ),
  Modal: (w, path, j) =>
    andThen(decodeModalSpec(w, path, j), (spec) =>
      ok<LayoutKind<unknown>>({ kind: 'Modal', spec }),
    ),
  ScrollArea: (w, path, j) =>
    andThen(decodeScrollAreaSpec(w, path, j), (spec) =>
      ok<LayoutKind<unknown>>({ kind: 'ScrollArea', spec }),
    ),
};

// ─── NodeKind ────────────────────────────────────────────────────────────────

const decodeContentHash = (w: Walk, path: string, j: JsonAst): R<ContentHash> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const algorithm = reqField(w, path, f, 'algorithm', 'hash algorithm string', requireString);
  const hash = reqField(w, path, f, 'hash', 'hash string', requireString);
  const strictness = reqField(
    w,
    path,
    f,
    'strictness',
    "'StrictReplay' | 'AdvisoryWarning' | 'Enforced'",
    (w2, p, j2) =>
      andThen(requireString(w2, p, j2), (s) =>
        s !== 'StrictReplay' && s !== 'AdvisoryWarning' && s !== 'Enforced'
          ? unknownEnumCase(p, s, 'StrictReplay | AdvisoryWarning | Enforced')
          : ok(s as HashStrictness),
      ),
  );
  if (!algorithm.ok || !hash.ok || !strictness.ok) return failed(algorithm, hash, strictness);
  return ok({ algorithm: algorithm.value, hash: hash.value, strictness: strictness.value });
};

// ─── Parameterised-fragment hole / effect / scalar decoders (Phase 180) ──────

const decodeHoleValueSpace = (w: Walk, path: string, j: JsonAst): R<HoleValueSpace> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const disc = requireDiscriminator(path, fo.value);
  if (!disc.ok) return disc;
  switch (disc.value) {
    case 'IntRange': {
      const min = reqField(w, path, fo.value, 'min', 'IntRange min', requireInt);
      const max = reqField(w, path, fo.value, 'max', 'IntRange max', requireInt);
      if (!min.ok || !max.ok) return failed(min, max);
      return ok({ kind: 'IntRange', min: min.value, max: max.value });
    }
    case 'FloatRange': {
      const min = reqField(w, path, fo.value, 'min', 'FloatRange min', requireFloat);
      const max = reqField(w, path, fo.value, 'max', 'FloatRange max', requireFloat);
      if (!min.ok || !max.ok) return failed(min, max);
      return ok({ kind: 'FloatRange', min: min.value, max: max.value });
    }
    case 'StringLen': {
      const minLen = reqField(w, path, fo.value, 'minLen', 'StringLen minLen', requireInt);
      const maxLen = reqField(w, path, fo.value, 'maxLen', 'StringLen maxLen', requireInt);
      if (!minLen.ok || !maxLen.ok) return failed(minLen, maxLen);
      return ok({ kind: 'StringLen', minLen: minLen.value, maxLen: maxLen.value });
    }
    case 'Enum': {
      const choices = reqField(w, path, fo.value, 'choices', 'Enum choices', listOf(requireString));
      if (!choices.ok) return choices;
      return ok({ kind: 'Enum', choices: choices.value });
    }
    case 'AnyString':
      return ok({ kind: 'AnyString' });
    default:
      return unknownDuCase(
        path,
        disc.value,
        'IntRange | FloatRange | StringLen | Enum | AnyString',
      );
  }
};

/** One `FragmentRef` argument / `Mount` input: a `SlotArg` tree or a scalar. */
const decodeFragmentArg = (w: Walk, argPath: string, valueJ: JsonAst): R<FragmentArg<unknown>> => {
  const fo = requireObject(w, argPath, valueJ);
  if (!fo.ok) return fo;
  const disc = requireDiscriminator(argPath, fo.value);
  if (!disc.ok) return disc;
  if (disc.value === 'SlotArg') {
    const tree = reqField(w, argPath, fo.value, 'tree', 'SlotArg tree Node', decodeNodeAst);
    if (!tree.ok) return tree;
    return ok({ kind: 'slot', tree: tree.value });
  }
  const scalar = decodeFragmentScalar(w, argPath, valueJ);
  if (!scalar.ok) return scalar;
  return ok({ kind: 'value', value: scalar.value });
};

const decodeFragmentScalar = (w: Walk, path: string, j: JsonAst): R<FragmentScalar> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const disc = requireDiscriminator(path, fo.value);
  if (!disc.ok) return disc;
  switch (disc.value) {
    case 'Int': {
      const v = reqField(w, path, fo.value, 'value', 'Int value', requireInt);
      return v.ok ? ok({ kind: 'int', value: v.value }) : v;
    }
    case 'Float': {
      const v = reqField(w, path, fo.value, 'value', 'Float value', requireFloat);
      return v.ok ? ok({ kind: 'float', value: v.value }) : v;
    }
    case 'Bool': {
      const v = reqField(w, path, fo.value, 'value', 'Bool value', requireBool);
      return v.ok ? ok({ kind: 'bool', value: v.value }) : v;
    }
    case 'Str': {
      const v = reqField(w, path, fo.value, 'value', 'Str value', requireString);
      return v.ok ? ok({ kind: 'str', value: v.value }) : v;
    }
    default:
      return unknownDuCase(path, disc.value, 'Int | Float | Bool | Str');
  }
};

const decodeHoleDecl = (w: Walk, path: string, j: JsonAst): R<HoleDecl> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const disc = requireDiscriminator(path, fo.value);
  if (!disc.ok) return disc;
  switch (disc.value) {
    case 'Value': {
      const name = reqField(w, path, fo.value, 'name', 'Value hole name', requireString);
      const space = reqField(w, path, fo.value, 'space', 'Value hole space', decodeHoleValueSpace);
      const def = optField(w, path, fo.value, 'default', decodeFragmentScalar);
      if (!name.ok || !space.ok || !def.ok) return failed(name, space, def);
      return ok({
        kind: 'Value',
        name: name.value,
        space: space.value,
        ...(def.value !== undefined ? { default: def.value } : {}),
      });
    }
    case 'Slot': {
      const name = reqField(w, path, fo.value, 'name', 'Slot hole name', requireString);
      const kc = optField(w, path, fo.value, 'kindConstraint', requireString);
      if (!name.ok || !kc.ok) return failed(name, kc);
      return ok({
        kind: 'Slot',
        name: name.value,
        ...(kc.value !== undefined ? { kindConstraint: kc.value } : {}),
      });
    }
    case 'Repeat': {
      const name = reqField(w, path, fo.value, 'name', 'Repeat hole name', requireString);
      const space = reqField(
        w,
        path,
        fo.value,
        'countSpace',
        'Repeat hole countSpace',
        decodeHoleValueSpace,
      );
      if (!name.ok || !space.ok) return failed(name, space);
      return ok({ kind: 'Repeat', name: name.value, countSpace: space.value });
    }
    default:
      return unknownDuCase(path, disc.value, 'Value | Slot | Repeat');
  }
};

/** An open map of `FragmentArg`s (`FragmentRef.args`, `Mount.inputs`): every entry decoded, each defect kept. */
const fragmentArgMap: Decoder<Record<string, FragmentArg<unknown>>> = (w, path, j) =>
  andThen(requireObject(w, path, j), (fields) =>
    traverseMembers(path, fields, (ep, _k, v) => decodeFragmentArg(w, ep, v)),
  );

/** A `Mount`'s guest channel (Phase 1021): the direction, and the message shape it declares. */
const decodeGuestChannel = recordDecoder('GuestChannel');

/** One further comparison on a `Metric` (Phase 2472): label and value required, format and polarity omitted at their defaults. */
const decodeMetricComparison = recordDecoder('MetricComparison');

const decodeEffectClass = (w: Walk, path: string, j: JsonAst): R<EffectClass> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const host = reqField(w, path, fo.value, 'hostEffect', 'EffectClass hostEffect', (w2, p, j2) =>
    andThen(requireString(w2, p, j2), (h) =>
      h !== 'Pure' && h !== 'ReadsHost' && h !== 'WritesHost'
        ? unknownEnumCase(p, h, 'Pure | ReadsHost | WritesHost')
        : ok(h),
    ),
  );
  const det = reqField(w, path, fo.value, 'determinism', 'EffectClass determinism', (w2, p, j2) =>
    andThen(requireString(w2, p, j2), (d) =>
      d !== 'Deterministic' && d !== 'Clock' && d !== 'Random' && d !== 'Network'
        ? unknownEnumCase(p, d, 'Deterministic | Clock | Random | Network')
        : ok(d),
    ),
  );
  if (!host.ok || !det.ok) return failed(host, det);
  return ok({ hostEffect: host.value as HostEffect, determinism: det.value as DeterminismSource });
};

/**
 * The `expectedShape` hint carried by every `WRONG_NODE_KIND` error, PROJECTED
 * from the single `NODE_KIND_GROUPS` vocabulary in `@fuaran-ui/schema` rather
 * than hand-maintained — a kind added to that enumeration reaches this hint for
 * free, which is the drift class three separately-maintained hint strings had
 * already accumulated across the hosts.
 *
 * Byte-identical to the F# and Rust hosts' hint (the group order is the shared
 * contract), so a model repairing against one host sees the same vocabulary it
 * would see from any other. Pinned against the generated manifest `kinds` by the
 * corpus test suite.
 */
export const WRONG_NODE_KIND_HINT: string = (() => {
  // Every group but `Structural` is a named primitive family; the structural
  // kinds are listed bare at the tail. Written as a fold over the groups rather
  // than four hardcoded lookups so a NEW family also reaches the hint for free.
  const primitives = NODE_KIND_GROUPS.filter((g) => g.label !== 'Structural')
    .map(
      (g) =>
        `${'AEIOU'.includes(g.label[0]!) ? 'an' : 'a'} ${g.label} primitive (${g.kinds.join(' | ')})`,
    )
    .join(', ');
  const structural = NODE_KIND_GROUPS.find((g) => g.label === 'Structural')?.kinds ?? [];
  return `${primitives}, or ${structural.join(' | ')}`;
})();

// The four behavioural categories are flat on the wire (WIRE_FORMAT §3.2): the
// `kind` object carries the primitive discriminator directly, so the category
// is recovered from the family table that owns the tag. Derived from the four
// tables, so a kind added to one of them routes here for free; the structural
// kinds (Custom, ErrorBoundary, Switch, the fragment kinds, Mount) keep their
// bodies in the switch below.
// ─── Structural specs (the kinds with no primitive family) ────────────────────

const decodeErrorBoundarySpec = specDecoder('ErrorBoundary');
const decodeFragmentDeclSpec = specDecoder('FragmentDecl');
const decodeFragmentRefSpec = specDecoder(
  'FragmentRef',
  { args: { dec: fragmentArgMap } },
  (spec) =>
    ok<FragmentRefSpec<unknown>>({
      ...spec,
      args: spec.args ?? wireKeyedRecord<FragmentArg<unknown>>(),
    }),
);
// Phase 2328 — `onBubble` is the optional closure slot the IDL declares: a present
// `"<closure>"` sentinel decodes to the inert placeholder and an absent key stays
// absent (a Mount that declares no bubble handler).
const decodeMountSpec = specDecoder(
  'Mount',
  { inputs: { dec: fragmentArgMap }, onBubble: { placeholder: closurePlaceholder } },
  (spec) =>
    ok<MountSpec<unknown>>({
      ...spec,
      inputs: spec.inputs ?? wireKeyedRecord<FragmentArg<unknown>>(),
    }),
);

const NODE_KIND_FAMILIES: KindArms<NodeKind<unknown>> = {
  ...familyOf(LAYOUT_KINDS, (layout) => ({ kind: 'Layout', layout })),
  ...familyOf(DISPLAY_KINDS, (display) => ({ kind: 'Display', display })),
  ...familyOf(INPUT_KINDS, (input) => ({ kind: 'Input', input })),
  ...familyOf(VIS_KINDS, (visualisation) => ({
    kind: 'Visualisation',
    visualisation,
  })),
};

const decodeNodeKind = (w: Walk, path: string, j: JsonAst): R<NodeKind<unknown>> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  // WIRE_FORMAT §23 — the host's declared admission policy is consulted FIRST,
  // before any family decoder runs, which is the whole economy of the mechanism:
  // a refused kind costs the discriminator read and nothing else. Narrowed to
  // kinds the vocabulary RECOGNISES so an unknown discriminator still reports
  // WRONG_NODE_KIND below — under a policy as without one — because "no such
  // kind" and "not admitted here" are different facts the author repairs
  // differently. Guarded on `narrows` so the default costs one comparison.
  if (narrows(w.policy) && NODE_KIND_NAMES.includes(d.value) && !admits(w.policy, d.value)) {
    return makeError(
      'KIND_NOT_ADMITTED',
      `${path}.$type`,
      `node kind '${d.value}' is not admitted by decode policy '${w.policy.identity}'`,
      policyHint(w.policy),
    );
  }
  const family = armFor(NODE_KIND_FAMILIES, d.value);
  if (family !== undefined) return family(w, path, j, f);
  switch (d.value) {
    case 'Custom': {
      const moduleId = reqField(w, path, f, 'moduleId', 'Custom moduleId string', requireString);
      const componentId = reqField(
        w,
        path,
        f,
        'componentId',
        'Custom componentId string',
        requireString,
      );
      const props = reqField(w, path, f, 'props', 'Custom props map', decodeJValMap);
      const contentHash = optField(w, path, f, 'contentHash', decodeContentHash);
      const exposedNodeIds = optField(w, path, f, 'exposedNodeIds', listOf(requireString));
      if (!moduleId.ok || !componentId.ok || !props.ok || !contentHash.ok || !exposedNodeIds.ok)
        return failed(moduleId, componentId, props, contentHash, exposedNodeIds);
      return ok({
        kind: 'Custom',
        moduleId: moduleId.value,
        componentId: componentId.value,
        props: props.value,
        exposedNodeIds: (exposedNodeIds.value ?? []) as NodeId[],
        ...(contentHash.value !== undefined ? { contentHash: contentHash.value } : {}),
      });
    }
    case 'ErrorBoundary':
      return andThen(decodeErrorBoundarySpec(w, path, j), (spec) =>
        ok<NodeKind<unknown>>({ kind: 'ErrorBoundary', spec }),
      );
    case 'Switch': {
      // State-bound conditional child (Phase 392). `stateKey` (string), `cases`
      // (array of `{child,match}` objects), `default` (Node) — all required.
      // Duplicate `match` values are NOT a decode error (first-match-wins keeps
      // decode structural; the pre-emit validator flags them, FUARAN082).
      // Phase 768 — `on` (any Binding) or the compact `stateKey` (the State
      // form's canonical spelling). Both absent keeps the stateKey
      // MISSING_FIELD, so the reject fixture's error is unchanged.
      const onJ = tryField(f, 'on');
      const on =
        onJ !== undefined
          ? decodeBinding(w, `${path}.on`, onJ)
          : (() => {
              const stateKey = reqField(
                w,
                path,
                f,
                'stateKey',
                'Switch stateKey string',
                requireString,
              );
              return stateKey.ok
                ? ok({
                    kind: 'State',
                    key: stateKey.value,
                    defaultValue: undefined as unknown as string,
                  } as Binding<string>)
                : stateKey;
            })();
      type Case = SwitchCase<unknown>;
      // Phase 1535 — a case selects on a string `match` XOR a `when` predicate
      // (a `Binding<boolean>` evaluated at render time). Exactly one; both and
      // neither are refused, naming both fields, on the Phase 818 `value` /
      // `valueFrom` precedent.
      //
      // "Neither" is refused rather than skipped at render because a case that
      // names no condition has no rendering that could be right: skipping it
      // renders the `default` and reports nothing.
      const cases = reqField(
        w,
        path,
        f,
        'cases',
        'Switch cases array',
        listOf((_w, cp, item): R<Case> => {
          const co = requireObject(w, cp, item);
          if (!co.ok) return co;
          const mJ = tryField(co.value, 'match');
          const wJ = tryField(co.value, 'when');
          // The selector and `child` are sibling members, decoded on their own, so
          // a defect in the selector does not hide the child's (§29.1).
          const sel = ((): R<{ readonly match: string } | { readonly when: Binding<boolean> }> => {
            if (mJ !== undefined && wJ !== undefined)
              return wrongType(
                `${cp}.when`,
                "either 'match' (a literal string compared against the switch's `on` selector) or 'when' (a Binding<bool> predicate evaluated at render time, needing no selector); remove one",
              );
            if (mJ === undefined && wJ === undefined)
              return missingField(
                cp,
                'match',
                "a literal string under 'match' (compared against the switch's `on` selector), or a Binding<bool> under 'when' (a predicate evaluated at render time)",
              );
            if (mJ !== undefined) {
              const m = requireString(w, `${cp}.match`, mJ);
              return m.ok ? ok({ match: m.value }) : m;
            }
            const b = decodeBindingBool(w, `${cp}.when`, wJ as JsonAst);
            return b.ok ? ok({ when: b.value }) : b;
          })();
          const c = reqField(w, cp, co.value, 'child', 'Switch case child Node', decodeNodeAst);
          if (!sel.ok || !c.ok) return failed(sel, c);
          return ok<Case>({ ...sel.value, child: c.value });
        }),
      );
      const def = reqField(w, path, f, 'default', 'Switch default Node', decodeNodeAst);
      // Phase 1122 — the timed advance. A POSITIVE INTEGER count of
      // milliseconds; non-positive and FRACTIONAL are both WRONG_TYPE and
      // neither is canonicalised. `0` is what an emitter reaches for to mean
      // "off" and the language already has a spelling for off (an absent key),
      // so rewriting it to absence would make two document shapes mean one
      // thing; decoding it to a live zero-millisecond timer would be a
      // re-render loop. A fraction is refused for a separate reason worth
      // stating: a decoder truncating where another rounded would leave two
      // hosts disagreeing about a document neither refused.
      const autoAdvanceMsR = optField(w, path, f, 'autoAdvanceMs', (_w, p, aj) =>
        aj.kind !== 'JNumber' || aj.value < 1 || !Number.isInteger(aj.value)
          ? wrongType(p, 'JSON number (a positive whole number of milliseconds)')
          : ok(aj.value),
      );
      if (!on.ok || !cases.ok || !def.ok || !autoAdvanceMsR.ok)
        return failed(on, cases, def, autoAdvanceMsR);
      const autoAdvanceMs = autoAdvanceMsR.value;
      return ok({
        kind: 'Switch',
        spec: {
          on: on.value as Binding<string>,
          cases: cases.value,
          default: def.value,
          ...(autoAdvanceMs !== undefined ? { autoAdvanceMs } : {}),
        },
      });
    }
    case 'FragmentDecl':
      return andThen(decodeFragmentDeclSpec(w, path, j), (spec) =>
        ok<NodeKind<unknown>>({ kind: 'FragmentDecl', spec }),
      );
    case 'FragmentRef':
      return andThen(decodeFragmentRefSpec(w, path, j), (spec) =>
        ok<NodeKind<unknown>>({ kind: 'FragmentRef', spec }),
      );
    case 'Mount':
      return andThen(decodeMountSpec(w, path, j), (spec) =>
        ok<NodeKind<unknown>>({ kind: 'Mount', spec }),
      );
    default:
      return makeError(
        'WRONG_NODE_KIND',
        `${path}.$type`,
        `unknown NodeKind discriminator '${d.value}'`,
        WRONG_NODE_KIND_HINT,
      );
  }
};

// ─── StateBehaviour / SemanticStyle / Accessibility / Node ───────────────────

const decodeStateBehaviour = (w: Walk, path: string, j: JsonAst): R<StateBehaviour<unknown>> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const onLoading = optField(w, path, f, 'onLoading', decodeNodeAst);
  const onEmpty = optField(w, path, f, 'onEmpty', decodeNodeAst);
  if (!onLoading.ok || !onEmpty.ok) return failed(onLoading, onEmpty);
  const hasOnError = tryField(f, 'onError') !== undefined;
  return ok({
    ...(onLoading.value !== undefined ? { onLoading: onLoading.value } : {}),
    ...(onEmpty.value !== undefined ? { onEmpty: onEmpty.value } : {}),
    ...(hasOnError ? { onError: (_p: ErrorPayload): Node<unknown> => placeholderClosureNode } : {}),
  });
};

const decodeSemanticStyle = (w: Walk, path: string, j: JsonAst): R<SemanticStyle> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  // Phase 460 — tone/weight/emphasis join role/voice as omitted-when-default;
  // restore the identity default on absence.
  const tone = optField(w, path, f, 'tone', decodeTone);
  const weight = optField(w, path, f, 'weight', decodeWeight);
  const emphasis = optField(w, path, f, 'emphasis', decodeEmphasis);
  // `role` / `voice` (Phase 147) are optional on the wire — omitted at their
  // defaults ('None' / 'Default'); restore the default on absence.
  const role = optField(w, path, f, 'role', decodeStyleRole);
  const voice = optField(w, path, f, 'voice', decodeFontVoice);
  // Phase 1472 — the declared base direction, joining the record's other
  // omitted-when-default members on exactly their terms. `auto` is the identity
  // and is restored on absence; an unrecognised token is REFUSED rather than
  // coerced to it.
  const direction = optField(w, path, f, 'direction', decodeTextDirection);
  if (!tone.ok || !weight.ok || !emphasis.ok || !role.ok || !voice.ok || !direction.ok)
    return failed(tone, weight, emphasis, role, voice, direction);
  // Every member of the record is `omitDefault` in the IDL, so each has its default.
  const d = defaults.style as Required<SemanticStyle>;
  return ok({
    tone: tone.value ?? d.tone,
    weight: weight.value ?? d.weight,
    emphasis: emphasis.value ?? d.emphasis,
    role: role.value ?? d.role,
    voice: voice.value ?? d.voice,
    direction: direction.value ?? d.direction,
  });
};

// Phase 2291 — the `PatchStyle` payload. The same six members through the same
// per-field decoders as `decodeSemanticStyle`, in the same order, but absence
// means "leave this field as it is", so nothing is defaulted: an absent member
// stays absent. Unknown keys are tolerated exactly as they are in a
// `SemanticStyle`. A delta naming no field is not an edit — refused as
// `WRONG_TYPE` at the delta, the `FieldRule` precedent (a record that declares
// nothing).
const decodeStyleDelta = (w: Walk, path: string, j: JsonAst): R<StyleDelta> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const tone = optField(w, path, f, 'tone', decodeTone);
  const weight = optField(w, path, f, 'weight', decodeWeight);
  const emphasis = optField(w, path, f, 'emphasis', decodeEmphasis);
  const role = optField(w, path, f, 'role', decodeStyleRole);
  const voice = optField(w, path, f, 'voice', decodeFontVoice);
  const direction = optField(w, path, f, 'direction', decodeTextDirection);
  if (!tone.ok || !weight.ok || !emphasis.ok || !role.ok || !voice.ok || !direction.ok)
    return failed(tone, weight, emphasis, role, voice, direction);
  const delta: StyleDelta = {
    ...(direction.value !== undefined ? { direction: direction.value } : {}),
    ...(emphasis.value !== undefined ? { emphasis: emphasis.value } : {}),
    ...(role.value !== undefined ? { role: role.value } : {}),
    ...(tone.value !== undefined ? { tone: tone.value } : {}),
    ...(voice.value !== undefined ? { voice: voice.value } : {}),
    ...(weight.value !== undefined ? { weight: weight.value } : {}),
  };
  if (Object.keys(delta).length === 0)
    return makeError(
      'WRONG_TYPE',
      path,
      'a style patch that names no field is not an edit — set at least one of direction / emphasis / role / tone / voice / weight, or send no op',
      'StyleDelta with at least one member',
    );
  return ok(delta);
};

// Phase 959 — the `Accessibility` trait's near-miss set (the Phase 863
// discipline applied to the §3.1 trait). Parity-locked with F#
// `accessibilityNearMisses` / `accessibilityNearMiss`, and mirrored in the
// published schema as `not: { required: [...] }`.
//
// Rule 2's tolerance of unknown keys is right for a slot a future profile may
// add and wrong for a near miss of one that exists. That silence is sharper
// here than anywhere else, for a reason peculiar to this trait: it has NO
// VISIBLE OUTPUT. A mislabelled column is on screen; an ignored `ariaLabel`
// looks identical to an honoured one from every side, so the refusal is the
// only feedback that can ever arrive.
//
// Refused rather than aliased. `ariaLabel` IS an unambiguous synonym, so
// admission turns on §16's other half — a shorthand earns its place by being a
// genuine assist to the emitting model, and a six-character key rename is not
// one. `live` settles it: the HTML idiom it comes from also spells a BOOLEAN,
// so an alias would bind a possibly-boolean prior onto a closed token set.
//
// `live` and `ariaLabel` are named by MEASURED evidence (6 and 1 emissions
// against `liveRegion`'s 12 and `label`'s 44, across 12,722 language-tier
// emissions); the rest of their families ride in with them. Declaration order
// is identical in all five hosts, so which defect surfaces first is
// deterministic.
const A11Y_NEAR_MISSES = [
  [
    'aria-label',
    'label — the accessible name, a Binding<string> (a bare string is the §3.6 shorthand)',
  ],
  [
    'ariaLabel',
    'label — the accessible name, a Binding<string> (a bare string is the §3.6 shorthand)',
  ],
  ['aria-labelledby', 'labelledBy — the id of a sibling node whose text carries the name'],
  ['ariaLabelledBy', 'labelledBy — the id of a sibling node whose text carries the name'],
  [
    'labelledby',
    'labelledBy — the slot name is camelCase on the wire, not the ARIA attribute spelling',
  ],
  ['aria-describedby', 'describedBy — the id of a sibling node whose text carries the description'],
  ['ariaDescribedBy', 'describedBy — the id of a sibling node whose text carries the description'],
  [
    'describedby',
    'describedBy — the slot name is camelCase on the wire, not the ARIA attribute spelling',
  ],
  ['aria-role', 'role — the ARIA role NAME as a bare string'],
  ['ariaRole', 'role — the ARIA role NAME as a bare string'],
  ['aria-live', 'liveRegion — the closed token set "polite" / "assertive" / "off"'],
  ['ariaLive', 'liveRegion — the closed token set "polite" / "assertive" / "off"'],
  ['live', 'liveRegion — the closed token set "polite" / "assertive" / "off"'],
  ['liveregion', 'liveRegion — the closed token set "polite" / "assertive" / "off"'],
  ['aria-hidden', 'hidden — a Binding<bool> (a bare bool is the §3.6 shorthand)'],
  ['ariaHidden', 'hidden — a Binding<bool> (a bare bool is the §3.6 shorthand)'],
] as const;

const checkA11yNearMisses = (w: Walk, path: string, f: Fields): R<void> => {
  // Every near miss present is its own defect (WIRE_FORMAT §29.1).
  let first: R<void> | undefined;
  for (const [name, canonical] of A11Y_NEAR_MISSES) {
    if (tryField(f, name) !== undefined) {
      const r = makeError(
        'WRONG_TYPE',
        `${path}.${name}`,
        `'${name}' is not part of the accessibility vocabulary — it would be ignored, not honoured, and the intent would reach assistive technology as nothing at all`,
        canonical,
      );
      first ??= r;
    }
  }
  return first ?? ok(undefined);
};

const decodeAccessibility = (w: Walk, path: string, j: JsonAst): R<Accessibility> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  // The near-miss check runs BEFORE the slot reads, matching the `FormField`
  // ordering, so a trait carrying both `ariaLabel` and a well-formed `label`
  // still names the ignored key rather than decoding half the intent silently.
  const nearMiss = checkA11yNearMisses(w, path, f);
  const label = optField(w, path, f, 'label', decodeBindingString);
  const labelledBy = optField(w, path, f, 'labelledBy', requireString);
  const describedBy = optField(w, path, f, 'describedBy', requireString);
  const role = optField(w, path, f, 'role', decodeAriaRole);
  const liveRegion = optField(w, path, f, 'liveRegion', decodeLiveRegion);
  const hidden = optField(w, path, f, 'hidden', decodeBindingBool);
  // Phase 1812 — `speak`, the node's spoken rendering for a voice surface: a
  // full `TextSource` like `tooltip`, decoded and preserved here, inert to the
  // visual renderer and never a source for `aria-label`.
  const speak = optField(w, path, f, 'speak', decodeTextSource);
  if (
    !nearMiss.ok ||
    !label.ok ||
    !labelledBy.ok ||
    !describedBy.ok ||
    !role.ok ||
    !liveRegion.ok ||
    !hidden.ok ||
    !speak.ok
  )
    return failed(nearMiss, label, labelledBy, describedBy, role, liveRegion, hidden, speak);
  return ok({
    ...(label.value !== undefined ? { label: label.value } : {}),
    ...(labelledBy.value !== undefined ? { labelledBy: labelledBy.value as NodeId } : {}),
    ...(describedBy.value !== undefined ? { describedBy: describedBy.value as NodeId } : {}),
    ...(role.value !== undefined ? { role: role.value } : {}),
    ...(liveRegion.value !== undefined ? { liveRegion: liveRegion.value } : {}),
    ...(hidden.value !== undefined ? { hidden: hidden.value } : {}),
    ...(speak.value !== undefined ? { speak: speak.value } : {}),
  });
};

/** All-empty StateBehaviour the decoder restores when `state` is absent (§3.1). */
const emptyStateBehaviour: StateBehaviour<unknown> = {};

/**
 * All-default SemanticStyle the decoder restores when `style` is absent (§3.1).
 * It carries no `direction`, where a present all-default `style` object decodes
 * WITH `direction: 'auto'`; the merge engine re-omits that identity and is
 * pinned to this shape, so the asymmetry is kept here and recorded rather than
 * changed under a table refactor.
 */
const defaultSemanticStyle: SemanticStyle = {
  tone: 'Default',
  weight: 'Standard',
  emphasis: 'Normal',
  role: 'None',
  voice: 'Default',
};

const placeholderClosureNode: Node<unknown> = {
  id: CLOSURE as NodeId,
  kind: {
    kind: 'Display',
    display: { kind: 'Markdown', spec: { text: { kind: 'Literal', value: CLOSURE } } },
  },
  state: {},
  style: defaultSemanticStyle,
};

// ─── §21 walk bounds for the structural + op decoders ──────────────────────
//
// Bounding the PARSER is not sufficient, and this is the trap §21.5 records
// against the reference host. The syntactic bound only LOOKS like cover for the
// two walks below: it is a different axis with a different constant per level,
// and on the reference host 2.6 KB of nested `Batch` killed the process with
// every node-side guard already in place. So each walk counts its own axis,
// on the `Walk` it is handed (Phase 2072: the counters were module-level
// state, which made a decode started from inside another reset the outer
// one's). `TreeItem` (Phase 1120) is the THIRD recursive axis, arriving exactly
// the way `TreeOp.Batch` did: a tree's rows nest inside ONE node, so the node
// bound cannot see them, and at roughly two JSON levels per row the syntactic
// bound is not reached either. The FIGURE is `MAX_NODE_DEPTH`, reused rather
// than a sixth limit minted: these frames cost what the node decoder's cost.

const limitError = (path: string, message: string, expected: string): R<never> =>
  makeError('LIMIT_EXCEEDED', path, message, expected);

const decodeNodeAst = (w: Walk, path: string, j: JsonAst): R<Node<unknown>> => {
  // §21.2 rule 4 — on the way DOWN, before the recursion that would breach it.
  if (w.depth >= MAX_NODE_DEPTH) {
    return limitError(
      path,
      `node nesting deeper than the wire limit MAX_NODE_DEPTH = ${MAX_NODE_DEPTH}`,
      `a tree nesting nodes no more than ${MAX_NODE_DEPTH} levels deep`,
    );
  }
  w.nodes += 1;
  if (w.nodes > MAX_NODES) {
    return limitError(
      path,
      `the document holds more than the wire limit MAX_NODES = ${MAX_NODES} nodes`,
      `a tree of no more than ${MAX_NODES} nodes in total`,
    );
  }
  w.depth += 1;
  const r = decodeNodeAstInner(w, path, j);
  w.depth -= 1;
  return r;
};

const decodeNodeAstInner = (w: Walk, path: string, j: JsonAst): R<Node<unknown>> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  // `id` and `kind` are sibling members; the id carries its own non-empty check (§29.1).
  const idStr = reqField(w, path, f, 'id', 'Node id string', (w2, p, j2) =>
    andThen(requireString(w2, p, j2), (id) =>
      id === '' ? makeError('EMPTY_NODE_ID', p, 'Node id is empty', 'non-empty string') : ok(id),
    ),
  );
  const kind = reqField(w, path, f, 'kind', 'NodeKind discriminator object', decodeNodeKind);
  // `state` / `style` are omitted on the wire when empty / all-default
  // (WIRE_FORMAT.md §3.1) — restore the default on absence.
  const state =
    tryField(f, 'state') === undefined
      ? ok<StateBehaviour<unknown>>(emptyStateBehaviour)
      : reqField(w, path, f, 'state', 'StateBehaviour object', decodeStateBehaviour);
  const style =
    tryField(f, 'style') === undefined
      ? ok<SemanticStyle>(defaultSemanticStyle)
      : reqField(w, path, f, 'style', 'SemanticStyle object', decodeSemanticStyle);
  const accessibility = optField(w, path, f, 'accessibility', decodeAccessibility);
  // Phase 1112 — the node-level tooltip trait. An ordinary optional
  // `TextSource`, decoded by the shared decoder rather than by anything this
  // position invents. Note the CANONICAL form of a literal hint is a BARE
  // STRING: `Literal` is `TextSource`'s transparent case, so
  // `"tooltip":"Updated nightly."` is the encoder's own output rather than a
  // lenient shorthand; `Bound` and `I18n` are the arms that carry an envelope.
  const tooltip = optField(w, path, f, 'tooltip', decodeTextSource);
  // Phase 1535 — the node-level visibility predicate. An ordinary optional
  // `Binding<boolean>`, decoded by the shared binding decoder for the reason the
  // tooltip above states: the one time a host read a node-envelope slot as its
  // own narrower thing it took two hosts and a ruling to unwind.
  const visible = optField(w, path, f, 'visible', decodeBindingBool);
  // Phase 1812 — the author-declared `fallback`: a full node a reader BEHIND
  // this node's kind renders in place of its placeholder (§3.1 / §15.3). This
  // reader knows the kind, so it decodes the fallback, preserves it and never
  // renders it; the descent goes through `decodeNodeAst` like `state.onEmpty`
  // does, so the §21 depth and node-count bounds cover the subtree.
  const fallback = optField(w, path, f, 'fallback', decodeNodeAst);
  if (
    !state.ok ||
    !style.ok ||
    !idStr.ok ||
    !kind.ok ||
    !accessibility.ok ||
    !tooltip.ok ||
    !visible.ok ||
    !fallback.ok
  )
    return failed(state, style, idStr, kind, accessibility, tooltip, visible, fallback);
  return ok({
    id: idStr.value as NodeId,
    kind: kind.value,
    state: state.value,
    style: style.value,
    ...(accessibility.value !== undefined ? { accessibility: accessibility.value } : {}),
    ...(tooltip.value !== undefined ? { tooltip: tooltip.value } : {}),
    ...(visible.value !== undefined ? { visible: visible.value } : {}),
    ...(fallback.value !== undefined ? { fallback: fallback.value } : {}),
  });
};

// ─── TreeOp ──────────────────────────────────────────────────────────────────

const decodeTreeOpAst = (w: Walk, path: string, j: JsonAst): R<TreeOp<unknown>> => {
  // The op axis, counted separately from the node axis and held to the same
  // ceiling. `Batch` makes this function self-recursive, and §21.5's note for
  // implementers is explicit that the syntactic bound is NOT adequate cover for
  // it — enumerate every recursive entry point, including the ones whose
  // recursion is over ops rather than nodes.
  if (w.opDepth >= MAX_NODE_DEPTH) {
    return limitError(
      path,
      `op nesting deeper than the wire limit MAX_NODE_DEPTH = ${MAX_NODE_DEPTH}`,
      `a Batch nesting ops no more than ${MAX_NODE_DEPTH} levels deep`,
    );
  }
  w.opDepth += 1;
  const r = decodeTreeOpAstInner(w, path, j);
  w.opDepth -= 1;
  return r;
};

// The RETIRED positional slot on `InsertChild` / `MoveNode` (Phase 687, closing
// the window Phase 681 opened).
//
// Phase 681 removed the field and the hosts then ACCEPTED AND IGNORED it so
// each could adopt independently. Silence was the whole mechanism: this decoder
// takes named fields and ignores the rest, so *not reading it* was the
// tolerance. That is also why closing the window cannot be done by deletion —
// there was never a read to delete, and the field would go on decoding silently
// forever. The close is an explicit refusal BY NAME, on the `checkNearMisses`
// pattern and for its reason: a key that no-ops is worse than one that fails,
// because the op decodes, applies, and puts the node somewhere other than where
// the ordinal asked.
//
// Evaluated BEFORE the required-field decodes, mirroring the FormField
// near-miss ordering, so an op carrying both a retired ordinal and some other
// defect names the ordinal. Parity-locked with F# `retiredPositionalField` and
// the Go / Rust / Python equivalents — the ordering is identical in all five, so
// which defect surfaces first is deterministic.
const retiredPositionalField = (path: string, f: Fields, name: string, opKind: string): R<void> =>
  tryField(f, name) !== undefined
    ? makeError(
        'WRONG_TYPE',
        `${path}.${name}`,
        `'${name}' was removed from the wire format — ${opKind} appends, and order is stated by naming ids with ReorderChildren`,
        'a Batch of the structural op followed by ReorderChildren',
      )
    : ok(undefined);

const decodeTreeOpAstInner = (w: Walk, path: string, j: JsonAst): R<TreeOp<unknown>> => {
  const fo = requireObject(w, path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  const target = (): R<NodeId> => {
    const r = reqField(w, path, f, 'target', 'target NodeId', requireString);
    return r.ok ? ok(r.value as NodeId) : r;
  };
  switch (d.value) {
    case 'EditNode': {
      const t = target();
      if (!t.ok) return t;
      const newKind = reqField(w, path, f, 'newKind', 'NodeKind object', decodeNodeKind);
      return newKind.ok
        ? ok({ kind: 'EditNode', target: t.value, newKind: newKind.value })
        : newKind;
    }
    case 'UpdateProp': {
      const t = target();
      const p = reqField(w, path, f, 'path', 'dot-separated path string', requireString);
      const valueJ = requireField(path, f, 'value', 'JsonValue payload');
      if (!t.ok || !p.ok || !valueJ.ok) return failed(t, p, valueJ);
      const value = decodeJVal(w, `${path}.value`, valueJ.value);
      return value.ok
        ? ok({
            kind: 'UpdateProp',
            target: t.value,
            path: p.value,
            value: value.value,
          })
        : value;
    }
    case 'ReplaceBinding': {
      const t = target();
      const slot = reqField(w, path, f, 'slot', 'slot name string', requireString);
      if (!t.ok || !slot.ok) return failed(t, slot);
      const b = reqField(w, path, f, 'binding', 'Binding object', decodeBinding);
      return b.ok
        ? ok({ kind: 'ReplaceBinding', target: t.value, slot: slot.value, binding: b.value })
        : b;
    }
    case 'UpdateStyle': {
      const t = target();
      if (!t.ok) return t;
      const style = reqField(w, path, f, 'style', 'SemanticStyle object', decodeSemanticStyle);
      return style.ok ? ok({ kind: 'UpdateStyle', target: t.value, style: style.value }) : style;
    }
    case 'PatchStyle': {
      // Phase 2291 — the field-level style edit: UpdateStyle's shape, a
      // StyleDelta payload.
      const t = target();
      if (!t.ok) return t;
      const style = reqField(w, path, f, 'style', 'StyleDelta object', decodeStyleDelta);
      return style.ok ? ok({ kind: 'PatchStyle', target: t.value, style: style.value }) : style;
    }
    case 'UpdateState': {
      const t = target();
      if (!t.ok) return t;
      const state = reqField(w, path, f, 'state', 'StateBehaviour object', decodeStateBehaviour);
      return state.ok ? ok({ kind: 'UpdateState', target: t.value, state: state.value }) : state;
    }
    case 'InsertChild': {
      // Phase 687 CLOSED the migration window Phase 681 opened: a legacy
      // `position` is a decode error. See `retiredPositionalField`.
      const retired = retiredPositionalField(path, f, 'position', 'InsertChild');
      const parentJ = reqField(w, path, f, 'parentId', 'parent NodeId', requireString);
      if (!retired.ok || !parentJ.ok) return failed(retired, parentJ);
      const child = reqField(w, path, f, 'child', 'child Node object', decodeNodeAst);
      return child.ok
        ? ok({
            kind: 'InsertChild',
            parentId: parentJ.value as NodeId,
            child: child.value,
          })
        : child;
    }
    case 'RemoveNode': {
      const t = target();
      return t.ok ? ok({ kind: 'RemoveNode', target: t.value }) : t;
    }
    case 'MoveNode': {
      // Legacy `newPosition` is a decode error — see InsertChild above.
      const retired = retiredPositionalField(path, f, 'newPosition', 'MoveNode');
      const t = target();
      if (!retired.ok || !t.ok) return failed(retired, t);
      const newParent = reqField(w, path, f, 'newParentId', 'new parent NodeId', requireString);
      return newParent.ok
        ? ok({
            kind: 'MoveNode',
            target: t.value,
            newParentId: newParent.value as NodeId,
          })
        : newParent;
    }
    case 'ReorderChildren': {
      const parentJ = reqField(w, path, f, 'parentId', 'parent NodeId', requireString);
      if (!parentJ.ok) return parentJ;
      const newOrder = reqField(w, path, f, 'newOrder', 'NodeId list', listOf(requireString));
      return newOrder.ok
        ? ok({
            kind: 'ReorderChildren',
            parentId: parentJ.value as NodeId,
            newOrder: newOrder.value as NodeId[],
          })
        : newOrder;
    }
    case 'ReplaceRoot': {
      const n = reqField(w, path, f, 'node', 'root Node object', decodeNodeAst);
      return n.ok ? ok({ kind: 'ReplaceRoot', node: n.value }) : n;
    }
    case 'Batch': {
      const ops = reqField(w, path, f, 'ops', 'Batch inner-op list', listOf(decodeTreeOpAst));
      return ops.ok ? ok({ kind: 'Batch', ops: ops.value }) : ops;
    }
    default:
      return unknownDuCase(
        path,
        d.value,
        'EditNode | UpdateProp | ReplaceBinding | UpdateStyle | PatchStyle | UpdateState | InsertChild | RemoveNode | MoveNode | ReorderChildren | ReplaceRoot | Batch',
      );
  }
};

// ─── Coercion bridge (apply-engine UpdateProp) ───────────────────────────────
//
// Port of the F# `JsonDecode.Coerce` module. `TreeOp.UpdateProp` carries a
// `JsonValue` payload; the apply engine pours it into a typed spec field. These
// helpers convert the decoded `JsonValue` (a JS primitive, or a wire-shaped DU
// object) into the field's typed value by rebuilding the JSON AST and running
// the matching per-type decoder. Failures surface a plain message string the
// apply engine reframes into a `KindMismatch` ApplyError.

const valueToAst = (v: JsonValue): JsonAst => {
  if (v === null) return { kind: 'JNull' };
  if (typeof v === 'boolean') return { kind: 'JBool', value: v };
  if (typeof v === 'number') return { kind: 'JNumber', value: v };
  if (typeof v === 'string') return { kind: 'JString', value: v };
  if (Array.isArray(v)) return { kind: 'JArray', items: v.map(valueToAst) };
  const m = new Map<string, JsonAst>();
  for (const [k, vv] of Object.entries(v)) m.set(k, valueToAst(vv));
  return { kind: 'JObject', fields: m };
};

const viaAst = <T>(v: JsonValue, dec: Decoder<T>): Result<T, string> => {
  const r = dec(newWalk(), '$value', valueToAst(v));
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error[0]!.message };
};

const okS = <T>(value: T): Result<T, string> => ({ ok: true, value });
const errS = (error: string): Result<never, string> => ({ ok: false, error });

/** Typed-value coercers for `TreeOp.UpdateProp` (used by the apply engine). */
export const coerce = {
  int: (v: JsonValue): Result<number, string> =>
    typeof v === 'number' ? okS(Math.trunc(v)) : errS('expected a JSON number (integer)'),
  float: (v: JsonValue): Result<number, string> =>
    typeof v === 'number' ? okS(v) : errS('expected a JSON number'),
  bool: (v: JsonValue): Result<boolean, string> =>
    typeof v === 'boolean' ? okS(v) : errS('expected a JSON boolean'),
  string: (v: JsonValue): Result<string, string> =>
    typeof v === 'string' ? okS(v) : errS('expected a JSON string'),
  textSource: (v: JsonValue): Result<TextSource, string> => viaAst(v, decodeTextSource),
  bindingNumber: (v: JsonValue): Result<Binding<number>, string> =>
    viaAst(v, decodeBinding) as Result<Binding<number>, string>,
  bindingInt: (v: JsonValue): Result<Binding<number>, string> =>
    viaAst(v, decodeBinding) as Result<Binding<number>, string>,
  bindingBool: (v: JsonValue): Result<Binding<boolean>, string> => viaAst(v, decodeBindingBool),
  bindingString: (v: JsonValue): Result<Binding<string>, string> => viaAst(v, decodeBindingString),
  cellFormat: (v: JsonValue): Result<CellFormat, string> => viaAst(v, decodeCellFormat),
  columnWidth: (v: JsonValue): Result<ColumnWidth, string> => viaAst(v, decodeColumnWidth),
  orientation: (v: JsonValue): Result<Orientation, string> => viaAst(v, decodeOrientation),
  tone: (v: JsonValue): Result<ToneVariant, string> => viaAst(v, decodeTone),
  weight: (v: JsonValue): Result<StyleWeight, string> => viaAst(v, decodeWeight),
  emphasis: (v: JsonValue): Result<Emphasis, string> => viaAst(v, decodeEmphasis),
  /** `Metric.TrendPolarity` (Phase 867) - the UpdateProp twin of `decodeTrendPolarity`. */
  trendPolarity: (v: JsonValue): Result<TrendPolarity, string> => viaAst(v, decodeTrendPolarity),
  /**
   * The behavioural `emphasis` BOOL on Fact / LabelValueRow — the UpdateProp
   * twin of `decodeEmphasisFlag`, so a TreeOp edit gets the same
   * cross-vocabulary admission as a fresh decode (0.2.8, 2026-07-19 sweep).
   */
  emphasisFlag: (v: JsonValue): Result<boolean, string> => viaAst(v, decodeEmphasisFlag),
  headingVariant: (v: JsonValue): Result<HeadingVariant, string> => viaAst(v, decodeHeadingVariant),
  badgeVariant: (v: JsonValue): Result<BadgeVariant, string> => viaAst(v, decodeBadgeVariant),
  iconSource: (v: JsonValue): Result<IconSource, string> => viaAst(v, decodeIconSource),
  /** `Icon.Size : IconSize` (Phase 821) — the UpdateProp twin of `decodeIconSize`,
   * added with the standalone Icon display kind. */
  iconSize: (v: JsonValue): Result<IconSize, string> => viaAst(v, decodeIconSize),
  stringOption: (v: JsonValue): Result<string | undefined, string> =>
    viaAst(v, parseStaticStringOpt) as Result<string | undefined, string>,
};

// ─── Public surface ──────────────────────────────────────────────────────────

const invalidJson = (parseMessage: string): R<never> =>
  makeError(
    'INVALID_JSON',
    '$',
    `input is not valid JSON: ${parseMessage}`,
    'well-formed JSON object per the canonical-JSON shape',
  );

/**
 * Turn a parse failure into a decode error, honouring §21.2 rule 2: a resource
 * limit breach is `LIMIT_EXCEEDED`, never `INVALID_JSON`. The parser flags the
 * distinction because only the parser knows which of the two happened.
 */
/** The single-error form (§29.2): the head of the list. */
const single = <T>(r: Result<T, readonly DecodeError[]>): Result<T, DecodeError> =>
  r.ok ? r : { ok: false, error: r.error[0]! };

/** One node walk from the root, its refusal in the §29 list form. */
const nodeWalk = (
  ast: JsonAst,
  policy: DecodePolicy | undefined,
): Result<Node<unknown>, readonly DecodeError[]> => {
  const r = decodeNodeAst(newWalk(policy), '$', ast);
  return r.ok ? r : { ok: false, error: defectList(r.error) };
};

const parseFailure = (e: {
  readonly message: string;
  readonly limit?: boolean;
  readonly path?: string;
}): R<never> =>
  e.limit === true
    ? makeError(
        'LIMIT_EXCEEDED',
        e.path ?? '$',
        e.message,
        'a document within the WIRE_FORMAT §21 limits',
      )
    : invalidJson(e.message);

/**
 * Decode a canonical-JSON `Node` payload into the storage-shape `Node<unknown>`.
 *
 * `policy` is the OPTIONAL WIRE_FORMAT §23 host-declared admission policy: a
 * tree naming a kind outside it is refused with `KIND_NOT_ADMITTED` at the
 * offending `kind.$type`, naming the kind and the policy. **Omitted, the decoder
 * has exactly the obligations it had before** — every valid document decodes and
 * the code is unreachable, which is what keeps §22 unqualified. Build a policy
 * with `@fuaran-ui/schema`'s `CLOSED_PROFILE`, `excluding` or `admitting`.
 *
 * The reference host spells this as a sibling entry point rather than an
 * optional argument, because F# optional parameters exist only on type members
 * and defaulting in place would reshape its whole decoder surface. What the two
 * hosts owe each other is the same behaviour on the same bytes, not the same
 * arity — the `decode-policy/` corpus family is where that is asserted.
 */
export const decodeNode = (
  json: string,
  policy?: DecodePolicy,
): Result<Node<unknown>, DecodeError> => single(decodeNodeWithDefects(json, policy));

/**
 * `decodeNode` over an already-parsed AST (Phase 2072) — the entry point for a
 * reader that holds a `JsonAst` from this package's own `parse` and used to
 * re-serialise it to decode it: the envelope and elicitation readers, the
 * tolerant decoder, teleport. Same policy, same errors, same single-error form
 * (the head of the §29.3 canonical list); the §21 bounds the parser imposes are
 * the caller's, as it parsed.
 */
export const decodeNodeFromAst = (
  ast: JsonAst,
  policy?: DecodePolicy,
): Result<Node<unknown>, DecodeError> => single(nodeWalk(ast, policy));

/**
 * `decodeNode`, reporting EVERY independent defect (WIRE_FORMAT.md §29; Phase
 * 1935). A refusal carries the defect list in the §29.3 canonical order: never
 * empty, and its head is exactly the error `decodeNode` returns for the same
 * inputs. `INVALID_JSON` and a §21 breach are one-entry lists, the walk stopping
 * there. An accepted document decodes exactly as through `decodeNode`: this entry
 * point shows more of a refusal and decides nothing differently. The reference
 * host's twin is `JsonDecode.decodeNodeWithDefects`, and the two agree
 * byte-for-byte on every list (the `reject/` corpus family's `expectedDefects`).
 */
export const decodeNodeWithDefects = (
  json: string,
  policy?: DecodePolicy,
): Result<Node<unknown>, readonly DecodeError[]> => {
  const parsed = parse(json);
  return parsed.ok ? nodeWalk(parsed.value, policy) : parseFailure(parsed.error);
};

/**
 * Decode a canonical-JSON `TreeOp` payload into the storage-shape
 * `TreeOp<unknown>`.
 *
 * `policy` is the optional §23 admission policy. A node kind reaches an op two
 * ways — inside a node-bearing operation, and as `EditNode`'s replacement kind —
 * and both are gated, because an op stream that could introduce a refused kind
 * into an admitted tree would make the policy a property of the first decode
 * only rather than a closure.
 */
export const decodeOp = (
  json: string,
  policy?: DecodePolicy,
): Result<TreeOp<unknown>, DecodeError> => {
  const parsed = parse(json);
  if (!parsed.ok) return single(parseFailure(parsed.error));
  return single(decodeTreeOpAst(newWalk(policy), '$', parsed.value));
};

/**
 * Decode a canonical-JSON payload holding EITHER one `TreeOp` or an array of
 * them — the shape a host sends down an op channel.
 *
 * It exists because the obvious composition is unsound. A consumer holding
 * "one op or an array" reaches for `JSON.parse`, walks the array, and calls
 * `decodeOp(JSON.stringify(entry))` per element; the embedded standalone bundle
 * did exactly that. Three things go wrong, and none of them is visible from the
 * call site:
 *
 *  - The whole payload passes through `JSON.parse` BEFORE any bound applies, so
 *    the §21 depth gate never sees it. `JSON.parse` is native and will not
 *    overflow, but the document it hands back is unbounded, and the per-op
 *    decode that follows measures each op against a limit the batch already
 *    escaped.
 *  - `JSON.parse` is a different parser with different §20 answers: it keeps the
 *    LAST duplicate member, reads `1e999` as `Infinity`, and accepts nothing
 *    this parser refuses. Re-stringifying its output launders every one of those
 *    differences into bytes this decoder then accepts without complaint — the
 *    §20.1 undeclared-entry-point defect, arrived at by composition.
 *  - `MAX_NODES` is reset per `decodeOp` call, so it bounded ONE op rather than
 *    the batch: 1 000 ops of 100 000 nodes each passed every check.
 *
 * So the batch is parsed ONCE through this package's own parser, the array is
 * split at the AST, and the node budget is carried ACROSS the ops rather than
 * reset per op.
 */
export const decodeOps = (
  json: string,
  policy?: DecodePolicy,
): Result<readonly TreeOp<unknown>[], DecodeError> => {
  const parsed = parse(json);
  if (!parsed.ok) return single(parseFailure(parsed.error));
  const w = newWalk(policy);

  const entries = parsed.value.kind === 'JArray' ? parsed.value.items : [parsed.value];
  const ops: TreeOp<unknown>[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    // The path names the batch position, so a failure in a 200-op batch says
    // WHICH op. ONE walk serves the batch: the node budget is the batch's, not
    // each op's.
    const path = parsed.value.kind === 'JArray' ? `$[${i}]` : '$';
    const decoded = decodeTreeOpAst(w, path, entries[i]!);
    if (!decoded.ok) return single(decoded);
    ops.push(decoded.value);
  }
  return { ok: true, value: ops };
};
