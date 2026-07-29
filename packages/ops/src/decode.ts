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

import { controlValueDefaults, projectSelectionField } from '@fuaran-ui/schema';
import type {
  Accessibility,
  Action,
  Agg,
  AggFn,
  AriaRole,
  BadgeSpec,
  BinOp,
  Cell,
  ColExpr,
  ColPair,
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
  WindowFn,
  LinkSpec,
  BadgeVariant,
  Binding,
  BoxLayout,
  BoxRole,
  BoxSpec,
  CallResultTarget,
  ButtonSpec,
  ButtonVariant,
  CalloutSpec,
  CellFormat,
  CellKindErased,
  ChartKind,
  ChartSpec,
  ColumnErased,
  ColumnWidth,
  ContentHash,
  DateVariant,
  DeterminismSource,
  DisclosureSpec,
  DisplayKind,
  EffectClass,
  Emphasis,
  ImageSpec,
  ImageVariant,
  ListSpec,
  ModalSpec,
  ScrollAreaSpec,
  ScrollOrientation,
  ToastSpec,
  CodeBlockSpec,
  CurveCommand,
  DrawPoint,
  DrawStyle,
  DrawingSpec,
  Shape,
  ViewBox,
  MathSpec,
  MathDisplay,
  FontVoice,
  StyleRole,
  ErrorPayload,
  FileReadEncoding,
  FileUploadSpec,
  FilterSpec,
  FragmentArg,
  FragmentScalar,
  Format,
  FormField,
  FormFieldKind,
  FormSpec,
  FragmentId,
  GridSpec,
  HashStrictness,
  HeadingSpec,
  HeadingVariant,
  HoleDecl,
  HoleValueSpace,
  HostEffect,
  IconSource,
  InputKind,
  JsonValue,
  MapMarker,
  MetricSpec,
  LabelValueRowSpec,
  FactSpec,
  LayoutKind,
  LiveRegionKind,
  LocaleSource,
  LocalFlushTrigger,
  MarkdownSpec,
  Node,
  NodeId,
  NodeKind,
  Orientation,
  ProgressSpec,
  Result,
  SelectOption,
  SelectSpec,
  SemanticStyle,
  SkeletonSpec,
  SparklineSpec,
  SplitPanelSpec,
  StateBehaviour,
  SummaryListSpec,
  StepperSpec,
  StyleWeight,
  TabHeader,
  TableSpec,
  TabsSpec,
  TextAnchor,
  TextSource,
  ToneVariant,
  VisKind,
} from '@fuaran-ui/schema';

import { type JsonAst, parse } from './parse.js';
import type { TreeOp } from './treeOp.js';

// ─── DecodeError surface ─────────────────────────────────────────────────────

/** Stable AI-friendly discriminator for decode-time failures (WIRE_FORMAT.md §6). */
export type DecodeErrorCode =
  | 'INVALID_JSON'
  | 'MISSING_FIELD'
  | 'WRONG_TYPE'
  | 'UNKNOWN_DU_CASE'
  | 'WRONG_NODE_KIND'
  | 'EMPTY_NODE_ID';

/** AI-recoverable decode-time failure. Mirrors the F# `DecodeError` record. */
export interface DecodeError {
  readonly code: DecodeErrorCode;
  readonly path: string;
  readonly message: string;
  readonly expectedShape?: string;
}

type R<T> = Result<T, DecodeError>;

const ok = <T>(value: T): R<T> => ({ ok: true, value });

const makeError = (
  code: DecodeErrorCode,
  path: string,
  message: string,
  expectedShape?: string,
): R<never> => ({
  ok: false,
  error:
    expectedShape === undefined ? { code, path, message } : { code, path, message, expectedShape },
});

const missingField = (path: string, key: string, expected: string): R<never> =>
  makeError('MISSING_FIELD', `${path}.${key}`, `missing required field '${key}'`, expected);

const wrongType = (path: string, expected: string): R<never> =>
  makeError('WRONG_TYPE', path, `expected ${expected}`, expected);

const unknownDuCase = (path: string, got: string, expected: string): R<never> =>
  makeError('UNKNOWN_DU_CASE', `${path}.$type`, `unknown discriminator '${got}'`, expected);

const CLOSURE = '<closure>';
const OPAQUE = '<opaque>';

// ─── AST require-helpers ─────────────────────────────────────────────────────

type Fields = ReadonlyMap<string, JsonAst>;

const requireObject = (path: string, j: JsonAst): R<Fields> =>
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

const requireString = (path: string, jRaw: JsonAst): R<string> => {
  const j = unwrapStaticEnvelope(jRaw);
  return j.kind === 'JString' ? ok(j.value) : wrongType(path, 'JSON string');
};

const requireBool = (path: string, jRaw: JsonAst): R<boolean> => {
  const j = unwrapStaticEnvelope(jRaw);
  return j.kind === 'JBool' ? ok(j.value) : wrongType(path, 'JSON boolean');
};

const requireFloat = (path: string, jRaw: JsonAst): R<number> => {
  const j = unwrapStaticEnvelope(jRaw);
  if (j.kind === 'JNumber') return ok(j.value);
  if (j.kind === 'JString') {
    if (j.value === 'NaN') return ok(NaN);
    if (j.value === 'Infinity') return ok(Infinity);
    if (j.value === '-Infinity') return ok(-Infinity);
  }
  return wrongType(path, "JSON number (or 'NaN' / 'Infinity' / '-Infinity' sentinel string)");
};

const requireInt = (path: string, jRaw: JsonAst): R<number> => {
  const j = unwrapStaticEnvelope(jRaw);
  return j.kind === 'JNumber' ? ok(Math.trunc(j.value)) : wrongType(path, 'JSON number (integer)');
};

const requireArray = (path: string, j: JsonAst): R<readonly JsonAst[]> =>
  j.kind === 'JArray' ? ok(j.items) : wrongType(path, 'JSON array');

const tryField = (fields: Fields, key: string): JsonAst | undefined => fields.get(key);

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
  path: string,
  fields: Fields,
  key: string,
  expected: string,
  dec: (p: string, j: JsonAst) => R<T>,
): R<T> => {
  const v = requireField(path, fields, key, expected);
  return v.ok ? dec(`${path}.${key}`, v.value) : v;
};

/** Decode an optional field; absent → `undefined` (None per WIRE_FORMAT.md §2 rule 4). */
const optField = <T>(
  path: string,
  fields: Fields,
  key: string,
  dec: (p: string, j: JsonAst) => R<T>,
): R<T | undefined> => {
  const v = tryField(fields, key);
  if (v === undefined) return ok(undefined);
  return dec(`${path}.${key}`, v);
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
    const w = tryField(fields, a);
    if (w !== undefined) return w;
  }
  return undefined;
};

/** `reqField` with decode-only field-name aliases; the error names the canonical key. */
const reqFieldAliased = <T>(
  path: string,
  fields: Fields,
  canonical: string,
  aliases: readonly string[],
  expected: string,
  dec: (p: string, j: JsonAst) => R<T>,
): R<T> => {
  const v = fieldAliased(fields, canonical, aliases);
  if (v === undefined) return missingField(path, canonical, expected);
  return dec(`${path}.${canonical}`, v);
};

/** `optField` with decode-only field-name aliases. */
const optFieldAliased = <T>(
  path: string,
  fields: Fields,
  canonical: string,
  aliases: readonly string[],
  dec: (p: string, j: JsonAst) => R<T>,
): R<T | undefined> => {
  const v = fieldAliased(fields, canonical, aliases);
  if (v === undefined) return ok(undefined);
  return dec(`${path}.${canonical}`, v);
};

const traverseIndexed = <T>(
  items: readonly JsonAst[],
  f: (i: number, j: JsonAst) => R<T>,
): R<T[]> => {
  const out: T[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const r = f(i, items[i]!);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return ok(out);
};

// ─── obj-erased value decode (port of decodeObj) ─────────────────────────────

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
      const o: Record<string, unknown> = {};
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

const decodeJVal = (path: string, j: JsonAst): R<JsonValue> => {
  switch (j.kind) {
    case 'JNull':
      return nullNotRepresentable(path);
    case 'JString':
      return ok(j.value);
    case 'JBool':
      return ok(j.value);
    case 'JNumber':
      return ok(j.value);
    case 'JArray': {
      const out: JsonValue[] = [];
      for (let i = 0; i < j.items.length; i += 1) {
        const r = decodeJVal(`${path}[${i}]`, j.items[i]!);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return ok(out);
    }
    case 'JObject': {
      const out: Record<string, JsonValue> = {};
      for (const [k, v] of j.fields) {
        const r = decodeJVal(`${path}.${k}`, v);
        if (!r.ok) return r;
        out[k] = r.value;
      }
      return ok(out);
    }
  }
};

const decodeJValMap = (path: string, j: JsonAst): R<Record<string, JsonValue>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of fo.value) {
    const r = decodeJVal(`${path}.${k}`, v);
    if (!r.ok) return r;
    out[k] = r.value;
  }
  return ok(out);
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
  return unknownDuCase(path, j.value, valid.join(' | '));
};

const ORIENTATION_ALIASES: Readonly<Record<string, Orientation>> = {
  // CSS flex-direction prior: a row lays out horizontally, a column vertically.
  Row: 'Horizontal',
  row: 'Horizontal',
  Column: 'Vertical',
  column: 'Vertical',
};

const decodeOrientation = (p: string, j: JsonAst): R<Orientation> => {
  if (j.kind === 'JString' && j.value in ORIENTATION_ALIASES)
    return ok(ORIENTATION_ALIASES[j.value]!);
  return bareEnum(p, j, ['Vertical', 'Horizontal'] as const, 'Orientation');
};

const decodeBadgeVariant = (p: string, j: JsonAst): R<BadgeVariant> => {
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

const decodeButtonVariant = (p: string, j: JsonAst): R<ButtonVariant> => {
  // Bootstrap's Danger names the same concept as Destructive (WIRE_FORMAT 3.6).
  if (j.kind === 'JString' && j.value === 'Danger') return ok('Destructive');
  return bareEnum(
    p,
    j,
    ['Primary', 'Secondary', 'Tertiary', 'Destructive'] as const,
    'ButtonVariant',
  );
};

const decodeHeadingVariant = (p: string, j: JsonAst): R<HeadingVariant> => {
  // Default -> the identity case; Title/Page/Section stay rejects (ambiguous mapping).
  if (j.kind === 'JString' && j.value === 'Default') return ok('Standard');
  return bareEnum(p, j, ['Standard', 'Eyebrow', 'Caption', 'Lead'] as const, 'HeadingVariant');
};

const decodeImageVariant = (p: string, j: JsonAst): R<ImageVariant> =>
  bareEnum(p, j, ['Default', 'Avatar', 'Rounded'] as const, 'ImageVariant');

const decodeScrollOrientation = (p: string, j: JsonAst): R<ScrollOrientation> =>
  bareEnum(p, j, ['Vertical', 'Horizontal', 'Both'] as const, 'ScrollOrientation');

const decodeDateVariant = (p: string, j: JsonAst): R<DateVariant> =>
  bareEnum(p, j, ['Date', 'Time', 'DateTime'] as const, 'DateVariant');

const decodeMathDisplay = (p: string, j: JsonAst): R<MathDisplay> =>
  bareEnum(p, j, ['Inline', 'Block'] as const, 'MathDisplay');

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

const decodeTone = (p: string, j: JsonAst): R<ToneVariant> => {
  if (j.kind === 'JString' && j.value in TONE_ALIASES) return ok(TONE_ALIASES[j.value]!);
  return bareEnum(
    p,
    j,
    ['Default', 'Subdued', 'Brand', 'Success', 'Warning', 'Critical', 'Info'] as const,
    'ToneVariant',
  );
};

const decodeWeight = (p: string, j: JsonAst): R<StyleWeight> =>
  // StyleWeight deliberately not aliased — `Bold`/`Heavy` is font-weight intent, but
  // Compact|Standard|Spacious means density (WIRE_FORMAT.md §3.6).
  bareEnum(p, j, ['Compact', 'Standard', 'Spacious'] as const, 'StyleWeight');

const decodeEmphasis = (p: string, j: JsonAst): R<Emphasis> => {
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
const decodeEmphasisFlag = (p: string, j: JsonAst): R<boolean> => {
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
  return requireBool(p, j);
};

// Phase 528.1 — SVG text-anchor for DrawStyle (Shape.Label alignment).
const decodeTextAnchor = (p: string, j: JsonAst): R<TextAnchor> =>
  bareEnum(p, j, ['Start', 'Middle', 'End'] as const, 'TextAnchor');

// Phase 147 — the additive style-role / font-voice DUs. Optional on the wire
// (omitted at default); the style decoder restores the default on absence.
const decodeStyleRole = (p: string, j: JsonAst): R<StyleRole> =>
  bareEnum(p, j, ['None', 'Eyebrow', 'Data', 'Lede', 'Caption'] as const, 'StyleRole');

const decodeFontVoice = (p: string, j: JsonAst): R<FontVoice> =>
  bareEnum(p, j, ['Default', 'Display', 'Structural'] as const, 'FontVoice');

const decodeChartKind = (p: string, j: JsonAst): R<ChartKind> =>
  bareEnum(p, j, ['Line', 'Bar', 'Area', 'Pie', 'Scatter', 'Heatmap'] as const, 'ChartKind');

const decodeFileReadEncoding = (p: string, j: JsonAst): R<FileReadEncoding> =>
  bareEnum(p, j, ['Text', 'Base64', 'DataUrl'] as const, 'FileReadEncoding');

const NAMED_ARIA_ROLES = [
  'button',
  'link',
  'dialog',
  'alert',
  'status',
  'banner',
  'navigation',
  'main',
  'form',
  'region',
  'heading',
  'progressbar',
  'tab',
  'tablist',
  'tabpanel',
] as const;

const decodeAriaRole = (p: string, j: JsonAst): R<AriaRole> => {
  // Any string is accepted — named roles or the AriaRole.Custom raw escape
  // (WIRE_FORMAT.md §10.2: both encode as the raw string, decode prefers it).
  if (j.kind !== 'JString') return wrongType(p, 'JSON string (ARIA role)');
  return ok(j.value as AriaRole);
};

const decodeLiveRegion = (p: string, j: JsonAst): R<LiveRegionKind> =>
  bareEnum(p, j, ['polite', 'assertive', 'off'] as const, 'LiveRegionKind');

// ─── CellFormat / ColumnWidth / IconSource ───────────────────────────────────

const decodeCellFormat = (path: string, j: JsonAst): R<CellFormat> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'None':
      return ok({ kind: 'None' });
    case 'Number': {
      const dec = tryField(f, 'decimals');
      if (dec === undefined) return ok({ kind: 'Number' });
      const r = requireInt(`${path}.decimals`, dec);
      return r.ok ? ok({ kind: 'Number', decimals: r.value }) : r;
    }
    case 'Currency': {
      const r = reqField(path, f, 'code', 'ISO currency code string', requireString);
      if (!r.ok) return r;
      return ok<CellFormat>({ kind: 'Currency', code: r.value });
    }
    case 'Percent': {
      const dec = tryField(f, 'decimals');
      if (dec === undefined) return ok({ kind: 'Percent' });
      const r = requireInt(`${path}.decimals`, dec);
      return r.ok ? ok({ kind: 'Percent', decimals: r.value }) : r;
    }
    case 'SignificantDigits': {
      const r = reqField(path, f, 'digits', 'integer digit count', requireInt);
      return r.ok ? ok({ kind: 'SignificantDigits', digits: r.value }) : r;
    }
    case 'Date': {
      const r = reqField(path, f, 'format', 'format string', requireString);
      return r.ok ? ok({ kind: 'Date', format: r.value }) : r;
    }
    case 'Custom':
      return ok({ kind: 'Custom', format: () => CLOSURE });
    default:
      return unknownDuCase(
        path,
        d.value,
        'None | Number | Currency | Percent | SignificantDigits | Date | Custom',
      );
  }
};

// ─── Format / LocaleSource (Phase 102) ───────────────────────────────────────

const decodeFormat = (path: string, j: JsonAst): R<Format> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Number': {
      const dec = tryField(f, 'decimals');
      if (dec === undefined) return ok({ kind: 'Number' });
      const r = requireInt(`${path}.decimals`, dec);
      return r.ok ? ok({ kind: 'Number', decimals: r.value }) : r;
    }
    case 'Currency': {
      const r = reqField(path, f, 'isoCode', 'ISO-4217 currency code string', requireString);
      return r.ok ? ok<Format>({ kind: 'Currency', isoCode: r.value }) : r;
    }
    case 'Percent': {
      const dec = tryField(f, 'decimals');
      if (dec === undefined) return ok({ kind: 'Percent' });
      const r = requireInt(`${path}.decimals`, dec);
      return r.ok ? ok({ kind: 'Percent', decimals: r.value }) : r;
    }
    case 'Date': {
      const r = reqField(path, f, 'dateStyle', 'DateStyle string', (p, v) =>
        bareEnum(p, v, ['Short', 'Medium', 'Long', 'Full'] as const, 'DateStyle'),
      );
      return r.ok ? ok<Format>({ kind: 'Date', dateStyle: r.value }) : r;
    }
    case 'RelativeTime': {
      const r = reqField(path, f, 'unit', 'RelativeTimeUnit string', (p, v) =>
        bareEnum(
          p,
          v,
          ['Second', 'Minute', 'Hour', 'Day', 'Week', 'Month', 'Year'] as const,
          'RelativeTimeUnit',
        ),
      );
      return r.ok ? ok<Format>({ kind: 'RelativeTime', unit: r.value }) : r;
    }
    default:
      return unknownDuCase(path, d.value, 'Number | Currency | Percent | Date | RelativeTime');
  }
};

const decodeLocaleSource = (path: string, j: JsonAst): R<LocaleSource> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Ambient':
      return ok({ kind: 'Ambient' });
    case 'Explicit': {
      const r = reqField(path, f, 'tag', 'BCP-47 locale tag string', requireString);
      return r.ok ? ok<LocaleSource>({ kind: 'Explicit', tag: r.value }) : r;
    }
    default:
      return unknownDuCase(path, d.value, 'Ambient | Explicit');
  }
};

const decodeColumnWidth = (path: string, j: JsonAst): R<ColumnWidth> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Auto':
      return ok({ kind: 'Auto' });
    case 'Fixed': {
      const r = reqField(path, f, 'pixels', 'integer pixel count', requireInt);
      return r.ok ? ok({ kind: 'Fixed', pixels: r.value }) : r;
    }
    case 'Flex': {
      const r = reqField(path, f, 'weight', 'float weight', requireFloat);
      return r.ok ? ok({ kind: 'Flex', weight: r.value }) : r;
    }
    default:
      return unknownDuCase(path, d.value, 'Auto | Fixed | Flex');
  }
};

const decodeIconSource = (path: string, j: JsonAst): R<IconSource> => {
  const r = requireString(path, j);
  return r.ok ? ok(r.value as IconSource) : r;
};

// ─── LocalFlushTrigger / Binding (recursive) ─────────────────────────────────

const decodeLocalFlushTrigger = (path: string, j: JsonAst): R<LocalFlushTrigger> => {
  const fo = requireObject(path, j);
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
      const r = reqField(path, f, 'milliseconds', 'debounce milliseconds integer', requireInt);
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

const COMPUTE_COLUMN_TYPES: readonly ColumnType[] = [
  'int',
  'float',
  'bool',
  'string',
  'date',
  'timestamp',
];
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
const cInt = (j: JsonAst): CR<number> =>
  j.kind === 'JNumber'
    ? cok(Math.trunc(j.value))
    : cerr('malformed: expected int, got ' + astKind(j));

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
      return v.kind === 'JNumber' ? cok({ kind: 'Int', value: Math.trunc(v.value) }) : mismatch;
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
    default:
      return mismatch;
  }
};

/**
 * fuaran-core#94 (lenient-ingest) — render an epoch-seconds instant as the
 * canonical ISO-8601 UTC timestamp string. Pure integer arithmetic
 * (civil-from-days), clock-free; negative epochs (pre-1970) are handled.
 * Every division mirrors the F# int64 truncating division.
 */
const isoOfEpochSeconds = (secs: number): string => {
  let days = Math.trunc(secs / 86400);
  if (secs % 86400 < 0) days -= 1;
  const sod = secs - days * 86400;
  const z = days + 719468;
  const era = Math.trunc((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.trunc(
    (doe - Math.trunc(doe / 1460) + Math.trunc(doe / 36524) - Math.trunc(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.trunc(yoe / 4) - Math.trunc(yoe / 100));
  const mp = Math.trunc((5 * doy + 2) / 153);
  const day = doy - Math.trunc((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const p4 = (n: number): string => String(n).padStart(4, '0');
  return `${p4(year)}-${p2(month)}-${p2(day)}T${p2(Math.trunc(sod / 3600))}:${p2(Math.trunc((sod % 3600) / 60))}:${p2(sod % 60)}Z`;
};

/**
 * One present column cell decoded against its declared type — port of F#
 * `decodeCell`. A float column accepts an integer JSON token (lossless
 * widening); a timestamp column accepts a whole-valued epoch number
 * (fuaran-core#94 — models emit epoch instants against their own correct
 * `"timestamp"` schema; unit by magnitude: ≥ 1e11 ⇒ milliseconds, else
 * seconds — epoch-seconds stay below 1e11 until year 5138). Every other type
 * requires its exact JSON kind.
 */
const decodeColumnCell = (colName: string, ty: ColumnType, v: JsonAst): CR<Cell> => {
  const mismatch = cerr(`column '${colName}': expected ${ty} value, got ${astKind(v)}`);
  switch (ty) {
    case 'int':
      return v.kind === 'JNumber' ? cok({ kind: 'Int', value: Math.trunc(v.value) }) : mismatch;
    case 'float':
      return v.kind === 'JNumber' ? cok({ kind: 'Float', value: v.value }) : mismatch;
    case 'bool':
      return v.kind === 'JBool' ? cok({ kind: 'Bool', value: v.value }) : mismatch;
    case 'string':
      return v.kind === 'JString' ? cok({ kind: 'Str', value: v.value }) : mismatch;
    case 'date':
      return v.kind === 'JString' ? cok({ kind: 'Date', value: v.value }) : mismatch;
    case 'timestamp': {
      if (v.kind === 'JString') return cok({ kind: 'Timestamp', value: v.value });
      // Whole-valued epoch number (the F# JInt path + the whole-JFloat path,
      // unified — TS has one number kind); |x| ≥ 9e15 stays a mismatch.
      if (v.kind === 'JNumber' && v.value === Math.floor(v.value) && Math.abs(v.value) < 9e15) {
        const secs = Math.abs(v.value) >= 100_000_000_000 ? Math.trunc(v.value / 1000) : v.value;
        return cok({ kind: 'Timestamp', value: isoOfEpochSeconds(secs) });
      }
      return mismatch;
    }
    default:
      return mismatch;
  }
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
    if (!COMPUTE_COLUMN_TYPES.includes(ty.value as ColumnType)) {
      return cerr(
        `unknown column type '${ty.value}'; expected one of: ${COMPUTE_COLUMN_TYPES.join(', ')}`,
      );
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
  const values = { ok: true as const, value: parts.value[0] };
  const validity = { ok: true as const, value: parts.value[1] };
  if (values.value.length !== validity.value.length) {
    return cerr(
      `column '${name}': values/validity length mismatch (${values.value.length} vs ${validity.value.length})`,
    );
  }
  const cells: Cell[] = [];
  for (let i = 0; i < values.value.length; i += 1) {
    const p = validity.value[i]!;
    if (p.kind !== 'JBool') {
      return cerr(`malformed: ${name}.validity: expected bool, got ${astKind(p)}`);
    }
    if (!p.value) {
      cells.push({ kind: 'Null' });
    } else {
      const c = decodeColumnCell(name, ty, values.value[i]!);
      if (!c.ok) return c;
      cells.push(c.value);
    }
  }
  return cok<DataColumn>({ name, type: ty, cells });
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
const decodeDataSource = (j: JsonAst): CR<DataSource> => {
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
      if (!COMPUTE_COLUMN_TYPES.includes(ty.value as ColumnType)) {
        return cerr(
          `unknown column type '${ty.value}'; expected one of: ${COMPUTE_COLUMN_TYPES.join(', ')}`,
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
  // fuaran-core#92 — sort-key aliases: `column` for `col`, boolean `descending` for `dir`.
  const fo = cFields(j);
  if (!fo.ok) return fo;
  const colEl = cFieldAliased(fo.value, 'col', 'column');
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
      const cj = cField(f, 'cols');
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
    default:
      return cerr(
        `unknown column type '${k.value}'; expected one of: filter, project, derive, groupBy, join, window, pivot, unpivot, sort, distinct, limit, union`,
      );
  }
};

const decodePipelineCore = (j: JsonAst): CR<Transform[]> => {
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
const decodeInvokeArgs = (path: string, j: JsonAst): R<InvokeArg[]> => {
  if (j.kind !== 'JArray') return wrongType(path, 'JSON array of invoke args');
  return traverseIndexed(j.items, (i, el) => {
    const p = `${path}[${i}]`;
    const m = requireObject(p, el);
    if (!m.ok) return m;
    const addr = reqField(p, m.value, 'addr', 'invoke arg addr string', requireString);
    if (!addr.ok) return addr;
    const value = reqField(p, m.value, 'value', 'invoke arg value string', requireString);
    if (!value.ok) return value;
    return ok<InvokeArg>({ addr: addr.value, value: value.value });
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
  path: string,
  j: JsonAst,
  parseStatic: (p: string, v: JsonAst) => R<unknown> = (_p, v) => ok(decodeAstValue(v)),
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
    const parsed = parseStatic(path, j);
    return parsed.ok ? ok({ kind: 'Static', value: parsed.value }) : parsed;
  }
  const fo = requireObject(path, j);
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
      const parsed = parseStatic(`${path}.value`, raw);
      return parsed.ok ? ok({ kind: 'Static', value: parsed.value }) : parsed;
    }
    case 'Query': {
      const r = reqField(path, f, 'name', 'query name string', requireString);
      if (!r.ok) return r;
      // Phase 421 — optional `dependsOn` string array (the declared filter edge); absent → omitted.
      const dependsOnField = fieldAliased(f, 'dependsOn', ['deps', 'dependencies']);
      let dependsOn: readonly string[] | undefined;
      if (dependsOnField !== undefined) {
        const arr = requireArray(`${path}.dependsOn`, dependsOnField);
        if (!arr.ok) return arr;
        const strs = traverseIndexed(arr.value, (_i, el) =>
          requireString(`${path}.dependsOn[]`, el),
        );
        if (!strs.ok) return strs;
        dependsOn = strs.value;
      }
      // Phase 421 identity-accessor fix: project the host's queryResults value straight through
      // (`(raw) => raw`) instead of discarding it, so host-fed data flows through decoded trees.
      return ok({
        kind: 'Query',
        name: r.value,
        accessor: (raw: unknown) => raw,
        ...(dependsOn !== undefined ? { dependsOn } : {}),
      });
    }
    case 'Filter': {
      const r = reqField(path, f, 'name', 'filter name string', requireString);
      if (!r.ok) return r;
      // 0.2.0 — optional `defaultValue`: the value the resolver yields (and
      // the renderer seeds the store with) before the filter is first
      // written. Decoded through the slot's typed static parser, mirroring
      // `State.defaultValue`; an absent / unparseable default stays omitted.
      const dv = tryField(f, 'defaultValue');
      let defaultValue: unknown;
      let hasDefault = false;
      if (dv !== undefined) {
        const parsed = parseStatic(`${path}.defaultValue`, dv);
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
      const r = reqField(path, f, 'nodeId', 'selection NodeId string', requireString);
      if (!r.ok) return r;
      // 0.2.9 (Phase 629) — optional `defaultValue`, the `Filter.defaultValue`
      // convention: yielded until the user first selects a row on `nodeId`.
      const dv = tryField(f, 'defaultValue');
      let defaultValue: unknown;
      let hasDefault = false;
      if (dv !== undefined) {
        const parsed = parseStatic(`${path}.defaultValue`, dv);
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
        const s = requireString(`${path}.field`, fv);
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
      const key = reqField(path, f, 'key', 'state key string', requireString);
      if (!key.ok) return key;
      // Decode the carried `defaultValue` through the slot's static parser
      // when it parses (Phase 426/429); an absent / unparseable default falls
      // back to the typed placeholder — byte-for-byte with the F# decoder.
      // Phase 677 — an ABSENT default decodes exactly as the legacy
      // `"defaultValue": null` did, or the encoder re-emits a placeholder and
      // the round-trip breaks.
      const dv =
        fieldAliased(f, 'defaultValue', ['initialValue', 'default']) ??
        ({ kind: 'JNull' } as const);
      let defaultValue: unknown = placeholder;
      if (dv !== undefined) {
        const parsed = parseStatic(`${path}.defaultValue`, dv);
        if (parsed.ok) defaultValue = parsed.value;
      }
      return ok({ kind: 'State', key: key.value, defaultValue });
    }
    case 'Computed':
      return ok({ kind: 'Computed', compute: () => undefined });
    case 'I18n': {
      const key = reqField(path, f, 'key', 'i18n key string', requireString);
      if (!key.ok) return key;
      const argsJ = tryField(f, 'args');
      if (argsJ === undefined) {
        const b: Binding<unknown> = { kind: 'I18n', key: key.value };
        return ok(b);
      }
      const argsR = decodeBindingArgs(`${path}.args`, argsJ);
      if (!argsR.ok) return argsR;
      const b: Binding<unknown> = { kind: 'I18n', key: key.value, args: argsR.value };
      return ok(b);
    }
    case 'Local': {
      // `initialFrom` recurses with the same typed pair (mirror of the F#
      // `bindingGeneric` recursion).
      const initial = reqField(path, f, 'initialFrom', 'Local InitialFrom Binding', (p, v) =>
        decodeBinding(p, v, parseStatic, placeholder),
      );
      if (!initial.ok) return initial;
      const flushJ = tryField(f, 'flushOn');
      const flush =
        flushJ === undefined
          ? ok<LocalFlushTrigger>({ kind: 'OnBlur' })
          : decodeLocalFlushTrigger(`${path}.flushOn`, flushJ);
      if (!flush.ok) return flush;
      const b: Binding<unknown> = {
        kind: 'Local',
        local: {
          initialFrom: initial.value,
          flushOn: flush.value,
          onCommit: () => undefined,
          parse: () => ({ ok: false, error: CLOSURE }),
        },
      };
      return ok(b);
    }
    case 'Format': {
      // Phase 102: source is always a numeric Binding; format / locale are
      // bounded DUs. The case is structurally independent of the slot type.
      const source = reqField(path, f, 'source', 'Binding<number> source object', decodeBinding);
      if (!source.ok) return source;
      const fmtJ = requireField(path, f, 'format', 'Format DU object');
      if (!fmtJ.ok) return fmtJ;
      const fmt = decodeFormat(`${path}.format`, fmtJ.value);
      if (!fmt.ok) return fmt;
      const locJ = requireField(path, f, 'locale', 'LocaleSource DU object');
      if (!locJ.ok) return locJ;
      const loc = decodeLocaleSource(`${path}.locale`, locJ.value);
      if (!loc.ok) return loc;
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
      const srcJ = requireField(path, f, 'source', 'Transform DataSource object');
      if (!srcJ.ok) return srcJ;
      const pipeJ = requireField(path, f, 'pipeline', 'Transform pipeline array');
      if (!pipeJ.ok) return pipeJ;
      const src = decodeDataSource(srcJ.value);
      if (!src.ok) return makeError('WRONG_TYPE', `${path}.source`, src.error);
      const pipe = decodePipelineCore(pipeJ.value);
      if (!pipe.ok) return makeError('WRONG_TYPE', `${path}.pipeline`, pipe.error);
      // Phase 424 — optional `params`: [{ from: <Binding>, name: <string> }, …] binding each
      // `ColExpr.Param` name to a scalar source. Absent → omitted (byte-identical to Phase 282).
      const paramsField = tryField(f, 'params');
      let params: readonly TransformParam[] | undefined;
      if (paramsField !== undefined && paramsField.kind === 'JObject') {
        // Lenient AI-ingest (WIRE_FORMAT.md 3.6, 2026-07-17): the name->binding
        // MAP form coerces to the canonical [{name, from}] array — params are a
        // name-keyed set, so key order carries no meaning. Mirror of F#
        // (Map.toList = sorted keys; sorted here to match).
        const entries = [...paramsField.fields.entries()].sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
        const out: TransformParam[] = [];
        let coerceErr: R<never> | undefined;
        for (const [name, v] of entries) {
          const from = decodeBinding(`${path}.params.${name}.from`, v);
          if (!from.ok) {
            coerceErr = from;
            break;
          }
          out.push({ name, from: from.value });
        }
        if (coerceErr !== undefined) return coerceErr;
        params = out;
      } else if (paramsField !== undefined) {
        const arr = requireArray(`${path}.params`, paramsField);
        if (!arr.ok) return arr;
        const decoded = traverseIndexed(arr.value, (_i, el) => {
          const po = requireObject(`${path}.params[]`, el);
          if (!po.ok) return po;
          const name = reqField(
            `${path}.params[]`,
            po.value,
            'name',
            'param name string',
            requireString,
          );
          if (!name.ok) return name;
          // Field alias: value — the observed repair-attempt shape ({name, value}).
          const from = reqFieldAliased(
            `${path}.params[]`,
            po.value,
            'from',
            ['value'],
            'param source Binding',
            decodeBinding,
          );
          if (!from.ok) return from;
          return ok<TransformParam>({ name: name.value, from: from.value });
        });
        if (!decoded.ok) return decoded;
        params = decoded.value;
      }
      const b: Binding<unknown> = {
        kind: 'Transform',
        source: src.value,
        pipeline: pipe.value,
        ...(params !== undefined ? { params } : {}),
      };
      return ok(b);
    }
    case 'Invoke': {
      // Phase 283 — host-registered capability dispatched for a value.
      const cid = reqField(path, f, 'capabilityId', 'capability id string', requireString);
      if (!cid.ok) return cid;
      const argsJ = requireField(path, f, 'args', 'invoke args array');
      if (!argsJ.ok) return argsJ;
      const args = decodeInvokeArgs(`${path}.args`, argsJ.value);
      if (!args.ok) return args;
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
      return decodeBinding(`${path}.binding`, inner.value, parseStatic, placeholder);
    }
    default:
      return unknownDuCase(
        path,
        d.value,
        'Static | Query | Filter | Selection | State | Computed | I18n | Local | Format | Transform | Invoke',
      );
  }
};

const decodeBindingArgs = (path: string, j: JsonAst): R<Record<string, Binding<JsonValue>>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const out: Record<string, Binding<JsonValue>> = {};
  for (const [k, v] of fo.value) {
    const r = decodeBinding(`${path}.${k}`, v);
    if (!r.ok) return r;
    out[k] = r.value as Binding<JsonValue>;
  }
  return ok(out);
};

const decodeBindingString = (p: string, j: JsonAst): R<Binding<string>> =>
  decodeBinding(p, j) as R<Binding<string>>;
const decodeBindingBool = (p: string, j: JsonAst): R<Binding<boolean>> =>
  decodeBinding(p, j) as R<Binding<boolean>>;

// ─── Typed Static payload decoders (Phase 429) ───────────────────────────────
//
// Mirrors of the F# `decodeBinding*` family: the typed wire form is preferred
// (the encoder emits it since 429), the legacy `"<opaque>"` sentinel decodes
// to a tagged placeholder (whose typed re-encode is byte-stable across both
// hosts), and JSON `null` — the pre-429 F# boxes-to-null empty-collection
// form — decodes to the typed empty. Only genuinely host-typed payloads
// (grid/table row seqs) stay on the generic `decodeAstValue` path by design.

const OPTIONS_PLACEHOLDER: readonly SelectOption[] = [
  { value: OPAQUE, label: { kind: 'Literal', value: OPAQUE } },
];

const decodeSelectOption = (path: string, j: JsonAst): R<SelectOption> => {
  // Lenient AI-ingest shape coercion (WIRE_FORMAT.md §3.6): a bare string
  // element coerces to `{value: s, label: Literal s}` — the HTML `<select>`
  // prior. The value→label map form (`{"A":"A"}`) is deliberately NOT
  // coerced: JSON key order is not contractual, so it could silently reorder
  // visible options. Mirror of F# `decodeSelectOption`.
  if (j.kind === 'JString') {
    return ok<SelectOption>({ value: j.value, label: { kind: 'Literal', value: j.value } });
  }
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const value = reqField(path, fo.value, 'value', 'option value string', requireString);
  if (!value.ok) return value;
  const label = reqField(path, fo.value, 'label', 'option label TextSource', decodeTextSource);
  if (!label.ok) return label;
  return ok<SelectOption>({ value: value.value, label: label.value });
};

const parseStaticSelectOptions = (p: string, v: JsonAst): R<unknown> => {
  if (v.kind === 'JNull') return ok([]); // pre-429 read-compat: empty list boxed to `null`
  if (v.kind === 'JString' && v.value === OPAQUE) return ok(OPTIONS_PLACEHOLDER);
  const arr = requireArray(p, v);
  if (!arr.ok) return arr;
  return traverseIndexed(arr.value, (i, el) => decodeSelectOption(`${p}[${i}]`, el));
};

const decodeBindingSelectOptions = (p: string, j: JsonAst): R<Binding<readonly SelectOption[]>> =>
  decodeBinding(p, j, parseStaticSelectOptions, OPTIONS_PLACEHOLDER) as R<
    Binding<readonly SelectOption[]>
  >;

const parseStaticStringOpt = (p: string, v: JsonAst): R<unknown> => {
  if (v.kind === 'JNull') return ok(undefined);
  if (v.kind === 'JString') return ok(v.value); // includes the opaque sentinel (read-compat)
  return wrongType(p, 'JSON string or null (string option)');
};

const decodeBindingStringOpt = (p: string, j: JsonAst): R<Binding<string | undefined>> =>
  decodeBinding(p, j, parseStaticStringOpt, OPAQUE) as R<Binding<string | undefined>>;

const parseStaticFloatPair = (p: string, v: JsonAst): R<unknown> => {
  // 0.2.0 — the dual-thumb Range control's [min, max] pair. Static forms:
  // the object `{min, max}` (canonical) or a two-element array (lenient).
  if (v.kind === 'JObject') {
    const mn = v.fields.get('min');
    const mx = v.fields.get('max');
    if (mn !== undefined && mx !== undefined) {
      const a = requireFloat(`${p}.min`, mn);
      if (!a.ok) return a;
      const b = requireFloat(`${p}.max`, mx);
      if (!b.ok) return b;
      return ok([a.value, b.value] as const);
    }
    return wrongType(p, 'object with min and max numbers');
  }
  if (v.kind === 'JArray' && v.items.length === 2) {
    const a = requireFloat(`${p}[0]`, v.items[0] as JsonAst);
    if (!a.ok) return a;
    const b = requireFloat(`${p}[1]`, v.items[1] as JsonAst);
    if (!b.ok) return b;
    return ok([a.value, b.value] as const);
  }
  return wrongType(p, 'range pair ({min, max} object or [min, max] array)');
};

const decodeBindingFloatPair = (p: string, j: JsonAst): R<Binding<readonly [number, number]>> => {
  // The canonical Static pair rides as the BARE `{min, max}` object (the
  // Phase-423 range shape, no envelope) — accept it before the generic
  // binding dispatch, which would otherwise demand a `$type`.
  if (
    j.kind === 'JObject' &&
    j.fields.get('$type') === undefined &&
    j.fields.get('min') !== undefined &&
    j.fields.get('max') !== undefined
  ) {
    const parsed = parseStaticFloatPair(p, j);
    return parsed.ok
      ? ok({ kind: 'Static', value: parsed.value as readonly [number, number] })
      : parsed;
  }
  return decodeBinding(p, j, parseStaticFloatPair, [0, 0] as const) as R<
    Binding<readonly [number, number]>
  >;
};

const parseStaticStringPair = (p: string, v: JsonAst): R<unknown> => {
  // Phase 725 — the DateRange control's (from, to) ISO-8601 pair. Mirrors
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
          `date-range start '${a}' is after end '${b}' — a DateRange pair is ordered (from <= to); ISO-8601 strings of one variant compare lexicographically, so swap the two values`,
          'ordered ISO-8601 pair ({"from": <iso>, "to": <iso>} with from <= to)',
        )
      : ok([a, b] as const);
  if (v.kind === 'JObject') {
    const from = v.fields.get('from');
    const to = v.fields.get('to');
    if (from !== undefined && to !== undefined) {
      const a = requireString(`${p}.from`, from);
      if (!a.ok) return a;
      const b = requireString(`${p}.to`, to);
      if (!b.ok) return b;
      return ordered(a.value, b.value);
    }
    return wrongType(p, 'object with from and to ISO-8601 strings');
  }
  if (v.kind === 'JArray' && v.items.length === 2) {
    const a = requireString(`${p}[0]`, v.items[0] as JsonAst);
    if (!a.ok) return a;
    const b = requireString(`${p}[1]`, v.items[1] as JsonAst);
    if (!b.ok) return b;
    return ordered(a.value, b.value);
  }
  return wrongType(p, 'date-range pair ({from, to} object or [from, to] array)');
};

const decodeBindingStringPair = (p: string, j: JsonAst): R<Binding<readonly [string, string]>> => {
  // The canonical Static pair rides as the BARE `{from, to}` object (the
  // `Range` posture, no envelope) — accept it before the generic binding
  // dispatch, which would otherwise demand a `$type`.
  if (
    j.kind === 'JObject' &&
    j.fields.get('$type') === undefined &&
    j.fields.get('from') !== undefined &&
    j.fields.get('to') !== undefined
  ) {
    const parsed = parseStaticStringPair(p, j);
    return parsed.ok
      ? ok({ kind: 'Static', value: parsed.value as readonly [string, string] })
      : parsed;
  }
  return decodeBinding(p, j, parseStaticStringPair, ['', ''] as const) as R<
    Binding<readonly [string, string]>
  >;
};

const parseStaticStringList = (p: string, v: JsonAst): R<unknown> => {
  if (v.kind === 'JNull') return ok([]);
  if (v.kind === 'JString' && v.value === OPAQUE) return ok([OPAQUE]);
  const arr = requireArray(p, v);
  if (!arr.ok) return arr;
  return traverseIndexed(arr.value, (i, el) => requireString(`${p}[${i}]`, el));
};

const decodeBindingStringList = (p: string, j: JsonAst): R<Binding<readonly string[]>> =>
  decodeBinding(p, j, parseStaticStringList, [OPAQUE]) as R<Binding<readonly string[]>>;

const parseStaticFloatSeq = (p: string, v: JsonAst): R<unknown> => {
  if (v.kind === 'JNull') return ok([]); // pre-429 read-compat: empty list-backed seq boxed to `null`
  if (v.kind === 'JString' && v.value === OPAQUE) return ok([]);
  const arr = requireArray(p, v);
  if (!arr.ok) return arr;
  return traverseIndexed(arr.value, (i, el) => requireFloat(`${p}[${i}]`, el));
};

const decodeBindingFloatSeq = (p: string, j: JsonAst): R<Binding<readonly number[]>> =>
  decodeBinding(p, j, parseStaticFloatSeq, []) as R<Binding<readonly number[]>>;

const decodeMapMarker = (path: string, j: JsonAst): R<MapMarker> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const label = reqField(path, fo.value, 'label', 'marker label TextSource', decodeTextSource);
  if (!label.ok) return label;
  const latitude = reqField(path, fo.value, 'latitude', 'marker latitude float', requireFloat);
  if (!latitude.ok) return latitude;
  const longitude = reqField(path, fo.value, 'longitude', 'marker longitude float', requireFloat);
  if (!longitude.ok) return longitude;
  return ok<MapMarker>({
    label: label.value,
    latitude: latitude.value,
    longitude: longitude.value,
  });
};

const parseStaticMarkerSeq = (p: string, v: JsonAst): R<unknown> => {
  if (v.kind === 'JNull') return ok([]); // pre-429 read-compat: empty list-backed seq boxed to `null`
  if (v.kind === 'JString' && v.value === OPAQUE) return ok([]);
  const arr = requireArray(p, v);
  if (!arr.ok) return arr;
  return traverseIndexed(arr.value, (i, el) => decodeMapMarker(`${p}[${i}]`, el));
};

const decodeBindingMarkerSeq = (p: string, j: JsonAst): R<Binding<readonly MapMarker[]>> =>
  decodeBinding(p, j, parseStaticMarkerSeq, []) as R<Binding<readonly MapMarker[]>>;

// ─── TextSource / SelectOption ───────────────────────────────────────────────

const decodeTextSource = (path: string, j: JsonAst): R<TextSource> => {
  // 0.2.0 — the bare JSON string IS the canonical Literal form (the encoder
  // emits it); the `{"$type":"Literal"}` envelope stays decode-accepted, so
  // pre-0.2.0 trees keep parsing. Byte-for-byte with the F# decoder.
  if (j.kind === 'JString') return ok({ kind: 'Literal', value: j.value });
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Literal': {
      const r = reqField(path, f, 'text', 'literal text string', requireString);
      return r.ok ? ok({ kind: 'Literal', value: r.value }) : r;
    }
    case 'Bound': {
      const r = reqField(path, f, 'binding', 'Binding<string> object', decodeBindingString);
      if (!r.ok) return r;
      const t: TextSource = { kind: 'Bound', binding: r.value };
      return ok(t);
    }
    case 'I18n': {
      const key = reqField(path, f, 'key', 'i18n key string', requireString);
      if (!key.ok) return key;
      const argsJ = tryField(f, 'args');
      if (argsJ === undefined) {
        const t: TextSource = { kind: 'I18n', key: key.value, args: {} };
        return ok(t);
      }
      const args = decodeJValMap(`${path}.args`, argsJ);
      if (!args.ok) return args;
      const t: TextSource = { kind: 'I18n', key: key.value, args: args.value };
      return ok(t);
    }
    default:
      return unknownDuCase(path, d.value, 'Literal | Bound | I18n');
  }
};

// ─── Action ──────────────────────────────────────────────────────────────────

const decodeAction = (path: string, j: JsonAst): R<Action<unknown>> => {
  // 0.2.2 DIDACTIC — a bare string in an Action slot (the "<closure>"
  // sentinel written as the value). Never coerced (a sentinel action would
  // be a dead control passing the gate); the error names the fix.
  if (j.kind === 'JString') {
    const s = j.value.length > 24 ? j.value.slice(0, 24) + '…' : j.value;
    return wrongType(
      path,
      `JSON object, got the string '${s}' — an action is a $type-discriminated object (SetState | Navigate | Call | Notify | Chain | AiTool | WriteToClipboard | Invoke); "<closure>" is not authorable. Pick a real action, e.g. {"$type":"SetState","key":…,"value":…}`,
    );
  }
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Dispatch':
      return ok({ kind: 'Dispatch', msg: CLOSURE });
    case 'Call': {
      const r = reqFieldAliased(path, f, 'endpoint', ['url'], 'ApiEndpoint string', requireString);
      if (!r.ok) return r;
      // Phase 428: a present `"<closure>"` onResult → the inert placeholder;
      // absent → omitted. `into` is the optional declarative result target.
      const intoJ = tryField(f, 'into');
      let into: CallResultTarget | undefined;
      if (intoJ !== undefined) {
        const io = requireObject(`${path}.into`, intoJ);
        if (!io.ok) return io;
        const id = requireDiscriminator(`${path}.into`, io.value);
        if (!id.ok) return id;
        if (id.value === 'State') {
          const key = reqField(`${path}.into`, io.value, 'key', 'state key string', requireString);
          if (!key.ok) return key;
          into = { kind: 'State', key: key.value };
        } else if (id.value === 'Query') {
          const name = reqField(
            `${path}.into`,
            io.value,
            'name',
            'query name string',
            requireString,
          );
          if (!name.ok) return name;
          into = { kind: 'Query', name: name.value };
        } else {
          return unknownDuCase(`${path}.into`, id.value, 'State | Query');
        }
      }
      return ok({
        kind: 'Call',
        endpoint: r.value as import('@fuaran-ui/schema').ApiEndpoint,
        ...(tryField(f, 'onResult') !== undefined ? { onResult: () => CLOSURE } : {}),
        ...(into !== undefined ? { into } : {}),
      });
    }
    case 'Notify': {
      const channel = reqField(path, f, 'channel', 'notification channel string', requireString);
      if (!channel.ok) return channel;
      const payloadJ = requireField(path, f, 'payload', 'JsonValue payload');
      if (!payloadJ.ok) return payloadJ;
      const payload = decodeJVal(`${path}.payload`, payloadJ.value);
      return payload.ok
        ? ok({ kind: 'Notify', channel: channel.value, payload: payload.value })
        : payload;
    }
    case 'Navigate': {
      const r = reqFieldAliased(
        path,
        f,
        'route',
        ['href', 'url', 'to'],
        'route string',
        requireString,
      );
      return r.ok ? ok({ kind: 'Navigate', route: r.value }) : r;
    }
    case 'SetState': {
      const key = reqField(path, f, 'key', 'state key string', requireString);
      if (!key.ok) return key;
      const valueJ = requireField(path, f, 'value', 'JsonValue value');
      if (!valueJ.ok) return valueJ;
      const value = decodeJVal(`${path}.value`, valueJ.value);
      return value.ok ? ok({ kind: 'SetState', key: key.value, value: value.value }) : value;
    }
    case 'AiTool': {
      const name = reqField(path, f, 'toolName', 'AI tool name string', requireString);
      if (!name.ok) return name;
      const argsJ = requireField(path, f, 'args', 'JsonValue args');
      if (!argsJ.ok) return argsJ;
      const args = decodeJVal(`${path}.args`, argsJ.value);
      return args.ok ? ok({ kind: 'AiTool', toolName: name.value, args: args.value }) : args;
    }
    case 'Chain': {
      const opsJ = requireField(path, f, 'ops', 'Action list (Chain)');
      if (!opsJ.ok) return opsJ;
      const arr = requireArray(`${path}.ops`, opsJ.value);
      if (!arr.ok) return arr;
      const inner = traverseIndexed(arr.value, (i, item) =>
        decodeAction(`${path}.ops[${i}]`, item),
      );
      return inner.ok ? ok({ kind: 'Chain', actions: inner.value }) : inner;
    }
    case 'CommitLocal': {
      const r = reqField(path, f, 'nodeId', 'Local-bound input NodeId string', requireString);
      return r.ok ? ok({ kind: 'CommitLocal', nodeId: r.value }) : r;
    }
    case 'WriteToClipboard': {
      const r = reqField(path, f, 'text', 'clipboard payload string', requireString);
      return r.ok ? ok({ kind: 'WriteToClipboard', text: r.value }) : r;
    }
    case 'ReadFileBody': {
      // Phase 136 — only fileRef (the opaque id) + encoding cross the wire.
      // The decoded FileRef carries no handle (no blob on a decoded tree);
      // onRead reconstructs as a no-op closure that re-encodes to "<closure>".
      const fileId = reqField(path, f, 'fileRef', 'FileRef id string', requireString);
      if (!fileId.ok) return fileId;
      const enc = reqField(path, f, 'encoding', 'FileReadEncoding', decodeFileReadEncoding);
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
      const cid = reqField(path, f, 'capabilityId', 'capability id string', requireString);
      if (!cid.ok) return cid;
      const argsJ = requireField(path, f, 'args', 'invoke args array');
      if (!argsJ.ok) return argsJ;
      const args = decodeInvokeArgs(`${path}.args`, argsJ.value);
      if (!args.ok) return args;
      return ok({ kind: 'Invoke', capabilityId: cid.value, args: args.value });
    }
    default:
      return unknownDuCase(
        path,
        d.value,
        'Dispatch | Call | Notify | Navigate | SetState | AiTool | Chain | CommitLocal | WriteToClipboard | ReadFileBody | Invoke',
      );
  }
};

// ─── Display specs ───────────────────────────────────────────────────────────

const placeholderAction: Action<unknown> = { kind: 'Chain', actions: [] };
const onChangePlaceholder = (): Action<unknown> => placeholderAction;

const decodeMetricSpec = (path: string, j: JsonAst): R<MetricSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const label = reqField(path, f, 'label', 'Metric label TextSource', decodeTextSource);
  if (!label.ok) return label;
  // 0.2.0 rename law: the scalar displayed value is `value` (clean break —
  // the old `source` name is NOT an accepted alias; `data` is the web prior).
  const source = reqFieldAliased(path, f, 'value', ['data'], 'Metric value binding', decodeBinding);
  if (!source.ok) {
    // DIDACTIC ERROR (2026-07-17): a text value here is the top observed
    // emission error — name the right kind so the structured repair channel
    // self-corrects. Mirror of F#.
    if (source.error.message.includes('expected JSON number')) {
      return {
        ok: false,
        error: {
          ...source.error,
          message:
            source.error.message +
            ' — Metric is numeric-only (trendable KPI); a labeled TEXT fact belongs in Fact: {"$type":"Fact","label":\u2026,"value":\u2026}',
        },
      };
    }
    return source;
  }
  // Phase 460 — stylistic fields omitted-when-default; restore the identity
  // default on absence (mirrors the Phase 147 role/voice decode).
  const format = optField(path, f, 'format', decodeCellFormat);
  if (!format.ok) return format;
  const tone = optField(path, f, 'tone', decodeTone);
  if (!tone.ok) return tone;
  const weight = optField(path, f, 'weight', decodeWeight);
  if (!weight.ok) return weight;
  const emphasis = optField(path, f, 'emphasis', decodeEmphasis);
  if (!emphasis.ok) return emphasis;
  const trend = optField(path, f, 'trend', decodeBinding);
  if (!trend.ok) return trend;
  const trendFormat = optField(path, f, 'trendFormat', decodeCellFormat);
  if (!trendFormat.ok) return trendFormat;
  const icon = optField(path, f, 'icon', decodeIconSource);
  if (!icon.ok) return icon;
  const subtext = optField(path, f, 'subtext', decodeTextSource);
  if (!subtext.ok) return subtext;
  return ok({
    label: label.value,
    value: source.value as Binding<number>,
    format: format.value ?? { kind: 'None' },
    tone: tone.value ?? 'Default',
    weight: weight.value ?? 'Standard',
    emphasis: emphasis.value ?? 'Normal',
    ...(trend.value !== undefined ? { trend: trend.value as Binding<number> } : {}),
    ...(trendFormat.value !== undefined ? { trendFormat: trendFormat.value } : {}),
    ...(icon.value !== undefined ? { icon: icon.value } : {}),
    ...(subtext.value !== undefined ? { subtext: subtext.value } : {}),
  });
};

const decodeHeadingSpec = (path: string, j: JsonAst): R<HeadingSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const level = reqField(path, f, 'level', 'heading level integer', requireInt);
  if (!level.ok) return level;
  const text = reqField(path, f, 'text', 'heading TextSource', decodeTextSource);
  if (!text.ok) return text;
  const variant = reqField(path, f, 'variant', 'HeadingVariant', decodeHeadingVariant);
  if (!variant.ok) return variant;
  return ok({ level: level.value, text: text.value, variant: variant.value });
};

const decodeLabelValueRowSpec = (path: string, j: JsonAst): R<LabelValueRowSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const label = reqField(path, f, 'label', 'row TextSource label', decodeTextSource);
  if (!label.ok) return label;
  const source = reqFieldAliased(
    path,
    f,
    'value',
    ['data'],
    'row Binding<float> value',
    decodeBinding,
  );
  if (!source.ok) return source;
  // Phase 460 — `format` omitted-when-default. 0.2.2 — `emphasis` is
  // omitted-when-false (aligning with Fact), and the style-enum prior
  // coerces: "Loud" → true, "Normal"/"Quiet" → false; any other string is a
  // didactic reject naming the bool and where the enum lives.
  const format = optField(path, f, 'format', decodeCellFormat);
  if (!format.ok) return format;
  // 0.2.8 — the cross-vocabulary coercion moved to the shared
  // `decodeEmphasisFlag` (2026-07-19 sweep: the 0.2.2 site-local version
  // missed the Phase-460 aliases — 'Strong' hard-failed here — and Fact's
  // identical flag had no coercion at all).
  const emphasisJ = tryField(f, 'emphasis');
  let emphasisVal = false;
  if (emphasisJ !== undefined) {
    const b = decodeEmphasisFlag(`${path}.emphasis`, emphasisJ);
    if (!b.ok) return b;
    emphasisVal = b.value;
  }
  const help = optField(path, f, 'help', decodeTextSource);
  if (!help.ok) return help;
  return ok({
    label: label.value,
    value: source.value as Binding<number>,
    format: format.value ?? { kind: 'None' },
    emphasis: emphasisVal,
    ...(help.value !== undefined ? { help: help.value } : {}),
  });
};

const decodeFactSpec = (path: string, j: JsonAst): R<FactSpec> => {
  // New kind (2026-07-17): minimal wire — only label + value required;
  // tone/emphasis omitted-when-default on both boundaries. Mirror of F#.
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const label = reqField(path, f, 'label', 'fact TextSource label', decodeTextSource);
  if (!label.ok) return label;
  const value = reqField(path, f, 'value', 'fact TextSource value', decodeTextSource);
  if (!value.ok) return value;
  const tone = optField(path, f, 'tone', decodeTone);
  if (!tone.ok) return tone;
  // 0.2.8 — the shared cross-vocabulary reader (enum spellings coerce to the bool).
  const emphasis = optField(path, f, 'emphasis', decodeEmphasisFlag);
  if (!emphasis.ok) return emphasis;
  const help = optField(path, f, 'help', decodeTextSource);
  if (!help.ok) return help;
  const icon = optField(path, f, 'icon', decodeIconSource);
  if (!icon.ok) return icon;
  return ok({
    label: label.value,
    value: value.value,
    tone: tone.value ?? 'Default',
    emphasis: emphasis.value ?? false,
    ...(help.value !== undefined ? { help: help.value } : {}),
    ...(icon.value !== undefined ? { icon: icon.value } : {}),
  });
};

const decodeMarkdownSpec = (path: string, j: JsonAst): R<MarkdownSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const text = reqField(path, fo.value, 'text', 'markdown TextSource', decodeTextSource);
  return text.ok ? ok({ text: text.value }) : text;
};

const decodeBadgeSpec = (path: string, j: JsonAst): R<BadgeSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const label = reqField(path, f, 'label', 'Badge label TextSource', decodeTextSource);
  if (!label.ok) return label;
  const variant = reqField(path, f, 'variant', 'BadgeVariant', decodeBadgeVariant);
  if (!variant.ok) return variant;
  return ok({ label: label.value, variant: variant.value });
};

const decodeLinkSpec = (path: string, j: JsonAst): R<LinkSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const href = reqField(path, f, 'href', 'link Binding<string> Href', decodeBindingString);
  if (!href.ok) return href;
  const label = reqField(path, f, 'label', 'link label TextSource', decodeTextSource);
  if (!label.ok) return label;
  const download = reqField(path, f, 'download', 'download bool', requireBool);
  if (!download.ok) return download;
  const rel = optField(path, f, 'rel', requireString);
  if (!rel.ok) return rel;
  const target = optField(path, f, 'target', requireString);
  if (!target.ok) return target;
  return ok({
    href: href.value,
    label: label.value,
    download: download.value,
    ...(rel.value !== undefined ? { rel: rel.value } : {}),
    ...(target.value !== undefined ? { target: target.value } : {}),
  });
};

const decodeImageSpec = (path: string, j: JsonAst): R<ImageSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const alt = reqField(path, f, 'alt', 'Image alt TextSource', decodeTextSource);
  if (!alt.ok) return alt;
  const src = reqField(path, f, 'src', 'Image Binding<string> Src', decodeBindingString);
  if (!src.ok) return src;
  const variant = reqField(path, f, 'variant', 'ImageVariant', decodeImageVariant);
  if (!variant.ok) return variant;
  return ok({ alt: alt.value, src: src.value, variant: variant.value });
};

const decodeListSpec = (path: string, j: JsonAst): R<ListSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const itemsJ = requireField(path, f, 'items', 'List items TextSource array');
  if (!itemsJ.ok) return itemsJ;
  const arr = requireArray(`${path}.items`, itemsJ.value);
  if (!arr.ok) return arr;
  const items = traverseIndexed(arr.value, (i, item) =>
    decodeTextSource(`${path}.items[${i}]`, item),
  );
  if (!items.ok) return items;
  const ordered = reqField(path, f, 'ordered', 'ordered bool', requireBool);
  if (!ordered.ok) return ordered;
  return ok({ items: items.value, ordered: ordered.value });
};

const decodeToastSpec = (path: string, j: JsonAst): R<ToastSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const message = reqField(path, f, 'message', 'Toast message TextSource', decodeTextSource);
  if (!message.ok) return message;
  // Phase 460 — `tone` omitted-when-default.
  const tone = optField(path, f, 'tone', decodeTone);
  if (!tone.ok) return tone;
  const open = reqField(path, f, 'open', 'Toast open binding', decodeBinding);
  if (!open.ok) return open;
  // 0.2.0 omitted-when-TRUE (a Toast is dismissable unless said otherwise).
  const dismissable = optField(path, f, 'dismissable', requireBool);
  if (!dismissable.ok) return dismissable;
  return ok({
    message: message.value,
    tone: tone.value ?? 'Default',
    open: open.value as Binding<boolean>,
    dismissable: dismissable.value ?? true,
  });
};

const decodeCodeBlockSpec = (path: string, j: JsonAst): R<CodeBlockSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const code = reqField(path, f, 'code', 'code-block code string', requireString);
  if (!code.ok) return code;
  const language = reqField(path, f, 'language', 'code-block language string', requireString);
  if (!language.ok) return language;
  const lineNumbers = reqField(path, f, 'lineNumbers', 'lineNumbers bool', requireBool);
  if (!lineNumbers.ok) return lineNumbers;
  const copyable = reqField(path, f, 'copyable', 'copyable bool', requireBool);
  if (!copyable.ok) return copyable;
  const linesJ = requireField(path, f, 'highlightLines', 'highlightLines int array');
  if (!linesJ.ok) return linesJ;
  const arr = requireArray(`${path}.highlightLines`, linesJ.value);
  if (!arr.ok) return arr;
  const highlightLines = traverseIndexed(arr.value, (i, item) =>
    requireInt(`${path}.highlightLines[${i}]`, item),
  );
  if (!highlightLines.ok) return highlightLines;
  return ok({
    code: code.value,
    language: language.value,
    lineNumbers: lineNumbers.value,
    highlightLines: highlightLines.value,
    copyable: copyable.value,
  });
};

const decodeMathSpec = (path: string, j: JsonAst): R<MathSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const source = reqField(path, f, 'source', 'math LaTeX source string', requireString);
  if (!source.ok) return source;
  const display = reqField(path, f, 'display', 'MathDisplay', decodeMathDisplay);
  if (!display.ok) return display;
  return ok({ source: source.value, display: display.value });
};

const decodeSparklineSpec = (path: string, j: JsonAst): R<SparklineSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const source = reqFieldAliased(
    path,
    fo.value,
    'source',
    ['data'],
    'Sparkline Source binding',
    decodeBindingFloatSeq,
  );
  return source.ok ? ok({ source: source.value }) : source;
};

const decodeSkeletonSpec = (path: string, j: JsonAst): R<SkeletonSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const rows = reqField(path, fo.value, 'rows', 'skeleton row count integer', requireInt);
  return rows.ok ? ok({ rows: rows.value }) : rows;
};

const decodeCalloutSpec = (path: string, j: JsonAst): R<CalloutSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const body = reqField(path, f, 'body', 'Callout body TextSource', decodeTextSource);
  if (!body.ok) return body;
  // 0.2.0 omitted-when-false.
  const dismissable = optField(path, f, 'dismissable', requireBool);
  if (!dismissable.ok) return dismissable;
  // Phase 460 — `tone` omitted-when-default.
  const tone = optField(path, f, 'tone', decodeTone);
  if (!tone.ok) return tone;
  const heading = optFieldAliased(path, f, 'heading', ['title'], decodeTextSource);
  if (!heading.ok) return heading;
  const icon = optField(path, f, 'icon', decodeIconSource);
  if (!icon.ok) return icon;
  return ok({
    body: body.value,
    dismissable: dismissable.value ?? false,
    tone: tone.value ?? 'Default',
    ...(heading.value !== undefined ? { heading: heading.value } : {}),
    ...(icon.value !== undefined ? { icon: icon.value } : {}),
  });
};

const decodeProgressSpec = (path: string, j: JsonAst): R<ProgressSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const fraction = reqField(path, f, 'fraction', 'Progress fraction binding', decodeBinding);
  if (!fraction.ok) return fraction;
  // The Static-envelope unwrap now lives in requireBool itself (generalised
  // 2026-07-18 after the pilot found `emphasis` wrapped the same way).
  // 0.2.0 omitted-when-false.
  const indeterminate = optField(path, f, 'indeterminate', requireBool);
  if (!indeterminate.ok) return indeterminate;
  // Phase 460 — `tone` omitted-when-default.
  const tone = optField(path, f, 'tone', decodeTone);
  if (!tone.ok) return tone;
  const label = optField(path, f, 'label', decodeTextSource);
  if (!label.ok) return label;
  const caveat = optField(path, f, 'caveat', decodeTextSource);
  if (!caveat.ok) return caveat;
  return ok({
    fraction: fraction.value as Binding<number>,
    indeterminate: indeterminate.value ?? false,
    tone: tone.value ?? 'Default',
    ...(label.value !== undefined ? { label: label.value } : {}),
    ...(caveat.value !== undefined ? { caveat: caveat.value } : {}),
  });
};

// ─── Drawing (Phase 524) ─────────────────────────────────────────────────────

const emptyDrawStyle: DrawStyle = {};

const decodeDrawPoint = (path: string, j: JsonAst): R<DrawPoint> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const x = reqField(path, fo.value, 'x', 'DrawPoint x float', requireFloat);
  if (!x.ok) return x;
  const y = reqField(path, fo.value, 'y', 'DrawPoint y float', requireFloat);
  if (!y.ok) return y;
  return ok({ x: x.value, y: y.value });
};

const decodeViewBox = (path: string, j: JsonAst): R<ViewBox> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const minX = reqField(path, f, 'minX', 'ViewBox minX float', requireFloat);
  if (!minX.ok) return minX;
  const minY = reqField(path, f, 'minY', 'ViewBox minY float', requireFloat);
  if (!minY.ok) return minY;
  const width = reqField(path, f, 'width', 'ViewBox width float', requireFloat);
  if (!width.ok) return width;
  const height = reqField(path, f, 'height', 'ViewBox height float', requireFloat);
  if (!height.ok) return height;
  return ok({ minX: minX.value, minY: minY.value, width: width.value, height: height.value });
};

const decodeDrawStyle = (path: string, j: JsonAst): R<DrawStyle> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const fill = optField(path, f, 'fill', decodeBindingString);
  if (!fill.ok) return fill;
  const stroke = optField(path, f, 'stroke', decodeBindingString);
  if (!stroke.ok) return stroke;
  const strokeWidth = optField(path, f, 'strokeWidth', decodeBinding);
  if (!strokeWidth.ok) return strokeWidth;
  const opacity = optField(path, f, 'opacity', decodeBinding);
  if (!opacity.ok) return opacity;
  // Text-only fields (Phase 528.1) — all optional, omitted when unset.
  const textAnchor = optField(path, f, 'textAnchor', decodeTextAnchor);
  if (!textAnchor.ok) return textAnchor;
  const fontSize = optField(path, f, 'fontSize', requireFloat);
  if (!fontSize.ok) return fontSize;
  const emphasis = optField(path, f, 'emphasis', decodeEmphasis);
  if (!emphasis.ok) return emphasis;
  const fontFamily = optField(path, f, 'fontFamily', requireString);
  if (!fontFamily.ok) return fontFamily;
  // Phase 642 — keyed mark identity; optional.
  const markId = optField(path, f, 'markId', requireString);
  if (!markId.ok) return markId;
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
  });
};

const decodeCurveCommand = (path: string, j: JsonAst): R<CurveCommand> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  const point = (key: string): R<DrawPoint> =>
    reqField(path, f, key, `DrawPoint ${key}`, decodeDrawPoint);
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
      if (!c1.ok) return c1;
      const c2 = point('control2');
      if (!c2.ok) return c2;
      const to = point('to');
      if (!to.ok) return to;
      return ok({ kind: 'CubicTo', control1: c1.value, control2: c2.value, to: to.value });
    }
    case 'QuadraticTo': {
      const c = point('control');
      if (!c.ok) return c;
      const to = point('to');
      if (!to.ok) return to;
      return ok({ kind: 'QuadraticTo', control: c.value, to: to.value });
    }
    case 'Close':
      return ok({ kind: 'Close' });
    default:
      // Default-deny (WIRE_FORMAT §11 / Phase 524): an unknown command is a typed defect.
      return unknownDuCase(path, d.value, 'MoveTo | LineTo | CubicTo | QuadraticTo | Close');
  }
};

const decodeShape = (path: string, j: JsonAst): R<Shape> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  const flt = (key: string): R<number> =>
    reqField(path, f, key, `Shape ${key} float`, requireFloat);
  const styleField = (): R<DrawStyle> => {
    const s = optField(path, f, 'style', decodeDrawStyle);
    return s.ok ? ok(s.value ?? emptyDrawStyle) : s;
  };
  const pointArray = (key: string): R<readonly DrawPoint[]> => {
    const arr = reqField(path, f, key, `Shape ${key} DrawPoint array`, requireArray);
    if (!arr.ok) return arr;
    return traverseIndexed(arr.value, (i, el) => decodeDrawPoint(`${path}.${key}[${i}]`, el));
  };
  const style = styleField();
  if (!style.ok) return style;
  switch (d.value) {
    case 'Group': {
      const arr = reqField(path, f, 'children', 'Shape children array', requireArray);
      if (!arr.ok) return arr;
      const children = traverseIndexed(arr.value, (i, el) =>
        decodeShape(`${path}.children[${i}]`, el),
      );
      return children.ok
        ? ok({ kind: 'Group', children: children.value, style: style.value })
        : children;
    }
    case 'Rectangle': {
      const x = flt('x');
      if (!x.ok) return x;
      const y = flt('y');
      if (!y.ok) return y;
      const width = flt('width');
      if (!width.ok) return width;
      const height = flt('height');
      if (!height.ok) return height;
      const cornerRadius = optField(path, f, 'cornerRadius', requireFloat);
      if (!cornerRadius.ok) return cornerRadius;
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
      if (!x1.ok) return x1;
      const y1 = flt('y1');
      if (!y1.ok) return y1;
      const x2 = flt('x2');
      if (!x2.ok) return x2;
      const y2 = flt('y2');
      if (!y2.ok) return y2;
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
      const arr = reqField(path, f, 'commands', 'Shape Curve commands array', requireArray);
      if (!arr.ok) return arr;
      const commands = traverseIndexed(arr.value, (i, el) =>
        decodeCurveCommand(`${path}.commands[${i}]`, el),
      );
      return commands.ok
        ? ok({ kind: 'Curve', commands: commands.value, style: style.value })
        : commands;
    }
    case 'Circle': {
      const cx = flt('cx');
      if (!cx.ok) return cx;
      const cy = flt('cy');
      if (!cy.ok) return cy;
      const r = flt('r');
      if (!r.ok) return r;
      return ok({ kind: 'Circle', cx: cx.value, cy: cy.value, r: r.value, style: style.value });
    }
    case 'Ellipse': {
      const cx = flt('cx');
      if (!cx.ok) return cx;
      const cy = flt('cy');
      if (!cy.ok) return cy;
      const rx = flt('rx');
      if (!rx.ok) return rx;
      const ry = flt('ry');
      if (!ry.ok) return ry;
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
      if (!x.ok) return x;
      const y = flt('y');
      if (!y.ok) return y;
      const text = reqField(path, f, 'text', 'Shape Label text TextSource', decodeTextSource);
      if (!text.ok) return text;
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

const decodeDrawingSpec = (path: string, j: JsonAst): R<DrawingSpec> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const viewBox = reqField(path, f, 'viewBox', 'Drawing ViewBox', decodeViewBox);
  if (!viewBox.ok) return viewBox;
  const arr = reqField(path, f, 'shapes', 'Drawing shapes array', requireArray);
  if (!arr.ok) return arr;
  const shapes = traverseIndexed(arr.value, (i, el) => decodeShape(`${path}.shapes[${i}]`, el));
  if (!shapes.ok) return shapes;
  const style = optField(path, f, 'style', decodeDrawStyle);
  if (!style.ok) return style;
  const title = optField(path, f, 'title', decodeTextSource);
  if (!title.ok) return title;
  const description = optField(path, f, 'description', decodeTextSource);
  if (!description.ok) return description;
  return ok({
    viewBox: viewBox.value,
    shapes: shapes.value,
    style: style.value ?? emptyDrawStyle,
    ...(title.value !== undefined ? { title: title.value } : {}),
    ...(description.value !== undefined ? { description: description.value } : {}),
  });
};

const decodeDisplayKind = (path: string, j: JsonAst): R<DisplayKind> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  // Flat wire: spec fields are hoisted onto the kind object itself (no `spec`
  // wrapper, WIRE_FORMAT.md §3.2) — pass `j` to the spec decoder, which reads
  // its fields by name and ignores the extra `$type` key.
  switch (d.value) {
    case 'Heading': {
      const r = decodeHeadingSpec(path, j);
      return r.ok ? ok({ kind: 'Heading', spec: r.value }) : r;
    }
    case 'Markdown': {
      const r = decodeMarkdownSpec(path, j);
      return r.ok ? ok({ kind: 'Markdown', spec: r.value }) : r;
    }
    case 'Metric': {
      const r = decodeMetricSpec(path, j);
      return r.ok ? ok<DisplayKind>({ kind: 'Metric', spec: r.value }) : r;
    }
    case 'Badge': {
      const r = decodeBadgeSpec(path, j);
      return r.ok ? ok({ kind: 'Badge', spec: r.value }) : r;
    }
    case 'Sparkline': {
      const r = decodeSparklineSpec(path, j);
      return r.ok ? ok({ kind: 'Sparkline', spec: r.value }) : r;
    }
    case 'Callout': {
      const r = decodeCalloutSpec(path, j);
      return r.ok ? ok<DisplayKind>({ kind: 'Callout', spec: r.value }) : r;
    }
    case 'Progress': {
      const r = decodeProgressSpec(path, j);
      return r.ok ? ok({ kind: 'Progress', spec: r.value }) : r;
    }
    case 'Skeleton': {
      const r = decodeSkeletonSpec(path, j);
      return r.ok ? ok({ kind: 'Skeleton', spec: r.value }) : r;
    }
    case 'LabelValueRow': {
      const r = decodeLabelValueRowSpec(path, j);
      return r.ok ? ok({ kind: 'LabelValueRow', spec: r.value }) : r;
    }
    case 'Fact': {
      const r = decodeFactSpec(path, j);
      return r.ok ? ok({ kind: 'Fact', spec: r.value }) : r;
    }
    case 'Link': {
      const r = decodeLinkSpec(path, j);
      return r.ok ? ok({ kind: 'Link', spec: r.value }) : r;
    }
    case 'Image': {
      const r = decodeImageSpec(path, j);
      return r.ok ? ok({ kind: 'Image', spec: r.value }) : r;
    }
    case 'List': {
      const r = decodeListSpec(path, j);
      return r.ok ? ok({ kind: 'List', spec: r.value }) : r;
    }
    case 'Toast': {
      const r = decodeToastSpec(path, j);
      return r.ok ? ok<DisplayKind>({ kind: 'Toast', spec: r.value }) : r;
    }
    case 'CodeBlock': {
      const r = decodeCodeBlockSpec(path, j);
      return r.ok ? ok<DisplayKind>({ kind: 'CodeBlock', spec: r.value }) : r;
    }
    case 'Math': {
      const r = decodeMathSpec(path, j);
      return r.ok ? ok<DisplayKind>({ kind: 'Math', spec: r.value }) : r;
    }
    case 'Drawing': {
      const r = decodeDrawingSpec(path, j);
      return r.ok ? ok<DisplayKind>({ kind: 'Drawing', spec: r.value }) : r;
    }
    default:
      return unknownDuCase(
        path,
        d.value,
        'Heading | Markdown | Metric | Badge | Link | Image | List | Toast | CodeBlock | Math | Drawing | Sparkline | Callout | Progress | Skeleton | LabelValueRow',
      );
  }
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

const decodeFormFieldKind = (
  autoBind: ControlAutoBind,
  path: string,
  j: JsonAst,
): R<FormFieldKind<unknown>> => {
  const fo = requireObject(path, j);
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
  const onToggleField: { onToggle?: () => Action<unknown> } =
    tryField(f, 'onToggle') !== undefined ? { onToggle: onChangePlaceholder } : {};
  // Value slot: present => typed decode; absent in a FILTER context => the
  // auto `Filter(name)` binding; absent in a Form => MISSING_FIELD as before.
  const valueOr = (
    dec: (p: string, v: JsonAst) => R<Binding<unknown>>,
    autoDefault: unknown,
    expected: string,
  ): R<Binding<unknown>> => {
    const v = tryField(f, 'value');
    if (v !== undefined) return dec(`${path}.value`, v);
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
      const v = valueOr(decodeBinding, controlValueDefaults.number, 'Number value binding');
      return v.ok ? ok({ kind: 'Number', value: v.value as Binding<number>, ...onChangeField }) : v;
    }
    case 'Checkbox': {
      const v = valueOr(decodeBinding, controlValueDefaults.checkbox, 'Checkbox value binding');
      return v.ok
        ? ok({
            kind: 'Checkbox',
            value: v.value as Binding<boolean>,
            ...onToggleField,
          })
        : v;
    }
    case 'Choice': {
      const options = reqField(
        path,
        f,
        'options',
        'Choice options binding',
        decodeBindingSelectOptions,
      );
      if (!options.ok) return options;
      const value = valueOr(
        decodeBindingStringOpt as (p: string, v: JsonAst) => R<Binding<unknown>>,
        controlValueDefaults.choice,
        'Choice value binding',
      ) as R<Binding<string | undefined>>;
      if (!value.ok) return value;
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
        decodeBindingFloatPair as (p: string, v: JsonAst) => R<Binding<unknown>>,
        controlValueDefaults.range,
        'Binding<[number, number]> value',
      ) as R<Binding<readonly [number, number]>>;
      if (!value.ok) return value;
      return ok({ kind: 'Range', value: value.value, ...onChangeField });
    }
    case 'RangedNumber': {
      const value = valueOr(
        decodeBinding,
        controlValueDefaults.number,
        'RangedNumber value binding',
      );
      if (!value.ok) return value;
      const min = optField(path, f, 'min', requireFloat);
      if (!min.ok) return min;
      const max = optField(path, f, 'max', requireFloat);
      if (!max.ok) return max;
      const step = optField(path, f, 'step', requireFloat);
      if (!step.ok) return step;
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
        path,
        f,
        'options',
        'SegmentedChoice options binding',
        decodeBindingSelectOptions,
      );
      if (!options.ok) return options;
      // Lenient AI-ingest omitted-when-default (WIRE_FORMAT.md §3.6 family):
      // absent segmented `orientation` restores the language default
      // `Horizontal`. Decode-only — the encoder still always emits it.
      // Mirror of the F# decoder.
      const orientationJ = tryField(f, 'orientation');
      const orientation =
        orientationJ === undefined
          ? ok<Orientation>('Horizontal')
          : decodeOrientation(`${path}.orientation`, orientationJ);
      if (!orientation.ok) return orientation;
      const value = valueOr(
        decodeBindingStringOpt as (p: string, v: JsonAst) => R<Binding<unknown>>,
        controlValueDefaults.choice,
        'SegmentedChoice value binding',
      ) as R<Binding<string | undefined>>;
      if (!value.ok) return value;
      return ok({
        kind: 'SegmentedChoice',
        options: options.value,
        value: value.value,
        ...onChangeField,
        orientation: orientation.value,
      });
    }
    case 'TextArea': {
      const rows = reqField(path, f, 'rows', 'textarea row count integer', requireInt);
      if (!rows.ok) return rows;
      const value = valueOr(decodeBinding, controlValueDefaults.text, 'TextArea value binding');
      if (!value.ok) return value;
      return ok({
        kind: 'TextArea',
        value: value.value as Binding<string>,
        ...onChangeField,
        rows: rows.value,
      });
    }
    case 'Date': {
      const value = valueOr(decodeBinding, controlValueDefaults.date, 'Date value binding');
      if (!value.ok) return value;
      const variant = reqField(path, f, 'variant', 'DateVariant', decodeDateVariant);
      if (!variant.ok) return variant;
      const min = optField(path, f, 'min', requireString);
      if (!min.ok) return min;
      const max = optField(path, f, 'max', requireString);
      if (!max.ok) return max;
      const step = optField(path, f, 'step', requireFloat);
      if (!step.ok) return step;
      return ok({
        kind: 'Date',
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
    case 'DateRange': {
      // Phase 725 — single-control date range: `Range`'s pair mechanics with
      // `Date`'s value conventions. `min` / `max` / `step` are flat (they bound
      // BOTH ends), same omit-when-absent discipline as `Date`.
      const value = valueOr(
        decodeBindingStringPair as (p: string, v: JsonAst) => R<Binding<unknown>>,
        controlValueDefaults.dateRange,
        'Binding<[from, to]> ISO-8601 pair value',
      ) as R<Binding<readonly [string, string]>>;
      if (!value.ok) return value;
      const variant = reqField(path, f, 'variant', 'DateVariant', decodeDateVariant);
      if (!variant.ok) return variant;
      const min = optField(path, f, 'min', requireString);
      if (!min.ok) return min;
      const max = optField(path, f, 'max', requireString);
      if (!max.ok) return max;
      const step = optField(path, f, 'step', requireFloat);
      if (!step.ok) return step;
      return ok({
        kind: 'DateRange',
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
      return unknownDuCase(
        path,
        d.value,
        'Text | Number | Checkbox | Choice | Range | RangedNumber | SegmentedChoice | TextArea | Date | DateRange',
      );
  }
};

const decodeFormField = (path: string, j: JsonAst): R<FormField<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const id = reqFieldAliased(path, f, 'id', ['name'], 'form field id string', requireString);
  if (!id.ok) return id;
  // Phase 596 — id decodes first so the form context's auto-bind can use it
  // (the chip-name-first precedent from the filters unification). `id` is
  // re-read below by the original ordering; a malformed id surfaces there.
  const idFirst = reqFieldAliased(path, f, 'id', ['name'], 'form-field id string', requireString);
  const kind = reqField(path, f, 'kind', 'FormFieldKind', (p, v) =>
    decodeFormFieldKind(idFirst.ok ? { kind: 'form', id: idFirst.value } : undefined, p, v),
  );
  if (!kind.ok) return kind;
  const label = reqField(path, f, 'label', 'field label TextSource', decodeTextSource);
  if (!label.ok) return label;
  const required = reqField(path, f, 'required', 'required bool', requireBool);
  if (!required.ok) return required;
  const help = optField(path, f, 'help', decodeTextSource);
  if (!help.ok) return help;
  return ok({
    id: id.value,
    kind: kind.value,
    label: label.value,
    required: required.value,
    ...(help.value !== undefined ? { help: help.value } : {}),
  });
};

const decodeFormSpec = (path: string, j: JsonAst): R<FormSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const fieldsJ = requireField(path, f, 'fields', 'form field list');
  if (!fieldsJ.ok) return fieldsJ;
  const arr = requireArray(`${path}.fields`, fieldsJ.value);
  if (!arr.ok) return arr;
  const fields = traverseIndexed(arr.value, (i, item) =>
    decodeFormField(`${path}.fields[${i}]`, item),
  );
  if (!fields.ok) return fields;
  const onSubmit = reqField(path, f, 'onSubmit', 'onSubmit Action', decodeAction);
  if (!onSubmit.ok) return onSubmit;
  const submitLabel = reqField(path, f, 'submitLabel', 'submitLabel TextSource', decodeTextSource);
  if (!submitLabel.ok) return submitLabel;
  // Phase 130: optional bound form-level disabled-state.
  const disabled = optField(path, f, 'disabled', decodeBindingBool);
  if (!disabled.ok) return disabled;
  return ok({
    fields: fields.value,
    onSubmit: onSubmit.value,
    submitLabel: submitLabel.value,
    ...(disabled.value !== undefined ? { disabled: disabled.value } : {}),
  });
};

const decodeFilterSpec = (path: string, j: JsonAst): R<FilterSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  // 0.2.0 filters-unification: the chip's control is an ordinary
  // FormFieldKind; its absent `value` auto-binds `Filter(name)` (see
  // decodeFormFieldKind). Name decodes first so the synthesis can use it.
  const name = reqField(path, f, 'name', 'filter name string', requireString);
  if (!name.ok) return name;
  const label = reqField(path, f, 'label', 'filter label TextSource', decodeTextSource);
  if (!label.ok) return label;
  const kind = reqField(path, f, 'kind', 'FormFieldKind control', (p, v) =>
    decodeFormFieldKind({ kind: 'filter', name: name.value }, p, v),
  );
  if (!kind.ok) return kind;
  return ok({ name: name.value, label: label.value, field: kind.value });
};

const decodeButtonSpec = (path: string, j: JsonAst): R<ButtonSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const label = reqField(path, f, 'label', 'Button label TextSource', decodeTextSource);
  if (!label.ok) return label;
  const onClick = reqField(path, f, 'onClick', 'onClick Action', decodeAction);
  if (!onClick.ok) return onClick;
  const variant = reqField(path, f, 'variant', 'ButtonVariant', decodeButtonVariant);
  if (!variant.ok) return variant;
  const icon = optField(path, f, 'icon', decodeIconSource);
  if (!icon.ok) return icon;
  // Phase 129: optional bound disabled-state.
  const disabled = optField(path, f, 'disabled', decodeBindingBool);
  if (!disabled.ok) return disabled;
  return ok({
    label: label.value,
    onClick: onClick.value,
    variant: variant.value,
    ...(icon.value !== undefined ? { icon: icon.value } : {}),
    ...(disabled.value !== undefined ? { disabled: disabled.value } : {}),
  });
};

const decodeSelectSpec = (path: string, j: JsonAst): R<SelectSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const label = reqField(path, f, 'label', 'Select label TextSource', decodeTextSource);
  if (!label.ok) return label;
  const source = reqFieldAliased(
    path,
    f,
    'source',
    ['options', 'data'],
    'Select source binding',
    decodeBindingSelectOptions,
  );
  if (!source.ok) return source;
  const value = reqField(path, f, 'value', 'Select value binding', decodeBindingStringOpt);
  if (!value.ok) return value;
  const placeholder = optField(path, f, 'placeholder', decodeTextSource);
  if (!placeholder.ok) return placeholder;
  // Phase 130: optional bound disabled-state.
  const disabled = optField(path, f, 'disabled', decodeBindingBool);
  if (!disabled.ok) return disabled;
  // Phase 291: multi-select. `multiple` absent ⇒ false (single-select); `values`
  // absent ⇒ omitted. The multi onChange is a closure reconstructed by the
  // existing `onChange` placeholder. `values` decodes through the typed
  // string-list decoder (Phase 429 — typed form preferred, opaque read-compat).
  const multiple = optField(path, f, 'multiple', requireBool);
  if (!multiple.ok) return multiple;
  const values = optField(path, f, 'values', decodeBindingStringList);
  if (!values.ok) return values;
  return ok({
    label: label.value,
    source: source.value,
    value: value.value,
    // Phase 426: a present `"<closure>"` sentinel → the inert placeholder; an
    // absent key → omitted, arming the renderer's write-back default against
    // `value` / `values`.
    ...(tryField(f, 'onChange') !== undefined ? { onChange: onChangePlaceholder } : {}),
    ...(placeholder.value !== undefined ? { placeholder: placeholder.value } : {}),
    ...(disabled.value !== undefined ? { disabled: disabled.value } : {}),
    ...(multiple.value === true ? { multiple: true } : {}),
    ...(values.value !== undefined ? { values: values.value } : {}),
    ...(tryField(f, 'onChangeMulti') !== undefined ? { onChangeMulti: onChangePlaceholder } : {}),
  });
};

const decodeFileUploadSpec = (path: string, j: JsonAst): R<FileUploadSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const acceptJ = requireField(path, f, 'accept', 'accept string list');
  if (!acceptJ.ok) return acceptJ;
  const arr = requireArray(`${path}.accept`, acceptJ.value);
  if (!arr.ok) return arr;
  const accept = traverseIndexed(arr.value, (i, item) =>
    requireString(`${path}.accept[${i}]`, item),
  );
  if (!accept.ok) return accept;
  const label = reqField(path, f, 'label', 'FileUpload label TextSource', decodeTextSource);
  if (!label.ok) return label;
  const multiple = reqField(path, f, 'multiple', 'multiple bool', requireBool);
  if (!multiple.ok) return multiple;
  // Phase 130: optional bound disabled-state.
  const disabled = optField(path, f, 'disabled', decodeBindingBool);
  if (!disabled.ok) return disabled;
  return ok({
    accept: accept.value,
    label: label.value,
    multiple: multiple.value,
    onSelect: () => placeholderAction,
    ...(disabled.value !== undefined ? { disabled: disabled.value } : {}),
  });
};

const decodeInputKind = (path: string, j: JsonAst): R<InputKind<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Form': {
      const r = decodeFormSpec(path, j);
      return r.ok ? ok({ kind: 'Form', spec: r.value }) : r;
    }
    case 'Filters': {
      const itemsJ = requireField(path, f, 'items', 'Filters item list');
      if (!itemsJ.ok) return itemsJ;
      const arr = requireArray(`${path}.items`, itemsJ.value);
      if (!arr.ok) return arr;
      const specs = traverseIndexed(arr.value, (i, item) =>
        decodeFilterSpec(`${path}.items[${i}]`, item),
      );
      return specs.ok ? ok({ kind: 'Filters', specs: specs.value }) : specs;
    }
    case 'Button': {
      const r = decodeButtonSpec(path, j);
      return r.ok ? ok({ kind: 'Button', spec: r.value }) : r;
    }
    case 'FileUpload': {
      const r = decodeFileUploadSpec(path, j);
      return r.ok ? ok({ kind: 'FileUpload', spec: r.value }) : r;
    }
    case 'Select': {
      const r = decodeSelectSpec(path, j);
      return r.ok ? ok({ kind: 'Select', spec: r.value }) : r;
    }
    default:
      return unknownDuCase(path, d.value, 'Form | Filters | Button | FileUpload | Select');
  }
};

// ─── Visualisation specs ─────────────────────────────────────────────────────

const decodeCellKindErased = (path: string, j: JsonAst): R<CellKindErased<unknown>> => {
  const fo = requireObject(path, j);
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
      const label = reqField(path, f, 'label', 'cell button label TextSource', decodeTextSource);
      return label.ok
        ? ok({ kind: 'Button', label: label.value, onClick: () => placeholderAction })
        : label;
    }
    case 'ButtonGroup': {
      const buttonsJ = requireField(path, f, 'buttons', 'button group list');
      if (!buttonsJ.ok) return buttonsJ;
      const arr = requireArray(`${path}.buttons`, buttonsJ.value);
      if (!arr.ok) return arr;
      type Btn = readonly [TextSource, (row: unknown) => Action<unknown>];
      const buttons = traverseIndexed<Btn>(arr.value, (i, item) => {
        const bo = requireObject(`${path}.buttons[${i}]`, item);
        if (!bo.ok) return bo;
        const label = reqField(
          `${path}.buttons[${i}]`,
          bo.value,
          'label',
          'button label TextSource',
          decodeTextSource,
        );
        if (!label.ok) return label;
        return ok<Btn>([label.value, () => placeholderAction]);
      });
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
      const k: CellKindErased<unknown> = {
        kind: 'Pill',
        label: () => ({ kind: 'Literal', value: CLOSURE }),
        tone: () => 'Default',
      };
      return ok(k);
    }
    case 'Progress': {
      const k: CellKindErased<unknown> = { kind: 'Progress', fraction: () => 0 };
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
        'Text | Numeric | Date | Editable | Checkbox | Button | ButtonGroup | Link | Pill | Progress | Custom',
      );
  }
};

const decodeColumnErased = (path: string, j: JsonAst): R<ColumnErased<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  // Phase 460 — `format`/`width` omitted-when-default (`CellFormat.None`/`ColumnWidth.Auto`).
  const format = optField(path, f, 'format', decodeCellFormat);
  if (!format.ok) return format;
  const kind = reqFieldAliased(path, f, 'kind', ['type'], 'CellKindErased', decodeCellKindErased);
  if (!kind.ok) return kind;
  const label = reqFieldAliased(
    path,
    f,
    'label',
    ['header', 'title'],
    'column label string',
    requireString,
  );
  if (!label.ok) return label;
  const width = optField(path, f, 'width', decodeColumnWidth);
  if (!width.ok) return width;
  // Phase 425 — `value` (closure) present → placeholder (the closure wins, renders Empty); absent →
  // omitted, and `field` (if present) drives the row-field projection with zero host code.
  const hasValue = tryField(f, 'value') !== undefined;
  const fieldJ = tryField(f, 'field');
  let field: string | undefined;
  if (fieldJ !== undefined) {
    const fr = requireString(`${path}.field`, fieldJ);
    if (!fr.ok) return fr;
    field = fr.value;
  }
  return ok({
    format: format.value ?? { kind: 'None' },
    kind: kind.value,
    label: label.value,
    width: width.value ?? { kind: 'Auto' },
    ...(hasValue ? { value: () => ({ kind: 'Empty' as const }) } : {}),
    ...(field !== undefined ? { field } : {}),
  });
};

// Phase 393 — decode the `{ headers, rows }` static-rows object of a read-only grid
// (also the shape the legacy `Table` decode-upgrade reads). Cells are `TextSource`.
type StaticRows = {
  readonly headers: readonly TextSource[];
  readonly rows: readonly (readonly TextSource[])[];
};
const decodeStaticRows = (path: string, j: JsonAst): R<StaticRows> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const headersJ = requireField(path, f, 'headers', 'headers TextSource list');
  if (!headersJ.ok) return headersJ;
  const harr = requireArray(`${path}.headers`, headersJ.value);
  if (!harr.ok) return harr;
  const headers = traverseIndexed(harr.value, (i, item) =>
    decodeTextSource(`${path}.headers[${i}]`, item),
  );
  if (!headers.ok) return headers;
  const rowsJ = requireField(path, f, 'rows', 'rows TextSource matrix');
  if (!rowsJ.ok) return rowsJ;
  const rarr = requireArray(`${path}.rows`, rowsJ.value);
  if (!rarr.ok) return rarr;
  const rows = traverseIndexed(rarr.value, (i, rowJ) => {
    const ro = requireArray(`${path}.rows[${i}]`, rowJ);
    if (!ro.ok) return ro;
    return traverseIndexed(ro.value, (k, cell) =>
      decodeTextSource(`${path}.rows[${i}][${k}]`, cell),
    );
  });
  if (!rows.ok) return rows;
  return ok({ headers: headers.value, rows: rows.value });
};

const decodeGridSpec = (path: string, j: JsonAst): R<GridSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const columnsJ = requireField(path, f, 'columns', 'columns list');
  if (!columnsJ.ok) return columnsJ;
  const arr = requireArray(`${path}.columns`, columnsJ.value);
  if (!arr.ok) return arr;
  const columns = traverseIndexed(arr.value, (i, item) =>
    decodeColumnErased(`${path}.columns[${i}]`, item),
  );
  if (!columns.ok) return columns;
  // 0.2.0 omitted-when-false.
  const editable = optField(path, f, 'editable', requireBool);
  if (!editable.ok) return editable;
  const source = reqFieldAliased(
    path,
    f,
    'source',
    ['data', 'rows'],
    'Grid source binding',
    decodeBinding,
  );
  if (!source.ok) return source;
  const hasRowClick = tryField(f, 'onRowClick') !== undefined;
  // Phase 425 — `rowKey` (closure) + `rowKeyField` (declarative) are sibling optional slots.
  const hasRowKey = tryField(f, 'rowKey') !== undefined;
  const rowKeyFieldJ = tryField(f, 'rowKeyField');
  let rowKeyField: string | undefined;
  if (rowKeyFieldJ !== undefined) {
    const rk = requireString(`${path}.rowKeyField`, rowKeyFieldJ);
    if (!rk.ok) return rk;
    rowKeyField = rk.value;
  }
  // Phase 393 — the static read-only mode (omitted for a data-bound grid, so existing fixtures
  // stay byte-identical).
  const staticRowsJ = tryField(f, 'staticRows');
  let staticRows: StaticRows | undefined;
  if (staticRowsJ !== undefined) {
    const sr = decodeStaticRows(`${path}.staticRows`, staticRowsJ);
    if (!sr.ok) return sr;
    staticRows = sr.value;
  }
  return ok({
    columns: columns.value,
    editable: editable.value ?? false,
    source: source.value as Binding<readonly unknown[]>,
    ...(hasRowClick ? { onRowClick: () => placeholderAction } : {}),
    ...(hasRowKey ? { rowKey: () => CLOSURE } : {}),
    ...(rowKeyField !== undefined ? { rowKeyField } : {}),
    ...(staticRows !== undefined ? { staticRows } : {}),
  });
};

const decodeChartSpec = (path: string, j: JsonAst): R<ChartSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const kind = reqField(path, f, 'kind', 'ChartKind', decodeChartKind);
  if (!kind.ok) return kind;
  const source = reqFieldAliased(
    path,
    f,
    'source',
    ['data'],
    'Chart source binding',
    decodeBinding,
  );
  if (!source.ok) return source;
  const xField = reqField(path, f, 'xField', 'xField string', requireString);
  if (!xField.ok) return xField;
  const yFieldsJ = requireField(path, f, 'yFields', 'yFields string list');
  if (!yFieldsJ.ok) return yFieldsJ;
  const arr = requireArray(`${path}.yFields`, yFieldsJ.value);
  if (!arr.ok) return arr;
  const yFields = traverseIndexed(arr.value, (i, item) =>
    requireString(`${path}.yFields[${i}]`, item),
  );
  if (!yFields.ok) return yFields;
  const title = optField(path, f, 'title', decodeTextSource);
  if (!title.ok) return title;
  const hasPointClick = tryField(f, 'onPointClick') !== undefined;
  // stacked (Phase 126) now round-trips; absent (legacy wire) defaults to false.
  const stacked = optField(path, f, 'stacked', requireBool);
  if (!stacked.ok) return stacked;
  return ok({
    kind: kind.value,
    source: source.value as Binding<readonly unknown[]>,
    xField: xField.value,
    yFields: yFields.value,
    stacked: stacked.value ?? false,
    ...(title.value !== undefined ? { title: title.value } : {}),
    ...(hasPointClick ? { onPointClick: () => placeholderAction } : {}),
  });
};

const decodeMapSpec = (
  path: string,
  j: JsonAst,
): R<import('@fuaran-ui/schema').MapSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const centreLatitude = reqField(path, f, 'centreLatitude', 'centre latitude float', requireFloat);
  if (!centreLatitude.ok) return centreLatitude;
  const centreLongitude = reqField(
    path,
    f,
    'centreLongitude',
    'centre longitude float',
    requireFloat,
  );
  if (!centreLongitude.ok) return centreLongitude;
  const source = reqFieldAliased(
    path,
    f,
    'source',
    ['data', 'markers'],
    'Map source binding',
    decodeBindingMarkerSeq,
  );
  if (!source.ok) return source;
  const zoom = reqField(path, f, 'zoom', 'zoom integer', requireInt);
  if (!zoom.ok) return zoom;
  const hasMarkerClick = tryField(f, 'onMarkerClick') !== undefined;
  return ok({
    centreLatitude: centreLatitude.value,
    centreLongitude: centreLongitude.value,
    source: source.value,
    zoom: zoom.value,
    ...(hasMarkerClick ? { onMarkerClick: () => placeholderAction } : {}),
  });
};

const decodeVisKind = (path: string, j: JsonAst): R<VisKind<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    // Wire discriminator 'DataGrid'; in-memory tag stays 'Grid'.
    case 'DataGrid': {
      const r = decodeGridSpec(path, j);
      return r.ok ? ok({ kind: 'Grid', spec: r.value }) : r;
    }
    case 'Chart': {
      const r = decodeChartSpec(path, j);
      return r.ok ? ok({ kind: 'Chart', spec: r.value }) : r;
    }
    case 'Map': {
      const r = decodeMapSpec(path, j);
      return r.ok ? ok({ kind: 'Map', spec: r.value }) : r;
    }
    default:
      return unknownDuCase(path, d.value, 'DataGrid | Chart | Table | Map');
  }
};

// ─── Layout specs ────────────────────────────────────────────────────────────

const decodeChildren = (path: string, fields: Fields): R<readonly Node<unknown>[]> => {
  const childrenJ = requireField(path, fields, 'children', 'children Node list');
  if (!childrenJ.ok) return childrenJ;
  const arr = requireArray(`${path}.children`, childrenJ.value);
  if (!arr.ok) return arr;
  return traverseIndexed(arr.value, (i, item) => decodeNodeAst(`${path}.children[${i}]`, item));
};

// ─── Box — the unified container (Phase 390) ─────────────────────────────────

const decodeBoxLayout = (path: string, j: JsonAst): R<BoxLayout> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    case 'Flex': {
      const direction = reqField(path, f, 'direction', 'Orientation', decodeOrientation);
      if (!direction.ok) return direction;
      const wrap = reqField(path, f, 'wrap', 'wrap bool', requireBool);
      if (!wrap.ok) return wrap;
      const gap = optField(path, f, 'gap', requireInt);
      if (!gap.ok) return gap;
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
          : reqFieldAliased(path, f, 'cols', ['columns'], 'cols integer', requireInt);
      if (!cols.ok) return cols;
      const gap = optField(path, f, 'gap', requireInt);
      if (!gap.ok) return gap;
      const templateColumns = optField(path, f, 'templateColumns', requireString);
      if (!templateColumns.ok) return templateColumns;
      return ok({
        kind: 'Grid',
        cols: cols.value,
        ...(gap.value !== undefined ? { gap: gap.value } : {}),
        ...(templateColumns.value !== undefined ? { templateColumns: templateColumns.value } : {}),
      });
    }
    case 'Auto':
      return ok({ kind: 'Auto' });
    default:
      return unknownDuCase(path, d.value, 'Flex | Grid | Auto');
  }
};

const decodeBoxRole = (path: string, j: JsonAst): R<BoxRole> => {
  const s = requireString(path, j);
  if (!s.ok) return s;
  switch (s.value) {
    case 'Group':
    case 'Card':
    case 'Dashboard':
    case 'Separator':
      return ok(s.value);
    default:
      return unknownDuCase(path, s.value, 'Group | Card | Dashboard | Separator');
  }
};

const decodeBox = (path: string, j: JsonAst): R<BoxSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const children = decodeChildren(path, f);
  if (!children.ok) return children;
  const heading = optFieldAliased(path, f, 'heading', ['title'], decodeTextSource);
  if (!heading.ok) return heading;
  const layout = reqField(path, f, 'layout', 'layout object', decodeBoxLayout);
  if (!layout.ok) return layout;
  const role = reqField(path, f, 'role', 'role string', decodeBoxRole);
  if (!role.ok) return role;
  return ok({
    children: children.value,
    ...(heading.value !== undefined ? { heading: heading.value } : {}),
    layout: layout.value,
    role: role.value,
  });
};

const decodeSplitPanelSpec = (path: string, j: JsonAst): R<SplitPanelSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const children = decodeChildren(path, f);
  if (!children.ok) return children;
  const weight = reqField(path, f, 'weight', 'weight float', requireFloat);
  if (!weight.ok) return weight;
  return ok({ children: children.value, weight: weight.value });
};

const decodeTabHeader = (path: string, j: JsonAst): R<TabHeader> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const label = reqField(path, f, 'label', 'tab header label TextSource', decodeTextSource);
  if (!label.ok) return label;
  const icon = optField(path, f, 'icon', decodeIconSource);
  if (!icon.ok) return icon;
  const disabled = optField(path, f, 'disabled', decodeBindingBool);
  if (!disabled.ok) return disabled;
  return ok({
    label: label.value,
    ...(icon.value !== undefined ? { icon: icon.value } : {}),
    ...(disabled.value !== undefined ? { disabled: disabled.value } : {}),
  });
};

const decodeTabsSpec = (path: string, j: JsonAst): R<TabsSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const children = decodeChildren(path, f);
  if (!children.ok) return children;
  // 0.2.0 omitted-when-default (`Horizontal`).
  const orientationJ = tryField(f, 'orientation');
  const orientation =
    orientationJ === undefined
      ? ok<Orientation>('Horizontal')
      : decodeOrientation(`${path}.orientation`, orientationJ);
  if (!orientation.ok) return orientation;
  let tabHeaders: readonly TabHeader[] | undefined;
  const thJ = tryField(f, 'tabHeaders');
  if (thJ !== undefined) {
    const arr = requireArray(`${path}.tabHeaders`, thJ);
    if (!arr.ok) return arr;
    const hs = traverseIndexed(arr.value, (i, item) =>
      decodeTabHeader(`${path}.tabHeaders[${i}]`, item),
    );
    if (!hs.ok) return hs;
    tabHeaders = hs.value;
  }
  let tabTags: readonly string[] | undefined;
  const ttJ = tryField(f, 'tabTags');
  if (ttJ !== undefined) {
    const arr = requireArray(`${path}.tabTags`, ttJ);
    if (!arr.ok) return arr;
    const ts = traverseIndexed(arr.value, (i, item) =>
      requireString(`${path}.tabTags[${i}]`, item),
    );
    if (!ts.ok) return ts;
    tabTags = ts.value;
  }
  const activeTag = optField(path, f, 'activeTag', decodeBindingString);
  if (!activeTag.ok) return activeTag;
  // activeIndex (Phase 126) now round-trips; absent (legacy wire) defaults to
  // Static 0. onSelect / onSelectTag (Phase 426): a present `"<closure>"`
  // sentinel → the inert placeholder; an absent key → omitted, arming the
  // renderer's ActiveIndex/ActiveTag write-back default.
  const activeIndex = optField(path, f, 'activeIndex', decodeBinding);
  if (!activeIndex.ok) return activeIndex;
  return ok({
    children: children.value,
    orientation: orientation.value,
    activeIndex: (activeIndex.value as Binding<number> | undefined) ?? { kind: 'Static', value: 0 },
    ...(tryField(f, 'onSelect') !== undefined ? { onSelect: () => placeholderAction } : {}),
    ...(tabHeaders !== undefined ? { tabHeaders } : {}),
    ...(tabTags !== undefined ? { tabTags } : {}),
    ...(activeTag.value !== undefined ? { activeTag: activeTag.value } : {}),
    ...(tryField(f, 'onSelectTag') !== undefined ? { onSelectTag: () => placeholderAction } : {}),
  });
};

const decodeStepperSpec = (path: string, j: JsonAst): R<StepperSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const activeStep = reqField(path, f, 'activeStep', 'activeStep binding', decodeBinding);
  if (!activeStep.ok) return activeStep;
  const children = decodeChildren(path, f);
  if (!children.ok) return children;
  // `onSelect` is a closure → the sentinel is consumed and reconstructs a
  // no-op placeholder action (mirrors Tabs).
  return ok({
    activeStep: activeStep.value as Binding<number>,
    children: children.value,
    onSelect: () => placeholderAction,
  });
};

const decodeSummaryListSpec = (path: string, j: JsonAst): R<SummaryListSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const children = decodeChildren(path, f);
  if (!children.ok) return children;
  const heading = optFieldAliased(path, f, 'heading', ['title'], decodeTextSource);
  if (!heading.ok) return heading;
  return ok({
    children: children.value,
    ...(heading.value !== undefined ? { heading: heading.value } : {}),
  });
};

const decodeDisclosureSpec = (path: string, j: JsonAst): R<DisclosureSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const children = decodeChildren(path, f);
  if (!children.ok) return children;
  const defaultOpen = reqField(path, f, 'defaultOpen', 'defaultOpen bool', requireBool);
  if (!defaultOpen.ok) return defaultOpen;
  const heading = reqFieldAliased(
    path,
    f,
    'heading',
    ['title'],
    'Disclosure heading TextSource',
    decodeTextSource,
  );
  if (!heading.ok) return heading;
  const open = reqField(path, f, 'open', 'open binding', decodeBinding);
  if (!open.ok) return open;
  return ok({
    children: children.value,
    defaultOpen: defaultOpen.value,
    heading: heading.value,
    open: open.value as Binding<boolean>,
    // Phase 426: a present `"<closure>"` sentinel → the inert placeholder; an
    // absent key → omitted, arming the `open` write-back default.
    ...(tryField(f, 'onToggle') !== undefined ? { onToggle: () => placeholderAction } : {}),
  });
};

const decodeModalSpec = (path: string, j: JsonAst): R<ModalSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const children = decodeChildren(path, f);
  if (!children.ok) return children;
  const dismissable = reqField(path, f, 'dismissable', 'dismissable bool', requireBool);
  if (!dismissable.ok) return dismissable;
  // `onDismiss` is optional since Phase 426: absent → omitted, arming the
  // `open` write-back default (dismiss writes `false` to the slot).
  const onDismiss = optField(path, f, 'onDismiss', decodeAction);
  if (!onDismiss.ok) return onDismiss;
  const open = reqField(path, f, 'open', 'open binding', decodeBinding);
  if (!open.ok) return open;
  const heading = optFieldAliased(path, f, 'heading', ['title'], decodeTextSource);
  if (!heading.ok) return heading;
  return ok({
    children: children.value,
    dismissable: dismissable.value,
    ...(onDismiss.value !== undefined ? { onDismiss: onDismiss.value } : {}),
    open: open.value as Binding<boolean>,
    ...(heading.value !== undefined ? { heading: heading.value } : {}),
  });
};

const decodeScrollAreaSpec = (path: string, j: JsonAst): R<ScrollAreaSpec<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const children = decodeChildren(path, f);
  if (!children.ok) return children;
  const orientation = reqField(
    path,
    f,
    'orientation',
    'ScrollOrientation',
    decodeScrollOrientation,
  );
  if (!orientation.ok) return orientation;
  const maxHeight = optField(path, f, 'maxHeight', requireInt);
  if (!maxHeight.ok) return maxHeight;
  const maxWidth = optField(path, f, 'maxWidth', requireInt);
  if (!maxWidth.ok) return maxWidth;
  return ok({
    children: children.value,
    orientation: orientation.value,
    ...(maxHeight.value !== undefined ? { maxHeight: maxHeight.value } : {}),
    ...(maxWidth.value !== undefined ? { maxWidth: maxWidth.value } : {}),
  });
};

const decodeLayoutKind = (path: string, j: JsonAst): R<LayoutKind<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  // Flat wire: spec fields are hoisted onto the kind object itself (no `spec`
  // wrapper, WIRE_FORMAT.md §3.2) — pass `j` to the spec decoder.
  switch (d.value) {
    // Phase 390 — the unified container + the four legacy decode-upgrades.
    case 'Box': {
      const r = decodeBox(path, j);
      return r.ok ? ok({ kind: 'Box', spec: r.value }) : r;
    }
    case 'SplitPanel': {
      const r = decodeSplitPanelSpec(path, j);
      return r.ok ? ok({ kind: 'SplitPanel', spec: r.value }) : r;
    }
    case 'Tabs': {
      const r = decodeTabsSpec(path, j);
      return r.ok ? ok({ kind: 'Tabs', spec: r.value }) : r;
    }
    case 'Stepper': {
      const r = decodeStepperSpec(path, j);
      return r.ok ? ok({ kind: 'Stepper', spec: r.value }) : r;
    }
    case 'SummaryList': {
      const r = decodeSummaryListSpec(path, j);
      return r.ok ? ok({ kind: 'SummaryList', spec: r.value }) : r;
    }
    case 'Disclosure': {
      const r = decodeDisclosureSpec(path, j);
      return r.ok ? ok({ kind: 'Disclosure', spec: r.value }) : r;
    }
    case 'Modal': {
      const r = decodeModalSpec(path, j);
      return r.ok ? ok({ kind: 'Modal', spec: r.value }) : r;
    }
    case 'ScrollArea': {
      const r = decodeScrollAreaSpec(path, j);
      return r.ok ? ok({ kind: 'ScrollArea', spec: r.value }) : r;
    }
    default:
      return unknownDuCase(
        path,
        d.value,
        'Box | SplitPanel | Tabs | Stepper | SummaryList | Disclosure | Modal | ScrollArea',
      );
  }
};

// ─── NodeKind ────────────────────────────────────────────────────────────────

const decodeContentHash = (path: string, j: JsonAst): R<ContentHash> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const algorithm = reqField(path, f, 'algorithm', 'hash algorithm string', requireString);
  if (!algorithm.ok) return algorithm;
  const hash = reqField(path, f, 'hash', 'hash string', requireString);
  if (!hash.ok) return hash;
  const strictnessR = reqField(
    path,
    f,
    'strictness',
    "'StrictReplay' | 'AdvisoryWarning' | 'Enforced'",
    requireString,
  );
  if (!strictnessR.ok) return strictnessR;
  const s = strictnessR.value;
  if (s !== 'StrictReplay' && s !== 'AdvisoryWarning' && s !== 'Enforced') {
    return unknownDuCase(`${path}.strictness`, s, 'StrictReplay | AdvisoryWarning | Enforced');
  }
  return ok({ algorithm: algorithm.value, hash: hash.value, strictness: s as HashStrictness });
};

// ─── Parameterised-fragment hole / effect / scalar decoders (Phase 180) ──────

const decodeHoleValueSpace = (path: string, j: JsonAst): R<HoleValueSpace> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const disc = requireDiscriminator(path, fo.value);
  if (!disc.ok) return disc;
  switch (disc.value) {
    case 'IntRange': {
      const min = reqField(path, fo.value, 'min', 'IntRange min', requireInt);
      if (!min.ok) return min;
      const max = reqField(path, fo.value, 'max', 'IntRange max', requireInt);
      if (!max.ok) return max;
      return ok({ kind: 'IntRange', min: min.value, max: max.value });
    }
    case 'FloatRange': {
      const min = reqField(path, fo.value, 'min', 'FloatRange min', requireFloat);
      if (!min.ok) return min;
      const max = reqField(path, fo.value, 'max', 'FloatRange max', requireFloat);
      if (!max.ok) return max;
      return ok({ kind: 'FloatRange', min: min.value, max: max.value });
    }
    case 'StringLen': {
      const minLen = reqField(path, fo.value, 'minLen', 'StringLen minLen', requireInt);
      if (!minLen.ok) return minLen;
      const maxLen = reqField(path, fo.value, 'maxLen', 'StringLen maxLen', requireInt);
      if (!maxLen.ok) return maxLen;
      return ok({ kind: 'StringLen', minLen: minLen.value, maxLen: maxLen.value });
    }
    case 'Enum': {
      const arr = reqField(path, fo.value, 'choices', 'Enum choices', requireArray);
      if (!arr.ok) return arr;
      const choices = traverseIndexed(arr.value, (i, item) =>
        requireString(`${path}.choices[${i}]`, item),
      );
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

const decodeFragmentScalar = (path: string, j: JsonAst): R<FragmentScalar> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const disc = requireDiscriminator(path, fo.value);
  if (!disc.ok) return disc;
  switch (disc.value) {
    case 'Int': {
      const v = reqField(path, fo.value, 'value', 'Int value', requireInt);
      return v.ok ? ok({ kind: 'int', value: v.value }) : v;
    }
    case 'Float': {
      const v = reqField(path, fo.value, 'value', 'Float value', requireFloat);
      return v.ok ? ok({ kind: 'float', value: v.value }) : v;
    }
    case 'Bool': {
      const v = reqField(path, fo.value, 'value', 'Bool value', requireBool);
      return v.ok ? ok({ kind: 'bool', value: v.value }) : v;
    }
    case 'Str': {
      const v = reqField(path, fo.value, 'value', 'Str value', requireString);
      return v.ok ? ok({ kind: 'str', value: v.value }) : v;
    }
    default:
      return unknownDuCase(path, disc.value, 'Int | Float | Bool | Str');
  }
};

const decodeHoleDecl = (path: string, j: JsonAst): R<HoleDecl> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const disc = requireDiscriminator(path, fo.value);
  if (!disc.ok) return disc;
  switch (disc.value) {
    case 'Value': {
      const name = reqField(path, fo.value, 'name', 'Value hole name', requireString);
      if (!name.ok) return name;
      const space = reqField(path, fo.value, 'space', 'Value hole space', decodeHoleValueSpace);
      if (!space.ok) return space;
      const def = optField(path, fo.value, 'default', decodeFragmentScalar);
      if (!def.ok) return def;
      return ok({
        kind: 'Value',
        name: name.value,
        space: space.value,
        ...(def.value !== undefined ? { default: def.value } : {}),
      });
    }
    case 'Slot': {
      const name = reqField(path, fo.value, 'name', 'Slot hole name', requireString);
      if (!name.ok) return name;
      const kc = optField(path, fo.value, 'kindConstraint', requireString);
      if (!kc.ok) return kc;
      return ok({
        kind: 'Slot',
        name: name.value,
        ...(kc.value !== undefined ? { kindConstraint: kc.value } : {}),
      });
    }
    case 'Repeat': {
      const name = reqField(path, fo.value, 'name', 'Repeat hole name', requireString);
      if (!name.ok) return name;
      const space = reqField(
        path,
        fo.value,
        'countSpace',
        'Repeat hole countSpace',
        decodeHoleValueSpace,
      );
      if (!space.ok) return space;
      return ok({ kind: 'Repeat', name: name.value, countSpace: space.value });
    }
    default:
      return unknownDuCase(path, disc.value, 'Value | Slot | Repeat');
  }
};

const decodeEffectClass = (path: string, j: JsonAst): R<EffectClass> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const host = reqField(path, fo.value, 'hostEffect', 'EffectClass hostEffect', requireString);
  if (!host.ok) return host;
  if (host.value !== 'Pure' && host.value !== 'ReadsHost' && host.value !== 'WritesHost')
    return unknownDuCase(`${path}.hostEffect`, host.value, 'Pure | ReadsHost | WritesHost');
  const det = reqField(path, fo.value, 'determinism', 'EffectClass determinism', requireString);
  if (!det.ok) return det;
  if (
    det.value !== 'Deterministic' &&
    det.value !== 'Clock' &&
    det.value !== 'Random' &&
    det.value !== 'Network'
  )
    return unknownDuCase(
      `${path}.determinism`,
      det.value,
      'Deterministic | Clock | Random | Network',
    );
  return ok({ hostEffect: host.value as HostEffect, determinism: det.value as DeterminismSource });
};

const decodeNodeKind = (path: string, j: JsonAst): R<NodeKind<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  switch (d.value) {
    // The four behavioural categories are flat on the wire (WIRE_FORMAT §3.2):
    // the `kind` object carries the primitive discriminator directly, so route
    // each primitive to its inner decoder and recover the category here. These
    // name-sets MUST stay in sync with the four inner decoders + the encoder.
    case 'Box':
    case 'SplitPanel':
    case 'Tabs':
    case 'Stepper':
    case 'SummaryList':
    case 'Disclosure':
    case 'Modal':
    case 'ScrollArea': {
      const k = decodeLayoutKind(path, j);
      return k.ok ? ok({ kind: 'Layout', layout: k.value }) : k;
    }
    case 'Heading':
    case 'Markdown':
    case 'Metric':
    case 'Badge':
    case 'Sparkline':
    case 'Callout':
    case 'Progress':
    case 'Skeleton':
    case 'LabelValueRow':
    case 'Fact':
    case 'Link':
    case 'Image':
    case 'List':
    case 'Toast':
    case 'CodeBlock':
    case 'Math':
    case 'Drawing': {
      const k = decodeDisplayKind(path, j);
      return k.ok ? ok({ kind: 'Display', display: k.value }) : k;
    }
    case 'Form':
    case 'Filters':
    case 'Button':
    case 'FileUpload':
    case 'Select': {
      const k = decodeInputKind(path, j);
      return k.ok ? ok({ kind: 'Input', input: k.value }) : k;
    }
    case 'DataGrid':
    case 'Chart':
    case 'Map': {
      const k = decodeVisKind(path, j);
      return k.ok ? ok({ kind: 'Visualisation', visualisation: k.value }) : k;
    }
    case 'Custom': {
      const moduleId = reqField(path, f, 'moduleId', 'Custom moduleId string', requireString);
      if (!moduleId.ok) return moduleId;
      const componentId = reqField(
        path,
        f,
        'componentId',
        'Custom componentId string',
        requireString,
      );
      if (!componentId.ok) return componentId;
      const propsJ = requireField(path, f, 'props', 'Custom props map');
      if (!propsJ.ok) return propsJ;
      const props = decodeJValMap(`${path}.props`, propsJ.value);
      if (!props.ok) return props;
      const contentHash = optField(path, f, 'contentHash', decodeContentHash);
      if (!contentHash.ok) return contentHash;
      let exposedNodeIds: readonly NodeId[] = [];
      const exJ = tryField(f, 'exposedNodeIds');
      if (exJ !== undefined) {
        const arr = requireArray(`${path}.exposedNodeIds`, exJ);
        if (!arr.ok) return arr;
        const ids = traverseIndexed(arr.value, (i, item) =>
          requireString(`${path}.exposedNodeIds[${i}]`, item),
        );
        if (!ids.ok) return ids;
        exposedNodeIds = ids.value as NodeId[];
      }
      return ok({
        kind: 'Custom',
        moduleId: moduleId.value,
        componentId: componentId.value,
        props: props.value,
        exposedNodeIds,
        ...(contentHash.value !== undefined ? { contentHash: contentHash.value } : {}),
      });
    }
    case 'ErrorBoundary': {
      const child = reqField(path, f, 'child', 'ErrorBoundary child Node', decodeNodeAst);
      if (!child.ok) return child;
      const fallback = reqField(path, f, 'fallback', 'ErrorBoundary fallback Node', decodeNodeAst);
      if (!fallback.ok) return fallback;
      return ok({ kind: 'ErrorBoundary', spec: { child: child.value, fallback: fallback.value } });
    }
    case 'Switch': {
      // State-bound conditional child (Phase 392). `stateKey` (string), `cases`
      // (array of `{child,match}` objects), `default` (Node) — all required.
      // Duplicate `match` values are NOT a decode error (first-match-wins keeps
      // decode structural; the pre-emit validator flags them, FUARAN082).
      const stateKey = reqField(path, f, 'stateKey', 'Switch stateKey string', requireString);
      if (!stateKey.ok) return stateKey;
      const casesArr = reqField(path, f, 'cases', 'Switch cases array', requireArray);
      if (!casesArr.ok) return casesArr;
      const cases = traverseIndexed(casesArr.value, (i, item) => {
        const cp = `${path}.cases[${i}]`;
        const co = requireObject(cp, item);
        if (!co.ok) return co;
        const m = reqField(cp, co.value, 'match', 'Switch case match string', requireString);
        if (!m.ok) return m;
        const c = reqField(cp, co.value, 'child', 'Switch case child Node', decodeNodeAst);
        if (!c.ok) return c;
        return ok({ match: m.value, child: c.value });
      });
      if (!cases.ok) return cases;
      const def = reqField(path, f, 'default', 'Switch default Node', decodeNodeAst);
      if (!def.ok) return def;
      return ok({
        kind: 'Switch',
        spec: { stateKey: stateKey.value, cases: cases.value, default: def.value },
      });
    }
    case 'FragmentDecl': {
      const name = reqField(path, f, 'name', 'FragmentDecl name string', requireString);
      if (!name.ok) return name;
      const body = reqField(path, f, 'body', 'FragmentDecl body Node', decodeNodeAst);
      if (!body.ok) return body;
      // Phase 180 — `holes` / `effect` additive; absent ⇒ degenerate fixed-body.
      let holes: readonly HoleDecl[] = [];
      const holesJ = tryField(f, 'holes');
      if (holesJ !== undefined) {
        const arr = requireArray(`${path}.holes`, holesJ);
        if (!arr.ok) return arr;
        const decoded = traverseIndexed(arr.value, (i, item) =>
          decodeHoleDecl(`${path}.holes[${i}]`, item),
        );
        if (!decoded.ok) return decoded;
        holes = decoded.value;
      }
      let effect: EffectClass = { hostEffect: 'Pure', determinism: 'Deterministic' };
      const effectJ = tryField(f, 'effect');
      if (effectJ !== undefined) {
        const e = decodeEffectClass(`${path}.effect`, effectJ);
        if (!e.ok) return e;
        effect = e.value;
      }
      return ok({
        kind: 'FragmentDecl',
        spec: { name: name.value as FragmentId, body: body.value, holes, effect },
      });
    }
    case 'FragmentRef': {
      const name = reqField(path, f, 'name', 'FragmentRef name string', requireString);
      if (!name.ok) return name;
      // Phase 180 — `args` additive; absent ⇒ degenerate zero-arg ref.
      const args: Record<string, FragmentArg<unknown>> = {};
      const argsJ = tryField(f, 'args');
      if (argsJ !== undefined) {
        const argsObj = requireObject(`${path}.args`, argsJ);
        if (!argsObj.ok) return argsObj;
        for (const [key, valueJ] of argsObj.value) {
          const argPath = `${path}.args.${key}`;
          const fo = requireObject(argPath, valueJ);
          if (!fo.ok) return fo;
          const disc = requireDiscriminator(argPath, fo.value);
          if (!disc.ok) return disc;
          if (disc.value === 'SlotArg') {
            const tree = reqField(argPath, fo.value, 'tree', 'SlotArg tree Node', decodeNodeAst);
            if (!tree.ok) return tree;
            args[key] = { kind: 'slot', tree: tree.value };
          } else {
            // Int | Float | Bool | Str — a value argument.
            const scalar = decodeFragmentScalar(argPath, valueJ);
            if (!scalar.ok) return scalar;
            args[key] = { kind: 'value', value: scalar.value };
          }
        }
      }
      return ok({ kind: 'FragmentRef', spec: { name: name.value as FragmentId, args } });
    }
    case 'Mount': {
      // Phase 265, §4o — the isolation/embedding boundary. Mirror the encoder:
      // required `scopeId` + `channel` + `capabilities`; optional `inputs`
      // (additive, reusing the FragmentArg decode). `onBubble` is a closure
      // sentinel on the wire → dropped from the typed shape. A malformed Mount
      // surfaces a structured DecodeError, never a throw (default-deny).
      const scopeId = reqField(path, f, 'scopeId', 'Mount scopeId string', requireString);
      if (!scopeId.ok) return scopeId;

      const channelObj = reqField(path, f, 'channel', 'Mount channel object', requireObject);
      if (!channelObj.ok) return channelObj;
      const direction = reqField(
        `${path}.channel`,
        channelObj.value,
        'direction',
        'channel direction string',
        requireString,
      );
      if (!direction.ok) return direction;
      if (direction.value !== 'OutOnly' && direction.value !== 'TwoWay')
        return makeError(
          'UNKNOWN_DU_CASE',
          `${path}.channel.direction`,
          `unknown ChannelDirection '${direction.value}'`,
          'OutOnly | TwoWay',
        );
      const dir = direction.value as 'OutOnly' | 'TwoWay';
      let messageShape: string | undefined;
      const msgShapeJ = tryField(channelObj.value, 'messageShape');
      if (msgShapeJ !== undefined) {
        const ms = requireString(`${path}.channel.messageShape`, msgShapeJ);
        if (!ms.ok) return ms;
        messageShape = ms.value;
      }

      const capsArr = reqField(path, f, 'capabilities', 'Mount capabilities array', requireArray);
      if (!capsArr.ok) return capsArr;
      const capabilities: string[] = [];
      for (let i = 0; i < capsArr.value.length; i++) {
        const c = requireString(`${path}.capabilities[${i}]`, capsArr.value[i]!);
        if (!c.ok) return c;
        capabilities.push(c.value);
      }

      // Phase 265 — `inputs` additive; absent ⇒ zero-input mount. Reuses the
      // FragmentArg decode (value scalar or slot subtree).
      const inputs: Record<string, FragmentArg<unknown>> = {};
      const inputsJ = tryField(f, 'inputs');
      if (inputsJ !== undefined) {
        const inputsObj = requireObject(`${path}.inputs`, inputsJ);
        if (!inputsObj.ok) return inputsObj;
        for (const [key, valueJ] of inputsObj.value) {
          const argPath = `${path}.inputs.${key}`;
          const fo = requireObject(argPath, valueJ);
          if (!fo.ok) return fo;
          const disc = requireDiscriminator(argPath, fo.value);
          if (!disc.ok) return disc;
          if (disc.value === 'SlotArg') {
            const tree = reqField(argPath, fo.value, 'tree', 'SlotArg tree Node', decodeNodeAst);
            if (!tree.ok) return tree;
            inputs[key] = { kind: 'slot', tree: tree.value };
          } else {
            const scalar = decodeFragmentScalar(argPath, valueJ);
            if (!scalar.ok) return scalar;
            inputs[key] = { kind: 'value', value: scalar.value };
          }
        }
      }

      // Build `channel` conditionally so `messageShape` is present only when
      // decoded (exactOptionalPropertyTypes forbids an explicit `undefined`).
      const channel =
        messageShape !== undefined ? { direction: dir, messageShape } : { direction: dir };

      return ok({
        kind: 'Mount',
        spec: {
          scopeId: scopeId.value,
          inputs,
          channel,
          capabilities,
        },
      });
    }
    default:
      return makeError(
        'WRONG_NODE_KIND',
        `${path}.$type`,
        `unknown NodeKind discriminator '${d.value}'`,
        'a Layout primitive (Box | SplitPanel | Tabs | Stepper | SummaryList | Disclosure | Modal | ScrollArea), a Display primitive (Heading | Markdown | Metric | Badge | Sparkline | Callout | Progress | Skeleton | LabelValueRow | Link | Image | List | Toast), an Input primitive (Form | Filters | Button | FileUpload | Select), a Visualisation primitive (DataGrid | Chart | Map), or Custom | ErrorBoundary | FragmentDecl | FragmentRef | Mount',
      );
  }
};

// ─── StateBehaviour / SemanticStyle / Accessibility / Node ───────────────────

const decodeStateBehaviour = (path: string, j: JsonAst): R<StateBehaviour<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const onLoading = optField(path, f, 'onLoading', decodeNodeAst);
  if (!onLoading.ok) return onLoading;
  const onEmpty = optField(path, f, 'onEmpty', decodeNodeAst);
  if (!onEmpty.ok) return onEmpty;
  const hasOnError = tryField(f, 'onError') !== undefined;
  return ok({
    ...(onLoading.value !== undefined ? { onLoading: onLoading.value } : {}),
    ...(onEmpty.value !== undefined ? { onEmpty: onEmpty.value } : {}),
    ...(hasOnError ? { onError: (_p: ErrorPayload): Node<unknown> => placeholderClosureNode } : {}),
  });
};

const decodeSemanticStyle = (path: string, j: JsonAst): R<SemanticStyle> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  // Phase 460 — tone/weight/emphasis join role/voice as omitted-when-default;
  // restore the identity default on absence.
  const tone = optField(path, f, 'tone', decodeTone);
  if (!tone.ok) return tone;
  const weight = optField(path, f, 'weight', decodeWeight);
  if (!weight.ok) return weight;
  const emphasis = optField(path, f, 'emphasis', decodeEmphasis);
  if (!emphasis.ok) return emphasis;
  // `role` / `voice` (Phase 147) are optional on the wire — omitted at their
  // defaults ('None' / 'Default'); restore the default on absence.
  const role = optField(path, f, 'role', decodeStyleRole);
  if (!role.ok) return role;
  const voice = optField(path, f, 'voice', decodeFontVoice);
  if (!voice.ok) return voice;
  return ok({
    tone: tone.value ?? 'Default',
    weight: weight.value ?? 'Standard',
    emphasis: emphasis.value ?? 'Normal',
    role: role.value ?? 'None',
    voice: voice.value ?? 'Default',
  });
};

const decodeAccessibility = (path: string, j: JsonAst): R<Accessibility> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const label = optField(path, f, 'label', decodeBindingString);
  if (!label.ok) return label;
  const labelledBy = optField(path, f, 'labelledBy', requireString);
  if (!labelledBy.ok) return labelledBy;
  const describedBy = optField(path, f, 'describedBy', requireString);
  if (!describedBy.ok) return describedBy;
  const role = optField(path, f, 'role', decodeAriaRole);
  if (!role.ok) return role;
  const liveRegion = optField(path, f, 'liveRegion', decodeLiveRegion);
  if (!liveRegion.ok) return liveRegion;
  const hidden = optField(path, f, 'hidden', decodeBindingBool);
  if (!hidden.ok) return hidden;
  return ok({
    ...(label.value !== undefined ? { label: label.value } : {}),
    ...(labelledBy.value !== undefined ? { labelledBy: labelledBy.value as NodeId } : {}),
    ...(describedBy.value !== undefined ? { describedBy: describedBy.value as NodeId } : {}),
    ...(role.value !== undefined ? { role: role.value } : {}),
    ...(liveRegion.value !== undefined ? { liveRegion: liveRegion.value } : {}),
    ...(hidden.value !== undefined ? { hidden: hidden.value } : {}),
  });
};

/** All-empty StateBehaviour the decoder restores when `state` is absent (§3.1). */
const emptyStateBehaviour: StateBehaviour<unknown> = {};

/** All-default SemanticStyle the decoder restores when `style` is absent (§3.1). */
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
  style: {
    tone: 'Default',
    weight: 'Standard',
    emphasis: 'Normal',
    role: 'None',
    voice: 'Default',
  },
};

const decodeNodeAst = (path: string, j: JsonAst): R<Node<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const idJ = requireField(path, f, 'id', 'Node id string');
  if (!idJ.ok) return idJ;
  const idStr = requireString(`${path}.id`, idJ.value);
  if (!idStr.ok) return idStr;
  if (idStr.value === '') {
    return makeError('EMPTY_NODE_ID', `${path}.id`, 'Node id is empty', 'non-empty string');
  }
  const kind = reqField(path, f, 'kind', 'NodeKind discriminator object', decodeNodeKind);
  if (!kind.ok) return kind;
  // `state` / `style` are omitted on the wire when empty / all-default
  // (WIRE_FORMAT.md §3.1) — restore the default on absence.
  const state =
    tryField(f, 'state') === undefined
      ? ok<StateBehaviour<unknown>>(emptyStateBehaviour)
      : reqField(path, f, 'state', 'StateBehaviour object', decodeStateBehaviour);
  if (!state.ok) return state;
  const style =
    tryField(f, 'style') === undefined
      ? ok<SemanticStyle>(defaultSemanticStyle)
      : reqField(path, f, 'style', 'SemanticStyle object', decodeSemanticStyle);
  if (!style.ok) return style;
  const accessibility = optField(path, f, 'accessibility', decodeAccessibility);
  if (!accessibility.ok) return accessibility;
  return ok({
    id: idStr.value as NodeId,
    kind: kind.value,
    state: state.value,
    style: style.value,
    ...(accessibility.value !== undefined ? { accessibility: accessibility.value } : {}),
  });
};

// ─── TreeOp ──────────────────────────────────────────────────────────────────

const decodeTreeOpAst = (path: string, j: JsonAst): R<TreeOp<unknown>> => {
  const fo = requireObject(path, j);
  if (!fo.ok) return fo;
  const f = fo.value;
  const d = requireDiscriminator(path, f);
  if (!d.ok) return d;
  const target = (): R<NodeId> => {
    const r = reqField(path, f, 'target', 'target NodeId', requireString);
    return r.ok ? ok(r.value as NodeId) : r;
  };
  switch (d.value) {
    case 'EditNode': {
      const t = target();
      if (!t.ok) return t;
      const newKind = reqField(path, f, 'newKind', 'NodeKind object', decodeNodeKind);
      return newKind.ok
        ? ok({ kind: 'EditNode', target: t.value, newKind: newKind.value })
        : newKind;
    }
    case 'UpdateProp': {
      const t = target();
      if (!t.ok) return t;
      const p = reqField(path, f, 'path', 'dot-separated path string', requireString);
      if (!p.ok) return p;
      const valueJ = requireField(path, f, 'value', 'JsonValue payload');
      if (!valueJ.ok) return valueJ;
      const value = decodeJVal(`${path}.value`, valueJ.value);
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
      if (!t.ok) return t;
      const slot = reqField(path, f, 'slot', 'slot name string', requireString);
      if (!slot.ok) return slot;
      const b = reqField(path, f, 'binding', 'Binding object', decodeBinding);
      return b.ok
        ? ok({ kind: 'ReplaceBinding', target: t.value, slot: slot.value, binding: b.value })
        : b;
    }
    case 'UpdateStyle': {
      const t = target();
      if (!t.ok) return t;
      const style = reqField(path, f, 'style', 'SemanticStyle object', decodeSemanticStyle);
      return style.ok ? ok({ kind: 'UpdateStyle', target: t.value, style: style.value }) : style;
    }
    case 'UpdateState': {
      const t = target();
      if (!t.ok) return t;
      const state = reqField(path, f, 'state', 'StateBehaviour object', decodeStateBehaviour);
      return state.ok ? ok({ kind: 'UpdateState', target: t.value, state: state.value }) : state;
    }
    case 'InsertChild': {
      const parentJ = reqField(path, f, 'parentId', 'parent NodeId', requireString);
      if (!parentJ.ok) return parentJ;
      // A legacy `position` is ACCEPTED AND IGNORED for the migration window
      // (phase 683, mirroring 681 on the F# side): the hosts adopt
      // independently, and a stored v1 emission must still apply — as an
      // append, since order is now ReorderChildren's. Simply not reading the
      // field is the tolerance; this decoder takes named fields and ignores
      // the rest. It is a migration mechanism, not a form offered to an
      // author: nothing that teaches the wire mentions it. Phase 687 closes
      // the window and makes it a decode error.
      const child = reqField(path, f, 'child', 'child Node object', decodeNodeAst);
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
      const t = target();
      if (!t.ok) return t;
      // Legacy `newPosition` accepted and ignored — see InsertChild above.
      const newParent = reqField(path, f, 'newParentId', 'new parent NodeId', requireString);
      return newParent.ok
        ? ok({
            kind: 'MoveNode',
            target: t.value,
            newParentId: newParent.value as NodeId,
          })
        : newParent;
    }
    case 'ReorderChildren': {
      const parentJ = reqField(path, f, 'parentId', 'parent NodeId', requireString);
      if (!parentJ.ok) return parentJ;
      const newOrderJ = requireField(path, f, 'newOrder', 'NodeId list');
      if (!newOrderJ.ok) return newOrderJ;
      const arr = requireArray(`${path}.newOrder`, newOrderJ.value);
      if (!arr.ok) return arr;
      const newOrder = traverseIndexed(arr.value, (i, item) =>
        requireString(`${path}.newOrder[${i}]`, item),
      );
      return newOrder.ok
        ? ok({
            kind: 'ReorderChildren',
            parentId: parentJ.value as NodeId,
            newOrder: newOrder.value as NodeId[],
          })
        : newOrder;
    }
    case 'ReplaceRoot': {
      const n = reqField(path, f, 'node', 'root Node object', decodeNodeAst);
      return n.ok ? ok({ kind: 'ReplaceRoot', node: n.value }) : n;
    }
    case 'Batch': {
      const opsJ = requireField(path, f, 'ops', 'Batch inner-op list');
      if (!opsJ.ok) return opsJ;
      const arr = requireArray(`${path}.ops`, opsJ.value);
      if (!arr.ok) return arr;
      const ops = traverseIndexed(arr.value, (i, item) =>
        decodeTreeOpAst(`${path}.ops[${i}]`, item),
      );
      return ops.ok ? ok({ kind: 'Batch', ops: ops.value }) : ops;
    }
    default:
      return unknownDuCase(
        path,
        d.value,
        'EditNode | UpdateProp | ReplaceBinding | UpdateStyle | UpdateState | InsertChild | RemoveNode | MoveNode | ReorderChildren | ReplaceRoot | Batch',
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

const viaAst = <T>(v: JsonValue, dec: (p: string, j: JsonAst) => R<T>): Result<T, string> => {
  const r = dec('$value', valueToAst(v));
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error.message };
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
  /**
   * The behavioural `emphasis` BOOL on Fact / LabelValueRow — the UpdateProp
   * twin of `decodeEmphasisFlag`, so a TreeOp edit gets the same
   * cross-vocabulary admission as a fresh decode (0.2.8, 2026-07-19 sweep).
   */
  emphasisFlag: (v: JsonValue): Result<boolean, string> => viaAst(v, decodeEmphasisFlag),
  headingVariant: (v: JsonValue): Result<HeadingVariant, string> => viaAst(v, decodeHeadingVariant),
  badgeVariant: (v: JsonValue): Result<BadgeVariant, string> => viaAst(v, decodeBadgeVariant),
  iconSource: (v: JsonValue): Result<IconSource, string> => viaAst(v, decodeIconSource),
};

// ─── Public surface ──────────────────────────────────────────────────────────

const invalidJson = (parseMessage: string): R<never> =>
  makeError(
    'INVALID_JSON',
    '$',
    `input is not valid JSON: ${parseMessage}`,
    'well-formed JSON object per the canonical-JSON shape',
  );

/** Decode a canonical-JSON `Node` payload into the storage-shape `Node<unknown>`. */
export const decodeNode = (json: string): R<Node<unknown>> => {
  const parsed = parse(json);
  return parsed.ok ? decodeNodeAst('$', parsed.value) : invalidJson(parsed.error.message);
};

/** Decode a canonical-JSON `TreeOp` payload into the storage-shape `TreeOp<unknown>`. */
export const decodeOp = (json: string): R<TreeOp<unknown>> => {
  const parsed = parse(json);
  return parsed.ok ? decodeTreeOpAst('$', parsed.value) : invalidJson(parsed.error.message);
};
