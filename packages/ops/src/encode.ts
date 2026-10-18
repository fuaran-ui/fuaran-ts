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

import {
  KIND_FIELDS,
  RECORD_FIELDS,
  controlValueDefaults,
  defaultValue,
  stateDefaultDeclared,
  wireRows,
} from '@fuaran-ui/schema';
import type {
  FieldRow,
  IdlRecord,
  IdlSpec,
  IdlType,
  NodeKindName,
  RecordName,
  Accessibility,
  Action,
  Agg,
  DefaultSort,
  Cell,
  ColExpr,
  ColPair,
  ColumnType,
  DataColumn,
  DataSource,
  InvokeArg,
  SortKey,
  Transform,
  Binding,
  BoxLayout,
  CellFormat,
  CellKindErased,
  ChartAnnotation,
  ChartAnnotationRange,
  ChartAnnotationX,
  ColumnErased,
  ColumnWidth,
  DisplayKind,
  EffectClass,
  MediaKind,
  TrackEntry,
  TreeItem,
  CurveCommand,
  DrawPoint,
  DrawStyle,
  Shape,
  ViewBox,
  FilterSpec,
  FragmentArg,
  FragmentScalar,
  Format,
  FormField,
  FieldRule,
  CompareRule,
  FormFieldKind,
  LocaleSource,
  HoleDecl,
  HoleValueSpace,
  InputKind,
  JsonValue,
  LayoutKind,
  LocalFlushTrigger,
  MapMarker,
  Node,
  NodeKind,
  SelectOption,
  SelectSpec,
  SrcSetEntry,
  SemanticStyle,
  StateBehaviour,
  TabHeader,
  TextSource,
  VisKind,
} from '@fuaran-ui/schema';

import { formatFiniteDouble, num } from '@fuaran-ui/core-twins';

import type { JsonAst } from './parse.js';
import type { StyleDelta, TreeOp } from './treeOp.js';

// ─── Primitive emitters ──────────────────────────────────────────────────────

const assertNever = (x: never): never => {
  throw new Error(`@fuaran-ui/ops encode: unreachable case ${JSON.stringify(x)}`);
};

/** Quote + escape a string per WIRE_FORMAT.md §2 rule 6 (only " \ and control chars). */
export const str = (s: string): string => {
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

// The canonical float layout (`formatFiniteDouble` / `num`) lives in the core-twins boundary
// (Phase 1861); re-exported here so every importer of this module is unchanged.
export { formatFiniteDouble, num };

export const bool = (b: boolean): string => (b ? 'true' : 'false');

export type Field = readonly [string, string];

/** Emit an object with Ordinal-sorted keys (§2 rule 2). */
export const jObject = (fields: readonly Field[]): string => {
  const sorted = [...fields].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return '{' + sorted.map(([k, v]) => str(k) + ':' + v).join(',') + '}';
};

export const jArray = (items: readonly string[]): string => '[' + items.join(',') + ']';

/** A `$type`-discriminated DU object (§2 rule 8). */
export const caseObj = (discriminator: string, fields: readonly Field[]): string =>
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
 * parameter, and fuaran#665 moved grid/chart rows onto `staticRowSeq`; this
 * catch-all is the residual-opaque boundary for the remaining genuinely
 * host-typed payloads — and the best-effort CELL encoder inside a typed row,
 * where a nested array/object cell re-encodes as `"<opaque>"`.
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

// 0.28.0 — the member is `column`, not `col`: a wire member whose only honest name is
// "the column" is spelled out in full. `col` stays a DECODE alias and is never emitted.
// The model field keeps its own name — this is a wire rename, not an API one.
const orderJson = (s: SortKey): string =>
  jObject([
    ['column', str(s.col)],
    ['dir', str(s.dir)],
  ]);

/** A `Transform` step — port of F# `DataFrameCodec.encodeTransform`. */
const transformStep = (t: Transform): string => {
  switch (t.kind) {
    case 'filter':
      return caseObj('filter', [['pred', colExpr(t.pred)]]);
    case 'project':
      // 0.28.0 — `columns`, not `cols` (see `orderJson` above); `cols` is a decode alias only.
      return caseObj('project', [['columns', jArray(t.cols.map(pairJson))]]);
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
      // §5's absent-`State.defaultValue` posture (Phase 1656; Phase 677's rule
      // for `Static`, stated normatively for this position). The DECLARATION
      // decides where the decoder recorded one: `defaultValue` is the
      // RESOLUTION default an unwritten key yields, and at a typed slot that is
      // `0` / `false` / `[]`, so emitting it would put a member on the wire the
      // document never carried.
      //
      // `defaultDeclared === undefined` is an AUTHORED binding — the field is
      // decode provenance and no authoring call site sets it — so it falls back
      // to reading the value, which is what those call sites have always relied
      // on (`defaults.switch.on` and the tagged-tabs constructor both spell "no
      // default" as `undefined`).
      // The value test remains a FLOOR under both routes, not merely the
      // fallback: a slot whose typed placeholder is itself absent (the
      // `Transform` source's is) can leave a DECLARED-but-unreadable default
      // holding nothing, and a member with no value is not a member.
      //
      // Phase 1690 — the predicate moved to `@fuaran-ui/schema` unchanged. It
      // now decides RESOLUTION as well as emission (§24.8: an undeclared
      // default resolves to nothing), and three seams that must agree about one
      // fact get one definition.
      const declared = stateDefaultDeclared(b);
      const defaultFields: readonly Field[] = declared
        ? [['defaultValue', staticEnc(b.defaultValue)]]
        : [];
      return caseObj('State', [...defaultFields, ['key', str(b.key)]]);
    }
    case 'Computed':
      return caseObj('Computed', [['fn', CLOSURE]]);
    // Phase 765 — the INSTANT is never on the wire: it is host-furnished at
    // resolve time. Phase 1533 — the declared GRAIN is, and only when it is not
    // the `Second` default, so a grain-less `Now` is the same bytes it has
    // always been.
    case 'Now':
      return caseObj('Now', b.grain !== undefined ? [['grain', str(b.grain)]] : []);
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
    case 'Local': {
      // The declared members ride when present; `onCommit` is emitted only when
      // the binding actually carries the closure, because a document that never
      // wrote the key must not gain one on re-encode — and because a declared
      // `commitTo` excludes it (they are mutually exclusive on the wire).
      const localFields: Field[] = [
        ['flushOn', flushTrigger(b.local.flushOn)],
        ['format', CLOSURE],
        ['initialFrom', binding(b.local.initialFrom, staticEnc)],
        ['parse', CLOSURE],
      ];
      if (b.local.codec !== undefined) localFields.push(['codec', formatIntent(b.local.codec)]);
      if (b.local.commitTo !== undefined) localFields.push(['commitTo', str(b.local.commitTo)]);
      if (b.local.onCommit !== undefined) localFields.push(['onCommit', CLOSURE]);
      return caseObj('Local', localFields);
    }
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
      // Phase 818 — a `Data` source keeps the columnar encoding byte-identical;
      // a `Live` source re-encodes the preserved binding itself (one wire
      // dialect — the State/Selection/Query-shaped source round-trips
      // byte-for-byte; the derived `initial` snapshot is never encoded). The
      // carried default encodes through the FAITHFUL structured encoder, the
      // shape it was decoded with.
      return caseObj('Transform', [
        ...paramFields,
        ['pipeline', jArray(b.pipeline.map(transformStep))],
        [
          'source',
          b.source.kind === 'Data'
            ? dataSource(b.source.source)
            : binding(b.source.binding, jsonValue),
        ],
      ]);
    }
    case 'Expr': {
      // Phase 1534 — the scalar expression. `expr` splices the SAME canonical
      // `ColExpr` rendering the pipeline's steps use, and `params` is the same
      // omitted-when-empty list `Transform` carries above — reusing both is what
      // keeps the two cases from drifting into two dialects. `$type` (0x24)
      // sorts before `expr` < `params`, so the composite is canonical.
      const exprParams: readonly Field[] =
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
      return caseObj('Expr', [['expr', colExpr(b.expr)], ...exprParams]);
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
    case 'Navigate': {
      // Phase 1536 — the route is a `TextSource`, and `target` rides only when
      // it is not `Self` (route < target stays alphabetical). A literal route
      // encodes as the bare JSON string, so every pre-1536 document's bytes are
      // unchanged.
      const fields: Field[] = [['route', textSource(a.route)]];
      if (a.target !== 'Self') fields.push(['target', str(a.target)]);
      return caseObj('Navigate', fields);
    }
    case 'SetState': {
      // Phase 818 — `value` / `valueFrom` are XOR siblings; each is emitted
      // only when present (key < value < valueFrom stays alphabetical).
      const fields: Field[] = [['key', str(a.key)]];
      if (a.value !== undefined) fields.push(['value', jsonValue(a.value)]);
      if (a.valueFrom !== undefined) fields.push(['valueFrom', binding(a.valueFrom, jsonValue)]);
      return caseObj('SetState', fields);
    }
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
      // Phase 1126 — a `TextSource`. `textSource` emits a `Literal` as the bare
      // JSON string, so a literal payload is byte-identical to what this arm
      // emitted before the widening: the change is source-breaking for
      // construction sites and WIRE-NEUTRAL.
      return caseObj('WriteToClipboard', [['text', textSource(a.text)]]);
    case 'Print':
      // Phase 1124 — the complete encoding is the discriminator. `caseObj` with
      // no fields emits `{"$type":"Print"}`; an encoder that emitted `{}` for a
      // case with no fields is exactly what the corpus fixture placing this
      // inside a `Chain` exists to catch.
      return caseObj('Print', []);
    case 'Confirm': {
      // Phase 1537 — the SECOND recursive arm after `Chain`, and the first that
      // recurses into named members: both continuations go through `action`
      // itself. Keys sort to onCancel < onConfirm < prompt, and `onCancel`
      // rides only when present.
      const fields: Field[] = [];
      if (a.onCancel !== undefined) fields.push(['onCancel', action(a.onCancel)]);
      fields.push(['onConfirm', action(a.onConfirm)]);
      fields.push(['prompt', textSource(a.prompt)]);
      return caseObj('Confirm', fields);
    }
    case 'Focus':
      // Phase 1537 — a node id and nothing else, the `CommitLocal` shape.
      return caseObj('Focus', [['nodeId', str(a.nodeId)]]);
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

/**
 * Phase 1661 — one `TextSource.I18n` argument (WIRE_FORMAT.md §5). A `Static`
 * argument carrying a value emits the BARE value, which is the whole reason the
 * widening from a bare-value bag to a `Binding<JsonValue>` bag moves no shipped
 * byte; every other arm emits its own `$type` object, and a valueless `Static`
 * stays `{"$type":"Static"}` because absence is structural and has no bare
 * spelling.
 *
 * `jsonValue` is passed as the static encoder rather than letting `binding`
 * default to the best-effort `objValue`: an argument is a rule-12 payload
 * position, so a composite must render faithfully rather than collapse to
 * `"<opaque>"`.
 */
const i18nArg = (arg: Binding<JsonValue>): string =>
  arg.kind === 'Static' && arg.value !== null && arg.value !== undefined
    ? jsonValue(arg.value)
    : binding(arg, jsonValue);

const i18nArgMap = (m: Readonly<Record<string, Binding<JsonValue>>>): string =>
  jObject(Object.entries(m).map(([k, v]) => [k, i18nArg(v)] as const));

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
        ['args', i18nArgMap(t.args)],
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
    case 'DateTime':
      return caseObj('DateTime', [['format', str(f.format)]]);
    case 'Duration':
      // Phase 819 — alphabetical field order (style before unit), the
      // canonical ordering rule.
      return caseObj('Duration', [
        ['style', str(f.style)],
        ['unit', str(f.unit)],
      ]);
    case 'RelativeTime':
      return caseObj('RelativeTime', [['unit', str(f.unit)]]);
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
    case 'DateTime':
      // Phase 1810 — each style rides only when present; alphabetical field
      // order (dateStyle before timeStyle), the canonical rule.
      return caseObj('DateTime', [
        ...(f.dateStyle !== undefined ? [['dateStyle', str(f.dateStyle)] as const] : []),
        ...(f.timeStyle !== undefined ? [['timeStyle', str(f.timeStyle)] as const] : []),
      ]);
    case 'RelativeTime':
      return caseObj('RelativeTime', [['unit', str(f.unit)]]);
    case 'Duration':
      // Phase 819 — alphabetical field order (style before unit).
      return caseObj('Duration', [
        ['style', str(f.style)],
        ['unit', str(f.unit)],
      ]);
    // Phase 1533 — `unit` omitted when absent: its absence is the
    // auto-selection request, not a default that could be spelled out.
    case 'Since':
      return caseObj('Since', f.unit !== undefined ? [['unit', str(f.unit)]] : []);
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
// Phase 867 - omitted at `HigherIsBetter`, so every pre-867 document is
// byte-unchanged and the slot costs nothing until it is used.
const pushColumnWidthOptional = (fields: Field[], key: string, w: ColumnWidth): void => {
  if (w.kind !== 'Auto') fields.push([key, columnWidth(w)]);
};

// ─── Spec encoders from the IDL's field tables (Phase 2073) ───────────────────
//
// Every kind spec encoder below is ONE field table folded by `specEncoder`,
// the mirror of the decoder's fold: each wire member of `KIND_FIELDS[kind]` is
// emitted through the encoder its IDL type implies (`encoderFor`), an
// `optional` member only when present, an `omitDefault` member only when its
// canonical bytes differ from its declared default's (WIRE_FORMAT.md §3.6 —
// equality is of the WIRE bytes, so a `Static` binding carrying the default
// equals only another such binding, and a record default compares member for
// member), a closure member as the `"<closure>"` sentinel when present. Keys
// are Ordinal-sorted by `jObject`, so the table's order never reaches the
// wire. What this file supplies per spec is the host's representation, once:
// a member whose bytes are not what its type implies (`enc`), and nothing
// else — a member the IDL gains encodes with no edit here, and a member whose
// type this host cannot encode is a load-time failure naming it.

type Enc = (v: unknown) => string;

/** What a spec declares, once, for one of its members. */
interface EncOverride {
  /**
   * This member's own bytes, in place of what its IDL type implies. Called with
   * the member's value even when it is absent; `undefined` omits the member.
   */
  readonly enc?: (v: unknown) => string | undefined;
}

type EncOverrides<K extends NodeKindName> = Partial<
  Record<(typeof KIND_FIELDS)[K][number]['name'], EncOverride>
>;
type RecordEncOverrides<N extends RecordName> = Partial<
  Record<(typeof RECORD_FIELDS)[N][number]['name'], EncOverride>
>;

/**
 * This host's encoders of the IDL's records, unions and `Binding<…>` payloads
 * whose bytes are not a function of their IDL type, by name. Built on first
 * use: the encoders it names are declared through the rest of this module.
 */
const encDialect = (() => {
  let tables:
    | {
        readonly records: Readonly<Record<string, Enc>>;
        readonly unions: Readonly<Record<string, Enc>>;
        readonly bindings: Readonly<Record<string, Enc>>;
      }
    | undefined;
  return () =>
    (tables ??= {
      records: {
        ColumnErased: columnErased as Enc,
        DefaultSort: defaultSortJson as Enc,
        DrawStyle: drawStyle as Enc,
        EffectClass: effectClass as Enc,
        FilterSpec: filterSpec as Enc,
        FormField: formField as Enc,
        GuestChannel: guestChannel as Enc,
        MapMarker: mapMarker as Enc,
        SelectOption: selectOption as Enc,
        SrcSetEntry: srcSetEntry as Enc,
        StaticRows: staticRows as Enc,
        TabHeader: tabHeader as Enc,
        TrackEntry: trackEntry as Enc,
        TreeItem: treeItem as Enc,
        ViewBox: viewBox as Enc,
      },
      unions: {
        Action: action as Enc,
        BoxLayout: boxLayout as Enc,
        CellFormat: cellFormat as Enc,
        ChartAnnotation: chartAnnotation as Enc,
        Format: formatIntent as Enc,
        HoleDecl: holeDecl as Enc,
        MediaKind: mediaKind as Enc,
        Shape: shape as Enc,
        TextSource: textSource as Enc,
      },
      bindings: {
        // fuaran#665 — rows are a typed Static payload, not the opaque residual.
        hosted: staticRowSeq as Enc,
      },
    });
})();

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

/** The encoder a member's IDL type implies, or `undefined` when this host has none. */
const encoderFor = (t: IdlType): Enc | undefined => {
  switch (t.$type) {
    case 'str':
    case 'enum':
      return (v) => str(v as string);
    case 'int':
    case 'float':
      return (v) => num(v as number);
    case 'bool':
      return (v) => bool(v as boolean);
    case 'node':
      return node as Enc;
    case 'json':
      return jsonValue as Enc;
    case 'list': {
      const inner = encoderFor(t.of);
      return inner === undefined ? undefined : (v) => jArray((v as readonly unknown[]).map(inner));
    }
    case 'map': {
      const inner = encoderFor(t.values);
      return inner === undefined
        ? undefined
        : (v) =>
            jObject(
              Object.entries(v as Readonly<Record<string, unknown>>).map(
                ([k, x]) => [k, inner(x)] as const,
              ),
            );
    }
    case 'record':
      return encDialect().records[t.name];
    case 'union': {
      if (t.name !== 'Binding') return encDialect().unions[t.name];
      const arg = t.args[0];
      const payload = arg === undefined ? undefined : encDialect().bindings[typeKey(arg)];
      const staticEnc = payload ?? (arg === undefined ? undefined : encoderFor(arg));
      return (v) => binding(v as Binding<unknown>, staticEnc);
    }
    case 'fn':
      return () => CLOSURE;
    default:
      return undefined;
  }
};

interface EncMember {
  readonly name: string;
  readonly required: boolean;
  readonly enc: (v: unknown) => string | undefined;
  /** The declared default's canonical bytes, for an `omitDefault` member. */
  readonly dflt: string | undefined;
}

const tableEncMembers = (
  owner: string,
  rows: readonly FieldRow[],
  overrides: Readonly<Record<string, EncOverride | undefined>>,
): readonly EncMember[] =>
  wireRows(rows).map((row) => {
    const o = overrides[row.name];
    const implied = encoderFor(row.type);
    if (o?.enc === undefined && implied === undefined)
      throw new Error(
        `${owner}.${row.name}: no encoder writes the IDL type ${typeKey(row.type)}; add an override`,
      );
    const enc: (v: unknown) => string | undefined =
      o?.enc ?? ((v) => (v === undefined ? undefined : implied!(v)));
    return {
      name: row.name,
      required: row.opt === 'required',
      enc,
      dflt: row.dflt === undefined ? undefined : enc(defaultValue(row.dflt)),
    };
  });

const encodeMembers = (value: Readonly<Record<string, unknown>>, members: readonly EncMember[]) => {
  const fields: Field[] = [];
  for (const m of members) {
    const bytes = m.enc(value[m.name]);
    if (bytes === undefined || bytes === m.dflt) continue;
    fields.push([m.name, bytes]);
  }
  return jObject(fields);
};

/** The encoder of one field table. */
const tableEncoder = <T>(
  owner: string,
  rows: readonly FieldRow[],
  overrides: Readonly<Record<string, EncOverride | undefined>>,
): ((value: T) => string) => {
  let members: readonly EncMember[] | undefined;
  return (value) =>
    encodeMembers(
      value as unknown as Readonly<Record<string, unknown>>,
      (members ??= tableEncMembers(owner, rows, overrides)),
    );
};

/** The encoder of a kind's spec, from `KIND_FIELDS`. */
const specEncoder = <K extends NodeKindName, S = IdlSpec<K>>(
  kind: K,
  overrides: EncOverrides<K> = {},
): ((spec: S) => string) => tableEncoder(kind, KIND_FIELDS[kind], overrides);

/** The encoder of a record, from `RECORD_FIELDS`. */
const recordEncoder = <N extends RecordName>(
  name: N,
  overrides: RecordEncOverrides<N> = {},
): ((value: IdlRecord<N>) => string) => tableEncoder(name, RECORD_FIELDS[name], overrides);

/** A map member omitted when it holds nothing (the pre-existing wire of the fragment arms). */
const nonEmptyMap =
  (inner: Enc): ((v: unknown) => string | undefined) =>
  (v) => {
    const entries = Object.entries(v as Readonly<Record<string, unknown>>);
    return entries.length === 0
      ? undefined
      : jObject(entries.map(([k, x]) => [k, inner(x)] as const));
  };

// ─── Display specs ───────────────────────────────────────────────────────────

const metricSpec = specEncoder('Metric');

const headingSpec = specEncoder('Heading');

const labelValueRowSpec = specEncoder('LabelValueRow');

const factSpec = specEncoder('Fact');

const markdownSpec = specEncoder('Markdown');

const badgeSpec = specEncoder('Badge');

const linkSpec = specEncoder('Link');

// Phase 1080 — one `srcSet` candidate. `jObject` sorts the members, so `src`
// precedes `width` on the wire whatever order they are pushed in here.
const srcSetEntry = (e: SrcSetEntry): string =>
  jObject([
    ['src', binding(e.src)],
    ['width', num(e.width)],
  ]);

const imageSpec = specEncoder('Image');

// Phase 1076 — the media variant. `Video`'s two slots take the two ordinary
// shapes: `autoplay` omitted at `false`, `poster` omitted when absent. `Audio`
// is the bare discriminator, and has no autoplay key to omit because the case
// declares no such slot.
const mediaKind = (k: MediaKind): string => {
  if (k.$type === 'Audio') return caseObj('Audio', []);
  const fields: Field[] = [];
  if (k.autoplay) fields.push(['autoplay', bool(true)]);
  if (k.poster !== undefined) fields.push(['poster', binding(k.poster)]);
  return caseObj('Video', fields);
};

// Phase 1076 — byte parity with the F# encoder, including the two OPPOSITE
// omit polarities: `controls` omits at TRUE (the accessible value is the free
// one), `loop` at false. `jObject` sorts, so the keys land canonically wherever
// they are pushed.
const mediaSpec = specEncoder('Media');

// Phase 1110 — one `<track>`. Four members always ride; `default` omits at
// `false`. `jObject` sorts, so the listed order is cosmetic.
const trackEntry = (t: TrackEntry): string => {
  const fields: Field[] = [];
  if (t.default) fields.push(['default', bool(true)]);
  fields.push(['kind', str(t.kind)]);
  fields.push(['label', textSource(t.label)]);
  fields.push(['src', binding(t.src)]);
  fields.push(['srcLang', str(t.srcLang)]);
  return jObject(fields);
};

// Phase 1120 — the tree. `items` always rides; the two State-slot names and the
// handler sentinel omit when absent.
const treeSpec = specEncoder('Tree');

// Phase 1120 — one row. `children` omits at the EMPTY LIST and `icon` when
// absent, so a leaf carries two keys and nothing else — a host emitting
// `"children":[]` on a leaf produces different bytes for most of a file listing.
const treeItem = (t: TreeItem): string => {
  const fields: Field[] = [];
  if (t.children.length > 0) fields.push(['children', jArray(t.children.map(treeItem))]);
  if (t.icon !== undefined) fields.push(['icon', str(t.icon)]);
  fields.push(['id', str(t.id)]);
  fields.push(['label', textSource(t.label)]);
  return jObject(fields);
};

// Phase 1111 — byte parity with the F# encoder. Both optional slots omit at
// their identity: `aspectRatio` at `Natural` and `permissions` at EMPTY, the
// second being the encode half of the missing-list rule. The permission ORDER
// is the document's and is emitted verbatim — a JSON array is ordered data, and
// re-sorting it here would make this encoder produce bytes it did not decode.
// Emitting the tokens in a canonical order is the RENDERER's obligation.
const embedSpec = specEncoder('Embed');

const listSpec = specEncoder('List');

const toastSpec = specEncoder('Toast');

/** `MathDisplay` bare-string enum (WIRE_FORMAT.md §3.5). */
const codeBlockSpec = specEncoder('CodeBlock');

const mathSpec = specEncoder('Math');

const sparklineSpec = specEncoder('Sparkline');

const skeletonSpec = specEncoder('Skeleton');

// Phase 821 — Icon display kind. `size` omitted-when-`Medium`, `tone`
// omitted-when-`Default`, `label` omitted-when-decorative.
const iconSpec = specEncoder('Icon');

const calloutSpec = specEncoder('Callout');

const progressSpec = specEncoder('Progress');

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
  // Phase 877 — Label text rotation (degrees). `!== undefined`, NOT a
  // truthiness test: an explicit 0 is a present value and a distinct wire
  // shape from absent, so omitting it would round-trip to different bytes.
  if (s.rotation !== undefined) fields.push(['rotation', num(s.rotation)]);
  // Phase 883 — the per-mark hover readout. Same `!== undefined` discipline:
  // an EMPTY STRING tip is a present value and a distinct wire shape from
  // absent, and `if (s.tip)` is the natural, wrong test here.
  if (s.tip !== undefined) fields.push(['tip', textSource(s.tip)]);
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

const drawingSpec = specEncoder('Drawing');

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
    case 'Icon':
      return hoistSpec('Icon', iconSpec(d.spec));
    case 'LabelValueRow':
      return hoistSpec('LabelValueRow', labelValueRowSpec(d.spec));
    case 'Fact':
      return hoistSpec('Fact', factSpec(d.spec));
    case 'Link':
      return hoistSpec('Link', linkSpec(d.spec));
    case 'Image':
      return hoistSpec('Image', imageSpec(d.spec));
    case 'Media':
      return hoistSpec('Media', mediaSpec(d.spec));
    case 'Tree':
      return hoistSpec('Tree', treeSpec(d.spec));
    case 'Embed':
      return hoistSpec('Embed', embedSpec(d.spec));
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
        ...handlerField('onChange', k.onChange),
        ...valueField(k.value, controlValueDefaults.checkbox, (v) => binding(v)),
      ]);
    case 'Toggle':
      return caseObj('Toggle', [
        ...handlerField('onChange', k.onChange),
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
    case 'Combobox': {
      // Phase 1113 — ordinal key order (`allowFreeText` < `onChange` <
      // `options` < `value`), with `allowFreeText` OMITTED at `false` so the
      // shortest combobox document is the constrained one.
      const fields: Field[] = [];
      if (k.allowFreeText) fields.push(['allowFreeText', bool(true)]);
      fields.push(...handlerField('onChange', k.onChange));
      fields.push(['options', binding(k.options, staticSelectOptions)]);
      fields.push(
        ...valueField(k.value, controlValueDefaults.choice, (v) => binding(v, staticStringOpt)),
      );
      return caseObj('Combobox', fields);
    }
    case 'Tokens': {
      // Phase 1121 — `allowFreeText` OMITS at `true`, the opposite polarity to
      // `Combobox`'s, so the shortest token document is the OPEN one. Ordinal
      // key order: allowFreeText < onChange < suggestions < value.
      const fields: Field[] = [];
      if (!k.allowFreeText) fields.push(['allowFreeText', bool(false)]);
      fields.push(...handlerField('onChange', k.onChange));
      if (k.suggestions !== undefined)
        fields.push(['suggestions', binding(k.suggestions, staticSelectOptions)]);
      fields.push(
        ...valueField(k.value, controlValueDefaults.tokens, (v) => binding(v, staticStringList)),
      );
      return caseObj('Tokens', fields);
    }
    case 'Rating': {
      // Phase 1130 — `max` always rides (it is the scale); `allowHalf` omits at
      // `false`, so the shortest rating document is the whole-star one.
      const fields: Field[] = [];
      if (k.allowHalf) fields.push(['allowHalf', bool(true)]);
      fields.push(['max', num(k.max)]);
      fields.push(...handlerField('onChange', k.onChange));
      fields.push(...valueField(k.value, controlValueDefaults.number, (v) => binding(v)));
      return caseObj('Rating', fields);
    }
    case 'Color':
      // Phase 1130 — both members optional, so the bare discriminator is a
      // complete auto-bound colour field. CASE IS PRESERVED: nothing here
      // lower-cases the literal, because a codec that did would fail the
      // round-trip this corpus exists to pin.
      return caseObj('Color', [
        ...handlerField('onChange', k.onChange),
        ...valueField(k.value, controlValueDefaults.color, (v) => binding(v)),
      ]);
    case 'TextArea':
      return caseObj('TextArea', [
        ...handlerField('onChange', k.onChange),
        ['rows', num(k.rows)],
        ...valueField(k.value, controlValueDefaults.text, (v) => binding(v)),
      ]);
    case 'DateTime': {
      // Phase 288 — value is Binding<string> (ISO-8601); variant required;
      // min/max (ISO strings) + step (seconds) omitted when undefined, mirroring
      // RangedNumber's optional-constraint discipline.
      const fields: Field[] = [
        ...handlerField('onChange', k.onChange),
        ...valueField(k.value, controlValueDefaults.dateTime, (v) => binding(v)),
        ['variant', str(k.variant)],
      ];
      if (k.constraints.min !== undefined) fields.push(['min', str(k.constraints.min)]);
      if (k.constraints.max !== undefined) fields.push(['max', str(k.constraints.max)]);
      if (k.constraints.step !== undefined) fields.push(['step', num(k.constraints.step)]);
      return caseObj('DateTime', fields);
    }
    case 'DateTimeRange': {
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
        ...valueField(k.value, controlValueDefaults.dateTimeRange, (v) =>
          v.kind === 'Static' ? staticPair(v.value) : binding(v, staticPair),
        ),
        ['variant', str(k.variant)],
      ];
      if (k.constraints.min !== undefined) fields.push(['min', str(k.constraints.min)]);
      if (k.constraints.max !== undefined) fields.push(['max', str(k.constraints.max)]);
      if (k.constraints.step !== undefined) fields.push(['step', num(k.constraints.step)]);
      return caseObj('DateTimeRange', fields);
    }
    default:
      return assertNever(k);
  }
};

// Phase 864 — the cross-field operand. `against` is an ordinary `Binding`, so
// it goes through the same encoder every other bound slot uses; the operand
// payload is untyped (the comparison is ordinal on whatever the slot holds), so
// the default `objValue` static encoder applies.
const compareRule = (c: CompareRule): string =>
  jObject([
    ['against', binding(c.against)],
    ['op', str(c.op)],
  ]);

// Every slot is optional, so the whole record is built by push. A field with no
// rule emits no `rule` key at all — `rule` is Optional rather than omit-default,
// so absence is absence, which is what keeps every pre-864 form fixture
// byte-unchanged.
const fieldRule = (r: FieldRule): string => {
  const fields: Field[] = [];
  if (r.compare !== undefined) fields.push(['compare', compareRule(r.compare)]);
  if (r.format !== undefined) fields.push(['format', str(r.format)]);
  if (r.maxLength !== undefined) fields.push(['maxLength', intLit(r.maxLength)]);
  if (r.message !== undefined) fields.push(['message', textSource(r.message)]);
  if (r.minLength !== undefined) fields.push(['minLength', intLit(r.minLength)]);
  if (r.pattern !== undefined) fields.push(['pattern', str(r.pattern)]);
  return jObject(fields);
};

const formField = (f: FormField<unknown>): string => {
  const fields: Field[] = [
    ['id', str(f.id)],
    ['kind', formFieldKind({ kind: 'form', id: f.id }, f.kind)],
    ['label', textSource(f.label)],
    ['required', bool(f.required)],
  ];
  if (f.help !== undefined) fields.push(['help', textSource(f.help)]);
  if (f.rule !== undefined) fields.push(['rule', fieldRule(f.rule)]);
  return jObject(fields);
};

const formSpec = specEncoder('Form');

const filterSpec = (s: FilterSpec<unknown>): string =>
  // 0.2.0 filters-unification: the chip's control is an ordinary
  // FormFieldKind; a `value` equal to the auto-binding `Filter(name)` is
  // omitted (see formFieldKind).
  jObject([
    ['kind', formFieldKind({ kind: 'filter', name: s.name }, s.field)],
    ['label', textSource(s.label)],
    ['name', str(s.name)],
  ]);

const buttonSpec = specEncoder('Button');

const selectSpec = specEncoder<'Select', SelectSpec<unknown>>('Select', {
  // An unselected control is a `Static` binding carrying no value (Phase 677).
  value: { enc: (v) => binding(v as Binding<string | undefined>, staticStringOpt) },
  // Phase 291 — `multiple` rides only when true; a false flag is the absent default.
  multiple: { enc: (v) => (v === true ? bool(true) : undefined) },
});

const fileUploadSpec = specEncoder('FileUpload');

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
// of F# `encodeBindingWith`). fuaran#665 retired the last residual payload:
// grid/chart ROWS now ride as typed row objects too (`staticRowSeq`), leaving
// `"<opaque>"` only at the CELL seam (WIRE_FORMAT.md §"Typed Static payloads").

const selectOption = (o: SelectOption): string =>
  jObject([
    ['label', textSource(o.label)],
    ['value', str(o.value)],
  ]);

const staticSelectOptions = (v: readonly SelectOption[]): string => jArray(v.map(selectOption));

const staticStringOpt = (v: string | undefined): string => (v === undefined ? 'null' : str(v));

const staticStringList = (v: readonly string[]): string => jArray(v.map(str));

// fuaran#665 — the typed row-source encoding. A grid/chart rows payload rides
// the wire as a JSON array of row objects (Ordinal-sorted keys via `jObject`)
// with best-effort scalar cells: the §2 rule-11 recognised set encodes natively
// through `objValue` (string / bool / number; `Date` → Unix seconds), a
// null/undefined cell is OMITTED (rule 4: absence is structural, never
// `"k":null`), and a nested array/object cell is the residual `"<opaque>"`
// sentinel — the opaque boundary narrowed from the whole payload to the cell
// seam. Mirror of F# `Fuaran.UI.RowCodec.encodeRows`.
//
// Phase 1960 — WIRE_FORMAT.md §5 "The two encode refusals". The 64-bit integer
// cell of rule 11 is a `bigint` here: inside ±2^53 it is exactly a double and
// encodes in integer form; past either bound no JSON number holds it, so the
// cell is REFUSED with a typed `RowCellRefusedError` naming it, rather than
// widened to a different number. (Before, a `bigint` fell to the `"<opaque>"`
// sentinel, which rule 11 does not allow for an integer.) A `Date` always names
// an instant, so the other refusal — a date-time naming none — cannot arise.
const EXACT_INTEGER_LIMIT = 9007199254740992n;

/** The stable codes of the two row-cell refusals (WIRE_FORMAT.md §5). */
export type RowCellRefusalCode = 'ROW_CELL_INEXACT_INTEGER' | 'ROW_CELL_UNSPECIFIED_DATETIME';

/**
 * A row cell the row-feed encoder refuses: the row's zero-based position in
 * the feed and the cell's key. Recognise it by `name`, never `instanceof` —
 * the same posture as `WireSurvivabilityError`.
 */
export class RowCellRefusedError extends Error {
  readonly code: RowCellRefusalCode;
  readonly row: number;
  readonly key: string;
  constructor(code: RowCellRefusalCode, row: number, key: string, why: string) {
    super(`row ${row}, cell '${key}': ${why}`);
    this.name = 'RowCellRefusedError';
    this.code = code;
    this.row = row;
    this.key = key;
  }
}

const rowCell = (v: unknown, row: number, key: string): string => {
  if (typeof v === 'bigint') {
    if (v > EXACT_INTEGER_LIMIT || v < -EXACT_INTEGER_LIMIT) {
      throw new RowCellRefusedError(
        'ROW_CELL_INEXACT_INTEGER',
        row,
        key,
        `the integer ${v} is outside +/-2^53, so no JSON number holds it exactly; carry it as a string`,
      );
    }
    return num(Number(v));
  }
  return objValue(v);
};

const rowValue = (row: unknown, i: number): string => {
  // A non-record element is unrepresentable from the typed authoring surface
  // (the F# slot is statically `Row seq`) and rejected by the decoder, so this
  // guard only keeps the encoder total.
  if (row === null || typeof row !== 'object') return '{}';
  const fields: Field[] = [];
  // Ordinal key order, so the FIRST refused cell is the one every host names.
  for (const k of Object.keys(row).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const v = (row as Record<string, unknown>)[k];
    if (v === null || v === undefined) continue;
    fields.push([k, rowCell(v, i, k)]);
  }
  return jObject(fields);
};

const staticRowSeq = (v: readonly unknown[]): string => jArray(v.map(rowValue));

/**
 * Encode a row feed (the DataGrid / Chart `source` payload) to its canonical
 * bytes — the encoder a node's row slot takes. Throws `RowCellRefusedError`
 * on a refused cell (WIRE_FORMAT.md §5).
 */
export const encodeRows = (rows: readonly unknown[]): string => staticRowSeq(rows);

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

const pushCellFormatOptional = (fields: Field[], key: string, f: CellFormat): void => {
  if (f.kind !== 'None') fields.push([key, cellFormat(f)]);
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
  // Phase 861 — per-column sort narrowing; omitted when absent, so every
  // pre-861 column stays byte-identical.
  if (c.sortable !== undefined) fields.push(['sortable', bool(c.sortable)]);
  // Phase 863 — per-column editability narrowing.
  if (c.editable !== undefined) fields.push(['editable', bool(c.editable)]);
  return jObject(fields);
};

// Phase 801 / 861 — ONE encoder for the `{column, direction}` initial-order
// record, used by both the `staticRows` spelling and the bound-grid one. The
// two paths share the record by design ("reuse, do not mint twins"); sharing
// the encoder is what makes that true rather than merely intended.
const defaultSortJson = (d: DefaultSort): string =>
  jObject([
    ['column', intLit(d.column)],
    ['direction', str(d.direction)],
  ]);

const gridSpec = specEncoder('DataGrid');

/** An annotation's x address (Phase 1491, §4l). */
const chartAnnotationX = (a: ChartAnnotationX): string =>
  a.kind === 'Category'
    ? caseObj('Category', [['key', str(a.key)]])
    : caseObj('Date', [['iso', str(a.iso)]]);

/** A range band's pair (Phase 1492, §4l) — the case carries the AXIS. */
const chartAnnotationRange = (r: ChartAnnotationRange): string =>
  r.kind === 'ValueRange'
    ? caseObj('ValueRange', [
        ['from', num(r.from)],
        ['to', num(r.to)],
      ])
    : caseObj('XRange', [
        ['from', chartAnnotationX(r.from)],
        ['to', chartAnnotationX(r.to)],
      ]);

/** A chart's data-addressed annotation (Phase 1490, §4l). An absent label omits
 * its key; every label is carried unresolved, whichever arm it takes. */
const chartAnnotation = (a: ChartAnnotation): string => {
  const label: Field[] = a.label !== undefined ? [['label', textSource(a.label)]] : [];
  switch (a.kind) {
    case 'ReferenceLine':
      return caseObj('ReferenceLine', [['value', num(a.value)], ...label]);
    case 'EventMarker':
      return caseObj('EventMarker', [['at', chartAnnotationX(a.at)], ...label]);
    default:
      return caseObj('RangeBand', [['range', chartAnnotationRange(a.range)], ...label]);
  }
};

const chartSpec = specEncoder('Chart');

const mapMarker = (m: MapMarker): string =>
  jObject([
    ['label', textSource(m.label)],
    ['latitude', num(m.latitude)],
    ['longitude', num(m.longitude)],
  ]);

const mapSpec = specEncoder('Map');

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
    case 'Masonry': {
      // cols < gap
      const fields: Field[] = [['cols', intLit(l.cols)]];
      if (l.gap !== undefined) fields.push(['gap', intLit(l.gap)]);
      return caseObj('Masonry', fields);
    }
    case 'Auto':
      return caseObj('Auto', []);
    default:
      return assertNever(l);
  }
};

const boxSpec = specEncoder('Box');

const splitPanelSpec = specEncoder('SplitPanel');

const tabHeader = (h: TabHeader): string => {
  const fields: Field[] = [['label', textSource(h.label)]];
  if (h.icon !== undefined) fields.push(['icon', str(h.icon)]);
  if (h.disabled !== undefined) fields.push(['disabled', binding(h.disabled)]);
  return jObject(fields);
};

const tabsSpec = specEncoder('Tabs');

// `onSelect` is a closure → the `"<closure>"` sentinel (decodes to a no-op,
// re-encodes to the same sentinel; byte-stable) — same treatment as Tabs
// `onSelect` (Phase 126).
const stepperSpec = specEncoder('Stepper');

const summaryListSpec = specEncoder('SummaryList');

const disclosureSpec = specEncoder('Disclosure');

const modalSpec = specEncoder('Modal');

const scrollAreaSpec = specEncoder('ScrollArea');

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

// ─── Structural specs (the kinds with no primitive family) ────────────────────

const errorBoundarySpec = specEncoder('ErrorBoundary');
const fragmentDeclSpec = specEncoder('FragmentDecl');
const fragmentRefSpec = specEncoder('FragmentRef', {
  args: { enc: nonEmptyMap(fragmentArg as Enc) },
});
/** A `Mount`'s guest channel (Phase 1021). */
const guestChannel = recordEncoder('GuestChannel');
const mountSpec = specEncoder('Mount', {
  inputs: { enc: nonEmptyMap(fragmentArg as Enc) },
  // The guest's bubble handler is host-side only; the sentinel always rides (byte-stable since Phase 265).
  onBubble: { enc: () => CLOSURE },
});
/** A static read-only table's rows (Phase 393; sort intent Phase 801). */
const staticRows = recordEncoder('StaticRows');

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
      return hoistSpec('ErrorBoundary', errorBoundarySpec(k.spec));
    case 'Switch':
      // State-bound conditional child (Phase 392). Each case encodes as a
      // `{child,match}` object (keys sort child < match); the whole kind's keys
      // sort cases < default < stateKey. jObject sorts, so the listed order is
      // cosmetic.
      return caseObj('Switch', [
        // Phase 1122 — omitted when absent, so every pre-1122 switch stays
        // byte-identical.
        ...(k.spec.autoAdvanceMs !== undefined
          ? ([['autoAdvanceMs', num(k.spec.autoAdvanceMs)]] as const)
          : []),
        [
          'cases',
          jArray(
            // Phase 1535 — exactly one of `match` and `when` is present, so
            // exactly one is emitted. `jObject` sorts, so the pair's relative
            // order here is immaterial.
            k.spec.cases.map((c) =>
              jObject([
                ['child', node(c.child)],
                ...(c.match !== undefined ? ([['match', str(c.match)]] as const) : []),
                ...(c.when !== undefined ? ([['when', binding(c.when, bool)]] as const) : []),
              ]),
            ),
          ),
        ],
        ['default', node(k.spec.default)],
        // Phase 768 collapse rule — State(key, no default) keeps the compact
        // canonical `stateKey` spelling (existing fixtures stay byte-identical);
        // any other selector encodes as `on`.
        k.spec.on.kind === 'State' && k.spec.on.defaultValue === undefined
          ? ['stateKey', str(k.spec.on.key)]
          : ['on', binding(k.spec.on, str)],
      ]);
    case 'FragmentDecl':
      return hoistSpec('FragmentDecl', fragmentDeclSpec(k.spec));
    case 'FragmentRef':
      return hoistSpec('FragmentRef', fragmentRefSpec(k.spec));
    case 'Mount':
      return hoistSpec('Mount', mountSpec(k.spec));
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
  // Phase 1472 — `auto` is the identity and is omitted at it, so a document that
  // declares nothing is byte-identical to what it was before this member
  // existed.
  if (s.direction !== undefined && s.direction !== 'auto')
    fields.push(['direction', str(s.direction)]);
  return jObject(fields);
};

// Phase 2291 — the `PatchStyle` payload. Every member the delta SETS is
// emitted, a default token included: absence means "leave it", so omitting a
// default would change the edit (`semanticStyle`'s omit-when-default rule does
// not apply here). `jObject` sorts keys.
const styleDelta = (d: StyleDelta): string => {
  const fields: Field[] = [];
  if (d.direction !== undefined) fields.push(['direction', str(d.direction)]);
  if (d.emphasis !== undefined) fields.push(['emphasis', str(d.emphasis)]);
  if (d.role !== undefined) fields.push(['role', str(d.role)]);
  if (d.tone !== undefined) fields.push(['tone', str(d.tone)]);
  if (d.voice !== undefined) fields.push(['voice', str(d.voice)]);
  if (d.weight !== undefined) fields.push(['weight', str(d.weight)]);
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
  // Phase 1812 — `speak`, omitted when absent; a literal is the bare string.
  if (a.speak !== undefined) fields.push(['speak', textSource(a.speak)]);
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
  (s.voice === undefined || s.voice === 'Default') &&
  // Phase 1472 — `auto` is this member's identity, so a style that declares only
  // a direction is NOT all-default and the envelope must carry it.
  (s.direction === undefined || s.direction === 'auto');

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
  // Phase 1112 — the node-level tooltip trait, omitted when absent. `jObject`
  // sorts, so the emitted key order is the envelope's ordinal one whatever order
  // the pushes happen in.
  if (n.tooltip !== undefined) fields.push(['tooltip', textSource(n.tooltip)]);
  // Phase 1535 — the node-level visibility predicate, omitted when absent, so
  // every node authored before it stays byte-identical.
  if (n.visible !== undefined) fields.push(['visible', binding(n.visible, bool)]);
  // Phase 1812 — the author-declared `fallback`, a full node, omitted when
  // absent; `jObject` sorts it into its ordinal place (before `id`).
  if (n.fallback !== undefined) fields.push(['fallback', node(n.fallback)]);
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
    case 'PatchStyle':
      return caseObj('PatchStyle', [
        ['style', styleDelta(op.style)],
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
