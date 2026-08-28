// ============================================================================
//  @fuaran-ui/renderer-server/bindings — binding resolution + text / number /
//  cell formatting.
//
//  Verbatim copy of @fuaran-ui/renderer's bindings module (React-free, but only
//  reachable through the React barrel). Kept local so the server renderer carries
//  no React dependency. The server resolves bindings exactly as the client does:
//  `Static` bindings resolve to their value; `Query` / `Filter` / `Selection`
//  resolve from host-supplied sources or fall back; `State` resolves to its
//  default. Locale-aware `Intl` formatting matches the client.
// ============================================================================

import type {
  Binding,
  BindingContext,
  CapabilityInvoker,
  Cell,
  CellFormat,
  CellValue,
  DurationStyle,
  DurationUnit,
  Format,
  JsonValue,
  RelativeTimeUnit,
  Table,
  TextSource,
} from '@fuaran-ui/schema';
import {
  evalPipelineWith,
  evalPipelineWithInEnv,
  stepParams,
  liveValueToTable,
  type SourceResolver,
} from '@fuaran-ui/ops';

/**
 * Coerce a resolved scalar to a `Cell` for a `Transform` param env (Phase 424).
 * Every numeric arm yields `Float` (JS int/float are indistinguishable, keeping
 * it cross-host-deterministic with the F# resolver). Non-scalar → `undefined`.
 */
const objToCell = (v: unknown): Cell | undefined => {
  if (typeof v === 'string') return { kind: 'Str', value: v };
  if (typeof v === 'boolean') return { kind: 'Bool', value: v };
  if (typeof v === 'number') return { kind: 'Float', value: v };
  if (v === null) return { kind: 'Null' };
  return undefined;
};

/** Data sources the renderer consults when it encounters a binding. */
export interface BindingSources {
  readonly queryResults?: Readonly<Record<string, unknown>>;
  readonly state?: Readonly<Record<string, unknown>>;
  readonly filters?: Readonly<Record<string, unknown>>;
  readonly selections?: Readonly<Record<string, unknown>>;
  /**
   * The current instant the host furnishes for `Binding.Now` (Phase 765), as an
   * ISO-8601 UTC string. Absent/empty resolves NotResolved — loud by design.
   */
  readonly now?: string;
  readonly computedContext?: BindingContext;
  readonly i18n?: Readonly<Record<string, string>>;
  readonly i18nResolver?: (key: string, args?: Readonly<Record<string, unknown>>) => string;
  readonly locale?: string;
  /** Phase 282 — named tables a `Binding.Transform` Ref / Join / Union resolves against. */
  readonly transformRefs?: Readonly<Record<string, Table>>;
  /**
   * Phase 283/284 — the host capability-dispatch seam (SSR twin of the client
   * renderer's). A server-placed capability (`Server` / `BuildTime` placement)
   * can resolve to `Ready` at SSR time → rendered; an absent seam (or a
   * client-placed capability) behaves as `Pending` → the node's `onLoading`. The
   * `Action.Invoke` effect side falls back to client hydration (the resume
   * disposition), mirroring the F# `Resume.disposition` Invoke → Fallback.
   */
  readonly capabilityInvoker?: CapabilityInvoker;
}

export const emptySources: BindingSources = {};

/** Build a `BindingContext` over a module-state bag. */
export const makeBindingContext = (state: Readonly<Record<string, unknown>>): BindingContext => ({
  state,
  tryGetState<T>(key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(state, key) ? (state[key] as T) : undefined;
  },
});

/** The not-provided sentinel `Binding.Query` name (mirrors @fuaran-ui/schema). */
const NOT_PROVIDED_SENTINEL = '__fuaran_not_provided__';

export type Resolution<T> =
  | { readonly kind: 'Resolved'; readonly value: T }
  | { readonly kind: 'NotResolved' }
  | { readonly kind: 'Errored'; readonly message: string }
  | { readonly kind: 'I18nUnresolved'; readonly key: string };

const defaultI18nResolver = (key: string): string => `[i18n:${key}]`;

/** Resolve a typed `Binding<T>` against the supplied sources. */
export const resolve = <T>(sources: BindingSources, binding: Binding<T>): Resolution<T> => {
  switch (binding.kind) {
    case 'Static':
      return { kind: 'Resolved', value: binding.value };
    case 'Query': {
      if (binding.name === NOT_PROVIDED_SENTINEL) return { kind: 'NotResolved' };
      const raw = sources.queryResults?.[binding.name];
      if (raw === undefined) return { kind: 'NotResolved' };
      try {
        return { kind: 'Resolved', value: binding.accessor(raw) };
      } catch (ex) {
        return { kind: 'Errored', message: `Query '${binding.name}' accessor threw: ${msg(ex)}` };
      }
    }
    case 'Filter': {
      const raw = sources.filters?.[binding.name];
      if (raw === undefined) {
        // 0.2.0 — the pre-selected-filter gap: an unwritten filter key
        // resolves to the binding's declared default.
        if (binding.defaultValue !== undefined)
          return { kind: 'Resolved', value: binding.defaultValue as T };
        return { kind: 'NotResolved' };
      }
      return { kind: 'Resolved', value: raw as T };
    }
    case 'Selection': {
      const raw = sources.selections?.[binding.nodeId];
      if (raw === undefined) {
        // 0.2.9 (Phase 629) — the pre-selected-row gap: an unwritten selection
        // resolves to the binding's declared default until the first real
        // selection (parity-locked with the client renderer).
        if (binding.defaultValue !== undefined)
          return { kind: 'Resolved', value: binding.defaultValue };
        return { kind: 'NotResolved' };
      }
      try {
        return { kind: 'Resolved', value: binding.accessor(raw) };
      } catch (ex) {
        return { kind: 'Errored', message: `Selection accessor threw: ${msg(ex)}` };
      }
    }
    case 'State': {
      const raw = sources.state?.[binding.key];
      if (raw === undefined) return { kind: 'Resolved', value: binding.defaultValue };
      return { kind: 'Resolved', value: raw as T };
    }
    case 'Now': {
      // Phase 765 — host-furnished, resolved once per render pass; never a
      // clock read here, so SSR output is reproducible for a pinned instant.
      if (sources.now === undefined || sources.now === '') return { kind: 'NotResolved' };
      return { kind: 'Resolved', value: binding.project(sources.now) };
    }
    case 'Computed': {
      const merged = { ...(sources.computedContext?.state ?? {}), ...(sources.state ?? {}) };
      const ctx = makeBindingContext(merged);
      try {
        return { kind: 'Resolved', value: binding.compute(ctx) };
      } catch (ex) {
        return { kind: 'Errored', message: `Computed binding threw: ${msg(ex)}` };
      }
    }
    case 'Local':
      return resolve<T>(sources, binding.local.initialFrom);
    case 'I18n': {
      const resolver = sources.i18nResolver ?? defaultI18nResolver;
      const resolved = resolver(binding.key);
      if (resolved === `[i18n:${binding.key}]`) return { kind: 'I18nUnresolved', key: binding.key };
      return { kind: 'Resolved', value: resolved as T };
    }
    case 'Format': {
      const inner = resolve<number>(sources, binding.source);
      if (inner.kind !== 'Resolved') return inner as Resolution<T>;
      const tag = binding.locale.kind === 'Explicit' ? binding.locale.tag : (sources.locale ?? '');
      return { kind: 'Resolved', value: formatLocaleValue(tag, binding.format, inner.value) as T };
    }
    case 'Transform': {
      // Phase 282 — evaluate the dataframe pipeline as data (matches the
      // client). The param/prune/eval machinery lives in `evalTransformFrame`
      // (extracted for Phase 632, shared with the scalar path); a SCALAR slot
      // resolves through `resolveScalarWith` instead — parity-locked with the
      // client renderer's Transform arm.
      const frame = evalTransformFrame(sources, binding);
      if (!frame.ok) return { kind: 'Errored', message: frame.error };
      return { kind: 'Resolved', value: tableToRows(frame.value) as T };
    }
    case 'Invoke': {
      // Phase 283/284 — dispatch a host-registered capability for a value. Maps
      // the `Deferred` onto the resolution surface exactly as the client
      // renderer does: `Pending` → `NotResolved` (onLoading), `Ready` →
      // `Resolved`, `Error` → `Errored` (onError). An absent invoker behaves as
      // `Pending`, so SSR renders the loading state for a client-placed
      // capability.
      const invoker = sources.capabilityInvoker;
      if (invoker === undefined) return { kind: 'NotResolved' };
      const deferred = invoker(binding.capabilityId, binding.args);
      switch (deferred.kind) {
        case 'Pending':
          return { kind: 'NotResolved' };
        case 'Error':
          return { kind: 'Errored', message: deferred.message };
        case 'Ready':
          return { kind: 'Resolved', value: deferred.value as T };
      }
    }
  }
};

/**
 * The shared Transform evaluation (Phase 282/424 machinery, extracted in Phase
 * 632 so the rows path and the scalar path evaluate identically) — the twin of
 * the client renderer's `evalTransformFrame`.
 */
const evalTransformFrame = (
  sources: BindingSources,
  binding: Extract<Binding<unknown>, { kind: 'Transform' }>,
):
  | { readonly ok: true; readonly value: Table }
  | { readonly ok: false; readonly error: string } => {
  const refs = sources.transformRefs ?? {};
  const resolveRef: SourceResolver = (name) => {
    const t = refs[name];
    return t !== undefined
      ? { ok: true, value: t }
      : { ok: false, error: { kind: 'UnresolvedSource', ref: name } };
  };
  // Phase 818 — a LIVE source resolves its preserved binding against the
  // stores and evaluates over the CURRENT data (row-major store values
  // transpose through the same 815 normalisation the decode-time snapshot
  // used); an unwritten store falls back to the decode-time `initial`, which
  // is what keeps SSR byte-identical to the snapshot era. Non-tabular live
  // values error loudly, never silently.
  let inputTable: Table | undefined;
  if (binding.source.kind === 'Live') {
    const live = binding.source;
    const r = resolve<JsonValue>(sources, live.binding);
    // Phase 1085 — an ABSENT resolved value is the initial snapshot, not an
    // error. A `State` binding with no `defaultValue` on a slot nothing has
    // seeded or written resolves to `undefined` rather than to `NotResolved`,
    // so without this the bare wire spelling `{"$type":"State","key":k}` — the
    // one this phase makes decodable, and the one FUARAN106's own remedy tells
    // an author to write — would refuse where `"defaultValue": []` renders the
    // empty table. Two spellings of "I read this key and carry no data of my
    // own" must resolve alike. Deliberately the quiet arm: FUARAN105 is the
    // pre-emit warning that names the resulting zero, where it can name the key
    // and the remedy, which a bare `undefined` at render time cannot.
    const resolvedAbsent = r.kind === 'Resolved' && (r.value === undefined || r.value === null);
    if (r.kind === 'NotResolved' || resolvedAbsent) {
      if (live.initial.kind !== 'Embedded') {
        return {
          ok: false,
          error: `Transform live source initial snapshot is a non-host-resolved 'ref' ('${live.initial.name}')`,
        };
      }
      inputTable = live.initial.table;
    } else if (r.kind === 'Resolved') {
      const t = liveValueToTable(r.value);
      if (!t.ok) return { ok: false, error: `Transform live source: ${t.error}` };
      inputTable = t.value;
    } else if (r.kind === 'Errored') {
      return { ok: false, error: `Transform live source errored: ${r.message}` };
    } else {
      return { ok: false, error: `Transform live source is an unresolved i18n key '${r.key}'` };
    }
  } else {
    const ds = binding.source.source;
    inputTable = ds.kind === 'Embedded' ? ds.table : refs[ds.name];
    if (inputTable === undefined) {
      const refName = ds.kind === 'Ref' ? ds.name : '';
      return { ok: false, error: `Transform source ref '${refName}' not provided` };
    }
  }
  const params = binding.params ?? [];
  const env: Record<string, Cell> = {};
  const unbound = new Set<string>();
  for (const p of params) {
    const r = resolve<unknown>(sources, p.from);
    if (r.kind === 'Resolved') {
      const cell = objToCell(r.value);
      if (cell === undefined)
        return { ok: false, error: `Transform param '${p.name}' resolved to a non-scalar value` };
      env[p.name] = cell;
    } else if (r.kind === 'NotResolved') {
      unbound.add(p.name);
    } else if (r.kind === 'Errored') {
      return { ok: false, error: `Transform param '${p.name}' source errored: ${r.message}` };
    } else {
      return {
        ok: false,
        error: `Transform param '${p.name}' source is an unresolved i18n key '${r.key}'`,
      };
    }
  }
  const pipeline = binding.pipeline.filter(
    (step) => step.kind !== 'filter' || stepParams(step).every((pn) => !unbound.has(pn)),
  );
  const out =
    params.length > 0
      ? evalPipelineWithInEnv(resolveRef, env, pipeline, inputTable)
      : evalPipelineWith(resolveRef, pipeline, inputTable);
  if (!out.ok) return { ok: false, error: `Transform evaluation failed: ${out.error.kind}` };
  return { ok: true, value: out.value };
};

/** Project an evaluated columnar `Table` into plain row objects (`Null` ⇒ `null`). */
export const tableToRows = (t: Table): Record<string, unknown>[] => {
  const n = t.columns.length > 0 ? t.columns[0]!.cells.length : 0;
  const cellToJs = (c: Cell): unknown => {
    switch (c.kind) {
      case 'Int':
      case 'Float':
        return c.value;
      case 'Bool':
        return c.value;
      case 'Str':
      case 'Date':
      case 'Timestamp':
        return c.value;
      case 'Null':
        return null;
    }
  };
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i += 1) {
    const row: Record<string, unknown> = {};
    for (const col of t.columns) row[col.name] = cellToJs(col.cells[i]!);
    rows.push(row);
  }
  return rows;
};

// ─── Locale-aware formatting ──────────────────────────────────────────────────

const dateStyleLower = (s: string): Intl.DateTimeFormatOptions['dateStyle'] =>
  s.toLowerCase() as Intl.DateTimeFormatOptions['dateStyle'];

const relUnitLower = (u: string): Intl.RelativeTimeFormatUnit =>
  u.toLowerCase() as Intl.RelativeTimeFormatUnit;

// ─── Duration / relative-time rendering (Phase 819) ──────────────────────────
//
// Mirrors the F# `Formatting.formatDuration` / `formatRelativeEnglish` exactly
// (shared hand-rolled implementations — a duration is deliberately
// LOCALE-INDEPENDENT, and the cell vocabulary has no locale dimension, so the
// English relative form IS the canonical cell rendering). Rounding is
// half-to-even, matching .NET `round`.

const roundHalfEven = (v: number): number => {
  const f = Math.floor(v);
  const diff = v - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
};

const durationUnitSeconds = (u: DurationUnit): number =>
  u === 'Seconds' ? 1 : u === 'Minutes' ? 60 : 3600;

/** Render `value` (a signed count of `unit`s) per the bounded `DurationStyle`. */
export const formatDuration = (unit: DurationUnit, style: DurationStyle, value: number): string => {
  const totalSeconds = value * durationUnitSeconds(unit);
  const total = roundHalfEven(Math.abs(totalSeconds));
  const sign = totalSeconds < 0 && total > 0 ? '-' : '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  let body: string;
  switch (style) {
    case 'Compact':
      // Largest two grains, zero tails omitted: "1h 20m" / "2h" / "5m 30s" /
      // "42s"; zero -> "0s".
      if (hours >= 1) body = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
      else if (minutes >= 1) body = seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
      else body = `${seconds}s`;
      break;
    case 'Clock':
      // "h:mm:ss" from one hour up, "m:ss" below it.
      body =
        hours >= 1
          ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
          : `${minutes}:${String(seconds).padStart(2, '0')}`;
      break;
    case 'Long': {
      // English words, singular/plural, zero components omitted; zero -> "0 minutes".
      const part = (n: number, word: string): string | undefined =>
        n === 0 ? undefined : n === 1 ? `1 ${word}` : `${n} ${word}s`;
      const parts = [part(hours, 'hour'), part(minutes, 'minute'), part(seconds, 'second')].filter(
        (p): p is string => p !== undefined,
      );
      body = parts.length === 0 ? '0 minutes' : parts.join(' ');
      break;
    }
  }
  return sign + body;
};

/**
 * English relative-time rendering over a signed count of `unit` — "in 2 hours"
 * / "3 minutes ago" / "this minute" (Phase 819).
 */
export const formatRelativeEnglish = (unit: RelativeTimeUnit, value: number): string => {
  const n = roundHalfEven(value);
  const unitWord = unit.toLowerCase();
  if (n === 0) return `this ${unitWord}`;
  const magnitude = Math.abs(n);
  const plural = magnitude === 1 ? unitWord : `${unitWord}s`;
  return n < 0 ? `${magnitude} ${plural} ago` : `in ${magnitude} ${plural}`;
};

/** Format a numeric value per a bounded `Format` intent + BCP-47 locale tag. */
export const formatLocaleValue = (localeTag: string, fmt: Format, value: number): string => {
  const loc = localeTag === '' ? undefined : localeTag;
  switch (fmt.kind) {
    case 'Number': {
      const opts: Intl.NumberFormatOptions =
        fmt.decimals !== undefined
          ? { minimumFractionDigits: fmt.decimals, maximumFractionDigits: fmt.decimals }
          : {};
      return new Intl.NumberFormat(loc, opts).format(value);
    }
    case 'Currency':
      return new Intl.NumberFormat(loc, { style: 'currency', currency: fmt.isoCode }).format(value);
    case 'Percent': {
      const opts: Intl.NumberFormatOptions =
        fmt.decimals !== undefined
          ? {
              style: 'percent',
              minimumFractionDigits: fmt.decimals,
              maximumFractionDigits: fmt.decimals,
            }
          : { style: 'percent' };
      return new Intl.NumberFormat(loc, opts).format(value);
    }
    case 'Date':
      return new Intl.DateTimeFormat(loc, { dateStyle: dateStyleLower(fmt.dateStyle) }).format(
        new Date(value * 1000),
      );
    case 'RelativeTime':
      return new Intl.RelativeTimeFormat(loc, { numeric: 'auto' }).format(
        value,
        relUnitLower(fmt.unit),
      );
    case 'Duration':
      // Phase 819 — locale-independent by design (see formatDuration above):
      // the one Format case with exact cross-host parity.
      return formatDuration(fmt.unit, fmt.style, value);
  }
};

/** Best-effort resolve — returns the value for `Resolved`, otherwise `undefined`. */
export const tryResolve = <T>(sources: BindingSources, binding: Binding<T>): T | undefined => {
  const r = resolve(sources, binding);
  return r.kind === 'Resolved' ? r.value : undefined;
};

// ─── Scalar-slot resolution (Phase 632) — twin of the client renderer ─────────
//
// A `Binding.Transform` in a SCALAR slot (a `TextSource.Bound`, a Metric /
// LabelValueRow value) resolves to the lone cell of an exactly-1×1 pipeline
// result; >1 row/col is a loud didactic, an empty result renders absence
// except a trailing global single-`count` groupBy which resolves 0. See the
// client renderer's section note for the full law statement.

type CellCoerce<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** Coerce a result cell to a text-slot string (invariant number formatting). */
export const cellToText = (c: Cell): CellCoerce<string> => {
  switch (c.kind) {
    case 'Str':
    case 'Date':
    case 'Timestamp':
      return { ok: true, value: c.value };
    case 'Int':
    case 'Float':
      return { ok: true, value: String(c.value) };
    case 'Bool':
      return { ok: true, value: c.value ? 'true' : 'false' };
    case 'Null':
      return { ok: false, error: 'Transform yielded a null cell in a text slot' };
  }
};

/** Coerce a result cell to a numeric-slot number. */
export const cellToFloat = (c: Cell): CellCoerce<number> => {
  switch (c.kind) {
    case 'Int':
    case 'Float':
      return { ok: true, value: c.value };
    case 'Str':
      return {
        ok: false,
        error: `Transform yielded a text cell ('${c.value}') in a numeric slot — project a numeric column, or aggregate with count / sum / mean`,
      };
    case 'Bool':
      return { ok: false, error: 'Transform yielded a bool cell in a numeric slot' };
    case 'Date':
    case 'Timestamp':
      return {
        ok: false,
        error: `Transform yielded a date cell ('${c.value}') in a numeric slot — project a numeric column, or aggregate with count / sum / mean`,
      };
    case 'Null':
      return { ok: false, error: 'Transform yielded a null cell in a numeric slot' };
  }
};

/** Resolve a binding in a SCALAR slot — twin of the client's `resolveScalarWith`. */
export const resolveScalarWith = <T>(
  coerceCell: (c: Cell) => CellCoerce<T>,
  sources: BindingSources,
  binding: Binding<T>,
): Resolution<T> => {
  if (binding.kind !== 'Transform') return resolve<T>(sources, binding);
  const frame = evalTransformFrame(sources, binding);
  if (!frame.ok) return { kind: 'Errored', message: frame.error };
  const result = frame.value;
  const colCount = result.columns.length;
  const rowCount = colCount > 0 ? result.columns[0]!.cells.length : 0;
  if (rowCount === 1 && colCount === 1) {
    const cell = result.columns[0]!.cells[0]!;
    if (cell.kind === 'Null') return { kind: 'NotResolved' };
    const v = coerceCell(cell);
    return v.ok ? { kind: 'Resolved', value: v.value } : { kind: 'Errored', message: v.error };
  }
  if (rowCount === 0) {
    // The count of nothing is 0 (the trailing global single-`count` law).
    const last = binding.pipeline[binding.pipeline.length - 1];
    if (
      last !== undefined &&
      last.kind === 'groupBy' &&
      last.keys.length === 0 &&
      last.aggs.length === 1 &&
      last.aggs[0]!.fn === 'count'
    ) {
      const v = coerceCell({ kind: 'Int', value: 0 });
      return v.ok ? { kind: 'Resolved', value: v.value } : { kind: 'Errored', message: v.error };
    }
    return { kind: 'NotResolved' };
  }
  return {
    kind: 'Errored',
    message: `Transform in a scalar slot must yield exactly one row × one column (got ${rowCount}×${colCount}) — end the pipeline with \`project\` to one column + \`limit\` 1 (a row-field lookup), or aggregate with \`groupBy\` keys [] + one agg (count / sum / mean / first)`,
  };
};

/** Scalar-slot resolution for a text slot (`TextSource.Bound` and friends). */
export const resolveScalarText = (
  sources: BindingSources,
  binding: Binding<string>,
): Resolution<string> => resolveScalarWith(cellToText, sources, binding);

/** Scalar-slot resolution for a numeric slot (Metric / LabelValueRow values). */
export const resolveScalarFloat = (
  sources: BindingSources,
  binding: Binding<number>,
): Resolution<number> => resolveScalarWith(cellToFloat, sources, binding);

/** Best-effort scalar text resolution — the `tryResolve` twin for text slots. */
export const tryResolveScalarText = (
  sources: BindingSources,
  binding: Binding<string>,
): string | undefined => {
  const r = resolveScalarText(sources, binding);
  return r.kind === 'Resolved' ? r.value : undefined;
};

/** Best-effort scalar float resolution — the `tryResolve` twin for numeric slots. */
export const tryResolveScalarFloat = (
  sources: BindingSources,
  binding: Binding<number>,
): number | undefined => {
  const r = resolveScalarFloat(sources, binding);
  return r.kind === 'Resolved' ? r.value : undefined;
};

/** Defensive array coercion — anything that is not a real array becomes empty. */
export const asArray = <T>(value: unknown): readonly T[] =>
  Array.isArray(value) ? (value as readonly T[]) : [];

const msg = (ex: unknown): string => (ex instanceof Error ? ex.message : String(ex));

// ─── Text-source rendering ───────────────────────────────────────────────────

/** Render a `TextSource` to a plain string against the supplied sources. */
export const renderText = (sources: BindingSources, text: TextSource): string => {
  switch (text.kind) {
    case 'Literal':
      return text.value;
    case 'Bound':
      // Phase 632 — text slots resolve through the scalar path, so a
      // `Binding.Transform` yields its 1×1 result cell (never the rows list).
      return tryResolveScalarText(sources, text.binding) ?? '';
    case 'I18n': {
      const template = sources.i18n?.[text.key];
      if (template === undefined) return `[i18n:${text.key}]`;
      let acc = template;
      for (const [k, v] of Object.entries(text.args)) {
        acc = acc.split(`{${k}}`).join(jsonToString(v));
      }
      return acc;
    }
  }
};

const jsonToString = (v: JsonValue): string => {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
};

// ─── Number / cell formatting ─────────────────────────────────────────────────

/** Format a numeric value per a `CellFormat`. */
export const formatNumber = (format: CellFormat, value: number): string => {
  switch (format.kind) {
    case 'None':
      return numToString(value);
    case 'Number':
      if (format.decimals !== undefined) return value.toFixed(format.decimals);
      return Number.isInteger(value) ? value.toFixed(0) : numToString(value);
    case 'Currency':
      return `${format.code} ${value.toFixed(2)}`;
    case 'Percent':
      if (format.decimals !== undefined) return `${(value * 100).toFixed(format.decimals)}%`;
      return `${(value * 100).toFixed(1)}%`;
    case 'SignificantDigits':
      return Number(value.toPrecision(format.digits)).toString();
    case 'Date':
      return numToString(value);
    case 'Duration':
      return formatDuration(format.unit, format.style, value);
    case 'RelativeTime':
      return formatRelativeEnglish(format.unit, value);
    case 'Custom':
      return format.format({ kind: 'Numeric', value });
  }
};

const numToString = (value: number): string => String(value);

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Format a `CellValue` per its `CellFormat` (used by Grid cells). */
export const renderCellValue = (format: CellFormat, value: CellValue): string => {
  if (format.kind === 'Custom') return format.format(value);
  switch (value.kind) {
    case 'Numeric':
      return formatNumber(format, value.value);
    case 'Text':
      return value.value;
    case 'Bool':
      return value.value ? 'true' : 'false';
    case 'Date': {
      const d = value.value;
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }
    case 'Empty':
      return '';
  }
};
