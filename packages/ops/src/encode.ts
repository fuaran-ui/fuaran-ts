// ============================================================================
//  @fuaran-ui/ops — canonical-JSON encoder.
//
//  Symmetric port of Fuaran.UI.OpStream.Abstractions.CanonicalJson
//  (encodeNode / encodeOp). Produces the deterministic, byte-stable wire form
//  pinned by fuaran-dotnet/docs/WIRE_FORMAT.md §2:
//
//   - object keys sorted by Ordinal (UTF-16 code-unit) comparison;
//   - `None` / `undefined` option fields omitted entirely (never `"k":null`);
//   - DU cases as `{"$type":"<CaseName>", …}` objects;
//   - bare-string enums (Orientation / ToneVariant / …) as plain strings;
//   - NaN / ±∞ as the quoted sentinels "NaN" / "Infinity" / "-Infinity";
//   - closures / unobservable runtime payloads as "<closure>";
//   - un-introspectable `Binding.Static` payloads as "<opaque>";
//   - Node.motion / Node.extraAttributes wire-omitted (WIRE_FORMAT.md §9).
//
//  Verified byte-for-byte against the workspace wire-format-fixtures corpus by
//  test/corpus.test.ts. This is the load-bearing "no silent drift" surface:
//  the encoder must reproduce the F# encoder's exact bytes for every fixture.
// ============================================================================

import { controlValueDefaults } from '@fuaran-ui/schema';
import type {
  Accessibility,
  Action,
  Agg,
  BadgeSpec,
  Cell,
  ColExpr,
  ColPair,
  ColumnType,
  DataColumn,
  DataSource,
  InvokeArg,
  SortKey,
  Transform,
  LinkSpec,
  Binding,
  BoxLayout,
  BoxSpec,
  ButtonSpec,
  CalloutSpec,
  CellFormat,
  CellKindErased,
  ChartSpec,
  ColumnErased,
  ColumnWidth,
  DisclosureSpec,
  DisplayKind,
  EffectClass,
  ImageSpec,
  ListSpec,
  ModalSpec,
  ScrollAreaSpec,
  ToastSpec,
  CodeBlockSpec,
  CurveCommand,
  DrawPoint,
  DrawStyle,
  DrawingSpec,
  MathSpec,
  Shape,
  ViewBox,
  MathDisplay,
  FileUploadSpec,
  FilterSpec,
  FragmentArg,
  FragmentScalar,
  Format,
  FormField,
  FormFieldKind,
  FormSpec,
  LocaleSource,
  GridSpec,
  HeadingSpec,
  HoleDecl,
  HoleValueSpace,
  InputKind,
  JsonValue,
  MetricSpec,
  LabelValueRowSpec,
  FactSpec,
  LayoutKind,
  LocalFlushTrigger,
  MapMarker,
  MapSpec,
  MarkdownSpec,
  Node,
  NodeKind,
  ProgressSpec,
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
  Emphasis,
  ToneVariant,
  TabHeader,
  TableSpec,
  TabsSpec,
  TextSource,
  VisKind,
} from '@fuaran-ui/schema';

import type { JsonAst } from './parse.js';
import type { TreeOp } from './treeOp.js';

// ─── Primitive emitters ──────────────────────────────────────────────────────

const assertNever = (x: never): never => {
  throw new Error(`@fuaran-ui/ops encode: unreachable case ${JSON.stringify(x)}`);
};

/** Quote + escape a string per WIRE_FORMAT.md §2 rule 6 (only " \ and control chars). */
const str = (s: string): string => {
  let out = '"';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    const code = s.charCodeAt(i);
    if (c === '"') {
      out += '\\"';
    } else if (c === '\\') {
      out += '\\\\';
    } else if (code < 0x20) {
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else {
      out += c;
    }
  }
  return out + '"';
};

/**
 * Render a finite double in .NET `Double.ToString("R", InvariantCulture)`
 * layout — the canonical numeric form mandated by WIRE_FORMAT.md §2 rule 5.
 *
 * Both runtimes compute the SAME shortest round-trip *digits* (.NET "R" and
 * JS `Number.prototype.toString()` are both shortest-round-trip since .NET
 * Core 3.0). They diverge only in *layout*: the fixed-vs-scientific threshold
 * and the scientific spelling. .NET uses fixed notation iff the leading-digit
 * decimal exponent `e` is in `[-4, 16]`, else scientific with an uppercase
 * `E`, an always-present sign, and a ≥2-digit zero-padded exponent
 * (`1E+21`, `1E-07`, `1.2345678901234568E+17`). JS's thresholds are wider
 * (scientific only for `e ≥ 21` or `e ≤ -7`) and its scientific form is
 * lowercase with an unpadded exponent (`1e+21`, `1e-7`).
 *
 * This normaliser extracts the shared shortest digits + exponent from JS's
 * own `toString()` and re-lays them out in .NET form, so the TS encoder is
 * byte-identical to the F# encoder across the whole finite-double range — not
 * just the int53 plain-decimal sub-range the two happened to already agree on
 * (Phase 117).
 */
export const formatFiniteDouble = (n: number): string => {
  if (n === 0) return '0';
  const neg = n < 0;
  const s = Math.abs(n).toString();

  // Decompose into significant `digits` (no point) + `exp`, the base-10
  // exponent of the leading digit (value = d0.d1d2… × 10^exp).
  let digits: string;
  let exp: number;
  const eIdx = s.indexOf('e');
  if (eIdx >= 0) {
    const mant = s.slice(0, eIdx);
    const mantExp = parseInt(s.slice(eIdx + 1), 10);
    const dot = mant.indexOf('.');
    if (dot < 0) {
      digits = mant;
      exp = mantExp + (mant.length - 1);
    } else {
      digits = mant.slice(0, dot) + mant.slice(dot + 1);
      exp = mantExp + (dot - 1);
    }
  } else {
    const dot = s.indexOf('.');
    if (dot < 0) {
      digits = s;
      exp = s.length - 1;
    } else {
      const intPart = s.slice(0, dot);
      const fracPart = s.slice(dot + 1);
      if (intPart === '0') {
        const leadingZeros = fracPart.length - fracPart.replace(/^0+/, '').length;
        digits = fracPart.slice(leadingZeros);
        exp = -(leadingZeros + 1);
      } else {
        digits = intPart + fracPart;
        exp = intPart.length - 1;
      }
    }
  }

  // Reduce to shortest significant digits (the leading digit is already
  // significant, so only trailing zeros can be dropped).
  digits = digits.replace(/0+$/, '') || '0';

  let out: string;
  if (exp >= -4 && exp <= 16) {
    // Fixed-point layout.
    if (exp >= 0) {
      if (digits.length <= exp + 1) {
        out = digits + '0'.repeat(exp + 1 - digits.length);
      } else {
        out = digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
      }
    } else {
      out = '0.' + '0'.repeat(-exp - 1) + digits;
    }
  } else {
    // Scientific layout: uppercase E, signed, ≥2-digit zero-padded exponent.
    const mantissa = digits.length === 1 ? digits : digits[0] + '.' + digits.slice(1);
    const expSign = exp >= 0 ? '+' : '-';
    const expDigits = Math.abs(exp).toString().padStart(2, '0');
    out = mantissa + 'E' + expSign + expDigits;
  }

  return neg ? '-' + out : out;
};

/** Number rule (§2 rule 5): finite via .NET "R" layout; specials as quoted sentinels; −0 → 0. */
export const num = (n: number): string => {
  if (Number.isNaN(n)) return '"NaN"';
  if (n === Infinity) return '"Infinity"';
  if (n === -Infinity) return '"-Infinity"';
  return formatFiniteDouble(n);
};

const bool = (b: boolean): string => (b ? 'true' : 'false');

type Field = readonly [string, string];

/** Emit an object with Ordinal-sorted keys (§2 rule 2). */
const jObject = (fields: readonly Field[]): string => {
  const sorted = [...fields].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return '{' + sorted.map(([k, v]) => str(k) + ':' + v).join(',') + '}';
};

const jArray = (items: readonly string[]): string => '[' + items.join(',') + ']';

/** A `$type`-discriminated DU object (§2 rule 8). */
const caseObj = (discriminator: string, fields: readonly Field[]): string =>
  jObject([['$type', str(discriminator)], ...fields]);

/**
 * Hoist a spec's fields directly under the kind's `$type` discriminator — the
 * flat wire carries no `spec` wrapper (WIRE_FORMAT.md §3.2). `specJson` is the
 * spec's `{…}` object string (keys already Ordinal-sorted); we splice
 * `"$type":"<disc>"` in front of those fields. Byte-correct because `$` (0x24)
 * sorts before every lowercase spec field name, so `$type` stays the canonical
 * first key and the spliced result remains Ordinal-sorted. Port of the F#
 * `CanonicalJson.hoistSpec` helper.
 */
const hoistSpec = (discriminator: string, specJson: string): string => {
  const head = '{' + str('$type') + ':' + str(discriminator);
  // specJson is "{…}" (or "{}" for a field-less spec); splice its inner fields
  // in after $type when present.
  return specJson.length > 2 ? head + ',' + specJson.slice(1, -1) + '}' : head + '}';
};

const CLOSURE = str('<closure>');
const OPAQUE = str('<opaque>');

/**
 * Best-effort `obj`-typed encoder — port of F# `appendObj`. Recognised JS
 * primitives encode natively; everything else (arrays, plain objects, …) is
 * the `"<opaque>"` sentinel (§5). No reflection. `Date` → Unix seconds (§2
 * rule 11). Since Phase 429 the enumerated slot-typed payloads (options /
 * values / series / markers) bypass this via `binding`'s `staticEnc`
 * parameter; this catch-all is the residual-opaque boundary for genuinely
 * host-typed payloads, whose decoded "<opaque>" placeholder re-encodes here
 * as `"<opaque>"`, keeping the round-trip byte-stable.
 */
const objValue = (v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return str(v);
  if (typeof v === 'boolean') return bool(v);
  if (typeof v === 'number') return num(v);
  if (v instanceof Date) return num(Math.trunc(v.getTime() / 1000));
  return OPAQUE;
};

/**
 * A structured `JsonValue` payload (Custom props, action payloads, I18n args, a
 * wire-form `UpdateProp` value) — port of F# `encodeJVal`. Renders the value
 * FAITHFULLY at any nesting depth: objects with Ordinal-sorted keys, arrays in
 * order, the pinned number layout — no `"<opaque>"` collapse. (The wire model
 * has no null, so a null leaf is unrepresentable; the decoder rejects it, so it
 * cannot reach here from a decoded value.) Keeping this distinct from `objValue`
 * — which stays the best-effort encoder for the genuinely obj-erased seams
 * (`Binding.Static`) — is exactly the F# `encodeJVal` vs `appendObj` split.
 */
const jsonValue = (v: JsonValue): string => {
  if (v === null) return 'null';
  if (typeof v === 'string') return str(v);
  if (typeof v === 'boolean') return bool(v);
  if (typeof v === 'number') return num(v);
  if (Array.isArray(v)) return jArray(v.map(jsonValue));
  return jObject(
    Object.entries(v as Record<string, JsonValue>).map(([k, x]) => [k, jsonValue(x)] as const),
  );
};

/** A `Map<string, JsonValue>` — port of F# `encodeMap` (structural keys, faithful per-value). */
const jsonMap = (m: Readonly<Record<string, JsonValue>>): string =>
  jObject(Object.entries(m).map(([k, v]) => [k, jsonValue(v)] as const));

/**
 * Re-render a parsed JSON AST (parse.ts) to canonical wire bytes — Ordinal-
 * sorted object keys (§2 rule 2), the §2 rule-5 number layout, the §2 rule-6
 * string escapes — using the very primitives the encoder uses. For input that
 * was already canonical, `renderAstCanonical(parse(x)) === x`. This is the
 * §15 wire-versioning building block: it re-emits a preserved `Unknown`
 * payload byte-for-byte (must-ignore-but-preserve, WIRE_FORMAT.md §15.3) and
 * renders the `$profile` / `$payload` envelope. Mirrors F#
 * `Fuaran.Core.Wire.Canon.render` composed over the same JVal shape.
 */
export const renderAstCanonical = (ast: JsonAst): string => {
  switch (ast.kind) {
    case 'JNull':
      return 'null';
    case 'JBool':
      return bool(ast.value);
    case 'JNumber':
      return num(ast.value);
    case 'JString':
      return str(ast.value);
    case 'JArray':
      return jArray(ast.items.map(renderAstCanonical));
    case 'JObject':
      return jObject([...ast.fields].map(([k, v]) => [k, renderAstCanonical(v)] as const));
  }
};

// ─── Compute layer (Phase 282 / 284) — DataSource / Transform / ColExpr / Cell ─
//
// Byte-identical port of the Fuaran.Core columnar + dataframe-algebra wire codecs
// (`Fuaran.Core.ColumnCodec` / `Fuaran.Core.DataFrameCodec`), which render under
// the SAME canonical `$type` discipline this encoder uses (Ordinal-sorted keys,
// the pinned float layout, `caseObj` for `$type`-tagged DU positions). Verified
// against nodes/grid-transform.json in the workspace corpus. The host
// `Binding.Transform` (below) splices a pipeline array + a DataSource object —
// `$type` (0x24) sorts before `pipeline` < `source`, so the composite stays
// canonical.

/** A JInt-shaped integer literal (decimal, no point/exponent) — port of F# `string i`. */
const intLit = (n: number): string => String(Math.trunc(n));

/** Cell type tags map 1:1 onto the in-memory `ColumnType` values (canonical wire tags). */
type WireColumnType = ColumnType;

/**
 * The present-cell JSON value for a column of type `ty` — port of F#
 * `ColumnCodec.cellJson`. A `Null` cell emits the type-default placeholder (the
 * validity mask records the nullity); an `Int` widens to a float in a float
 * column; every other present cell encodes as-is.
 */
const columnCellWire = (ty: WireColumnType, c: Cell): string => {
  switch (c.kind) {
    case 'Null':
      // Cell.defaultFor ty, then cellJson: int→"0", float→"0", bool→false, others→"".
      return ty === 'bool' ? bool(false) : ty === 'int' || ty === 'float' ? '0' : str('');
    case 'Int':
      return ty === 'float' ? num(c.value) : intLit(c.value);
    case 'Float':
      return num(c.value);
    case 'Bool':
      return bool(c.value);
    case 'Str':
    case 'Date':
    case 'Timestamp':
      return str(c.value);
    default:
      return assertNever(c);
  }
};

const dataColumnJson = (c: DataColumn): string =>
  jObject([
    ['values', jArray(c.cells.map((cell) => columnCellWire(c.type, cell)))],
    ['validity', jArray(c.cells.map((cell) => bool(cell.kind !== 'Null')))],
  ]);

const schemaJson = (
  schema: readonly { readonly name: string; readonly type: ColumnType }[],
): string =>
  jArray(
    schema.map((e) =>
      jObject([
        ['name', str(e.name)],
        ['type', str(e.type)],
      ]),
    ),
  );

/** Encode a `DataSource` — port of F# `ColumnCodec.encodeJson`. */
const dataSource = (src: DataSource): string => {
  if (src.kind === 'Ref') {
    return jObject([
      ['schema', jArray([])],
      ['ref', str(src.name)],
    ]);
  }
  const t = src.table;
  const columns: Field[] = t.schema.map((e) => {
    const col: DataColumn = t.columns.find((c) => c.name === e.name) ?? {
      name: e.name,
      type: 'string',
      cells: [],
    };
    return [e.name, dataColumnJson(col)];
  });
  return jObject([
    ['schema', schemaJson(t.schema)],
    ['columns', jObject(columns)],
  ]);
};

/** A type-tagged literal cell — port of F# `DataFrameCodec.cellToJson`. */
const cellLit = (c: Cell): string => {
  switch (c.kind) {
    case 'Null':
      return caseObj('Null', []);
    case 'Int':
      return caseObj('Int', [['value', intLit(c.value)]]);
    case 'Float':
      return caseObj('Float', [['value', num(c.value)]]);
    case 'Bool':
      return caseObj('Bool', [['value', bool(c.value)]]);
    case 'Str':
      return caseObj('Str', [['value', str(c.value)]]);
    case 'Date':
      return caseObj('Date', [['value', str(c.value)]]);
    case 'Timestamp':
      return caseObj('Timestamp', [['value', str(c.value)]]);
    default:
      return assertNever(c);
  }
};

/** A `ColExpr` — port of F# `DataFrameCodec.encodeExpr`. */
const colExpr = (e: ColExpr): string => {
  switch (e.kind) {
    case 'col':
      return caseObj('col', [['name', str(e.name)]]);
    case 'param':
      return caseObj('param', [['name', str(e.name)]]);
    case 'lit':
      return caseObj('lit', [['cell', cellLit(e.cell)]]);
    case 'binary':
      return caseObj('binary', [
        ['op', str(e.op)],
        ['left', colExpr(e.left)],
        ['right', colExpr(e.right)],
      ]);
    case 'not':
      return caseObj('not', [['expr', colExpr(e.expr)]]);
    case 'coalesce':
      return caseObj('coalesce', [['exprs', jArray(e.exprs.map(colExpr))]]);
    case 'case':
      return caseObj('case', [
        [
          'cases',
          jArray(
            e.cases.map((c) =>
              jObject([
                ['when', colExpr(c.when)],
                ['then', colExpr(c.then)],
              ]),
            ),
          ),
        ],
        ['else', colExpr(e.else)],
      ]);
    case 'cast':
      return caseObj('cast', [
        ['type', str(e.type)],
        ['expr', colExpr(e.expr)],
      ]);
    case 'apply':
      return caseObj('apply', [
        ['fn', str(e.fn)],
        ['args', jArray(e.args.map(colExpr))],
      ]);
    case 'in':
      return caseObj('in', [
        ['expr', colExpr(e.expr)],
        ['items', jArray(e.items.map(colExpr))],
      ]);
    case 'inParam':
      return caseObj('in', [
        ['expr', colExpr(e.expr)],
        ['param', str(e.param)],
      ]);
    case 'isNull':
      return caseObj('isNull', [['expr', colExpr(e.expr)]]);
    default:
      return assertNever(e);
  }
};

const pairJson = (p: ColPair): string =>
  jObject([
    ['a', str(p.a)],
    ['b', str(p.b)],
  ]);

const aggJson = (a: Agg): string =>
  jObject([
    ['name', str(a.name)],
    ['fn', str(a.fn)],
    ['of', str(a.of)],
  ]);

const orderJson = (s: SortKey): string =>
  jObject([
    ['col', str(s.col)],
    ['dir', str(s.dir)],
  ]);

/** A `Transform` step — port of F# `DataFrameCodec.encodeTransform`. */
const transformStep = (t: Transform): string => {
  switch (t.kind) {
    case 'filter':
      return caseObj('filter', [['pred', colExpr(t.pred)]]);
    case 'project':
      return caseObj('project', [['cols', jArray(t.cols.map(pairJson))]]);
    case 'derive':
      return caseObj('derive', [
        ['name', str(t.name)],
        ['expr', colExpr(t.expr)],
      ]);
    case 'groupBy':
      return caseObj('groupBy', [
        ['keys', jArray(t.keys.map(str))],
        ['aggs', jArray(t.aggs.map(aggJson))],
      ]);
    case 'join':
      return caseObj('join', [
        ['source', dataSource(t.source)],
        ['on', jArray(t.on.map(pairJson))],
        ['how', str(t.how)],
      ]);
    case 'window':
      return caseObj('window', [
        ['partitionBy', jArray(t.spec.partitionBy.map(str))],
        ['orderBy', jArray(t.spec.orderBy.map(orderJson))],
        ['fn', str(t.spec.fn)],
        ['of', str(t.spec.of)],
        ['as', str(t.spec.as)],
      ]);
    case 'pivot':
      return caseObj('pivot', [
        ['index', jArray(t.spec.index.map(str))],
        ['on', str(t.spec.on)],
        ['values', str(t.spec.values)],
        ['agg', str(t.spec.agg)],
      ]);
    case 'unpivot':
      return caseObj('unpivot', [
        ['idVars', jArray(t.idVars.map(str))],
        ['valueVars', jArray(t.valueVars.map(str))],
      ]);
    case 'sort':
      return caseObj('sort', [['by', jArray(t.by.map(orderJson))]]);
    case 'distinct':
      return caseObj('distinct', []);
    case 'limit':
      return caseObj('limit', [
        ['n', intLit(t.n)],
        ['offset', intLit(t.offset)],
      ]);
    case 'union':
      return caseObj('union', [['source', dataSource(t.source)]]);
    default:
      return assertNever(t);
  }
};

/** Encode a `DataSource` to its canonical-JSON string (Compute layer). */
export const encodeDataSource = (src: DataSource): string => dataSource(src);

/** Encode a literal `Cell` to its `$type`-tagged canonical-JSON string. */
export const encodeCell = (c: Cell): string => cellLit(c);

/** Encode a `ColExpr` to its canonical-JSON string. */
export const encodeColExpr = (e: ColExpr): string => colExpr(e);

/** Encode a transform `pipeline` (ordered steps) to its canonical-JSON array string. */
export const encodePipeline = (pipeline: readonly Transform[]): string =>
  jArray(pipeline.map(transformStep));

/**
 * The canonical `args` array of a `Binding.Invoke` / `Action.Invoke` (Phase 283)
 * — scalar `(addr, value)` pairs `[{"addr":…,"value":…}]`. Shared by both arms.
 */
const invokeArgs = (args: readonly InvokeArg[]): string =>
  jArray(
    args.map((a) =>
      jObject([
        ['addr', str(a.addr)],
        ['value', str(a.value)],
      ]),
    ),
  );

// ─── Bindings / actions / text ───────────────────────────────────────────────

const flushTrigger = (t: LocalFlushTrigger): string => {
  switch (t.kind) {
    case 'OnBlur':
      return caseObj('OnBlur', []);
    case 'OnSubmit':
      return caseObj('OnSubmit', []);
    case 'OnCommitAction':
      return caseObj('OnCommitAction', []);
    case 'OnDebounce':
      return caseObj('OnDebounce', [['milliseconds', num(t.milliseconds)]]);
    default:
      return assertNever(t);
  }
};

/**
 * Phase 429 — the typed-static-payload seam. `staticEnc` names the slot's own
 * encoding for the `T` payload positions (`Static.value` and
 * `State.defaultValue`; `Local.initialFrom` recurses with the same encoder).
 * The default is `objValue` (primitives + the `"<opaque>"` catch-all), so
 * untyped slots stay byte-identical; the enumerated slot-typed call sites pass
 * the typed encoders below. Mirror of the F# `encodeBindingWith` parameter.
 */
const binding = <T>(b: Binding<T>, staticEnc: (v: T) => string = objValue): string => {
  switch (b.kind) {
    case 'Static': {
      // Phase 677 — absence is structural: a binding carrying no value omits the
      // key rather than emitting JSON null, for which the wire model has no case.
      const valueFields: readonly Field[] =
        b.value === null || b.value === undefined ? [] : [['value', staticEnc(b.value)]];
      return caseObj('Static', valueFields);
    }
    case 'Query': {
      // Phase 421 — `dependsOn` rides as a string array, omitted-when-empty.
      // 0.2.0 — the `accessor` closure sentinel is OFF the wire (decoders
      // never read it; pure token weight).
      const dependsOnFields: readonly Field[] =
        b.dependsOn !== undefined && b.dependsOn.length > 0
          ? [['dependsOn', jArray(b.dependsOn.map((s) => str(s)))]]
          : [];
      return caseObj('Query', [...dependsOnFields, ['name', str(b.name)]]);
    }
    case 'Filter': {
      // 0.2.0 — `defaultValue` rides the wire when present (typed via the
      // slot's static encoder, mirroring `State.defaultValue`); omitted
      // otherwise, keeping the plain chip byte-stable.
      const defaultField: readonly Field[] =
        b.defaultValue !== undefined ? [['defaultValue', staticEnc(b.defaultValue as T)]] : [];
      return caseObj('Filter', [...defaultField, ['name', str(b.name)]]);
    }
    case 'Selection': {
      // 0.2.0 — the `accessor` sentinel is off the wire (same as Query).
      // 0.2.9 (Phase 629) — `defaultValue` rides the wire when present,
      // exactly the `Filter.defaultValue` convention; omitted when absent so
      // the pre-629 minimal form stays byte-identical.
      // 0.2.10 (Phase 632) — `field` (the declarative row-field projection)
      // rides the same convention; the accessor closure is not serialisable,
      // so the carried name is the encode source.
      const defaultField: readonly Field[] =
        b.defaultValue !== undefined ? [['defaultValue', staticEnc(b.defaultValue)]] : [];
      const fieldField: readonly Field[] = b.field !== undefined ? [['field', str(b.field)]] : [];
      return caseObj('Selection', [...defaultField, ...fieldField, ['nodeId', str(b.nodeId)]]);
    }
    case 'State': {
      // Phase 677 — same rule as `Static`: absence omits, never null.
      const defaultFields: readonly Field[] =
        b.defaultValue === null || b.defaultValue === undefined
          ? []
          : [['defaultValue', staticEnc(b.defaultValue)]];
      return caseObj('State', [...defaultFields, ['key', str(b.key)]]);
    }
    case 'Computed':
      return caseObj('Computed', [['fn', CLOSURE]]);
    case 'I18n': {
      const fields: Field[] = [];
      if (b.args !== undefined) {
        fields.push([
          'args',
          jObject(Object.entries(b.args).map(([k, v]) => [k, binding(v)] as const)),
        ]);
      }
      fields.push(['key', str(b.key)]);
      return caseObj('I18n', fields);
    }
    case 'Local':
      return caseObj('Local', [
        ['flushOn', flushTrigger(b.local.flushOn)],
        ['format', CLOSURE],
        ['initialFrom', binding(b.local.initialFrom, staticEnc)],
        ['onCommit', CLOSURE],
        ['parse', CLOSURE],
      ]);
    case 'Format':
      // Phase 102: source is always a numeric Binding; format / locale are
      // bounded DUs. Keys sort to format < locale < source.
      return caseObj('Format', [
        ['format', formatIntent(b.format)],
        ['locale', localeSource(b.locale)],
        ['source', binding(b.source)],
      ]);
    case 'Transform': {
      // Phase 282 — the Compute layer. `pipeline` + `source` are Core values
      // whose codecs render under the SAME canonical `$type` discipline; `$type`
      // (0x24) sorts before `params` < `pipeline` < `source`, so the composite is canonical.
      // Phase 424 — `params` binds `ColExpr.Param` names to scalar `Binding` sources;
      // omitted-when-empty so a param-free Transform is byte-identical to the Phase 282 wire.
      const paramFields: readonly Field[] =
        b.params !== undefined && b.params.length > 0
          ? [
              [
                'params',
                jArray(
                  b.params.map((p) =>
                    jObject([
                      ['from', binding(p.from)],
                      ['name', str(p.name)],
                    ]),
                  ),
                ),
              ],
            ]
          : [];
      return caseObj('Transform', [
        ...paramFields,
        ['pipeline', jArray(b.pipeline.map(transformStep))],
        ['source', dataSource(b.source)],
      ]);
    }
    case 'Invoke':
      // Phase 283 — host-registered capability for a value; the body never on the wire.
      return caseObj('Invoke', [
        ['args', invokeArgs(b.args)],
        ['capabilityId', str(b.capabilityId)],
      ]);
    default:
      return assertNever(b);
  }
};

const action = <T>(a: Action<T>): string => {
  switch (a.kind) {
    case 'Dispatch':
      // 0.2.0 — the `msg` closure sentinel is off the wire (decoders never
      // read it).
      return caseObj('Dispatch', []);
    case 'Call': {
      // Phase 428: `onResult` rides the wire only when present (byte-identical
      // sentinel); `into` is the declarative result target, omitted when absent.
      const fields: Field[] = [['endpoint', str(a.endpoint)]];
      if (a.into !== undefined) {
        fields.push([
          'into',
          a.into.kind === 'State'
            ? caseObj('State', [['key', str(a.into.key)]])
            : caseObj('Query', [['name', str(a.into.name)]]),
        ]);
      }
      if (a.onResult !== undefined) fields.push(['onResult', CLOSURE]);
      return caseObj('Call', fields);
    }
    case 'Notify':
      return caseObj('Notify', [
        ['channel', str(a.channel)],
        ['payload', jsonValue(a.payload)],
      ]);
    case 'Navigate':
      return caseObj('Navigate', [['route', str(a.route)]]);
    case 'SetState':
      return caseObj('SetState', [
        ['key', str(a.key)],
        ['value', jsonValue(a.value)],
      ]);
    case 'AiTool':
      return caseObj('AiTool', [
        ['args', jsonValue(a.args)],
        ['toolName', str(a.toolName)],
      ]);
    case 'Chain':
      return caseObj('Chain', [['ops', jArray(a.actions.map(action))]]);
    case 'CommitLocal':
      return caseObj('CommitLocal', [['nodeId', str(a.nodeId)]]);
    case 'WriteToClipboard':
      return caseObj('WriteToClipboard', [['text', str(a.text)]]);
    case 'ReadFileBody':
      // Phase 136 — only file.id + encoding cross the wire; the blob is
      // host-held (file.handle) and onRead is the closure sentinel (§4).
      // Keys sort to encoding < fileRef < onRead.
      return caseObj('ReadFileBody', [
        ['encoding', str(a.encoding)],
        ['fileRef', str(a.file.id)],
        ['onRead', CLOSURE],
      ]);
    case 'Invoke':
      // Phase 283 — capability invoked as an effect; same wire shape as Binding.Invoke.
      return caseObj('Invoke', [
        ['args', invokeArgs(a.args)],
        ['capabilityId', str(a.capabilityId)],
      ]);
    default:
      return assertNever(a);
  }
};

const textSource = (t: TextSource): string => {
  switch (t.kind) {
    case 'Literal':
      // 0.2.0 — the CANONICAL Literal form is the bare JSON string; the
      // {"$type":"Literal"} envelope stays decode-accepted.
      return str(t.value);
    case 'Bound':
      return caseObj('Bound', [['binding', binding(t.binding)]]);
    case 'I18n':
      return caseObj('I18n', [
        ['args', jsonMap(t.args)],
        ['key', str(t.key)],
      ]);
    default:
      return assertNever(t);
  }
};

const cellFormat = (f: CellFormat): string => {
  switch (f.kind) {
    case 'None':
      return caseObj('None', []);
    case 'Number':
      return caseObj('Number', f.decimals !== undefined ? [['decimals', num(f.decimals)]] : []);
    case 'Currency':
      return caseObj('Currency', [['code', str(f.code)]]);
    case 'Percent':
      return caseObj('Percent', f.decimals !== undefined ? [['decimals', num(f.decimals)]] : []);
    case 'SignificantDigits':
      return caseObj('SignificantDigits', [['digits', num(f.digits)]]);
    case 'Date':
      return caseObj('Date', [['format', str(f.format)]]);
    case 'Custom':
      return caseObj('Custom', [['fn', CLOSURE]]);
    default:
      return assertNever(f);
  }
};

const formatIntent = (f: Format): string => {
  switch (f.kind) {
    case 'Number':
      return caseObj('Number', f.decimals !== undefined ? [['decimals', num(f.decimals)]] : []);
    case 'Currency':
      return caseObj('Currency', [['isoCode', str(f.isoCode)]]);
    case 'Percent':
      return caseObj('Percent', f.decimals !== undefined ? [['decimals', num(f.decimals)]] : []);
    case 'Date':
      return caseObj('Date', [['dateStyle', str(f.dateStyle)]]);
    case 'RelativeTime':
      return caseObj('RelativeTime', [['unit', str(f.unit)]]);
    default:
      return assertNever(f);
  }
};

const localeSource = (l: LocaleSource): string => {
  switch (l.kind) {
    case 'Ambient':
      return caseObj('Ambient', []);
    case 'Explicit':
      return caseObj('Explicit', [['tag', str(l.tag)]]);
    default:
      return assertNever(l);
  }
};

const columnWidth = (w: ColumnWidth): string => {
  switch (w.kind) {
    case 'Auto':
      return caseObj('Auto', []);
    case 'Fixed':
      return caseObj('Fixed', [['pixels', num(w.pixels)]]);
    case 'Flex':
      return caseObj('Flex', [['weight', num(w.weight)]]);
    default:
      return assertNever(w);
  }
};

// ─── Display specs ───────────────────────────────────────────────────────────

// Phase 460 — the stylistic fields are emitted only when non-default (identity:
// CellFormat.None / ColumnWidth.Auto / tone Default / weight Standard / emphasis
// Normal), mirroring the F# encoder + the role/voice precedent. `jObject` sorts
// keys, so push order is irrelevant.
const pushToneOptional = (fields: Field[], t: ToneVariant): void => {
  if (t !== 'Default') fields.push(['tone', str(t)]);
};
const pushWeightOptional = (fields: Field[], w: StyleWeight): void => {
  if (w !== 'Standard') fields.push(['weight', str(w)]);
};
const pushEmphasisOptional = (fields: Field[], e: Emphasis): void => {
  if (e !== 'Normal') fields.push(['emphasis', str(e)]);
};
const pushCellFormatOptional = (fields: Field[], key: string, f: CellFormat): void => {
  if (f.kind !== 'None') fields.push([key, cellFormat(f)]);
};
const pushColumnWidthOptional = (fields: Field[], key: string, w: ColumnWidth): void => {
  if (w.kind !== 'Auto') fields.push([key, columnWidth(w)]);
};

const metricSpec = (s: MetricSpec): string => {
  const fields: Field[] = [
    ['label', textSource(s.label)],
    ['value', binding(s.value)],
  ];
  pushCellFormatOptional(fields, 'format', s.format);
  pushToneOptional(fields, s.tone);
  pushWeightOptional(fields, s.weight);
  pushEmphasisOptional(fields, s.emphasis);
  if (s.trend !== undefined) fields.push(['trend', binding(s.trend)]);
  if (s.trendFormat !== undefined) fields.push(['trendFormat', cellFormat(s.trendFormat)]);
  if (s.icon !== undefined) fields.push(['icon', str(s.icon)]);
  if (s.subtext !== undefined) fields.push(['subtext', textSource(s.subtext)]);
  return jObject(fields);
};

const headingSpec = (s: HeadingSpec): string =>
  jObject([
    ['level', num(s.level)],
    ['text', textSource(s.text)],
    ['variant', str(s.variant)],
  ]);

const labelValueRowSpec = (s: LabelValueRowSpec): string => {
  // 0.2.2 — `emphasis` omitted-when-false (aligning with Fact); `format`
  // omitted-when-default (Phase 460).
  const fields: Field[] = [
    ...(s.emphasis ? ([['emphasis', bool(true)]] as const) : []),
    ['label', textSource(s.label)],
    ['value', binding(s.value)],
  ];
  pushCellFormatOptional(fields, 'format', s.format);
  if (s.help !== undefined) fields.push(['help', textSource(s.help)]);
  return jObject(fields);
};

const factSpec = (s: FactSpec): string => {
  // New-kind posture: label + value required; emphasis omitted-when-false,
  // tone omitted-when-default (both boundaries); help/icon optional.
  const fields: Field[] = [
    ['label', textSource(s.label)],
    ['value', textSource(s.value)],
  ];
  if (s.emphasis) fields.push(['emphasis', bool(true)]);
  pushToneOptional(fields, s.tone);
  if (s.help !== undefined) fields.push(['help', textSource(s.help)]);
  if (s.icon !== undefined) fields.push(['icon', str(s.icon)]);
  return jObject(fields);
};

const markdownSpec = (s: MarkdownSpec): string => jObject([['text', textSource(s.text)]]);

const badgeSpec = (s: BadgeSpec): string =>
  jObject([
    ['label', textSource(s.label)],
    ['variant', str(s.variant)],
  ]);

const linkSpec = (s: LinkSpec): string => {
  const fields: Field[] = [
    ['href', binding(s.href)],
    ['label', textSource(s.label)],
    ['download', bool(s.download)],
  ];
  if (s.rel !== undefined) fields.push(['rel', str(s.rel)]);
  if (s.target !== undefined) fields.push(['target', str(s.target)]);
  return jObject(fields);
};

const imageSpec = (s: ImageSpec): string =>
  jObject([
    ['alt', textSource(s.alt)],
    ['src', binding(s.src)],
    ['variant', str(s.variant)],
  ]);

const listSpec = (s: ListSpec): string =>
  jObject([
    ['items', jArray(s.items.map(textSource))],
    ['ordered', bool(s.ordered)],
  ]);

const toastSpec = (s: ToastSpec): string => {
  // Phase 460 — `tone` omitted-when-default.
  const fields: Field[] = [
    // 0.2.0 omitted-when-TRUE (a Toast is dismissable unless said otherwise).
    ...(s.dismissable ? [] : ([['dismissable', bool(false)]] as const)),
    ['message', textSource(s.message)],
    ['open', binding(s.open)],
  ];
  pushToneOptional(fields, s.tone);
  return jObject(fields);
};

/** `MathDisplay` bare-string enum (WIRE_FORMAT.md §3.5). */
const mathDisplay = (d: MathDisplay): string => str(d);

const codeBlockSpec = (s: CodeBlockSpec): string =>
  jObject([
    ['code', str(s.code)],
    ['copyable', bool(s.copyable)],
    // highlightLines is always present (possibly empty); ints render as decimal
    // literals (port of F# `int_`), not the float layout.
    ['highlightLines', jArray(s.highlightLines.map(intLit))],
    ['language', str(s.language)],
    ['lineNumbers', bool(s.lineNumbers)],
  ]);

const mathSpec = (s: MathSpec): string =>
  jObject([
    ['display', mathDisplay(s.display)],
    ['source', str(s.source)],
  ]);

const sparklineSpec = (s: SparklineSpec): string =>
  jObject([['source', binding(s.source, staticFloatSeq)]]);

const skeletonSpec = (s: SkeletonSpec): string => jObject([['rows', num(s.rows)]]);

const calloutSpec = (s: CalloutSpec): string => {
  // Phase 460 — `tone` omitted-when-default.
  const fields: Field[] = [
    ['body', textSource(s.body)],
    // 0.2.0 omitted-when-false.
    ...(s.dismissable ? ([['dismissable', bool(true)]] as const) : []),
  ];
  pushToneOptional(fields, s.tone);
  if (s.heading !== undefined) fields.push(['heading', textSource(s.heading)]);
  if (s.icon !== undefined) fields.push(['icon', str(s.icon)]);
  return jObject(fields);
};

const progressSpec = (s: ProgressSpec): string => {
  // Phase 460 — `tone` omitted-when-default.
  const fields: Field[] = [
    ['fraction', binding(s.fraction)],
    // 0.2.0 omitted-when-false.
    ...(s.indeterminate ? ([['indeterminate', bool(true)]] as const) : []),
  ];
  pushToneOptional(fields, s.tone);
  if (s.label !== undefined) fields.push(['label', textSource(s.label)]);
  if (s.caveat !== undefined) fields.push(['caveat', textSource(s.caveat)]);
  return jObject(fields);
};

// ─── Drawing (Phase 524) ─────────────────────────────────────────────────────

const drawPoint = (p: DrawPoint): string =>
  jObject([
    ['x', num(p.x)],
    ['y', num(p.y)],
  ]);

const viewBox = (v: ViewBox): string =>
  jObject([
    ['height', num(v.height)],
    ['minX', num(v.minX)],
    ['minY', num(v.minY)],
    ['width', num(v.width)],
  ]);

const drawStyle = (s: DrawStyle): string => {
  const fields: Field[] = [];
  if (s.fill !== undefined) fields.push(['fill', binding(s.fill)]);
  if (s.opacity !== undefined) fields.push(['opacity', binding(s.opacity)]);
  if (s.stroke !== undefined) fields.push(['stroke', binding(s.stroke)]);
  if (s.strokeWidth !== undefined) fields.push(['strokeWidth', binding(s.strokeWidth)]);
  // Text-only fields (Phase 528.1) — omitted when unset; jObject sorts keys.
  if (s.textAnchor !== undefined) fields.push(['textAnchor', str(s.textAnchor)]);
  if (s.fontSize !== undefined) fields.push(['fontSize', num(s.fontSize)]);
  if (s.emphasis !== undefined) fields.push(['emphasis', str(s.emphasis)]);
  if (s.fontFamily !== undefined) fields.push(['fontFamily', str(s.fontFamily)]);
  // Phase 642 — keyed mark identity; omitted when unset.
  if (s.markId !== undefined) fields.push(['markId', str(s.markId)]);
  return jObject(fields);
};

const curveCommand = (c: CurveCommand): string => {
  switch (c.kind) {
    case 'MoveTo':
      return caseObj('MoveTo', [['to', drawPoint(c.to)]]);
    case 'LineTo':
      return caseObj('LineTo', [['to', drawPoint(c.to)]]);
    case 'CubicTo':
      return caseObj('CubicTo', [
        ['control1', drawPoint(c.control1)],
        ['control2', drawPoint(c.control2)],
        ['to', drawPoint(c.to)],
      ]);
    case 'QuadraticTo':
      return caseObj('QuadraticTo', [
        ['control', drawPoint(c.control)],
        ['to', drawPoint(c.to)],
      ]);
    case 'Close':
      return caseObj('Close', []);
  }
};

const shape = (sh: Shape): string => {
  switch (sh.kind) {
    case 'Group':
      return caseObj('Group', [
        ['children', jArray(sh.children.map(shape))],
        ['style', drawStyle(sh.style)],
      ]);
    case 'Rectangle': {
      const fields: Field[] = [
        ['height', num(sh.height)],
        ['style', drawStyle(sh.style)],
        ['width', num(sh.width)],
        ['x', num(sh.x)],
        ['y', num(sh.y)],
      ];
      if (sh.cornerRadius !== undefined) fields.push(['cornerRadius', num(sh.cornerRadius)]);
      return caseObj('Rectangle', fields);
    }
    case 'Line':
      return caseObj('Line', [
        ['style', drawStyle(sh.style)],
        ['x1', num(sh.x1)],
        ['x2', num(sh.x2)],
        ['y1', num(sh.y1)],
        ['y2', num(sh.y2)],
      ]);
    case 'Polyline':
      return caseObj('Polyline', [
        ['points', jArray(sh.points.map(drawPoint))],
        ['style', drawStyle(sh.style)],
      ]);
    case 'Polygon':
      return caseObj('Polygon', [
        ['points', jArray(sh.points.map(drawPoint))],
        ['style', drawStyle(sh.style)],
      ]);
    case 'Curve':
      return caseObj('Curve', [
        ['commands', jArray(sh.commands.map(curveCommand))],
        ['style', drawStyle(sh.style)],
      ]);
    case 'Circle':
      return caseObj('Circle', [
        ['cx', num(sh.cx)],
        ['cy', num(sh.cy)],
        ['r', num(sh.r)],
        ['style', drawStyle(sh.style)],
      ]);
    case 'Ellipse':
      return caseObj('Ellipse', [
        ['cx', num(sh.cx)],
        ['cy', num(sh.cy)],
        ['rx', num(sh.rx)],
        ['ry', num(sh.ry)],
        ['style', drawStyle(sh.style)],
      ]);
    case 'Label':
      return caseObj('Label', [
        ['style', drawStyle(sh.style)],
        ['text', textSource(sh.text)],
        ['x', num(sh.x)],
        ['y', num(sh.y)],
      ]);
  }
};

const drawingSpec = (s: DrawingSpec): string => {
  const fields: Field[] = [
    ['shapes', jArray(s.shapes.map(shape))],
    ['style', drawStyle(s.style)],
    ['viewBox', viewBox(s.viewBox)],
  ];
  if (s.description !== undefined) fields.push(['description', textSource(s.description)]);
  if (s.title !== undefined) fields.push(['title', textSource(s.title)]);
  return jObject(fields);
};

const displayKind = (d: DisplayKind): string => {
  switch (d.kind) {
    case 'Heading':
      return hoistSpec('Heading', headingSpec(d.spec));
    case 'Markdown':
      return hoistSpec('Markdown', markdownSpec(d.spec));
    case 'Metric':
      return hoistSpec('Metric', metricSpec(d.spec));
    case 'Badge':
      return hoistSpec('Badge', badgeSpec(d.spec));
    case 'Sparkline':
      return hoistSpec('Sparkline', sparklineSpec(d.spec));
    case 'Callout':
      return hoistSpec('Callout', calloutSpec(d.spec));
    case 'Progress':
      return hoistSpec('Progress', progressSpec(d.spec));
    case 'Skeleton':
      return hoistSpec('Skeleton', skeletonSpec(d.spec));
    case 'LabelValueRow':
      return hoistSpec('LabelValueRow', labelValueRowSpec(d.spec));
    case 'Fact':
      return hoistSpec('Fact', factSpec(d.spec));
    case 'Link':
      return hoistSpec('Link', linkSpec(d.spec));
    case 'Image':
      return hoistSpec('Image', imageSpec(d.spec));
    case 'List':
      return hoistSpec('List', listSpec(d.spec));
    case 'Toast':
      return hoistSpec('Toast', toastSpec(d.spec));
    case 'CodeBlock':
      return hoistSpec('CodeBlock', codeBlockSpec(d.spec));
    case 'Math':
      return hoistSpec('Math', mathSpec(d.spec));
    case 'Drawing':
      return hoistSpec('Drawing', drawingSpec(d.spec));
    default:
      return assertNever(d);
  }
};

// ─── Input specs ─────────────────────────────────────────────────────────────

/**
 * Phase 596 — the auto-bind context for a control's `value` slot, mirroring
 * the decoder's synthesis exactly: a `value` that is the context's exact
 * auto-binding is OMITTED — `Filter(name)` (no defaultValue) on a chip,
 * `State(field id, typed placeholder)` on a form field — so the canonical
 * minimal control carries no `value` key. Any other binding always emits.
 */
type ControlAutoBind =
  | { readonly kind: 'filter'; readonly name: string }
  | { readonly kind: 'form'; readonly id: string }
  | undefined;

const formFieldKind = (autoBind: ControlAutoBind, k: FormFieldKind<unknown>): string => {
  // Handlers ride the wire only when present (Phase 426, generalising the
  // Phase 423 chip mechanics): a defined handler → the `"<closure>"`
  // sentinel (byte-identical to before); an omitted (declarative) handler
  // omits the key entirely and arms the renderer's write-back default.
  const handlerField = (name: string, h: unknown): readonly Field[] =>
    h !== undefined ? [[name, CLOSURE]] : [];
  const isAutoBinding = (b: Binding<unknown>, autoDefault: unknown): boolean => {
    if (autoBind?.kind === 'filter')
      return b.kind === 'Filter' && b.name === autoBind.name && b.defaultValue === undefined;
    if (autoBind?.kind === 'form')
      return (
        b.kind === 'State' &&
        b.key === autoBind.id &&
        // structural equality — the range placeholder is a tuple
        JSON.stringify(b.defaultValue) === JSON.stringify(autoDefault)
      );
    return false;
  };
  const valueField = <V>(
    b: Binding<V>,
    autoDefault: unknown,
    enc: (v: Binding<V>) => string,
  ): readonly Field[] =>
    isAutoBinding(b as Binding<unknown>, autoDefault) ? [] : [['value', enc(b)]];
  switch (k.kind) {
    case 'Text':
      return caseObj('Text', [
        ...handlerField('onChange', k.onChange),
        ...valueField(k.value, controlValueDefaults.text, (v) => binding(v)),
      ]);
    case 'Number':
      return caseObj('Number', [
        ...handlerField('onChange', k.onChange),
        ...valueField(k.value, controlValueDefaults.number, (v) => binding(v)),
      ]);
    case 'Checkbox':
      return caseObj('Checkbox', [
        ...handlerField('onToggle', k.onToggle),
        ...valueField(k.value, controlValueDefaults.checkbox, (v) => binding(v)),
      ]);
    case 'Choice':
      return caseObj('Choice', [
        ...handlerField('onChange', k.onChange),
        ['options', binding(k.options, staticSelectOptions)],
        ...valueField(k.value, controlValueDefaults.choice, (v) => binding(v, staticStringOpt)),
      ]);
    case 'Range': {
      // 0.2.0 — dual-thumb range (absorbed FilterKind.RangeFilter). The
      // Static pair rides as the typed {min, max} object; constraints
      // omitted when absent (rule 4).
      const staticPair = (p: readonly [number, number]): string =>
        jObject([
          ['max', num(p[1])],
          ['min', num(p[0])],
        ]);
      const fields: Field[] = [
        ...handlerField('onChange', k.onChange),
        ...valueField(k.value, controlValueDefaults.range, (v) =>
          v.kind === 'Static' ? staticPair(v.value) : binding(v, staticPair),
        ),
      ];
      if (k.constraints?.min !== undefined) fields.push(['min', num(k.constraints.min)]);
      if (k.constraints?.max !== undefined) fields.push(['max', num(k.constraints.max)]);
      if (k.constraints?.step !== undefined) fields.push(['step', num(k.constraints.step)]);
      return caseObj('Range', fields);
    }
    case 'RangedNumber': {
      const fields: Field[] = [
        ...handlerField('onChange', k.onChange),
        ...valueField(k.value, controlValueDefaults.number, (v) => binding(v)),
      ];
      if (k.constraints.min !== undefined) fields.push(['min', num(k.constraints.min)]);
      if (k.constraints.max !== undefined) fields.push(['max', num(k.constraints.max)]);
      if (k.constraints.step !== undefined) fields.push(['step', num(k.constraints.step)]);
      return caseObj('RangedNumber', fields);
    }
    case 'SegmentedChoice':
      return caseObj('SegmentedChoice', [
        ...handlerField('onChange', k.onChange),
        ['options', binding(k.options, staticSelectOptions)],
        ['orientation', str(k.orientation)],
        ...valueField(k.value, controlValueDefaults.choice, (v) => binding(v, staticStringOpt)),
      ]);
    case 'TextArea':
      return caseObj('TextArea', [
        ...handlerField('onChange', k.onChange),
        ['rows', num(k.rows)],
        ...valueField(k.value, controlValueDefaults.text, (v) => binding(v)),
      ]);
    case 'Date': {
      // Phase 288 — value is Binding<string> (ISO-8601); variant required;
      // min/max (ISO strings) + step (seconds) omitted when undefined, mirroring
      // RangedNumber's optional-constraint discipline.
      const fields: Field[] = [
        ...handlerField('onChange', k.onChange),
        ...valueField(k.value, controlValueDefaults.date, (v) => binding(v)),
        ['variant', str(k.variant)],
      ];
      if (k.constraints.min !== undefined) fields.push(['min', str(k.constraints.min)]);
      if (k.constraints.max !== undefined) fields.push(['max', str(k.constraints.max)]);
      if (k.constraints.step !== undefined) fields.push(['step', num(k.constraints.step)]);
      return caseObj('Date', fields);
    }
    case 'DateRange': {
      // Phase 725 — single-control date range. The Static pair rides as the
      // BARE {from, to} object (the Range posture, no envelope); min/max (ISO
      // strings) + step (seconds) are flat and bound both ends.
      const staticPair = (p: readonly [string, string]): string =>
        jObject([
          ['from', str(p[0])],
          ['to', str(p[1])],
        ]);
      const fields: Field[] = [
        ...handlerField('onChange', k.onChange),
        ...valueField(k.value, controlValueDefaults.dateRange, (v) =>
          v.kind === 'Static' ? staticPair(v.value) : binding(v, staticPair),
        ),
        ['variant', str(k.variant)],
      ];
      if (k.constraints.min !== undefined) fields.push(['min', str(k.constraints.min)]);
      if (k.constraints.max !== undefined) fields.push(['max', str(k.constraints.max)]);
      if (k.constraints.step !== undefined) fields.push(['step', num(k.constraints.step)]);
      return caseObj('DateRange', fields);
    }
    default:
      return assertNever(k);
  }
};

const formField = (f: FormField<unknown>): string => {
  const fields: Field[] = [
    ['id', str(f.id)],
    ['kind', formFieldKind({ kind: 'form', id: f.id }, f.kind)],
    ['label', textSource(f.label)],
    ['required', bool(f.required)],
  ];
  if (f.help !== undefined) fields.push(['help', textSource(f.help)]);
  return jObject(fields);
};

const formSpec = (s: FormSpec<unknown>): string => {
  const fields: Field[] = [
    ['fields', jArray(s.fields.map(formField))],
    ['onSubmit', action(s.onSubmit)],
    ['submitLabel', textSource(s.submitLabel)],
  ];
  // Phase 130: optional bound form-level disabled-state — emitted only when
  // present, mirroring ButtonSpec.disabled.
  if (s.disabled !== undefined) fields.push(['disabled', binding(s.disabled)]);
  return jObject(fields);
};

const filterSpec = (s: FilterSpec<unknown>): string =>
  // 0.2.0 filters-unification: the chip's control is an ordinary
  // FormFieldKind; a `value` equal to the auto-binding `Filter(name)` is
  // omitted (see formFieldKind).
  jObject([
    ['kind', formFieldKind({ kind: 'filter', name: s.name }, s.field)],
    ['label', textSource(s.label)],
    ['name', str(s.name)],
  ]);

const buttonSpec = (s: ButtonSpec<unknown>): string => {
  const fields: Field[] = [
    ['label', textSource(s.label)],
    ['onClick', action(s.onClick)],
    ['variant', str(s.variant)],
  ];
  if (s.icon !== undefined) fields.push(['icon', str(s.icon)]);
  // Phase 129: optional bound disabled-state — emitted only when present,
  // mirroring MetricSpec.trend's optional-binding shape.
  if (s.disabled !== undefined) fields.push(['disabled', binding(s.disabled)]);
  return jObject(fields);
};

const selectSpec = (s: SelectSpec<unknown>): string => {
  const fields: Field[] = [
    ['label', textSource(s.label)],
    ['source', binding(s.source, staticSelectOptions)],
    ['value', binding(s.value, staticStringOpt)],
  ];
  // Phase 426: `onChange` rides the wire only when present (byte-identical
  // sentinel); omitted, the renderer writes the chosen option back to a
  // writable `value` binding.
  if (s.onChange !== undefined) fields.push(['onChange', CLOSURE]);
  if (s.placeholder !== undefined) fields.push(['placeholder', textSource(s.placeholder)]);
  // Phase 130: optional bound disabled-state.
  if (s.disabled !== undefined) fields.push(['disabled', binding(s.disabled)]);
  // Phase 291: multi-select. `multiple` emitted ONLY when true and `values` ONLY
  // when present, so single-select wire stays byte-identical to pre-multi-select
  // fixtures (the degenerate case).
  if (s.multiple) fields.push(['multiple', bool(true)]);
  if (s.values !== undefined) fields.push(['values', binding(s.values, staticStringList)]);
  // Phase 426: the multi-select handler carries its own sentinel key when
  // present (previously never encoded).
  if (s.onChangeMulti !== undefined) fields.push(['onChangeMulti', CLOSURE]);
  return jObject(fields);
};

const fileUploadSpec = (s: FileUploadSpec<unknown>): string => {
  const fields: Field[] = [
    ['accept', jArray(s.accept.map(str))],
    ['label', textSource(s.label)],
    ['multiple', bool(s.multiple)],
    ['onSelect', CLOSURE],
  ];
  // Phase 130: optional bound disabled-state.
  if (s.disabled !== undefined) fields.push(['disabled', binding(s.disabled)]);
  return jObject(fields);
};

const inputKind = (i: InputKind<unknown>): string => {
  switch (i.kind) {
    case 'Form':
      return hoistSpec('Form', formSpec(i.spec));
    case 'Filters':
      return caseObj('Filters', [['items', jArray(i.specs.map(filterSpec))]]);
    case 'Button':
      return hoistSpec('Button', buttonSpec(i.spec));
    case 'FileUpload':
      return hoistSpec('FileUpload', fileUploadSpec(i.spec));
    case 'Select':
      return hoistSpec('Select', selectSpec(i.spec));
    default:
      return assertNever(i);
  }
};

// ─── Typed Static payload encoders (Phase 429) ───────────────────────────────
//
// The `objValue` catch-all collapses non-primitive `Binding.Static` payloads to
// `"<opaque>"`. For the shapes the language itself enumerates — options,
// values, series, markers — the encoder emits the typed forms the decoders
// parse, passed per slot through `binding`'s `staticEnc` parameter (the mirror
// of F# `encodeBindingWith`). A `Static` of a host domain type (grid/table
// rows) still falls through to the catch-all — the residual-opaque boundary is
// by design (WIRE_FORMAT.md §"Typed Static payloads").

const selectOption = (o: SelectOption): string =>
  jObject([
    ['label', textSource(o.label)],
    ['value', str(o.value)],
  ]);

const staticSelectOptions = (v: readonly SelectOption[]): string => jArray(v.map(selectOption));

const staticStringOpt = (v: string | undefined): string => (v === undefined ? 'null' : str(v));

const staticStringList = (v: readonly string[]): string => jArray(v.map(str));

const staticFloatSeq = (v: readonly number[]): string => jArray(v.map(num));

const staticMarkerSeq = (v: readonly MapMarker[]): string => jArray(v.map(mapMarker));

// ─── Visualisation specs ─────────────────────────────────────────────────────

const cellKindErased = (k: CellKindErased<unknown>): string => {
  switch (k.kind) {
    case 'Text':
      return caseObj('Text', []);
    case 'Numeric':
      return caseObj('Numeric', []);
    case 'Date':
      return caseObj('Date', []);
    case 'Editable':
      return caseObj('Editable', [['onEdit', CLOSURE]]);
    case 'Checkbox':
      return caseObj('Checkbox', [
        ['get', CLOSURE],
        ['onToggle', CLOSURE],
      ]);
    case 'Button':
      return caseObj('Button', [
        ['label', textSource(k.label)],
        ['onClick', CLOSURE],
      ]);
    case 'ButtonGroup':
      return caseObj('ButtonGroup', [
        [
          'buttons',
          jArray(
            k.buttons.map(([label]) =>
              jObject([
                ['label', textSource(label)],
                ['onClick', CLOSURE],
              ]),
            ),
          ),
        ],
      ]);
    case 'Link':
      return caseObj('Link', [
        ['hrefFn', CLOSURE],
        ['labelFn', CLOSURE],
      ]);
    case 'Pill':
      return caseObj('Pill', [
        ['labelFn', CLOSURE],
        ['toneFn', CLOSURE],
      ]);
    // Phase 750 — the declarative pill. `default` is omitted-when-`Default` (the Phase
    // 460 discipline); `jObject` Ordinal-sorts, so push order is irrelevant.
    case 'TonedPill': {
      const fields: Field[] = [
        ['field', str(k.field)],
        ['map', jObject(Object.entries(k.map).map(([v, t]) => [v, str(t)] as const))],
      ];
      if (k.defaultTone !== 'Default') fields.push(['default', str(k.defaultTone)]);
      return caseObj('TonedPill', fields);
    }
    case 'Progress':
      return caseObj('Progress', [
        ['fractionFn', CLOSURE],
        ['labelFn', CLOSURE],
      ]);
    case 'Custom':
      return caseObj('Custom', [['fn', CLOSURE]]);
    default:
      return assertNever(k);
  }
};

const columnErased = (c: ColumnErased<unknown>): string => {
  // Phase 425 — `value` (closure) + `field` (declarative) are sibling optional slots.
  // Phase 460 — `format`/`width` omitted-when-default (`None`/`Auto`).
  const fields: Field[] = [
    ['kind', cellKindErased(c.kind)],
    ['label', str(c.label)],
  ];
  pushCellFormatOptional(fields, 'format', c.format);
  pushColumnWidthOptional(fields, 'width', c.width);
  if (c.value !== undefined) fields.push(['value', CLOSURE]);
  if (c.field !== undefined) fields.push(['field', str(c.field)]);
  return jObject(fields);
};

const gridSpec = (s: GridSpec<unknown>): string => {
  const fields: Field[] = [
    ['columns', jArray(s.columns.map(columnErased))],
    // 0.2.0 omitted-when-false.
    ...(s.editable ? ([['editable', bool(true)]] as const) : []),
    ['source', binding(s.source)],
  ];
  if (s.onRowClick !== undefined) fields.push(['onRowClick', CLOSURE]);
  // Phase 425 — `rowKey` (closure) + `rowKeyField` (declarative) are sibling optional slots.
  if (s.rowKey !== undefined) fields.push(['rowKey', CLOSURE]);
  if (s.rowKeyField !== undefined) fields.push(['rowKeyField', str(s.rowKeyField)]);
  // Phase 393 — the static read-only mode; omitted for a data-bound grid so every existing
  // grid fixture stays byte-identical.
  if (s.staticRows !== undefined)
    fields.push([
      'staticRows',
      jObject([
        ['headers', jArray(s.staticRows.headers.map(textSource))],
        ['rows', jArray(s.staticRows.rows.map((row) => jArray(row.map(textSource))))],
      ]),
    ]);
  return jObject(fields);
};

const chartSpec = (s: ChartSpec<unknown>): string => {
  // `stacked` (Phase 126) is now carried — previously dropped on the wire,
  // losing a chart's stacked-vs-grouped intent on every round-trip.
  const fields: Field[] = [
    ['kind', str(s.kind)],
    ['source', binding(s.source)],
    ['stacked', bool(s.stacked)],
    ['xField', str(s.xField)],
    ['yFields', jArray(s.yFields.map(str))],
  ];
  if (s.title !== undefined) fields.push(['title', textSource(s.title)]);
  if (s.onPointClick !== undefined) fields.push(['onPointClick', CLOSURE]);
  return jObject(fields);
};

const mapMarker = (m: MapMarker): string =>
  jObject([
    ['label', textSource(m.label)],
    ['latitude', num(m.latitude)],
    ['longitude', num(m.longitude)],
  ]);

const mapSpec = (s: MapSpec<unknown>): string => {
  const fields: Field[] = [
    ['centreLatitude', num(s.centreLatitude)],
    ['centreLongitude', num(s.centreLongitude)],
    ['source', binding(s.source, staticMarkerSeq)],
    ['zoom', num(s.zoom)],
  ];
  if (s.onMarkerClick !== undefined) fields.push(['onMarkerClick', CLOSURE]);
  return jObject(fields);
};

const visKind = (v: VisKind<unknown>): string => {
  switch (v.kind) {
    // In-memory tag stays 'Grid'; the wire discriminator is 'DataGrid' (the
    // data-bound grid) — globally unique vs the Layout 'GridLayout' so the
    // flat wire stays unambiguous (WIRE_FORMAT §3.2).
    case 'Grid':
      return hoistSpec('DataGrid', gridSpec(v.spec));
    case 'Chart':
      return hoistSpec('Chart', chartSpec(v.spec));
    case 'Map':
      return hoistSpec('Map', mapSpec(v.spec));
    default:
      return assertNever(v);
  }
};

// ─── Layout specs ────────────────────────────────────────────────────────────

// Phase 390 — the unified Box container. Ordinal key order:
// children < heading < layout < role. `layout` is a discriminated object
// (Flex | Grid | Auto), `role` a string; `heading` emits only when set. Every
// nested optional (gap / templateColumns) emits only when present, preserving
// byte-identical encoding. Mirrors F# `layoutKindAppender`'s Box arm.
const boxLayout = (l: BoxLayout): string => {
  switch (l.kind) {
    case 'Flex': {
      // direction < gap < wrap
      const fields: Field[] = [['direction', str(l.direction)]];
      if (l.gap !== undefined) fields.push(['gap', intLit(l.gap)]);
      fields.push(['wrap', bool(l.wrap)]);
      return caseObj('Flex', fields);
    }
    case 'Grid': {
      // cols < gap < templateColumns
      const fields: Field[] = [['cols', intLit(l.cols)]];
      if (l.gap !== undefined) fields.push(['gap', intLit(l.gap)]);
      if (l.templateColumns !== undefined) fields.push(['templateColumns', str(l.templateColumns)]);
      return caseObj('Grid', fields);
    }
    case 'Auto':
      return caseObj('Auto', []);
    default:
      return assertNever(l);
  }
};

const boxSpec = (s: BoxSpec<unknown>): string => {
  const fields: Field[] = [['children', jArray(s.children.map(node))]];
  if (s.heading !== undefined) fields.push(['heading', textSource(s.heading)]);
  fields.push(['layout', boxLayout(s.layout)]);
  fields.push(['role', str(s.role)]);
  return jObject(fields);
};

const splitPanelSpec = (s: SplitPanelSpec<unknown>): string =>
  jObject([
    ['children', jArray(s.children.map(node))],
    ['weight', num(s.weight)],
  ]);

const tabHeader = (h: TabHeader): string => {
  const fields: Field[] = [['label', textSource(h.label)]];
  if (h.icon !== undefined) fields.push(['icon', str(h.icon)]);
  if (h.disabled !== undefined) fields.push(['disabled', binding(h.disabled)]);
  return jObject(fields);
};

const tabsSpec = (s: TabsSpec<unknown>): string => {
  // `activeIndex` (Phase 126) is carried. `onSelect` / `onSelectTag` (Phase
  // 426): each rides the wire only when present — a defined closure → the
  // `"<closure>"` sentinel (byte-identical to the pre-426 always-emitted
  // `onSelect`); omitted, the renderer's ActiveIndex/ActiveTag write-back
  // default takes over.
  const fields: Field[] = [
    ['children', jArray(s.children.map(node))],
    // 0.2.0 omitted-when-default (`Horizontal`).
    ...(s.orientation === 'Horizontal' ? [] : ([['orientation', str(s.orientation)]] as const)),
    ['activeIndex', binding(s.activeIndex)],
  ];
  if (s.onSelect !== undefined) fields.push(['onSelect', CLOSURE]);
  if (s.tabHeaders !== undefined) fields.push(['tabHeaders', jArray(s.tabHeaders.map(tabHeader))]);
  if (s.tabTags !== undefined) fields.push(['tabTags', jArray(s.tabTags.map(str))]);
  if (s.activeTag !== undefined) fields.push(['activeTag', binding(s.activeTag)]);
  if (s.onSelectTag !== undefined) fields.push(['onSelectTag', CLOSURE]);
  return jObject(fields);
};

// `onSelect` is a closure → the `"<closure>"` sentinel (decodes to a no-op,
// re-encodes to the same sentinel; byte-stable) — same treatment as Tabs
// `onSelect` (Phase 126).
const stepperSpec = (s: StepperSpec<unknown>): string =>
  jObject([
    ['activeStep', binding(s.activeStep)],
    ['children', jArray(s.children.map(node))],
    ['onSelect', CLOSURE],
  ]);

const summaryListSpec = (s: SummaryListSpec<unknown>): string => {
  const fields: Field[] = [['children', jArray(s.children.map(node))]];
  if (s.heading !== undefined) fields.push(['heading', textSource(s.heading)]);
  return jObject(fields);
};

const disclosureSpec = (s: DisclosureSpec<unknown>): string => {
  // `onToggle` (Phase 426): rides the wire only when present — a defined
  // closure → the `"onToggle":"<closure>"` sentinel (previously never encoded,
  // so every pre-426 fixture omits it and stays byte-identical); omitted, the
  // renderer's `open` write-back default takes over.
  const fields: Field[] = [
    ['children', jArray(s.children.map(node))],
    ['defaultOpen', bool(s.defaultOpen)],
    ['heading', textSource(s.heading)],
    ['open', binding(s.open)],
  ];
  if (s.onToggle !== undefined) fields.push(['onToggle', CLOSURE]);
  return jObject(fields);
};

const modalSpec = (s: ModalSpec<unknown>): string => {
  // `onDismiss` is a full wire-survivable Action (encoded via the Action codec,
  // NOT a closure sentinel) — optional since Phase 426: omitted, a dismissable
  // modal falls to the `open` write-back default; `heading` omitted when
  // undefined.
  const fields: Field[] = [
    ['children', jArray(s.children.map(node))],
    ['dismissable', bool(s.dismissable)],
    ['open', binding(s.open)],
  ];
  if (s.onDismiss !== undefined) fields.push(['onDismiss', action(s.onDismiss)]);
  if (s.heading !== undefined) fields.push(['heading', textSource(s.heading)]);
  return jObject(fields);
};

const scrollAreaSpec = (s: ScrollAreaSpec<unknown>): string => {
  const fields: Field[] = [
    ['children', jArray(s.children.map(node))],
    ['orientation', str(s.orientation)],
  ];
  if (s.maxHeight !== undefined) fields.push(['maxHeight', num(s.maxHeight)]);
  if (s.maxWidth !== undefined) fields.push(['maxWidth', num(s.maxWidth)]);
  return jObject(fields);
};

const layoutKind = (l: LayoutKind<unknown>): string => {
  switch (l.kind) {
    // Phase 390 — the unified container. `Stack` / `GridLayout` / `Dashboard` /
    // `Card` all encode as `Box`; the role + layout mode carry what the retired
    // kinds encoded. A legacy tag never re-encodes to its old form.
    case 'Box':
      return hoistSpec('Box', boxSpec(l.spec));
    case 'SplitPanel':
      return hoistSpec('SplitPanel', splitPanelSpec(l.spec));
    case 'Tabs':
      return hoistSpec('Tabs', tabsSpec(l.spec));
    case 'Stepper':
      return hoistSpec('Stepper', stepperSpec(l.spec));
    case 'SummaryList':
      return hoistSpec('SummaryList', summaryListSpec(l.spec));
    case 'Disclosure':
      return hoistSpec('Disclosure', disclosureSpec(l.spec));
    case 'Modal':
      return hoistSpec('Modal', modalSpec(l.spec));
    case 'ScrollArea':
      return hoistSpec('ScrollArea', scrollAreaSpec(l.spec));
    default:
      return assertNever(l);
  }
};

// ─── Parameterised-fragment hole / effect / scalar emitters (Phase 180) ──────

const fragmentScalar = (s: FragmentScalar): string => {
  switch (s.kind) {
    case 'int':
      return caseObj('Int', [['value', String(s.value)]]);
    case 'float':
      return caseObj('Float', [['value', num(s.value)]]);
    case 'bool':
      return caseObj('Bool', [['value', bool(s.value)]]);
    case 'str':
      return caseObj('Str', [['value', str(s.value)]]);
    default:
      return assertNever(s);
  }
};

const holeValueSpace = (s: HoleValueSpace): string => {
  switch (s.kind) {
    case 'IntRange':
      return caseObj('IntRange', [
        ['max', String(s.max)],
        ['min', String(s.min)],
      ]);
    case 'FloatRange':
      return caseObj('FloatRange', [
        ['max', num(s.max)],
        ['min', num(s.min)],
      ]);
    case 'StringLen':
      return caseObj('StringLen', [
        ['maxLen', String(s.maxLen)],
        ['minLen', String(s.minLen)],
      ]);
    case 'Enum':
      return caseObj('Enum', [['choices', jArray(s.choices.map(str))]]);
    case 'AnyString':
      return caseObj('AnyString', []);
    default:
      return assertNever(s);
  }
};

const holeDecl = (h: HoleDecl): string => {
  switch (h.kind) {
    case 'Value': {
      const fields: Field[] = [
        ['name', str(h.name)],
        ['space', holeValueSpace(h.space)],
      ];
      if (h.default !== undefined) fields.push(['default', fragmentScalar(h.default)]);
      return caseObj('Value', fields);
    }
    case 'Slot': {
      const fields: Field[] = [['name', str(h.name)]];
      if (h.kindConstraint !== undefined) fields.push(['kindConstraint', str(h.kindConstraint)]);
      return caseObj('Slot', fields);
    }
    case 'Repeat':
      return caseObj('Repeat', [
        ['countSpace', holeValueSpace(h.countSpace)],
        ['name', str(h.name)],
      ]);
    default:
      return assertNever(h);
  }
};

const effectClass = (e: EffectClass): string =>
  jObject([
    ['determinism', str(e.determinism)],
    ['hostEffect', str(e.hostEffect)],
  ]);

const isPureDeterministic = (e: EffectClass): boolean =>
  e.hostEffect === 'Pure' && e.determinism === 'Deterministic';

const fragmentArg = (a: FragmentArg<unknown>): string => {
  switch (a.kind) {
    case 'value':
      return fragmentScalar(a.value);
    case 'slot':
      return caseObj('SlotArg', [['tree', node(a.tree)]]);
    default:
      return assertNever(a);
  }
};

// ─── NodeKind / Node / StateBehaviour / Style / Accessibility ────────────────

const nodeKind = (k: NodeKind<unknown>): string => {
  switch (k.kind) {
    // The four behavioural categories are flat on the wire (WIRE_FORMAT §3.2):
    // emit the inner kind directly into the `kind` slot with no category
    // envelope. The category is a host-side classification, not a wire level.
    case 'Layout':
      return layoutKind(k.layout);
    case 'Display':
      return displayKind(k.display);
    case 'Input':
      return inputKind(k.input);
    case 'Visualisation':
      return visKind(k.visualisation);
    case 'Custom': {
      // Phase 70 arm: contentHash + exposedNodeIds emit only when populated
      // (None / [] omitted), matching the F# encoder — so a Custom with no
      // exposed ids encodes without the key.
      const fields: Field[] = [
        ['componentId', str(k.componentId)],
        ['moduleId', str(k.moduleId)],
        ['props', jsonMap(k.props)],
      ];
      if (k.contentHash !== undefined) {
        fields.push([
          'contentHash',
          jObject([
            ['algorithm', str(k.contentHash.algorithm)],
            ['hash', str(k.contentHash.hash)],
            ['strictness', str(k.contentHash.strictness)],
          ]),
        ]);
      }
      if (k.exposedNodeIds.length > 0) {
        fields.push(['exposedNodeIds', jArray(k.exposedNodeIds.map(str))]);
      }
      return caseObj('Custom', fields);
    }
    case 'ErrorBoundary':
      return caseObj('ErrorBoundary', [
        ['child', node(k.spec.child)],
        ['fallback', node(k.spec.fallback)],
      ]);
    case 'Switch':
      // State-bound conditional child (Phase 392). Each case encodes as a
      // `{child,match}` object (keys sort child < match); the whole kind's keys
      // sort cases < default < stateKey. jObject sorts, so the listed order is
      // cosmetic.
      return caseObj('Switch', [
        [
          'cases',
          jArray(
            k.spec.cases.map((c) =>
              jObject([
                ['child', node(c.child)],
                ['match', str(c.match)],
              ]),
            ),
          ),
        ],
        ['default', node(k.spec.default)],
        ['stateKey', str(k.spec.stateKey)],
      ]);
    case 'FragmentDecl': {
      // Phase 180 — `holes` / `effect` additive; omitted at the degenerate
      // (zero-hole, pure-deterministic) case so the fixed-body shape is
      // byte-identical.
      const fields: Field[] = [
        ['body', node(k.spec.body)],
        ['name', str(k.spec.name)],
      ];
      if (k.spec.holes.length > 0) fields.push(['holes', jArray(k.spec.holes.map(holeDecl))]);
      if (!isPureDeterministic(k.spec.effect)) fields.push(['effect', effectClass(k.spec.effect)]);
      return caseObj('FragmentDecl', fields);
    }
    case 'FragmentRef': {
      // Phase 180 — `args` additive; omitted at the zero-arg case.
      const fields: Field[] = [['name', str(k.spec.name)]];
      const argKeys = Object.keys(k.spec.args);
      if (argKeys.length > 0)
        fields.push([
          'args',
          jObject(argKeys.map((key) => [key, fragmentArg(k.spec.args[key]!)] as const)),
        ]);
      return caseObj('FragmentRef', fields);
    }
    case 'Mount': {
      // Phase 265, §4o — the isolation/embedding boundary. `scopeId` + `channel`
      // + `capabilities` + the `onBubble` closure sentinel always present;
      // `inputs` additive (omitted when empty, reusing the FragmentArg encoding).
      // `capabilities` always emits (even `[]`) — the explicit visible
      // default-deny posture. Mirrors the F# CanonicalJson Mount arm.
      const s = k.spec;
      const channelFields: Field[] = [['direction', str(s.channel.direction)]];
      if (s.channel.messageShape !== undefined)
        channelFields.push(['messageShape', str(s.channel.messageShape)]);
      const fields: Field[] = [
        ['capabilities', jArray(s.capabilities.map(str))],
        ['channel', jObject(channelFields)],
        ['onBubble', CLOSURE],
        ['scopeId', str(s.scopeId)],
      ];
      const inputKeys = Object.keys(s.inputs);
      if (inputKeys.length > 0)
        fields.push([
          'inputs',
          jObject(inputKeys.map((key) => [key, fragmentArg(s.inputs[key]!)] as const)),
        ]);
      return caseObj('Mount', fields);
    }
    default:
      return assertNever(k);
  }
};

const stateBehaviour = (s: StateBehaviour<unknown>): string => {
  const fields: Field[] = [];
  if (s.onLoading !== undefined) fields.push(['onLoading', node(s.onLoading)]);
  if (s.onEmpty !== undefined) fields.push(['onEmpty', node(s.onEmpty)]);
  if (s.onError !== undefined) fields.push(['onError', CLOSURE]);
  return jObject(fields);
};

const semanticStyle = (s: SemanticStyle): string => {
  // Every field is emitted only when non-default: `role`/`voice` since Phase 147,
  // and `emphasis`/`tone`/`weight` since Phase 460, so a style object authored
  // before a field existed round-trips byte-identically and an all-default style
  // encodes as `{}`. Per the wire contract an absent field IS the default, so
  // `undefined` (a loosely-typed object literal lacking the key) is treated as the
  // default and omitted — symmetric with the decoder's `?? default` on absence.
  // `jObject` sorts keys, so order is irrelevant.
  const fields: Field[] = [];
  if (s.emphasis !== undefined && s.emphasis !== 'Normal')
    fields.push(['emphasis', str(s.emphasis)]);
  if (s.tone !== undefined && s.tone !== 'Default') fields.push(['tone', str(s.tone)]);
  if (s.weight !== undefined && s.weight !== 'Standard') fields.push(['weight', str(s.weight)]);
  if (s.role !== undefined && s.role !== 'None') fields.push(['role', str(s.role)]);
  if (s.voice !== undefined && s.voice !== 'Default') fields.push(['voice', str(s.voice)]);
  return jObject(fields);
};

const accessibility = (a: Accessibility): string => {
  const fields: Field[] = [];
  if (a.label !== undefined) fields.push(['label', binding(a.label)]);
  if (a.labelledBy !== undefined) fields.push(['labelledBy', str(a.labelledBy)]);
  if (a.describedBy !== undefined) fields.push(['describedBy', str(a.describedBy)]);
  if (a.role !== undefined) fields.push(['role', str(a.role)]);
  if (a.liveRegion !== undefined) fields.push(['liveRegion', str(a.liveRegion)]);
  if (a.hidden !== undefined) fields.push(['hidden', binding(a.hidden)]);
  return jObject(fields);
};

/** All-empty StateBehaviour (no onLoading / onEmpty / onError) — port of F# `isEmptyState`. */
const isEmptyState = (s: StateBehaviour<unknown>): boolean =>
  s.onLoading === undefined && s.onEmpty === undefined && s.onError === undefined;

/** All-default SemanticStyle (Normal / Default / Standard / None / Default) — port of F# `isDefaultStyle`.
 *  An absent role/voice (undefined) is the default per the wire contract. */
const isDefaultStyle = (s: SemanticStyle): boolean =>
  (s.emphasis === undefined || s.emphasis === 'Normal') &&
  (s.tone === undefined || s.tone === 'Default') &&
  (s.weight === undefined || s.weight === 'Standard') &&
  (s.role === undefined || s.role === 'None') &&
  (s.voice === undefined || s.voice === 'Default');

const node = (n: Node<unknown>): string => {
  const fields: Field[] = [
    ['id', str(n.id)],
    ['kind', nodeKind(n.kind)],
  ];
  // `state` / `style` are omitted when empty / all-default — the common case
  // (WIRE_FORMAT.md §3.1). The decoder restores the default on absence.
  if (!isEmptyState(n.state)) fields.push(['state', stateBehaviour(n.state)]);
  if (!isDefaultStyle(n.style)) fields.push(['style', semanticStyle(n.style)]);
  if (n.accessibility !== undefined) fields.push(['accessibility', accessibility(n.accessibility)]);
  return jObject(fields);
};

// ─── TreeOp ──────────────────────────────────────────────────────────────────

const treeOp = (op: TreeOp<unknown>): string => {
  switch (op.kind) {
    case 'EditNode':
      return caseObj('EditNode', [
        ['newKind', nodeKind(op.newKind)],
        ['target', str(op.target)],
      ]);
    case 'UpdateProp':
      return caseObj('UpdateProp', [
        ['path', str(op.path)],
        ['target', str(op.target)],
        ['value', jsonValue(op.value)],
      ]);
    case 'ReplaceBinding':
      return caseObj('ReplaceBinding', [
        ['binding', binding(op.binding)],
        ['slot', str(op.slot)],
        ['target', str(op.target)],
      ]);
    case 'UpdateStyle':
      return caseObj('UpdateStyle', [
        ['style', semanticStyle(op.style)],
        ['target', str(op.target)],
      ]);
    case 'UpdateState':
      return caseObj('UpdateState', [
        ['state', stateBehaviour(op.state)],
        ['target', str(op.target)],
      ]);
    case 'InsertChild':
      return caseObj('InsertChild', [
        ['child', node(op.child)],
        ['parentId', str(op.parentId)],
      ]);
    case 'RemoveNode':
      return caseObj('RemoveNode', [['target', str(op.target)]]);
    case 'MoveNode':
      return caseObj('MoveNode', [
        ['newParentId', str(op.newParentId)],
        ['target', str(op.target)],
      ]);
    case 'ReorderChildren':
      return caseObj('ReorderChildren', [
        ['newOrder', jArray(op.newOrder.map(str))],
        ['parentId', str(op.parentId)],
      ]);
    case 'ReplaceRoot':
      return caseObj('ReplaceRoot', [['node', node(op.node)]]);
    case 'Batch':
      return caseObj('Batch', [['ops', jArray(op.ops.map(treeOp))]]);
    default:
      return assertNever(op);
  }
};

// ─── Public surface ──────────────────────────────────────────────────────────

/** Encode a `Node<TMsg>` to its canonical-JSON string (WIRE_FORMAT.md). */
export const encodeNode = <TMsg>(n: Node<TMsg>): string => node(n as Node<unknown>);

/** Encode a `TreeOp<TMsg>` to its canonical-JSON string (WIRE_FORMAT.md). */
export const encodeOp = <TMsg>(op: TreeOp<TMsg>): string => treeOp(op as TreeOp<unknown>);
