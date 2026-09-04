// ============================================================================
//  @fuaran-ui/renderer/bindings — binding resolution + text / number / cell
//  formatting. Port of the F# reference renderer's BindingResolver module
//  plus the renderText / formatNumber / renderCellValue helpers from Render.fs.
//
//  Authors write `binding.query('totalRevenue', (r) => r.amount)`; the renderer
//  must produce a current value to feed a KPI. The typed surface lives here;
//  the data sources (query result cache, state store, filter / selection
//  registries) are supplied by the host via `BindingSources`.
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
  CaptureSource,
  RelativeTimeUnit,
  Table,
  TextSource,
  TrackEntry,
  TrackKind,
  TreeItem,
} from '@fuaran-ui/schema';
import {
  evalPipelineWith,
  evalPipelineWithInEnv,
  liveValueToTable,
  stepParams,
  substituteListParams,
  type SourceResolver,
} from '@fuaran-ui/ops';

/**
 * Coerce a resolved scalar to a `Cell` for a `Transform` param env (Phase 424). Every numeric arm
 * yields `Float` (JS int/float are indistinguishable, keeping it cross-host-deterministic with the F#
 * resolver; DataFrame comparison treats `Int`/`Float` as numbers). Non-scalar → `undefined` (error).
 */
const objToCell = (v: unknown): Cell | undefined => {
  if (typeof v === 'string') return { kind: 'Str', value: v };
  if (typeof v === 'boolean') return { kind: 'Bool', value: v };
  if (typeof v === 'number') return { kind: 'Float', value: v };
  if (v === null) return { kind: 'Null' };
  return undefined;
};

/**
 * Coerce a resolved LIST to a `Cell[]` for a `Transform` LIST param (Phase 610) — a
 * multi-select chip's selection. Element coercion is `objToCell`'s, so a list scalar and a
 * scalar param cannot disagree about what a value means. A non-array, or an array holding a
 * non-scalar item, is `undefined` and stays the loud "non-scalar value" error.
 */
const objToCells = (v: unknown): Cell[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const cells: Cell[] = [];
  for (const item of v) {
    const c = objToCell(item);
    if (c === undefined) return undefined;
    cells.push(c);
  }
  return cells;
};

/**
 * Data sources the renderer consults when it encounters a binding. Every field
 * is optional; an omitted field behaves as the empty source. Mirrors the F#
 * `BindingResolver.BindingSources` record. The host passes this via the
 * `<FuaranRenderer sources={...}>` prop; the default is `{}` (everything empty),
 * so a tree of `Binding.Static` values renders with no host plumbing.
 */
export interface BindingSources {
  readonly queryResults?: Readonly<Record<string, unknown>>;
  readonly state?: Readonly<Record<string, unknown>>;
  readonly filters?: Readonly<Record<string, unknown>>;
  readonly selections?: Readonly<Record<string, unknown>>;
  /**
   * The current instant the host furnishes for `Binding.Now` (Phase 765), as an
   * ISO-8601 UTC string. Resolve it ONCE per render pass; absent/empty resolves
   * NotResolved — deliberately loud, so a host that forgets to supply the clock
   * shows a placeholder rather than a plausible wrong date.
   */
  readonly now?: string;
  /**
   * Phase 137: a seed `BindingContext` for `Binding.Computed`. The resolver
   * always projects the live `state` bag (above) into the context it hands the
   * closure, so a `Computed` closure reads state via `ctx.tryGetState(key)` with
   * no extra wiring. This field lets a host inject *additional* keys not in
   * `state`; live `state` wins on a key clash.
   */
  readonly computedContext?: BindingContext;
  /** i18n catalog: keys → localised template strings (used by `TextSource.I18n`). */
  readonly i18n?: Readonly<Record<string, string>>;
  /** `Binding.I18n` resolver. Default returns the `[i18n:<key>]` debug placeholder. */
  readonly i18nResolver?: (key: string, args?: Readonly<Record<string, unknown>>) => string;
  /**
   * Phase 102: ambient locale (BCP-47 tag) for `Binding.Format` whose
   * `LocaleSource` is `Ambient`. Omitted (the default) means "use the runtime
   * default locale" (`Intl` with `undefined`). `LocaleSource.Explicit` pins its
   * own tag and ignores this.
   */
  readonly locale?: string;
  /**
   * Phase 282 — named columnar tables a `Binding.Transform` can reference as its
   * `source` (a `DataSource.Ref`) or in a `Join` / `Union` step. Keyed by ref
   * name. Omitted (the default) means embedded-only pipelines; a `Ref` to an
   * unknown name resolves to an `Errored` (the evaluator's `UnresolvedSource`).
   */
  readonly transformRefs?: Readonly<Record<string, Table>>;
  /**
   * Phase 283/284 — the host capability-dispatch seam. Given a `Binding.Invoke`'s
   * `capabilityId` + scalar `(addr, value)` args, returns the current `Deferred`
   * resolution of the invocation. The renderer maps `Pending` → `NotResolved`
   * (the node's `onLoading`), `Ready` → `Resolved`, `Error` → `Errored` (its
   * `onError`). Omitted (the default) behaves as `Pending`, so an `Invoke`
   * binding renders its loading state until a host wires real dispatch. A host
   * builds one from a capability registry + a host body via
   * `@fuaran-ui/ui`'s `makeCapabilityInvoker`. Mirrors the F#
   * `BindingResolver.BindingSources.CapabilityInvoker`.
   */
  readonly capabilityInvoker?: CapabilityInvoker;
}

export const emptySources: BindingSources = {};

/**
 * Build a `BindingContext` over a module-state bag (Phase 137). The `tryGetState`
 * accessor returns the stored value cast to `T`, or `undefined` for a missing
 * key — never throws, so a `Binding.Computed` closure stays total.
 */
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
        // resolves to the binding's declared default (the projected scalar,
        // not a row) until the user first selects a row on `nodeId`.
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
      // Phase 765 — the clock is never read here: `sources.now` was resolved
      // host-side once for the whole pass, which is what keeps replay exact.
      if (sources.now === undefined || sources.now === '') return { kind: 'NotResolved' };
      return { kind: 'Resolved', value: binding.project(sources.now) };
    }
    case 'Computed': {
      // Phase 137: hand the closure a context with typed read access to the
      // live state bag. `sources.state` is authoritative (the same map `State`
      // resolves against); any keys injected via `computedContext` are merged
      // underneath, live state winning on a clash.
      const merged = { ...(sources.computedContext?.state ?? {}), ...(sources.state ?? {}) };
      const ctx = makeBindingContext(merged);
      try {
        return { kind: 'Resolved', value: binding.compute(ctx) };
      } catch (ex) {
        return { kind: 'Errored', message: `Computed binding threw: ${msg(ex)}` };
      }
    }
    case 'Local':
      // A `Binding.Local` resolves (for pure reads) to its initial-source
      // value; the per-field local buffer overlays it at the form layer.
      return resolve<T>(sources, binding.local.initialFrom);
    case 'I18n': {
      const resolver = sources.i18nResolver ?? defaultI18nResolver;
      const resolved = resolver(binding.key);
      if (resolved === `[i18n:${binding.key}]`) return { kind: 'I18nUnresolved', key: binding.key };
      return { kind: 'Resolved', value: resolved as T };
    }
    case 'Format': {
      // Phase 102: resolve the numeric source, then project to a localised
      // string via the browser Intl APIs. Constrained to Binding<string> use.
      const inner = resolve<number>(sources, binding.source);
      if (inner.kind !== 'Resolved') return inner as Resolution<T>;
      const tag = binding.locale.kind === 'Explicit' ? binding.locale.tag : (sources.locale ?? '');
      return { kind: 'Resolved', value: formatLocaleValue(tag, binding.format, inner.value) as T };
    }
    case 'Transform': {
      // Phase 282 — evaluate the dataframe pipeline client-side as data and
      // resolve to the transformed rows (plain row objects the data-bearing node
      // consumes). Embedded source is inline; a `Ref` (and Join/Union refs) come
      // from `sources.transformRefs`. The param/prune/eval machinery lives in
      // `evalTransformFrame` (extracted for Phase 632, shared with the scalar
      // path); a SCALAR slot (TextSource, Metric/LabelValueRow values) resolves
      // through `resolveScalarWith` instead.
      const frame = evalTransformFrame(sources, binding);
      if (!frame.ok) return { kind: 'Errored', message: frame.error };
      return { kind: 'Resolved', value: tableToRows(frame.value) as T };
    }
    case 'Invoke': {
      // Phase 283/284 — dispatch a host-registered capability for a value. The
      // host invoker resolves (capabilityId, args) to a `Deferred`; map
      // `Pending` → `NotResolved` (the node's `onLoading`), `Ready` → `Resolved`,
      // `Error` → `Errored` (its `onError`) — reusing the `StateBehaviour`
      // surface, no new node. An absent invoker behaves as `Pending`, so the
      // binding shows its loading state until a host wires real dispatch.
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
 * 632 so the rows path and the scalar path evaluate identically): resolve each
 * param's scalar `from` binding to a `Cell` and build the evaluation env; a
 * param whose source is `NotResolved` (an unset choice filter) is *unbound* —
 * every `filter` step referencing an unbound param is PRUNED (the one lenient
 * "unset filter ⇒ no constraint" rule — the evaluator stays strict), while a
 * *non-filter* step referencing an unbound param surfaces `UnboundParam`
 * loudly (never silent). A non-scalar / `Errored` param source, a missing
 * `Ref` source, and an evaluator error are all errors.
 *
 * Phase 610 — a param source that resolves to a LIST (a multi-select chip's
 * selection) is a LIST param. It never enters the scalar env: it resolves by
 * SUBSTITUTION through `substituteListParams` (`inParam` → the literal `in`
 * form) before the prune, which is how `fuaran-core#91` specifies a list param
 * rather than as a second evaluation env. An EMPTY selection is UNBOUND rather
 * than `items: []`: "nothing selected" is the absence of a constraint, not a
 * constraint no row satisfies — the same lenient rule an unset scalar chip
 * already gets, so deselecting everything shows the unfiltered table rather
 * than an empty one. A list bound to a name the pipeline reads as a scalar
 * `param` (or a scalar bound to one it reads as `in`/`param`) substitutes
 * nothing and reaches the evaluator's strict `UnboundParam` — loud, never a
 * silent wrong scoping.
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
  // is what keeps output byte-identical to the snapshot era. Non-tabular live
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
  const listEnv: Record<string, readonly Cell[]> = {};
  let hasListParam = false;
  const unbound = new Set<string>();
  for (const p of params) {
    const r = resolve<unknown>(sources, p.from);
    if (r.kind === 'Resolved') {
      const cell = objToCell(r.value);
      if (cell !== undefined) {
        env[p.name] = cell;
        continue;
      }
      const cells = objToCells(r.value);
      if (cells === undefined)
        return { ok: false, error: `Transform param '${p.name}' resolved to a non-scalar value` };
      // The empty selection is UNBOUND, not an empty membership set (see above).
      if (cells.length === 0) {
        unbound.add(p.name);
      } else {
        listEnv[p.name] = cells;
        hasListParam = true;
      }
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
  // Bound LIST params substitute BEFORE the prune: a substituted step names no param at
  // all, while an unbound one still names its own, so the one `stepParams` prune below
  // covers both param kinds with no second rule.
  const substituted = hasListParam
    ? substituteListParams(listEnv, binding.pipeline)
    : binding.pipeline;
  const pipeline = substituted.filter(
    (step) => step.kind !== 'filter' || stepParams(step).every((pn) => !unbound.has(pn)),
  );
  const out =
    params.length > 0
      ? evalPipelineWithInEnv(resolveRef, env, pipeline, inputTable)
      : evalPipelineWith(resolveRef, pipeline, inputTable);
  if (!out.ok) return { ok: false, error: `Transform evaluation failed: ${out.error.kind}` };
  return { ok: true, value: out.value };
};

/**
 * Project an evaluated columnar `Table` into plain row objects (one per row,
 * `{ [columnName]: jsValue }`) — the shape a data-bearing node's source slot
 * consumes. A `Null` cell becomes `null`.
 */
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

// ─── Locale-aware formatting (Phase 102, mirrors F# Renderer.Formatting) ──────

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

// ─── Scalar-slot resolution (Phase 632) ──────────────────────────────────────
//
// A `Binding.Transform` in a SCALAR slot (a `TextSource.Bound`, a Metric /
// LabelValueRow value) resolves to the lone cell of an exactly-1×1 pipeline
// result — the r42 shape (`filter → project [col] → limit 1`) and the global
// aggregate (`groupBy(keys: [], aggs: [one agg])`) are the two canonical
// terminals; no new wire vocabulary. The rule is LOUD on ambiguity (never a
// silent first cell) and renders absence for an empty result, except a
// trailing global single-`count` groupBy which resolves 0 (the count of
// nothing is 0 — the host completes the SQL global-aggregate semantic the
// strict fold leaves empty). This is a DISTINCT entry point wired at the
// scalar call sites rather than type-directed dispatch inside `resolve` — the
// rows list would otherwise silently render in a text slot. Mirror of the F#
// reference resolver's `resolveScalarWith` / `cellToText` / `cellToFloat`.

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

/**
 * Resolve a binding in a SCALAR slot: `Binding.Transform` evaluates through
 * the shared frame machinery and interprets the result as one cell (see the
 * section note above); every other binding case resolves exactly as `resolve`.
 */
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
    // The count of nothing is 0: the strict groupBy fold yields zero groups
    // over an empty frame; a trailing global single-`count` aggregate
    // completes to 0 here. Every other empty result is the slot's empty state
    // ("filter matched nothing" renders as absence).
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

/**
 * Defensive array coercion. Collection-valued bindings (option lists, grid /
 * chart / map sources, tuples) wire-encode to an opaque sentinel — `<opaque>`
 * — because the value is a closure-backed accessor result, not serialisable
 * data. A decoded tree therefore resolves such a binding to a non-array
 * sentinel; the renderer treats anything that is not a real array as empty,
 * exactly as the F# renderer's `Option.defaultValue []` falls back. Authored
 * (non-decoded) trees carry real arrays and pass through unchanged.
 */
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

// ─── Number / cell formatting (mirrors Render.fs formatNumber / renderCellValue)

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

// ─── Tree state (Phase 1120) ─────────────────────────────────────────────────
//
// The three readers and the two derivations a `Tree` needs, held HERE rather
// than in either render leg, because the server rendering and the client's
// first frame must agree on which rows are open, which row is focusable, and
// what "visible" means. A hydrating client that disagreed would replace the
// server's rows. Port of the F# `BindingResolver` tree helpers.

/**
 * The rows a `Tree` currently has OPEN, read off the named State key.
 *
 * The shape the specification fixes for that slot is a JSON ARRAY OF ROW IDS —
 * an array and not a per-row map, because the question the host asks is set
 * membership over a hierarchy it walks, and a set has one spelling where a map
 * of booleans has two for "closed".
 *
 * Every non-conforming shape reads as the EMPTY SET rather than as an error: a
 * key holding a number, an object, or an array with non-string members is a
 * host's state slot, not a wire document, so there is nothing here to refuse and
 * refusing would blank a tree over a value the reader never authored. Non-string
 * members are dropped individually for the same reason — `["a", 3, "b"]` still
 * says two true things.
 */
export const readExpandedItems = (
  sources: BindingSources,
  key: string | undefined,
): ReadonlySet<string> => {
  if (key === undefined) return new Set<string>();
  const raw = sources.state?.[key];
  if (!Array.isArray(raw)) return new Set<string>();
  return new Set(raw.filter((v): v is string => typeof v === 'string'));
};

/**
 * The row a `Tree` currently has SELECTED, read off the named State key. The
 * fixed shape is a bare row-id STRING, so `undefined` covers both an unset key
 * and a key holding anything else, on `readExpandedItems`' reasoning.
 */
export const readSelectedItem = (
  sources: BindingSources,
  key: string | undefined,
): string | undefined => {
  if (key === undefined) return undefined;
  const raw = sources.state?.[key];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
};

/**
 * Is this row's SUBTREE shown?
 *
 * A tree naming NO expansion key renders FULLY EXPANDED, and that is the
 * grid-behaviour rule read straight across rather than a special case: a grid
 * with no sort state key still honours its declared order, because an initial
 * presentation without interactive re-ordering is a legitimate shape.
 */
export const treeItemExpanded = (
  expandedKeyNamed: boolean,
  expanded: ReadonlySet<string>,
  item: TreeItem,
): boolean => item.children.length > 0 && (!expandedKeyNamed || expanded.has(item.id));

/**
 * Every row a reader can currently see, in document order: the roots, and the
 * descendants of every open row.
 */
export const visibleTreeItems = (
  expandedKeyNamed: boolean,
  expanded: ReadonlySet<string>,
  items: readonly TreeItem[],
): readonly TreeItem[] =>
  items.flatMap((item) => [
    item,
    ...(treeItemExpanded(expandedKeyNamed, expanded, item)
      ? visibleTreeItems(expandedKeyNamed, expanded, item.children)
      : []),
  ]);

/**
 * Which row carries `tabindex="0"`.
 *
 * The WAI-ARIA tree pattern is ONE tab stop, not one per row, so exactly one
 * visible row is in the sequential focus order and the arrow keys move within
 * the widget. That is the property no `List` + `Disclosure` composition has, and
 * it is computed off STATE alone so both legs put it on the same row.
 *
 * The selected row wins when it is visible; otherwise the first visible row
 * does. A selection scrolled out of view by its parent being closed is not a
 * focus target — tabbing into the widget must land somewhere the reader can see.
 */
export const focusableTreeItem = (
  expandedKeyNamed: boolean,
  expanded: ReadonlySet<string>,
  selected: string | undefined,
  items: readonly TreeItem[],
): string | undefined => {
  const visible = visibleTreeItems(expandedKeyNamed, expanded, items);
  if (selected !== undefined && visible.some((i) => i.id === selected)) return selected;
  return visible[0]?.id;
};

/**
 * Phase 1110 — which track entries keep their `default` election.
 *
 * At most ONE default per KIND survives, FIRST election wins. A document
 * electing two default captions tracks is legal bytes — the decoder does not
 * refuse it, because a lenient host would render it anyway and HTML leaves the
 * case undefined — so the HOST resolves it, and every host resolves it the same
 * way. The track is still emitted; only its claim on the menu is dropped.
 */
export const electedDefaultTracks = (tracks: readonly TrackEntry[]): readonly boolean[] => {
  const claimed = new Set<string>();
  return tracks.map((t) => {
    if (!t.default || claimed.has(t.kind)) return false;
    claimed.add(t.kind);
    return true;
  });
};

/** Phase 1110 — the lower-case HTML token for a wire `TrackKind`. */
export const trackKindToken = (kind: TrackKind): string => kind.toLowerCase();

/**
 * Phase 1116 — the HTML `capture` keyword for a wire `CaptureSource`.
 *
 * The keywords name a camera FACING, so the projection is `Camera` →
 * `environment` and `Microphone` → `user`: both are conforming keywords, the
 * facing constrains only a camera, and a host MUST NOT emit the device name
 * itself, which is not a keyword and is non-conforming markup.
 */
export const captureKeyword = (source: CaptureSource): string =>
  source === 'Camera' ? 'environment' : 'user';

// ─── Rating / Tokens / Colour models (Phases 1121, 1130) ─────────────────────
//
// The arithmetic and the projections a `Rating`, a `Tokens` field and a `Color`
// field need, held HERE rather than in either render leg. Both legs read them,
// so a static rendering and a hydrated one cannot disagree about which star is
// half-full or how a token list spells itself in a text box. Port of the F#
// `RatingModel` / `TokensModel` / `HexColor`.

/** The entry granularity: a half-star control moves by 0.5, a whole-star by 1. */
export const ratingStep = (allowHalf: boolean): number => (allowHalf ? 0.5 : 1);

/**
 * Hold a value inside `0 .. max`. NaN reads as 0 rather than propagating: a
 * rating is a magnitude, and there is no position on the scale that "not a
 * number" names.
 */
export const ratingClamp = (max: number, value: number): number =>
  Number.isNaN(value) ? 0 : value < 0 ? 0 : value > max ? max : value;

/** The nearest enterable position, clamped to the scale. */
export const ratingSnap = (allowHalf: boolean, max: number, value: number): number => {
  const s = ratingStep(allowHalf);
  return ratingClamp(max, Math.round(value / s) * s);
};

/**
 * How full each of the `max` positions is, in `0 .. 1`.
 *
 * A FRACTIONAL value renders as a partial position rather than rounding, and
 * that is normative: the commonest rating a reader sees is an AVERAGE arriving
 * through a `Query` binding, and rounding it would show the reader a figure the
 * document did not state.
 */
export const ratingFills = (max: number, value: number): readonly number[] => {
  const v = ratingClamp(max, value);
  return Array.from({ length: max }, (_, i) => {
    const filled = v - i;
    return filled <= 0 ? 0 : filled >= 1 ? 1 : filled;
  });
};

/**
 * The whole reading — "3.5 out of 5". `aria-valuetext` is the only ARIA member
 * that can announce a fraction at all, and it is what a display-only rating
 * carries as its accessible name.
 */
export const ratingValueText = (max: number, value: number): string => {
  const v = ratingClamp(max, value);
  const shown =
    Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(Number(v.toFixed(2)));
  return `${shown} out of ${max}`;
};

/** The per-position class fragment: empty, full, or partially filled. */
export const ratingFillClass = (fill: number): string =>
  fill <= 0
    ? 'fuaran-rating-star-empty'
    : fill >= 1
      ? 'fuaran-rating-star-full'
      : 'fuaran-rating-star-partial';

/**
 * The token list as the static floor's single text input spells it.
 *
 * The separator lives here and not at the call site, so the projection and its
 * inverse cannot drift apart.
 */
export const tokensToCommaSeparated = (tokens: readonly string[]): string => tokens.join(', ');

/**
 * The inverse. Empty entries are dropped and duplicates collapse — a token list
 * the reader SEES as chips cannot honestly carry two identical ones, and the
 * text floor is the one place a reader can type them.
 */
export const tokensFromCommaSeparated = (text: string): readonly string[] => {
  const seen = new Set<string>();
  return text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '' && !seen.has(t) && (seen.add(t), true));
};

/**
 * `true` for the canonical `#rrggbb` form and nothing else — six hex digits
 * after a `#`, either case.
 *
 * Deliberately STRICT. `<input type="color">` holds exactly this form: it cannot
 * carry `#fff`, `rebeccapurple`, `rgb(0 0 0)` or an alpha channel, and a control
 * that silently narrowed one of those would be answering a question the author
 * did not ask. Case is accepted and never rewritten — the browser lower-cases on
 * its own, at the DOM, where that is its business.
 */
export const isHexColor = (text: string): boolean => /^#[0-9a-fA-F]{6}$/.test(text);

/**
 * Can an omitted handler's write-back reach this value slot?
 *
 * A `State` or `Filter` binding is writable, so a control with no handler still
 * changes something; every other binding is read-only, and a control over one is
 * a DISPLAY. The rating floor turns on exactly this: a slider a reader can focus
 * and can never move is a fake affordance, and the honest markup for a picture of
 * a score is a picture.
 */
export const isWriteBackTarget = <T>(binding: Binding<T>): boolean =>
  binding.kind === 'State' || binding.kind === 'Filter';
