// ============================================================================
//  @fuaran-ui/schema — the TypeScript shape of the Fuaran §4b record contract.
//
//  This is a shape-for-shape port of the F# reference type contract
//  (Fuaran.UI/Types.fs). It is one conformant host of the canonical wire
//  format declared language-neutrally in fuaran-dotnet/docs/WIRE_FORMAT.md; the F#
//  tier is the other. Phase 76 (@fuaran-ui/ops) verifies the JSON codec built
//  on these types against the workspace ../wire-format-fixtures/ corpus
//  byte-for-byte. This file owns only the typed contract — smart constructors
//  + pre-emit validation live in @fuaran-ui/ui.
//
//  PORTING CONVENTIONS (see Phase 75 of the workspace roadmap):
//   - F# discriminated unions become TS tagged unions discriminated by a
//     `kind: '<CaseName>'` literal, where `<CaseName>` is the F# case name
//     verbatim (PascalCase). The codec maps `kind` to the wire `$type`.
//   - F# records become readonly object types.
//   - F# `option` becomes an optional property (`field?: T`). An ABSENT key
//     is the in-memory representation of `None`; this matches the wire
//     format's "None / null fields are EXCLUDED from object output" rule
//     (WIRE_FORMAT.md §2 rule 4) — `undefined`, never `null`.
//   - Single-case F# wrappers (`NodeId of string`) become branded primitives.
//   - F# `'Msg` flows through as a generic `TMsg`; the smart-ctor layer in
//     @fuaran-ui/ui returns `Node<TMsg>` directly (no `obj` erasure needed at
//     the author surface — structural typing handles it). The row-typed grid
//     surface still erases to `unknown` at the tree level, mirroring the F#
//     `obj`-erasure boundary, because `Node<TMsg>` cannot carry the row type.
//
//  NOT PORTED HERE: the Phase 12.K `Theme` record family (Tones, Spacing,
//  FontScale, ColorVar, Interaction, …). Theme is a renderer-tier CSS-variable
//  surface with its own toJson / fromJson serialisation distinct from the
//  Node / TreeOp wire format this package mirrors; it ships with
//  @fuaran-ui/renderer (Phase 77), not the typed-contract core.
// ============================================================================

import type { Result } from './result.js';
import type { DataSource, InvokeArg, Transform } from './compute.js';

// ─── Branded primitives ─────────────────────────────────────────────────────
//
// The standard TS branding trick: an intersection with a phantom field that
// no plain string carries, so a bare string is not assignable to the brand
// without an explicit cast (`'root' as NodeId`) or the helper constructor.

/** A node's stable, addressable identity. Port of F# `NodeId of string`. */
export type NodeId = string & { readonly __brand: 'NodeId' };

/** Wire-shaped name a fragment is addressed by. Port of F# `FragmentId of string`. */
export type FragmentId = string & { readonly __brand: 'FragmentId' };

/** API endpoint handle. Port of F# `ApiEndpoint of string`. */
export type ApiEndpoint = string & { readonly __brand: 'ApiEndpoint' };

/** Icon reference. Port of F# `IconSource of string`. */
export type IconSource = string & { readonly __brand: 'IconSource' };

/** Brand a raw string as a `NodeId`. */
export const nodeId = (value: string): NodeId => value as NodeId;
/** Brand a raw string as a `FragmentId`. */
export const fragmentId = (value: string): FragmentId => value as FragmentId;
/** Brand a raw string as an `ApiEndpoint`. */
export const apiEndpoint = (value: string): ApiEndpoint => value as ApiEndpoint;
/** Brand a raw string as an `IconSource`. */
export const iconSource = (value: string): IconSource => value as IconSource;

// ─── JSON value (the `JsonValue` placeholder) ────────────────────────────────
//
// Port of F# `JsonValue of obj`, but given a real recursive JSON type rather
// than an opaque box — used in NodeKind.Custom props, Action.Notify / SetState
// / AiTool payloads, and TextSource.I18n args.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// ─── Bare-string enums (WIRE_FORMAT.md §3.5) ─────────────────────────────────
//
// These DUs encode as a bare JSON string on the wire. In-memory they are TS
// string-literal unions discriminated structurally by value.

export type Orientation = 'Vertical' | 'Horizontal';

export type BadgeVariant = 'Neutral' | 'Brand' | 'Success' | 'Warning' | 'Critical' | 'Info';

export type ButtonVariant = 'Primary' | 'Secondary' | 'Tertiary' | 'Destructive';

export type HeadingVariant = 'Standard' | 'Eyebrow' | 'Caption' | 'Lead';

/** `DisplayKind.Image` presentation variant (Phase 287). Bare-string enum. */
export type ImageVariant = 'Default' | 'Avatar' | 'Rounded';

/** `LayoutKind.ScrollArea` scroll axis (Phase 289). Bare-string enum. */
export type ScrollOrientation = 'Vertical' | 'Horizontal' | 'Both';

/** `FormFieldKind.Date` temporal breadth (Phase 288). Bare-string enum. */
export type DateVariant = 'Date' | 'Time' | 'DateTime';

/**
 * `DisplayKind.Math` presentation mode (Phase 293). `Inline` flows the equation
 * within surrounding text (a `<span>`); `Block` is a centred display equation on
 * its own line (a `<div>`). Bare-string enum (WIRE_FORMAT.md §3.5).
 */
export type MathDisplay = 'Inline' | 'Block';

export type ToneVariant =
  | 'Default'
  | 'Subdued'
  | 'Brand'
  | 'Success'
  | 'Warning'
  | 'Critical'
  | 'Info';

export type StyleWeight = 'Compact' | 'Standard' | 'Spacious';

export type Emphasis = 'Quiet' | 'Normal' | 'Loud';

/**
 * Phase 147 — the bounded, additive-only semantic content-role vocabulary.
 * The AI emits a role as intent; the renderer projects a stable
 * `fuaran-role-{role}` class. `'None'` (the default) emits nothing and is
 * omitted from the wire, so a tree authored before the field existed renders +
 * round-trips byte-identically. Generalises `HeadingVariant`'s eyebrow/caption
 * variants to a role any node can carry.
 */
export type StyleRole = 'None' | 'Eyebrow' | 'Data' | 'Lede' | 'Caption';

/**
 * Phase 147 — the bounded, additive-only font-voice vocabulary: the
 * display-vs-structural split. Projects a `fuaran-voice-{voice}` class;
 * `'Default'` emits nothing (byte-identical default).
 */
export type FontVoice = 'Default' | 'Display' | 'Structural';

export type ChartKind = 'Line' | 'Bar' | 'Area' | 'Pie' | 'Scatter' | 'Heatmap';

/**
 * Phase 880 — which edge of the chart the series legend occupies, or `'None'`,
 * which suppresses it entirely.
 *
 * A WIRE vocabulary on the same side of the line as `ChartSpec.title`: WHERE an
 * author wants the legend is their meaning; the geometry that puts it there —
 * column widths, pitches, how the plot shrinks — stays the host's. The lowering
 * carries the DEFAULT (`Right`); an explicit `ChartSpec.legendPosition` beats it.
 */
export type ChartLegendPosition = 'Top' | 'Right' | 'Bottom' | 'None';

/**
 * Phase 881 — whether a chart writes its values directly onto the picture,
 * and where.
 *
 * A WIRE vocabulary on the semantic side of the line: whether the reader is
 * meant to READ THE NUMBERS or read the shape is the author's meaning; the
 * type size, the offsets and the fit rule that realise it stay the host's.
 *
 * THE CASE SET IS TWO, AND THAT IS THE POINT. There is deliberately no
 * all-points value: a number on every interior point is the clutter this
 * vocabulary exists to avoid, so no shape of this type can request one.
 * `'Ends'` names the selective placements that read — a bar's cap, a line's
 * last point — and the set is closed there.
 */
export type ChartDataLabels = 'Off' | 'Ends';

/**
 * Phase 882 — what a chart's x axis MEANS: the scale its x column is read on.
 *
 * A WIRE vocabulary on the semantic side of the line: whether a column is a set
 * of CATEGORIES or a run of DATES is a fact about the data the author is
 * declaring, not an appearance choice. Where the ticks land, how they are
 * formatted and how much margin they need stay the host's.
 *
 * DECLARED, NOT INFERRED, and that is the point of the field. A chart's data
 * schema is statically known only for an embedded table with an empty pipeline,
 * so an inferred axis would make one wire tree draw a band axis or a temporal
 * one depending on where its rows came from; and sniffing the cell strings for
 * an ISO-8601 shape is a guess dressed as a rule. Declaring it lets the pre-emit
 * validator GROUND the claim instead (`FUARAN097` refuses a temporal axis over a
 * non-date column) — the author says what the column is, and the language
 * refuses to be wrong about it quietly.
 *
 * `'Category'` is the shipped default and what an absent field means, so every
 * pre-882 chart is byte-unchanged on the wire AND in the picture.
 */
export type ChartXScale = 'Category' | 'Temporal';

/** `aria-live` politeness. Wire form is lower-case (WIRE_FORMAT.md §3.5). */
export type LiveRegionKind = 'polite' | 'assertive' | 'off';

/**
 * ARIA role. The F# `AriaRole` DU enumerates the common roles plus a
 * `Custom of string` escape; the wire emits the raw ARIA string either way.
 * The TS analogue is a string-literal union with a `(string & {})` tail that
 * keeps autocomplete for the named roles while accepting any custom role
 * string — the structural equivalent of the `Custom` case.
 */
export type AriaRole =
  | 'button'
  | 'link'
  | 'dialog'
  | 'alert'
  | 'status'
  | 'banner'
  | 'navigation'
  | 'main'
  | 'form'
  | 'region'
  | 'heading'
  | 'progressbar'
  | 'tab'
  | 'tablist'
  | 'tabpanel'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/**
 * Per-Node animation token (Phase 12.F). Wire-omitted (WIRE_FORMAT.md §9) —
 * this is a consumer-authored in-memory trait the renderer projects to a
 * `fuaran-motion-{token}` class.
 */
export type Motion =
  | 'None'
  | 'PulseDuringLoad'
  | 'FadeInOnMount'
  | 'SlideInFromBelow'
  | 'ShakeOnError'
  | 'RotateOnRefresh'
  | 'SlideInFromRight'
  | 'ExpandCollapse';

export type ErrorKind =
  | 'NotFound'
  | 'Forbidden'
  | 'Server'
  | 'Network'
  | 'Timeout'
  | 'BindingResolution';

/** Hash-mismatch handling for a `NodeKind.Custom` body (Phase 70). */
export type HashStrictness = 'StrictReplay' | 'AdvisoryWarning' | 'Enforced';

// ─── Content hash (Phase 70) ─────────────────────────────────────────────────

/** Content-identity envelope for a `NodeKind.Custom` body. */
export interface ContentHash {
  readonly algorithm: string;
  readonly hash: string;
  readonly strictness: HashStrictness;
}

// ─── Bindings (§4k Q3.1) ─────────────────────────────────────────────────────
//
// Typed at author, stringly-typed at wire. Query / Selection / Computed carry
// accessor closures that wire-encode to the `"<closure>"` sentinel.

/**
 * The read-only context handed to a `Binding.Computed` closure. Port of F#
 * `BindingContext` (Phase 137): typed read access over the live module-state
 * bag the renderer projects from the host state store, so a `Computed` closure
 * can derive a value from a `Binding.State` slot (e.g. label text that depends
 * on a `"busy"` flag).
 *
 * `tryGetState` never throws: a missing key returns `undefined`, so the closure
 * stays total. As in the F# Fable pipeline, the value is returned as-is (the
 * state bag is structurally erased) — callers read the type they stored.
 *
 * Reactivity caveat (mirrors the F# tier): a `Computed`-over-state binding does
 * not auto-re-render on state change (the closure's reads are opaque to static
 * state-key analysis). Prefer `binding.state` for reactive text; reach for a
 * `Computed` projection only when the derivation can't be a direct read.
 */
export interface BindingContext {
  /** The live module-state bag (same erasure as `BindingSources.state`). */
  readonly state: Readonly<Record<string, unknown>>;
  /** Read the value at `key`, cast to `T`. `undefined` for a missing key. */
  tryGetState<T>(key: string): T | undefined;
}

/**
 * One parameter of a `Binding.Transform` (Phase 424) — binds a `ColExpr.Param` `name` the pipeline
 * references to a scalar `from` binding source. Wire shape `{"from":<Binding>,"name":<string>}`.
 */
export interface TransformParam {
  readonly name: string;
  readonly from: Binding<unknown>;
}

export type Binding<T> =
  | { readonly kind: 'Static'; readonly value: T }
  | {
      readonly kind: 'Query';
      readonly name: string;
      readonly accessor: (source: unknown) => T;
      // Phase 421 — the declared filter dependency edge: which filters scope this consumer. The tree
      // owns the edge (AI-authorable, validator-visible); the accessor still owns the predicate.
      // Optional (omitted-when-empty), byte-stable for the degenerate case.
      readonly dependsOn?: readonly string[];
    }
  | {
      readonly kind: 'Filter';
      readonly name: string;
      /**
       * 0.2.0 — the value the resolver yields (and the renderer seeds the
       * store with) before the filter is first written. Closes the
       * pre-selected-filter gap. Absent = today's behaviour.
       */
      readonly defaultValue?: unknown;
    }
  | {
      readonly kind: 'Selection';
      readonly nodeId: NodeId;
      readonly accessor: (row: unknown) => T;
      /**
       * 0.2.9 (Phase 629) — the value the resolver yields when no row has been
       * selected on `nodeId` yet; the default stops applying after the first
       * real selection (the `Filter.defaultValue` law, replayed for the
       * selection channel). Absent = prior behaviour: unselected resolves to
       * nothing.
       */
      readonly defaultValue?: T;
      /**
       * 0.2.10 (Phase 632) — the declarative row-field projection: a decoded
       * Selection's accessor projects this named field off the clicked row
       * (the grid writes the full row; the identity accessor yields the row
       * itself). Carried alongside the accessor because the closure cannot be
       * re-serialised: the encoder writes `field` back from here. Absent = the
       * identity accessor, pre-632 bytes unchanged.
       */
      readonly field?: string;
    }
  | { readonly kind: 'State'; readonly key: string; readonly defaultValue: T }
  | { readonly kind: 'Computed'; readonly compute: (ctx: BindingContext) => T }
  /**
   * The host-furnished current instant, as an ISO-8601 UTC string
   * (`2026-08-02T06:59:24Z`).
   *
   * The wire form is `{"$type":"Now"}` — no fields. The clock lives in the
   * HOST, resolved once per render pass, never on the wire and never read
   * during resolution: that is what keeps a tree a pure value and lets a
   * replayed op-stream reproduce its original render rather than drift to
   * replay-time "now". The ISO-8601 form composes with the core
   * `dateDiffDays`, which reads the leading `YYYY-MM-DD`.
   */
  | { readonly kind: 'Now'; readonly project: (iso: string) => T }
  | {
      readonly kind: 'I18n';
      readonly key: string;
      readonly args?: Readonly<Record<string, Binding<JsonValue>>>;
    }
  | { readonly kind: 'Local'; readonly local: LocalBinding<T> }
  | {
      // Phase 102: locale-aware formatted value. Wraps a numeric `source`
      // binding and projects it to a localised display string via the browser
      // `Intl` APIs. `format` is the bounded semantic intent (NOT a raw Intl
      // option bag); `locale` selects the BCP-47 locale (Ambient defers to the
      // host's ambient locale). Constrained to `Binding<string>` use.
      readonly kind: 'Format';
      readonly source: Binding<number>;
      readonly format: Format;
      readonly locale: LocaleSource;
    }
  | {
      // Phase 282 — the Compute layer. A declarative `Fuaran.Core.DataFrame`
      // pipeline (the full v1 verb set) over a columnar `DataSource`, evaluated
      // client-side **as data** — no closure on the wire. Semantically
      // constrained to a data-bearing slot (`Grid` / `Chart` / `Table`): the
      // @fuaran-ui/ops evaluator runs the pipeline and the result rows resolve as
      // the node's data source. Structurally independent of `T` (the case carries
      // no typed payload), mirroring the F# `Binding.Transform` case.
      // Phase 818 — the source slot widened from `DataSource` to the host
      // `TransformSource` union so a binding-shaped wire source (State /
      // Selection / Query) is PRESERVED for live re-evaluation instead of
      // being snapshotted at decode (the Phase-815 leniency's semantics
      // upgrade).
      readonly kind: 'Transform';
      readonly source: TransformSource;
      readonly pipeline: readonly Transform[];
      // Phase 424 — bind each `ColExpr.Param` name the pipeline references to a scalar `Binding`
      // source (`Filter` / `State` / `Static` / `Selection`). Optional (omitted-when-empty), so a
      // param-free Transform is byte-identical to the Phase 282 shape.
      readonly params?: readonly TransformParam[];
    }
  | {
      // Phase 283 — invoke a host-registered compute capability for a value.
      // `capabilityId` references a host registry entry; `args` are scalar
      // `(addr, value)` pairs validated against the capability signature before
      // dispatch. The body is host-provided, never on the wire; resolves to a
      // `Deferred<T>` at a data-bearing node. Structurally independent of `T`.
      // (Wire codec ships here; the renderer dispatch seam + `Deferred` states
      // are gated on the Phase 283 capability runtime.)
      readonly kind: 'Invoke';
      readonly capabilityId: string;
      readonly args: readonly InvokeArg[];
    };

/**
 * Phase 818 — a `Binding.Transform`'s source slot (mirror of the F#
 * `TransformSource` DU). `Data` is the canonical columnar / `ref` source (the
 * pre-818 shape, byte-identical on the wire). `Live` preserves a
 * binding-shaped source (State / Selection / Query) verbatim so a runtime
 * re-evaluates the Transform when the binding's channel changes; `initial` is
 * the decode-time snapshot table derived from the binding's carried default
 * data (never encoded — the binding IS the wire form), which SSR / diagnostic
 * evaluation reads, byte-identical to the Phase-815 snapshot for the same
 * input.
 */
export type TransformSource =
  | { readonly kind: 'Data'; readonly source: DataSource }
  | {
      readonly kind: 'Live';
      readonly binding: Binding<JsonValue>;
      readonly initial: DataSource;
    };

/** Phase 62: when a `Binding.Local` flushes its buffered value to the model. */
export type LocalFlushTrigger =
  | { readonly kind: 'OnBlur' }
  | { readonly kind: 'OnSubmit' }
  | { readonly kind: 'OnDebounce'; readonly milliseconds: number }
  | { readonly kind: 'OnCommitAction' };

/**
 * Phase 62: the body of a `Binding.Local`. `onCommit` returns the
 * consumer's action erased to `unknown` (mirrors the F# `'T -> obj` tree-level
 * erasure); the smart-ctor `binding.local` boxes a typed `Action<TMsg>` into
 * it. `parse` is mandatory; `format` is optional.
 */
export interface LocalBinding<T> {
  readonly initialFrom: Binding<T>;
  readonly flushOn: LocalFlushTrigger;
  readonly onCommit: (value: T) => unknown;
  readonly format?: (value: T) => string;
  readonly parse: (raw: string) => Result<T, string>;
}

// ─── Actions (effect-typed) ──────────────────────────────────────────────────

/**
 * `Action.Call`'s declarative result target (Phase 428): where the endpoint
 * response lands so consumers can read it. `State` writes the `$state.<key>`
 * slot (`Binding.State` readers); `Query` writes the `queryResults` slot
 * `<name>` (`Binding.Query` readers — data-preserving on the decoded path per
 * the Phase 421 identity accessor). Wire: `"into":{"$type":"State","key":…}` /
 * `{"$type":"Query","name":…}`, omitted when absent.
 */
export type CallResultTarget =
  | { readonly kind: 'State'; readonly key: string }
  | { readonly kind: 'Query'; readonly name: string };

export type Action<TMsg> =
  | { readonly kind: 'Dispatch'; readonly msg: TMsg }
  | {
      /**
       * Call a host-registered endpoint. `onResult` (a closure, `"<closure>"`
       * on the wire) wins when present; `into` (Phase 428) is the declarative
       * result target the AI-authored / decoded shape uses. Both absent is a
       * fire-and-forget command call. The endpoint set + the default-deny
       * dispatch gate are unchanged — `into` adds no new capability, only a
       * destination.
       */
      readonly kind: 'Call';
      readonly endpoint: ApiEndpoint;
      readonly onResult?: (result: unknown) => TMsg;
      readonly into?: CallResultTarget;
    }
  | { readonly kind: 'Notify'; readonly channel: string; readonly payload: JsonValue }
  | { readonly kind: 'Navigate'; readonly route: string }
  // Phase 818 — `valueFrom` (a Binding evaluated at dispatch time inside the
  // existing gate) is a SIBLING of the literal `value`; decode enforces
  // value XOR valueFrom. `value` became optional in the same change so the
  // valueFrom-only wire shape is representable without a placeholder.
  | {
      readonly kind: 'SetState';
      readonly key: string;
      readonly value?: JsonValue;
      readonly valueFrom?: Binding<JsonValue>;
    }
  | { readonly kind: 'AiTool'; readonly toolName: string; readonly args: JsonValue }
  | { readonly kind: 'Chain'; readonly actions: readonly Action<TMsg>[] }
  | { readonly kind: 'CommitLocal'; readonly nodeId: string }
  | { readonly kind: 'WriteToClipboard'; readonly text: string }
  | {
      /**
       * Phase 136 — read a previously-selected file's body in `encoding`, then
       * dispatch `onRead body`. Mirrors `Call`'s return-channel shape: only
       * `file.id` + `encoding` cross the wire (the blob is host-held on
       * `file.handle`); `onRead` is unobservable (closure sentinel). Routes
       * through `FuaranRuntime.readFileBody`, so the consumer never touches
       * `FileReader` directly.
       */
      readonly kind: 'ReadFileBody';
      readonly file: FileRef;
      readonly encoding: FileReadEncoding;
      readonly onRead: (body: string) => TMsg;
    }
  | {
      // Phase 283 — invoke a host-registered compute capability as an effect (the
      // effectful sibling of `Binding.Invoke` / `Action.Call`). Same wire shape:
      // `capabilityId` + scalar `(addr, value)` args; the body never on the wire.
      // (Wire codec ships here; the renderer dispatch seam is gated on the Phase
      // 283 capability runtime.)
      readonly kind: 'Invoke';
      readonly capabilityId: string;
      readonly args: readonly InvokeArg[];
    };

// ─── Text sources (bindable, i18n-aware) ─────────────────────────────────────

export type TextSource =
  | { readonly kind: 'Literal'; readonly value: string }
  | { readonly kind: 'Bound'; readonly binding: Binding<string> }
  | {
      readonly kind: 'I18n';
      readonly key: string;
      readonly args: Readonly<Record<string, JsonValue>>;
    };

// ─── Cell value / format / width (§4k Q3.2 / Q3.3) ───────────────────────────

export type CellValue =
  | { readonly kind: 'Numeric'; readonly value: number }
  | { readonly kind: 'Text'; readonly value: string }
  | { readonly kind: 'Bool'; readonly value: boolean }
  | { readonly kind: 'Date'; readonly value: Date }
  | { readonly kind: 'Empty' };

/** Duration grain for `CellFormat.Duration` / `Format.Duration` (Phase 819) —
 * the numeric source counts this unit (Seconds = 1, Minutes = 60, Hours = 3600). */
export type DurationUnit = 'Seconds' | 'Minutes' | 'Hours';

/** Duration presentation for `CellFormat.Duration` / `Format.Duration`
 * (Phase 819): `Compact` "1h 20m", `Clock` "1:20:00", `Long` "1 hour 20 minutes". */
export type DurationStyle = 'Compact' | 'Clock' | 'Long';

export type CellFormat =
  | { readonly kind: 'None' }
  | { readonly kind: 'Number'; readonly decimals?: number }
  | { readonly kind: 'Currency'; readonly code: string }
  | { readonly kind: 'Percent'; readonly decimals?: number }
  | { readonly kind: 'SignificantDigits'; readonly digits: number }
  | { readonly kind: 'Date'; readonly format: string }
  | { readonly kind: 'Duration'; readonly unit: DurationUnit; readonly style: DurationStyle }
  | { readonly kind: 'RelativeTime'; readonly unit: RelativeTimeUnit }
  | { readonly kind: 'Custom'; readonly format: (value: CellValue) => string };

export type ColumnWidth =
  | { readonly kind: 'Auto' }
  | { readonly kind: 'Fixed'; readonly pixels: number }
  | { readonly kind: 'Flex'; readonly weight: number };

// ─── Locale-aware formatting (Phase 102) ─────────────────────────────────────

/** Date-presentation breadth for `Format.Date` (maps to Intl `dateStyle`). */
export type DateStyle = 'Short' | 'Medium' | 'Long' | 'Full';

/** Relative-time grain for `Format.RelativeTime` (maps to Intl `unit`). */
export type RelativeTimeUnit = 'Second' | 'Minute' | 'Hour' | 'Day' | 'Week' | 'Month' | 'Year';

/**
 * Bounded, semantic locale-aware formatting intent carried by `Binding.Format`.
 * The numeric source is read as a plain number (`Number` / `Currency` /
 * `Percent` — `Percent` a ratio), whole Unix-epoch seconds (`Date`), or a
 * signed count of the unit (`RelativeTime` / `Duration` — Phase 819; Duration
 * renders locale-independently, see `DurationStyle`). No raw Intl option-bag escape.
 */
export type Format =
  | { readonly kind: 'Number'; readonly decimals?: number }
  | { readonly kind: 'Currency'; readonly isoCode: string }
  | { readonly kind: 'Percent'; readonly decimals?: number }
  | { readonly kind: 'Date'; readonly dateStyle: DateStyle }
  | { readonly kind: 'RelativeTime'; readonly unit: RelativeTimeUnit }
  | { readonly kind: 'Duration'; readonly unit: DurationUnit; readonly style: DurationStyle };

/**
 * Locale selector for `Binding.Format`. `Ambient` defers to the host-supplied
 * ambient locale; `Explicit` pins a BCP-47 locale tag (e.g. "en-GB").
 */
export type LocaleSource =
  | { readonly kind: 'Ambient' }
  | { readonly kind: 'Explicit'; readonly tag: string };

// ─── State behaviour + style + accessibility ─────────────────────────────────

export interface ErrorPayload {
  readonly kind: ErrorKind;
  readonly message: string;
  readonly correlationId: string;
}

export interface StateBehaviour<TMsg> {
  readonly onLoading?: Node<TMsg>;
  readonly onEmpty?: Node<TMsg>;
  readonly onError?: (payload: ErrorPayload) => Node<TMsg>;
}

export interface SemanticStyle {
  readonly tone: ToneVariant;
  readonly weight: StyleWeight;
  readonly emphasis: Emphasis;
  /**
   * Phase 147 — named content role. Optional: an absent field is the default
   * (`'None'`), per the wire contract (absent ⟺ default). `'None'` emits no
   * class + is omitted from the wire. `defaults.style` populates it as `'None'`.
   */
  readonly role?: StyleRole;
  /**
   * Phase 147 — font voice (display vs structural). Optional: absent ⟺ default
   * (`'Default'`); emits no class + is omitted from the wire.
   */
  readonly voice?: FontVoice;
}

export interface Accessibility {
  readonly label?: Binding<string>;
  readonly labelledBy?: NodeId;
  readonly describedBy?: NodeId;
  readonly role?: AriaRole;
  readonly liveRegion?: LiveRegionKind;
  readonly hidden?: Binding<boolean>;
}

// ─── The tree ────────────────────────────────────────────────────────────────

export interface Node<TMsg> {
  readonly id: NodeId;
  readonly kind: NodeKind<TMsg>;
  readonly state: StateBehaviour<TMsg>;
  readonly style: SemanticStyle;
  readonly accessibility?: Accessibility;
  readonly motion?: Motion;
  readonly extraAttributes?: Readonly<Record<string, string>>;
}

export type NodeKind<TMsg> =
  | { readonly kind: 'Layout'; readonly layout: LayoutKind<TMsg> }
  | { readonly kind: 'Display'; readonly display: DisplayKind }
  | { readonly kind: 'Input'; readonly input: InputKind<TMsg> }
  | { readonly kind: 'Visualisation'; readonly visualisation: VisKind<TMsg> }
  | {
      readonly kind: 'Custom';
      readonly moduleId: string;
      readonly componentId: string;
      readonly props: Readonly<Record<string, JsonValue>>;
      readonly contentHash?: ContentHash;
      readonly exposedNodeIds: readonly NodeId[];
    }
  | { readonly kind: 'ErrorBoundary'; readonly spec: ErrorBoundarySpec<TMsg> }
  | { readonly kind: 'Switch'; readonly spec: SwitchSpec<TMsg> }
  | { readonly kind: 'FragmentDecl'; readonly spec: FragmentDeclSpec<TMsg> }
  | { readonly kind: 'FragmentRef'; readonly spec: FragmentRefSpec<TMsg> }
  | { readonly kind: 'Mount'; readonly spec: MountSpec<TMsg> };

/**
 * The emittable NodeKind vocabulary, grouped by the four behavioural categories
 * (WIRE_FORMAT.md §3.2) plus the structural kinds. This is the SINGLE
 * enumeration: `NODE_KIND_NAMES` flattens it, and `@fuaran-ui/ops` projects the
 * `WRONG_NODE_KIND` decoder hint from it — so a kind added here reaches both,
 * and the hint cannot fall behind the kind set the way three hand-maintained
 * hint strings did across the hosts.
 *
 * The group names and their order are a cross-host contract: the F# and Rust
 * hosts emit the same grouped hint, so a model repairing against any host sees
 * the same vocabulary in the same shape.
 */
export const NODE_KIND_GROUPS: readonly {
  readonly label: string;
  readonly kinds: readonly string[];
}[] = [
  {
    label: 'Layout',
    kinds: [
      'Box',
      'SplitPanel',
      'Tabs',
      'Stepper',
      'SummaryList',
      'Disclosure',
      'Modal',
      'ScrollArea',
    ],
  },
  {
    label: 'Display',
    kinds: [
      'Heading',
      'Markdown',
      'Metric',
      'Badge',
      'Sparkline',
      'Callout',
      'Progress',
      'Skeleton',
      'Icon',
      'LabelValueRow',
      'Fact',
      'Link',
      'Image',
      'List',
      'Toast',
      'CodeBlock',
      'Math',
      'Drawing',
    ],
  },
  {
    label: 'Input',
    kinds: ['Form', 'Filters', 'Button', 'FileUpload', 'Select'],
  },
  {
    label: 'Visualisation',
    kinds: ['DataGrid', 'Chart', 'Map'],
  },
  {
    // The structural kinds carry no category prose in the hint — they are
    // listed bare after the four primitive families.
    label: 'Structural',
    kinds: ['Custom', 'ErrorBoundary', 'Switch', 'FragmentDecl', 'FragmentRef', 'Mount'],
  },
];

/**
 * The emittable NodeKind vocabulary — one entry per wire `kind.$type` name a
 * conformant host encodes/decodes, flattened from `NODE_KIND_GROUPS`. Pinned
 * against the generated `wire-format-fixtures` manifest `kinds` enumeration by
 * the corpus test suite (Phase 548 cross-host kind-set attestation): a new kind
 * added without an entry in the groups above fails that pin with the kind named.
 * Maintained in lockstep with the codec under the §11 forward-coupling
 * discipline (`DataGrid` is the wire name of the grid kind — the `Grid`
 * discriminator is a `BoxLayout` case, not a NodeKind).
 */
export const NODE_KIND_NAMES: readonly string[] = NODE_KIND_GROUPS.flatMap((g) => g.kinds);

export interface ErrorBoundarySpec<TMsg> {
  readonly child: Node<TMsg>;
  readonly fallback: Node<TMsg>;
}

/**
 * State-bound conditional-child primitive (Phase 392). `stateKey` names the
 * reactive StateStore key that selects the case; `cases` is an ordered list of
 * `{ match, child }` pairs (first-match-wins on the state value's string form);
 * `default` renders when no case matches (and is the SSR / first-paint surface
 * before any `SetState`). State transitions arrive as ordinary `Action.SetState`
 * through the existing policy gate — no new dispatch path. Port of F#
 * `Fuaran.UI.Types.SwitchSpec`. Wire:
 * `{ "$type":"Switch", "cases":[{"child":<Node>,"match":<string>},…],
 *    "default":<Node>, "stateKey":<string> }`.
 */
export interface SwitchSpec<TMsg> {
  /**
   * The branch selector — any Binding (Phase 768): a `State` selector keeps the
   * Phase 392 behaviour; a `Selection` selector lets the branch follow the
   * clicked row with no writer. The State form keeps its compact `stateKey`
   * spelling on the wire (the encoder collapses `State(key)` back to it); any
   * other binding encodes as `on`.
   */
  readonly on: Binding<string>;
  readonly cases: readonly SwitchCase<TMsg>[];
  readonly default: Node<TMsg>;
}

/** One case in a {@link SwitchSpec}: render `child` when the state value's
 * string form equals `match`. */
export interface SwitchCase<TMsg> {
  readonly match: string;
  readonly child: Node<TMsg>;
}

// ─── Parameterised-fragment surface (Phase 180) ──────────────────────────────
//
// A saved tree behaves as a FUNCTION of declared holes (the artifact-function
// abstraction). A zero-hole decl with a pure-deterministic effect is the
// degenerate Phase-61 fixed-body fragment (both fields omitted on the wire, so
// that shape stays byte-identical). Port of F# `Fuaran.UI.Types` /
// `Fuaran.UI.Fragment`.

/** A hole's value-space — the type domain of a value argument. */
export type HoleValueSpace =
  | { readonly kind: 'IntRange'; readonly min: number; readonly max: number }
  | { readonly kind: 'FloatRange'; readonly min: number; readonly max: number }
  | { readonly kind: 'StringLen'; readonly minLen: number; readonly maxLen: number }
  | { readonly kind: 'Enum'; readonly choices: readonly string[] }
  | { readonly kind: 'AnyString' };

/**
 * A self-describing boxed scalar (a value default or a value argument). The
 * `kind` tag preserves the F# CLR shape (`int` vs `float`) the wire `$type`
 * encodes — so a decoded scalar re-encodes to the same `$type` byte-for-byte.
 */
export type FragmentScalar =
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'str'; readonly value: string };

/** A declared hole on a parameterised fragment. */
export type HoleDecl =
  | {
      readonly kind: 'Value';
      readonly name: string;
      readonly space: HoleValueSpace;
      readonly default?: FragmentScalar;
    }
  | { readonly kind: 'Slot'; readonly name: string; readonly kindConstraint?: string }
  | { readonly kind: 'Repeat'; readonly name: string; readonly countSpace: HoleValueSpace };

/** The host-effect axis: does the fragment read or write host state? */
export type HostEffect = 'Pure' | 'ReadsHost' | 'WritesHost';

/** The determinism-source axis (mirrors Calc's `Volatility`). */
export type DeterminismSource = 'Deterministic' | 'Clock' | 'Random' | 'Network';

/** A total two-axis effect class. Defaults to pure-deterministic. */
export interface EffectClass {
  readonly hostEffect: HostEffect;
  readonly determinism: DeterminismSource;
}

/** One bound argument at a `FragmentRef` — a value scalar or a slot subtree. */
export type FragmentArg<TMsg> =
  | { readonly kind: 'value'; readonly value: FragmentScalar }
  | { readonly kind: 'slot'; readonly tree: Node<TMsg> };

export interface FragmentDeclSpec<TMsg> {
  readonly name: FragmentId;
  readonly body: Node<TMsg>;
  readonly holes: readonly HoleDecl[];
  readonly effect: EffectClass;
}

export interface FragmentRefSpec<TMsg> {
  readonly name: FragmentId;
  readonly args: Readonly<Record<string, FragmentArg<TMsg>>>;
}

// ─── Mount — isolation/embedding boundary (Phase 265, §4o) ───────────────────
//
// The named primitive for embedding an isolated guest subtree at a point in a
// host tree (iframe-like composition). Port of F# `Fuaran.UI.Types.MountSpec`.
// The runtime, stateful, scoped counterpart to `FragmentRefSpec`: `inputs`
// reuses the FragmentArg hole-binding shape (config + initial host→guest state);
// the guest's own render tree is NOT carried here — only a scope reference — so
// the boundary interior is opaque (like `Custom`).

/** The direction a Mount's guest channel permits (§4o.4). `OutOnly` (default,
 * safe for untrusted guests) forbids host→guest push; `TwoWay` permits it. */
export type ChannelDirection = 'OutOnly' | 'TwoWay';

/** The declared out-channel of a Mount (§4o.4). `messageShape` optionally names
 * the guest message shape for validation + the capability gate; omitted at None. */
export interface GuestChannel {
  readonly direction: ChannelDirection;
  readonly messageShape?: string;
}

/** A per-Mount capability tag (§4o.4) — e.g. `"notify"`, `"call:reports.*"`. The
 * boundary's default-deny gate consults these; an empty list denies every
 * host-affecting guest action. */
export type CapabilityTag = string;

/**
 * The isolation/embedding boundary spec (Phase 265, §4o). `onBubble` (the host
 * handler for a guest-bubbled `Action<obj>`) is a closure — the `"<closure>"`
 * sentinel on the wire — so it is not carried structurally on this typed shape.
 */
export interface MountSpec<TMsg> {
  readonly scopeId: string;
  readonly inputs: Readonly<Record<string, FragmentArg<TMsg>>>;
  readonly channel: GuestChannel;
  readonly capabilities: readonly CapabilityTag[];
}

// ─── Layout — semantic intent, not pixel-pushing ─────────────────────────────

export type LayoutKind<TMsg> =
  // Phase 390 — the unified container primitive. Absorbs the retired
  // `Dashboard` / `Stack` / `Grid` (GridLayout) / `Card` near-synonyms into one
  // `Box` whose layout mode names how children arrange and whose role names what
  // the container means. The author-facing `DashboardSpec` / `StackSpec` /
  // `GridLayoutSpec` / `CardSpec` records survive as smart-ctor inputs; only the
  // wire vocabulary consolidates. Byte-exact wire is `{"$type":"Box", …}`.
  | { readonly kind: 'Box'; readonly spec: BoxSpec<TMsg> }
  | { readonly kind: 'SplitPanel'; readonly spec: SplitPanelSpec<TMsg> }
  | { readonly kind: 'Tabs'; readonly spec: TabsSpec<TMsg> }
  | { readonly kind: 'Stepper'; readonly spec: StepperSpec<TMsg> }
  | { readonly kind: 'SummaryList'; readonly spec: SummaryListSpec<TMsg> }
  | { readonly kind: 'Disclosure'; readonly spec: DisclosureSpec<TMsg> }
  | { readonly kind: 'Modal'; readonly spec: ModalSpec<TMsg> }
  | { readonly kind: 'ScrollArea'; readonly spec: ScrollAreaSpec<TMsg> };

// ─── Box — the unified container primitive (Phase 390) ───────────────────────
//
// Port of F# `BoxSpec` / `BoxLayout` / `BoxRole`. `layout` names how children
// arrange (Flex | Grid | Auto); `role` names what the container means (drives
// the emitted element + ARIA landmark + `fuaran-*` chrome). `heading` is the
// retired Card heading, emitted only when set.

/** How a `Box` arranges its children (port of F# `BoxLayout`). */
export type BoxLayout =
  // Flex flow — the retired Stack. `direction` is the main axis; `wrap` allows
  // children to wrap. `gap` is the canonical inter-child spacing control
  // (omitted on the wire when absent — byte-identical for existing trees).
  | {
      readonly kind: 'Flex';
      readonly direction: Orientation;
      readonly wrap: boolean;
      readonly gap?: number;
    }
  // Explicit grid — the retired GridLayout. `cols` fixed count, or
  // `templateColumns` verbatim `grid-template-columns` (present ⇒ `cols` ignored).
  | {
      readonly kind: 'Grid';
      readonly cols: number;
      readonly gap?: number;
      readonly templateColumns?: string;
    }
  // Responsive auto-tile — the retired Dashboard's defining behaviour. The
  // renderer owns the tiling; no author-supplied column count.
  | { readonly kind: 'Auto' };

/**
 * What a `Box` means — drives the emitted element, ARIA landmark, and chrome
 * (port of F# `BoxRole`). `Separator` is the retired `Divider`'s replacement
 * (Phase 459) — `separator()` / `divider()` emit a `Box` with this role,
 * rendering `<hr class="fuaran-layout-separator">`.
 */
export type BoxRole = 'Group' | 'Card' | 'Dashboard' | 'Separator';

/** The unified container spec (Phase 390). Port of F# `BoxSpec`. */
export interface BoxSpec<TMsg> {
  readonly layout: BoxLayout;
  readonly role: BoxRole;
  /** Optional container heading (the retired Card heading). Emitted only when set. */
  readonly heading?: TextSource;
  readonly children: readonly Node<TMsg>[];
}

// ── Author-facing container spec records — retained as smart-ctor inputs
//    (the authoring vocabulary is unchanged; only the wire consolidates). Each
//    `fuaran.*` ctor emits a `Box`; these shape the ctor options + defaults.

export interface DashboardSpec<TMsg> {
  readonly children: readonly Node<TMsg>[];
}

export interface StackSpec<TMsg> {
  readonly orientation: Orientation;
  readonly children: readonly Node<TMsg>[];
  readonly wrap: boolean;
}

export interface GridLayoutSpec<TMsg> {
  readonly cols: number;
  readonly children: readonly Node<TMsg>[];
  /** Phase 67: verbatim `grid-template-columns` escape; overrides `cols` when present. */
  readonly templateColumns?: string;
}

export interface SplitPanelSpec<TMsg> {
  readonly weight: number;
  readonly children: readonly Node<TMsg>[];
}

export interface TabsSpec<TMsg> {
  readonly orientation: Orientation;
  readonly children: readonly Node<TMsg>[];
  readonly activeIndex: Binding<number>;
  /**
   * Optional since Phase 426 (the control write-back default): omitted, a tab
   * click writes the clicked index back to a writable `activeIndex` binding
   * (`State` / `Filter`); a present handler dispatches exactly as before.
   */
  readonly onSelect?: (index: number) => Action<TMsg>;
  /** Phase 69: explicit per-tab headers; align 1:1 with `children` (FUARAN047). */
  readonly tabHeaders?: readonly TabHeader[];
  /** Phase 69: typed tab-tag overlay; align 1:1 with `children` (FUARAN048). */
  readonly tabTags?: readonly string[];
  readonly activeTag?: Binding<string>;
  /**
   * Phase 426: omitted with a populated `tabTags` overlay, a tab click writes
   * the clicked tag back to a writable `activeTag` binding.
   */
  readonly onSelectTag?: (tag: string) => Action<TMsg>;
}

export interface TabHeader {
  readonly label: TextSource;
  readonly icon?: IconSource;
  readonly disabled?: Binding<boolean>;
}

export interface CardSpec<TMsg> {
  readonly heading?: TextSource;
  readonly children: readonly Node<TMsg>[];
}

export interface StepperSpec<TMsg> {
  readonly activeStep: Binding<number>;
  readonly children: readonly Node<TMsg>[];
  /**
   * Dispatch when the user clicks a step header. The renderer calls this with
   * the clicked step index; the host typically dispatches a `SelectStep i`
   * message and the model-driven `activeStep` binding picks up the new value
   * on the next render. Defaults to a no-op `Chain []` — steps render and the
   * active styling tracks `activeStep`, but no dispatch fires on click.
   * Mirrors `TabsSpec.onSelect`.
   */
  readonly onSelect: (index: number) => Action<TMsg>;
}

export interface SummaryListSpec<TMsg> {
  readonly heading?: TextSource;
  readonly children: readonly Node<TMsg>[];
}

export interface DisclosureSpec<TMsg> {
  readonly heading: TextSource;
  readonly open: Binding<boolean>;
  /**
   * Optional since Phase 426 (the control write-back default): omitted, a
   * toggle writes the new open value back to a writable `open` binding.
   */
  readonly onToggle?: (open: boolean) => Action<TMsg>;
  readonly children: readonly Node<TMsg>[];
  readonly defaultOpen: boolean;
}

// §4n — the declarative, SSR-rendered modal overlay (Phase 289). `open` is the
// controlled visibility binding; `dismissable` adds a close affordance; `heading`
// captions the dialog when set. `onDismiss` is a full wire-survivable `Action`
// (encoded via the Action codec, NOT a closure sentinel) fired on backdrop /
// close-button click. Renders inline (no React portal), positioned by CSS;
// closed = the `hidden` attribute — so SSR and CSR are byte-identical.
export interface ModalSpec<TMsg> {
  readonly open: Binding<boolean>;
  readonly heading?: TextSource;
  readonly dismissable: boolean;
  readonly children: readonly Node<TMsg>[];
  /**
   * Optional since Phase 426 (the control write-back default): omitted, a
   * dismiss writes `false` back to a writable `open` binding — a decoded
   * dismissable modal closes itself with zero host code.
   */
  readonly onDismiss?: Action<TMsg>;
}

// An overflow / scroll container (Phase 289). `orientation` selects the scroll
// axis (CSS owns `overflow`); optional `maxHeight` / `maxWidth` (pixels) bound
// the viewport via inline `max-height` / `max-width`.
export interface ScrollAreaSpec<TMsg> {
  readonly orientation: ScrollOrientation;
  readonly children: readonly Node<TMsg>[];
  readonly maxHeight?: number;
  readonly maxWidth?: number;
}

// ─── Display — pure presentation, no Msg ─────────────────────────────────────
//
// The F# `DisplayKind<'Msg>` is generic for uniformity, but none of its cases
// reference `'Msg`. The TS port drops the type parameter — Display specs carry
// no actions.

export type DisplayKind =
  | { readonly kind: 'Heading'; readonly spec: HeadingSpec }
  | { readonly kind: 'Markdown'; readonly spec: MarkdownSpec }
  | { readonly kind: 'Metric'; readonly spec: MetricSpec }
  | { readonly kind: 'Badge'; readonly spec: BadgeSpec }
  | { readonly kind: 'Sparkline'; readonly spec: SparklineSpec }
  | { readonly kind: 'Callout'; readonly spec: CalloutSpec }
  | { readonly kind: 'Progress'; readonly spec: ProgressSpec }
  | { readonly kind: 'Skeleton'; readonly spec: SkeletonSpec }
  | { readonly kind: 'Icon'; readonly spec: IconSpec }
  | { readonly kind: 'LabelValueRow'; readonly spec: LabelValueRowSpec }
  | { readonly kind: 'Fact'; readonly spec: FactSpec }
  | { readonly kind: 'Link'; readonly spec: LinkSpec }
  | { readonly kind: 'Image'; readonly spec: ImageSpec }
  | { readonly kind: 'List'; readonly spec: ListSpec }
  | { readonly kind: 'Toast'; readonly spec: ToastSpec }
  | { readonly kind: 'CodeBlock'; readonly spec: CodeBlockSpec }
  | { readonly kind: 'Math'; readonly spec: MathSpec }
  | { readonly kind: 'Drawing'; readonly spec: DrawingSpec };

export interface HeadingSpec {
  readonly level: number;
  readonly text: TextSource;
  readonly variant: HeadingVariant;
}

export interface MarkdownSpec {
  readonly text: TextSource;
}

export interface MetricSpec {
  readonly label: TextSource;
  // 0.2.0 rename law: the scalar displayed value is `value` across
  // Metric / LabelValueRow / Fact; `source` is reserved for collection feeds.
  readonly value: Binding<number>;
  readonly format: CellFormat;
  readonly tone: ToneVariant;
  readonly weight: StyleWeight;
  readonly emphasis: Emphasis;
  readonly trend?: Binding<number>;
  readonly trendFormat?: CellFormat;
  readonly icon?: IconSource;
  readonly subtext?: TextSource;
}

export interface BadgeSpec {
  readonly label: TextSource;
  readonly variant: BadgeVariant;
}

// A crawlable hyperlink primitive (Phase 139). Renders a real `<a href>` in
// both the client and server renderers — followable with JavaScript disabled
// and visible to crawlers — distinct from `Button` + `Action.Navigate` (the
// SPA client-routing gesture). `href` is a `Binding<string>` (static or
// data-bound); the renderer routes it through the URL sanitizer. `rel` /
// `target` emit the matching anchor attributes when set; `download` emits a
// bare `download` attribute.
export interface LinkSpec {
  readonly href: Binding<string>;
  readonly label: TextSource;
  readonly rel?: string;
  readonly target?: string;
  readonly download: boolean;
  readonly protection?: LinkProtection;
}

// Anti-scraper render strategy for a `Link` (Phase 812). `email` marks a
// `mailto:` link whose address must not appear in plaintext in emitted HTML —
// the renderers own the emission strategy (the server renderer emits href +
// label entity-encoded per character; the client sets the decoded href).
// Omitted on the wire when absent, so every pre-existing tree is
// byte-identical.
export type LinkProtection = 'email';

// A crawlable `<img>` primitive (Phase 287). `src` is a `Binding<string>`
// routed through the URL sanitizer at render time (like `Link.href`); `alt` is
// mandatory; `variant` appends an Avatar / Rounded class.
export interface ImageSpec {
  readonly src: Binding<string>;
  readonly alt: TextSource;
  readonly variant: ImageVariant;
}

// An ordered (`<ol>`) / unordered (`<ul>`) list of item texts (Phase 287).
export interface ListSpec {
  readonly items: readonly TextSource[];
  readonly ordered: boolean;
}

// A declarative, in-tree, SSR-rendered notification surface (Phase 289). `open`
// is the controlled visibility binding (resolves `true` → shown); `tone`
// selects the status colour; `dismissable` adds a close affordance. Renders
// inline (no portal), positioned by CSS, with `role="status"` + an `aria-live`
// region — see the overlay render-fidelity contract.
export interface ToastSpec {
  readonly message: TextSource;
  readonly tone: ToneVariant;
  readonly open: Binding<boolean>;
  readonly dismissable: boolean;
}

// A deterministic `<pre><code>` source block (Phase 290). `code` is the raw
// source text (HTML-escaped at render time, NO markdown library); `language` is
// the language hint the client-only syntax-highlighting enhancement keys off via
// the `language-{x}` class; `lineNumbers` toggles a CSS-counter gutter;
// `highlightLines` is the (possibly empty) set of 1-based lines to emphasise
// (the `data-highlight-lines` attribute the enhancement reads); `copyable` adds
// a copy affordance. All five fields are required + carry plain values (no
// bindings) — syntax highlighting is explicitly outside the parity output.
export interface CodeBlockSpec {
  readonly code: string;
  readonly language: string;
  readonly lineNumbers: boolean;
  readonly highlightLines: readonly number[];
  readonly copyable: boolean;
}

// A deterministic math primitive (Phase 293). `source` is the LaTeX source the
// renderer emits verbatim (escaped) in a known container; `display` selects
// inline (`<span>`) vs block (`<div>`) presentation. KaTeX upgrades it
// client-only post-hydration (targets `.fuaran-math-source`), outside parity.
export interface MathSpec {
  readonly source: string;
  readonly display: MathDisplay;
}

export interface SparklineSpec {
  readonly source: Binding<readonly number[]>;
}

// ─── Drawing (Phase 524) ─────────────────────────────────────────────────────
//
// A bounded, typed vector-graphics primitive — the shared render target every
// `Chart` lowers to (Phase 526) and the substrate for maps/diagrams. Geometry
// is static (a Drawing is a resolved artefact); only `DrawStyle` carries
// bindings. The `Shape` DU is closed + typed — no raw SVG / `Path` / `d` string.

// The user-space coordinate box (SVG `viewBox` semantics).
export interface ViewBox {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
}

export interface DrawPoint {
  readonly x: number;
  readonly y: number;
}

// SVG `text-anchor` for `Shape.Label` — Start | Middle | End (→ start/middle/end).
export type TextAnchor = 'Start' | 'Middle' | 'End';

// Fill/stroke bindings; every field optional (omitted → inherits the renderer
// default). `fill`/`stroke` are colour strings; `strokeWidth`/`opacity` numbers.
// The text-only fields (Phase 528.1) style `Shape.Label`: alignment, font-family,
// font-size (px), and weight (reusing `Emphasis` → 300/400/700). Omitted-when-unset,
// so non-text shapes and pre-528.1 fixtures are byte-unchanged.
export interface DrawStyle {
  readonly fill?: Binding<string>;
  readonly stroke?: Binding<string>;
  readonly strokeWidth?: Binding<number>;
  readonly opacity?: Binding<number>;
  readonly textAnchor?: TextAnchor;
  readonly fontSize?: number;
  readonly emphasis?: Emphasis;
  readonly fontFamily?: string;
  /**
   * Phase 642 — a derivation-based mark identity for a data-bearing shape
   * (object constancy): the chart lowering stamps `series-field|category-key`
   * so a mark's identity survives row reorder, data refresh, and the wire —
   * the anchor every future attachment addresses, never an ordinal index.
   * Renderers emit it as `data-fuaran-mark`. Omitted-when-unset: chrome shapes
   * and hand-authored drawings are byte-unchanged.
   */
  readonly markId?: string;
  /**
   * Phase 877 — clockwise text rotation in DEGREES about the label's own
   * anchor point (`Shape.Label`'s `x` / `y`). Renderers emit
   * `transform="rotate(θ x y)"` on the `<text>` element, so the anchor is the
   * pivot and `textAnchor` keeps its meaning in the rotated frame.
   *
   * Like the other text fields it applies only to `Label` and is ignored on
   * every other shape — and here that is load-bearing rather than cosmetic:
   * SVG's `transform` on a `<rect>` would MOVE GEOMETRY, so emitting it off
   * `Label` would make this the one text field with side-effects elsewhere.
   *
   * Omitted-when-unset, so every pre-877 drawing is byte-unchanged. Note that
   * `0` is a legitimate PRESENT value and is not the same wire shape as
   * absent — encode with an `!== undefined` test, never a truthiness test.
   *
   * Rounding (2 dp, round-half-up) is an authoring discipline applied by the
   * producing tier; the wire value is taken as-authored and no host re-rounds
   * on decode.
   */
  readonly rotation?: number;
  /**
   * Phase 883 — the mark's hover-readable text. Renderers emit it as an SVG
   * `<title>` element that is the FIRST CHILD of that shape's own element:
   * the native browser tooltip and the element's accessible name, with no
   * script, so a statically-served page carries the readout too.
   *
   * Unlike the Phase 528.1 text cluster and `rotation`, this applies to EVERY
   * shape, not just `Label` — the marks a reader hovers are bars, wedges and
   * points, and a `<title>` child is inert geometry-wise everywhere.
   *
   * The emission consequence to get right: a TIPPED shape cannot be emitted
   * self-closing — `<rect …/>` becomes `<rect …><title>…</title></rect>`. An
   * absent tip leaves the emitted bytes unchanged, self-closing tag included.
   *
   * Omitted-when-unset. Note that an EMPTY STRING tip is a legitimate PRESENT
   * value and is not the same wire shape as absent — encode with a
   * `!== undefined` test, never a truthiness test, exactly as for `rotation`'s
   * explicit `0`.
   */
  readonly tip?: TextSource;
}

// The typed drawing-command list for `Shape.Curve` — the `Path`/`d`-string
// replacement (there is no `Path` shape). Internal discriminant is `kind`; the
// wire discriminator is `$type`.
export type CurveCommand =
  | { readonly kind: 'MoveTo'; readonly to: DrawPoint }
  | { readonly kind: 'LineTo'; readonly to: DrawPoint }
  | {
      readonly kind: 'CubicTo';
      readonly control1: DrawPoint;
      readonly control2: DrawPoint;
      readonly to: DrawPoint;
    }
  | { readonly kind: 'QuadraticTo'; readonly control: DrawPoint; readonly to: DrawPoint }
  | { readonly kind: 'Close' };

// The closed, typed shape vocabulary. `Rectangle` (not `Rect`), `Label` (not
// `Text`) — chosen for the data-science audience.
export type Shape =
  | { readonly kind: 'Group'; readonly children: readonly Shape[]; readonly style: DrawStyle }
  | {
      readonly kind: 'Rectangle';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly cornerRadius?: number;
      readonly style: DrawStyle;
    }
  | {
      readonly kind: 'Line';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly style: DrawStyle;
    }
  | { readonly kind: 'Polyline'; readonly points: readonly DrawPoint[]; readonly style: DrawStyle }
  | { readonly kind: 'Polygon'; readonly points: readonly DrawPoint[]; readonly style: DrawStyle }
  | {
      readonly kind: 'Curve';
      readonly commands: readonly CurveCommand[];
      readonly style: DrawStyle;
    }
  | {
      readonly kind: 'Circle';
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly style: DrawStyle;
    }
  | {
      readonly kind: 'Ellipse';
      readonly cx: number;
      readonly cy: number;
      readonly rx: number;
      readonly ry: number;
      readonly style: DrawStyle;
    }
  | {
      readonly kind: 'Label';
      readonly x: number;
      readonly y: number;
      readonly text: TextSource;
      readonly style: DrawStyle;
    };

export interface DrawingSpec {
  readonly viewBox: ViewBox;
  readonly shapes: readonly Shape[];
  readonly style: DrawStyle;
  readonly title?: TextSource;
  readonly description?: TextSource;
}

export interface SkeletonSpec {
  readonly rows: number;
}

/** Icon glyph size for the standalone `Icon` display kind (Phase 821). */
export type IconSize = 'Small' | 'Medium' | 'Large';

/**
 * Phase 821 — the standalone icon-only display kind: a decorative or labelled
 * glyph with no Button / Image envelope. `icon` names a glyph from the existing
 * icon vocabulary (the `data-icon` hook); `label` absent is decorative
 * (`aria-hidden="true"`), present is meaningful (`role="img"` + `aria-label`).
 */
export interface IconSpec {
  readonly icon: string;
  readonly size: IconSize;
  readonly tone: ToneVariant;
  readonly label?: string;
}

export interface CalloutSpec {
  readonly tone: ToneVariant;
  readonly heading?: TextSource;
  readonly body: TextSource;
  readonly icon?: IconSource;
  readonly dismissable: boolean;
}

export interface ProgressSpec {
  readonly fraction: Binding<number>;
  readonly label?: TextSource;
  readonly caveat?: TextSource;
  readonly indeterminate: boolean;
  readonly tone: ToneVariant;
}

export interface LabelValueRowSpec {
  readonly label: TextSource;
  readonly value: Binding<number>;
  readonly format: CellFormat;
  readonly emphasis: boolean;
  readonly help?: TextSource;
}

/**
 * A labeled TEXT fact — "Patient: Alice Smith". The complementary kind to the
 * numeric `Metric`/`LabelValueRow` (2026-07-17: the launch eval showed every
 * frontier model forcing text facts into Metric's numeric source — the missing
 * kind was the defect, not the type error). `value` is a TextSource, so
 * static / Bound / I18n values ride the label vocabulary.
 */
export interface FactSpec {
  readonly label: TextSource;
  readonly value: TextSource;
  readonly icon?: IconSource;
  readonly tone: ToneVariant;
  readonly emphasis: boolean;
  readonly help?: TextSource;
}

// ─── Input — interactive, carries Msg via Action<TMsg> ───────────────────────

export type InputKind<TMsg> =
  | { readonly kind: 'Form'; readonly spec: FormSpec<TMsg> }
  | { readonly kind: 'Filters'; readonly specs: readonly FilterSpec<TMsg>[] }
  | { readonly kind: 'Button'; readonly spec: ButtonSpec<TMsg> }
  | { readonly kind: 'FileUpload'; readonly spec: FileUploadSpec<TMsg> }
  | { readonly kind: 'Select'; readonly spec: SelectSpec<TMsg> };

export interface ButtonSpec<TMsg> {
  readonly label: TextSource;
  readonly onClick: Action<TMsg>;
  readonly variant: ButtonVariant;
  readonly icon?: IconSource;
  readonly tooltip?: TextSource;
  /**
   * Optional bound disabled-state. Absent (the default) means the button is
   * always enabled; when present, the button is disabled whenever the bound
   * `boolean` resolves `true` — the canonical "disabled while a calc is in
   * flight" shape. The renderer emits the HTML `disabled` attribute when the
   * binding resolves `true` and omits it otherwise. ReplaceBinding-able +
   * introspectable under the slot name `Disabled` (mirrors `MetricSpec.trend`
   * / `TabsSpec.activeTag`).
   */
  readonly disabled?: Binding<boolean>;
}

export interface SelectSpec<TMsg> {
  readonly label: TextSource;
  readonly source: Binding<readonly SelectOption[]>;
  readonly value: Binding<string | undefined>;
  /**
   * Optional since Phase 426 (the control write-back default): omitted, the
   * renderer writes the chosen option back to a writable `value` binding
   * (`State` / `Filter`; a cleared choice clears the slot); a present handler
   * dispatches exactly as before (`"onChange":"<closure>"`, byte-stable).
   */
  readonly onChange?: (value: string | undefined) => Action<TMsg>;
  readonly placeholder?: TextSource;
  /**
   * Optional bound disabled-state (Phase 130 — the interactive-state class-fix
   * generalising `ButtonSpec.disabled`). Absent (the default) means the select
   * is always enabled; when present, the `<select>` is disabled whenever the
   * bound `boolean` resolves `true`. ReplaceBinding-able + introspectable under
   * the slot name `Disabled`.
   */
  readonly disabled?: Binding<boolean>;
  /**
   * Multi-select flag (Phase 291). `false`/absent (the default) is
   * single-select — `value` / `onChange` carry the chosen option, and the field
   * is omitted on the wire (the degenerate case stays byte-identical to
   * pre-multi-select fixtures). When `true`, the renderer emits a
   * `<select multiple>` and the selection is carried by `values` (a list).
   */
  readonly multiple?: boolean;
  /**
   * The multi-select value binding (Phase 291). Absent for single-select
   * (omitted on the wire); present when `multiple` — resolves to the list of
   * selected option values. ReplaceBinding-able + introspectable under the
   * slot name `Values`.
   */
  readonly values?: Binding<readonly string[]>;
  /**
   * The multi-select change handler (Phase 426): rides the wire as its own
   * `"onChangeMulti":"<closure>"` sentinel when present; omitted, a change
   * writes the selected list back to a writable `values` binding.
   */
  readonly onChangeMulti?: (values: readonly string[]) => Action<TMsg>;
}

export interface SelectOption {
  readonly value: string;
  readonly label: TextSource;
}

export interface FormSpec<TMsg> {
  readonly fields: readonly FormField<TMsg>[];
  readonly onSubmit: Action<TMsg>;
  readonly submitLabel: TextSource;
  /**
   * Optional bound form-level disabled-state (Phase 130 — the interactive-state
   * class-fix generalising `ButtonSpec.disabled`). Absent (the default) leaves
   * the form enabled; when present, the renderer wraps the fields + submit in a
   * `<fieldset disabled>` (native HTML cascade) so every descendant control is
   * disabled whenever the bound `boolean` resolves `true`. ReplaceBinding-able +
   * introspectable under the slot name `Disabled`.
   */
  readonly disabled?: Binding<boolean>;
}

export interface FormField<TMsg> {
  readonly id: string;
  readonly label: TextSource;
  readonly kind: FormFieldKind<TMsg>;
  readonly required: boolean;
  readonly help?: TextSource;
}

// Every handler is optional (Phase 426 — the control write-back default,
// generalising `FilterKind.onChange`'s Phase 423 mechanics). A present handler
// dispatches exactly as before (`"<closure>"` sentinel on the wire); omitted —
// the AI-authored / decoded shape — the renderer writes the typed change back
// to the field's own `value` binding when that binding is directly
// `State`/`Filter` (any other shape is inert — FUARAN069).
export type FormFieldKind<TMsg> =
  | {
      readonly kind: 'Text';
      readonly value: Binding<string>;
      readonly onChange?: (value: string) => Action<TMsg>;
    }
  | {
      readonly kind: 'Number';
      readonly value: Binding<number>;
      readonly onChange?: (value: number) => Action<TMsg>;
    }
  | {
      readonly kind: 'Checkbox';
      readonly value: Binding<boolean>;
      readonly onToggle?: (value: boolean) => Action<TMsg>;
    }
  /**
   * The on/off SWITCH affordance. Identical data to `Checkbox` — a boolean with
   * the same write-back — but a different control and, the part that matters, a
   * different a11y contract: `role="switch"` + `aria-checked`, announced as
   * on/off rather than checked.
   */
  | {
      readonly kind: 'Toggle';
      readonly value: Binding<boolean>;
      readonly onToggle?: (value: boolean) => Action<TMsg>;
    }
  | {
      readonly kind: 'Choice';
      readonly options: Binding<readonly SelectOption[]>;
      readonly value: Binding<string | undefined>;
      readonly onChange?: (value: string | undefined) => Action<TMsg>;
    }
  | {
      readonly kind: 'TextArea';
      readonly value: Binding<string>;
      readonly onChange?: (value: string) => Action<TMsg>;
      readonly rows: number;
    }
  | {
      // 0.2.0 — dual-thumb numeric range (absorbed FilterKind.RangeFilter).
      readonly kind: 'Range';
      readonly value: Binding<readonly [number, number]>;
      readonly onChange?: (value: readonly [number, number]) => Action<TMsg>;
      readonly constraints?: NumberFieldConstraints;
    }
  | {
      readonly kind: 'RangedNumber';
      readonly value: Binding<number>;
      readonly onChange?: (value: number) => Action<TMsg>;
      readonly constraints: NumberFieldConstraints;
    }
  | {
      readonly kind: 'SegmentedChoice';
      readonly options: Binding<readonly SelectOption[]>;
      readonly value: Binding<string | undefined>;
      readonly onChange?: (value: string | undefined) => Action<TMsg>;
      readonly orientation: Orientation;
    }
  | {
      // Phase 288 — native date / time / datetime control. The bound `value` is
      // an ISO-8601 string; `variant` chooses the native input; optional `min` /
      // `max` are ISO strings, `step` is seconds. Mirrors `RangedNumber`'s
      // omit-when-undefined discipline for the bound fields.
      readonly kind: 'Date';
      readonly value: Binding<string>;
      readonly onChange?: (value: string) => Action<TMsg>;
      readonly variant: DateVariant;
      readonly constraints: DateFieldConstraints;
    }
  | {
      // Phase 725 — single-control date range: `Range`'s pair mechanics with
      // `Date`'s value conventions. The bound value is the ordered `(from, to)`
      // pair, each end an ISO-8601 string in the `variant`'s shape; it rides
      // the wire as the bare `{from, to}` object (no `Static` envelope — the
      // `Range` posture) and is held in memory as a two-element tuple (also the
      // `Range` precedent). A LITERAL pair must satisfy `from <= to` by ordinal
      // compare — the decoder rejects an inverted one (`WRONG_TYPE`); a bound
      // pair's ordering is a runtime concern. `variant` chooses the native
      // input; the optional `min` / `max` (ISO strings) + `step` (seconds)
      // bound BOTH ends, mirroring `Date`'s omit-when-undefined discipline.
      readonly kind: 'DateRange';
      readonly value: Binding<readonly [string, string]>;
      readonly onChange?: (value: readonly [string, string]) => Action<TMsg>;
      readonly variant: DateVariant;
      readonly constraints: DateFieldConstraints;
    };

/**
 * The emittable `FormFieldKind` vocabulary — one entry per wire `kind.$type` a
 * conformant host encodes/decodes in a control position. ONE vocabulary, two
 * carriers: a `Form` spec's `fields[]` and a `Filters` spec's `items[]`
 * (WIRE_FORMAT.md §11.2).
 *
 * This is the SINGLE enumeration, on the `NODE_KIND_NAMES` pattern: `@fuaran-ui/ops`
 * projects the control decoder's `UNKNOWN_DU_CASE` hint from it, and the corpus
 * suite pins it against the generated manifest `formFieldKinds` array — so a case
 * added here reaches both, and neither can fall behind the other. Before this
 * existed the vocabulary was a hand-typed hint string per host, which is how
 * `DateRange` shipped into the corpus and sat unadopted in four hosts with every
 * gate green.
 *
 * The order is the cross-host contract (it is the hint's order); keep it in step
 * with the sibling hosts rather than sorting it.
 */
export const FORM_FIELD_KIND_NAMES: readonly string[] = [
  'Text',
  'Number',
  'Checkbox',
  'Toggle',
  'Choice',
  'Range',
  'RangedNumber',
  'SegmentedChoice',
  'TextArea',
  'Date',
  'DateRange',
];

export interface NumberFieldConstraints {
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

/** Optional date/time-field bounds (Phase 288). `min` / `max` are ISO-8601
 *  strings; `step` is seconds. Absent ⇒ the renderer omits the HTML attribute. */
export interface DateFieldConstraints {
  readonly min?: string;
  readonly max?: string;
  readonly step?: number;
}

/**
 * 0.2.0 filters-unification: the chip's control is an ordinary
 * `FormFieldKind` — one control vocabulary for forms and filter strips.
 * A control whose `value` binding is omitted on the wire decodes to
 * `Filter(name)` (the item's declared name IS the store key). The old
 * parallel FilterKind family is retired (pre-launch clean break).
 */
export interface FilterSpec<TMsg> {
  readonly name: string;
  readonly label: TextSource;
  readonly field: FormFieldKind<TMsg>;
}

export interface FileUploadSpec<TMsg> {
  readonly label: TextSource;
  readonly accept: readonly string[];
  readonly multiple: boolean;
  readonly onSelect: (files: readonly FileSelection[]) => Action<TMsg>;
  /**
   * Optional bound disabled-state (Phase 130 — the interactive-state class-fix
   * generalising `ButtonSpec.disabled`). Absent (the default) leaves the upload
   * control enabled; when present, the `<input type=file>` is disabled whenever
   * the bound `boolean` resolves `true`. ReplaceBinding-able + introspectable
   * under the slot name `Disabled`.
   */
  readonly disabled?: Binding<boolean>;
}

/**
 * Requested encoding for `Action.ReadFileBody` (Phase 136). The renderer's
 * default browser impl maps each to a `FileReader` projection. Encodes as a
 * bare-string enum on the wire (WIRE_FORMAT §3.5).
 *  - `Text`    → `readAsText` (CSV / JSON / plain text)
 *  - `Base64`  → the file's bytes base64-encoded with no data-URL prefix
 *  - `DataUrl` → the full `data:<mime>;base64,…` string
 */
export type FileReadEncoding = 'Text' | 'Base64' | 'DataUrl';

/**
 * An opaque, host-held reference to a user-selected file's blob (Phase 136).
 * `id` is a renderer-assigned token — the ONLY part that serialises (a blob
 * cannot cross the wire). `handle` carries the actual browser `File` on
 * browser hosts so `Action.ReadFileBody` can read it without consumer-side
 * `FileReader` interop; it is absent on non-browser hosts and on decoded trees.
 */
export interface FileRef {
  readonly id: string;
  readonly handle?: unknown;
}

export interface FileSelection {
  readonly name: string;
  readonly size: number;
  readonly mimeType: string;
  /**
   * Phase 136 — opaque handle to the selected file's blob, so `onSelect` can
   * chain `Action.ReadFileBody` to ingest the body. Carries the browser `File`
   * on `ref.handle` browser-side; only `ref.id` ever serialises.
   */
  readonly ref: FileRef;
}

// ─── Visualisation — data-bound, complex ─────────────────────────────────────

export type VisKind<TMsg> =
  | { readonly kind: 'Grid'; readonly spec: GridSpec<TMsg> }
  | { readonly kind: 'Chart'; readonly spec: ChartSpec<TMsg> }
  // Phase 393 — the `Table` case is retired; static read-only tables are the
  // `GridSpec.staticRows` mode of `Grid`. A legacy `Table` wire tag decode-upgrades
  // into a read-only `Grid` (never re-encodes as `Table`).
  | { readonly kind: 'Map'; readonly spec: MapSpec<TMsg> };

/**
 * Tree-level grid spec. Row-typed fields are erased to `unknown` (the TS
 * analogue of the F# `obj`-erasure boundary) because `Node<TMsg>` cannot
 * carry the row type parameter. The author surface is the typed
 * `GridSpecOf<TRow, TMsg>`, which `fuaran.grid` erases into this shape.
 */
export interface GridSpec<TMsg> {
  readonly source: Binding<readonly unknown[]>;
  // Phase 425 — `rowKey` (closure) is optional; `rowKeyField` names a row property for the key. A
  // decoded grid uses the field for stable identity with zero host code. Closure wins when both present.
  readonly rowKey?: (row: unknown) => string;
  readonly rowKeyField?: string;
  // Phase 818 — the grid-sort header affordance for a DATA-BOUND grid: names
  // the State key carrying the sort descriptor
  // `{"column": <index>, "direction": "asc"|"desc"}`. When set, the runtime
  // renders sortable column headers (a header click writes the toggled
  // descriptor via the SetState path) and sorts its resolved rows by the
  // state-carried descriptor before rendering. Sorting keys off the clicked
  // column's `field` — a field-less closure column renders without the
  // affordance. Omitted on the wire when absent; `staticRows`' own Phase-801
  // sort intent is untouched.
  readonly sortStateKey?: string;
  // Phase 862 — declarative pagination, the second instance of the
  // grid-behaviour rule (Phase 860's charter): a behaviour the user drives
  // names the State key the grid both writes and reads. `pageStateKey` carries
  // the descriptor `{"page": <1-based int>}`; `pageSize` is how many rows a
  // page holds. When both are set the runtime renders a pager and shows one
  // page at a time; the pager is renderer-owned, so a decorative pager (a
  // button writing state nothing reads) cannot be authored. Where the source is
  // a `Query` whose `dependsOn` names the page key, the HOST pages and the grid
  // does not slice. Both omitted on the wire when absent.
  readonly pageSize?: number;
  readonly pageStateKey?: string;
  // Phase 861 — the bound path's declared INITIAL order, reusing the same
  // `DefaultSort` record and field name `staticRows` carries (Phase 801): same
  // behaviour, same spelling, no twin. It applies while the sort state key
  // carries nothing; once the user has sorted, the state wins. A grid may
  // declare it with no `sortStateKey` at all — an initial order without
  // interactive re-sorting.
  readonly defaultSort?: DefaultSort;
  // Phase 863 — the DECLARED edit destination: the State key an edited cell's
  // whole updated rows value commits to. Absent keeps Phase 663's shipped
  // behaviour (write back to the grid's own State `source`). Present, it names
  // the destination explicitly — what census row #27 asked for, since the only
  // previous spelling was a closure erasing to "<closure>".
  readonly editStateKey?: string;
  readonly columns: readonly ColumnErased<TMsg>[];
  readonly onRowClick?: (row: unknown) => Action<TMsg>;
  readonly editable: boolean;
  // Phase 393 — the static read-only mode. When present, this grid is a static text table
  // folded in from the retired `Table`: the renderer emits semantic `<table>` markup from
  // these `TextSource` cells and ignores `source` / `columns`. Absent for a data-bound grid,
  // so every existing grid fixture stays byte-identical. A legacy `Table` document
  // decode-upgrades into a grid with this field set.
  // Phase 801 — `sortable` / `defaultSort` are the declarative sort intent. Both optional;
  // both absent is the pre-801 wire byte-for-byte. `sortable` declares what the table
  // INVITES, not what a host guarantees; `defaultSort` is an initial presentation order,
  // distinct from the transform pipeline's data `sort`.
  readonly staticRows?: {
    readonly headers: readonly TextSource[];
    readonly rows: readonly (readonly TextSource[])[];
    readonly sortable?: boolean;
    readonly defaultSort?: DefaultSort;
  };
}

/**
 * A static table's declared initial order (Phase 801). `column` is a NON-NEGATIVE index
 * into `staticRows.headers`; `direction` is the closed two-value wire enum. An index past
 * the end of `headers` is deliberately not a decode error — it is a relation between two
 * sibling values, which a per-object codec does not judge.
 */
export interface DefaultSort {
  readonly column: number;
  readonly direction: SortDirection;
}

/** Sort direction on a `DefaultSort` (Phase 801) — lower-case on the wire. */
export type SortDirection = 'asc' | 'desc';

/** Typed author-facing facade for `GridSpec`. `fuaran.grid` erases it. */
export interface GridSpecOf<TRow, TMsg> {
  readonly source: Binding<readonly TRow[]>;
  readonly rowKey: (row: TRow) => string;
  readonly columns: readonly Column<TRow, TMsg>[];
  readonly onRowClick?: (row: TRow) => Action<TMsg>;
  readonly editable: boolean;
}

export interface Column<TRow, TMsg> {
  readonly label: string;
  readonly value: (row: TRow) => CellValue;
  readonly format: CellFormat;
  readonly kind: CellKind<TRow, TMsg>;
  readonly width: ColumnWidth;
}

/** Tree-level row-erased `Column`. `column.erase` boxes a typed `Column`. */
export interface ColumnErased<TMsg> {
  readonly label: string;
  // Phase 425 — `value` (closure) is optional; `field` names a row property projected to the cell.
  // A decoded column renders from `field` with zero host code. Closure wins when both present.
  readonly value?: (row: unknown) => CellValue;
  readonly field?: string;
  // Phase 861 — per-column sort NARROWING on the bound path (Phase 860's
  // charter rule: a column flag narrows a behaviour, never widens it). Absent =
  // inherit, i.e. sortable iff the column has a `field` and the grid declares
  // `sortStateKey`. `false` opts this column out. `true` is the inherited
  // default made explicit and is an ERROR where the grid declares no
  // `sortStateKey`. Omitted on the wire when absent.
  readonly sortable?: boolean;
  // Phase 863 — per-column EDITABILITY narrowing, the same rule on the write
  // side. Absent = inherit the grid-level `editable`. `false` makes this column
  // read-only under a grid-level `true` — the declaration "read-only implied by
  // omission" could not express. `true` under a non-editable grid is an ERROR:
  // a column narrows, never widens. Omitted on the wire when absent.
  readonly editable?: boolean;
  readonly format: CellFormat;
  readonly kind: CellKindErased<TMsg>;
  readonly width: ColumnWidth;
}

export type CellKind<TRow, TMsg> =
  | { readonly kind: 'Text' }
  | { readonly kind: 'Numeric' }
  | { readonly kind: 'Date' }
  | { readonly kind: 'Editable'; readonly onEdit: (row: TRow, value: CellValue) => Action<TMsg> }
  | {
      readonly kind: 'Checkbox';
      readonly get: (row: TRow) => boolean;
      readonly onToggle: (row: TRow, value: boolean) => Action<TMsg>;
    }
  | {
      readonly kind: 'Button';
      readonly label: TextSource;
      readonly onClick: (row: TRow) => Action<TMsg>;
    }
  | {
      readonly kind: 'ButtonGroup';
      readonly buttons: readonly (readonly [TextSource, (row: TRow) => Action<TMsg>])[];
    }
  | {
      readonly kind: 'Link';
      readonly href: (row: TRow) => string;
      readonly label: (row: TRow) => TextSource;
    }
  | {
      readonly kind: 'Pill';
      readonly label: (row: TRow) => TextSource;
      readonly tone: (row: TRow) => ToneVariant;
    }
  /**
   * Phase 750 — the declarative twin of `Pill`, and the only cell kind carrying no
   * closure: `field` names the row property that supplies both the pill's label and
   * the tone-map key, `map` gives the tone for each value it mentions, and
   * `defaultTone` tones a value it does not (omitted on the wire at `Default`).
   * Row-type-free by construction, which is why it survives the wire where `Pill`
   * erases to two sentinels.
   */
  | {
      readonly kind: 'TonedPill';
      readonly field: string;
      readonly map: Readonly<Record<string, ToneVariant>>;
      readonly defaultTone: ToneVariant;
    }
  | {
      readonly kind: 'Progress';
      readonly fraction: (row: TRow) => number;
      readonly label?: (row: TRow) => TextSource;
    }
  | { readonly kind: 'Custom'; readonly render: (jsonOf: (row: TRow) => JsonValue) => Node<TMsg> };

export type CellKindErased<TMsg> =
  | { readonly kind: 'Text' }
  | { readonly kind: 'Numeric' }
  | { readonly kind: 'Date' }
  | { readonly kind: 'Editable'; readonly onEdit: (row: unknown, value: CellValue) => Action<TMsg> }
  | {
      readonly kind: 'Checkbox';
      readonly get: (row: unknown) => boolean;
      readonly onToggle: (row: unknown, value: boolean) => Action<TMsg>;
    }
  | {
      readonly kind: 'Button';
      readonly label: TextSource;
      readonly onClick: (row: unknown) => Action<TMsg>;
    }
  | {
      readonly kind: 'ButtonGroup';
      readonly buttons: readonly (readonly [TextSource, (row: unknown) => Action<TMsg>])[];
    }
  | {
      readonly kind: 'Link';
      readonly href: (row: unknown) => string;
      readonly label: (row: unknown) => TextSource;
    }
  | {
      readonly kind: 'Pill';
      readonly label: (row: unknown) => TextSource;
      readonly tone: (row: unknown) => ToneVariant;
    }
  /**
   * Phase 750 — the declarative twin of `Pill`, and the only cell kind carrying no
   * closure: `field` names the row property that supplies both the pill's label and
   * the tone-map key, `map` gives the tone for each value it mentions, and
   * `defaultTone` tones a value it does not (omitted on the wire at `Default`).
   * Row-type-free by construction, which is why it survives the wire where `Pill`
   * erases to two sentinels.
   */
  | {
      readonly kind: 'TonedPill';
      readonly field: string;
      readonly map: Readonly<Record<string, ToneVariant>>;
      readonly defaultTone: ToneVariant;
    }
  | {
      readonly kind: 'Progress';
      readonly fraction: (row: unknown) => number;
      readonly label?: (row: unknown) => TextSource;
    }
  | {
      readonly kind: 'Custom';
      readonly render: (jsonOf: (row: unknown) => JsonValue) => Node<TMsg>;
    };

export interface ChartSpec<TMsg> {
  readonly source: Binding<readonly unknown[]>;
  readonly kind: ChartKind;
  readonly xField: string;
  readonly yFields: readonly string[];
  readonly title?: TextSource;
  // Phase 876 — the VALUE axis's number format, reusing the existing `Format`
  // vocabulary. A semantic declaration ("these numbers are pounds / a ratio"),
  // which is why it is a wire field where the chart STYLE is not. Absent means
  // no declared meaning — the lowering still applies its canonical default
  // rendering (thousands separators + step-derived decimals).
  readonly valueFormat?: Format;
  // Phase 878 — the axis NAMES and the muted subtitle. Wire fields for the same
  // reason `title` is one and the chart STYLE is not: what an axis is CALLED is
  // the author's meaning; where and how it is drawn is the host's appearance.
  //
  // Absent is the ORDINARY shape, not an opt-out — each axis title falls back to
  // its capitalised field name, so an axis is never nameless. An explicit
  // `subtitle` additionally SUPPRESSES the lowering's own display-unit label:
  // the author has stated the units, so the machine does not repeat them.
  readonly xTitle?: TextSource;
  readonly yTitle?: TextSource;
  readonly subtitle?: TextSource;
  // Phase 880 — WHERE the legend sits, and whether it sits anywhere at all.
  // Semantic for the same reason the titles above are: the edge an author wants
  // the legend on is their meaning; the column widths and pitches that realise
  // it are the host's.
  //
  // Absent means "the host's default" (`Right`) — NOT "no legend"; suppression
  // is the explicit `'None'`. So absence stays the ordinary shape and is omitted
  // on the wire, and an author who wants no legend says so.
  readonly legendPosition?: ChartLegendPosition;
  // Phase 881 — whether the values are written onto the picture. Semantic in
  // the same way: whether a reader is meant to read the NUMBERS or the shape
  // is the author's meaning; the type size, the offsets and the fit rule that
  // decide whether a given label draws are the host's.
  //
  // Absent means `'Off'`, and `'Off'` is also the default — the one place this
  // differs from `legendPosition`, deliberately: a legend is chrome an author
  // opts OUT of, where a data label is ink an author opts IN to. So an absent
  // field is byte-identical to the pre-881 wire AND to the pre-881 picture.
  readonly dataLabels?: ChartDataLabels;
  // Phase 882 — what the x column MEANS: discrete categories, or dates on a
  // continuous temporal scale. Semantic in the same way: whether a column is a
  // set of categories or a run of dates is a fact about the data; the tick
  // ladder, the label format and the margins that realise it are the host's.
  //
  // Absent means `'Category'`, which is also the shipped default, so an absent
  // field is byte-identical to the pre-882 wire AND to the pre-882 picture.
  // `'Temporal'` is a DECLARATION the pre-emit validator grounds against the
  // column type (`FUARAN097`) — never an inference from the data, which would
  // make the same tree draw differently depending on where its rows came from.
  readonly xScale?: ChartXScale;
  readonly onPointClick?: (point: unknown) => Action<TMsg>;
  readonly stacked: boolean;
}

export interface TableSpec<TMsg> {
  readonly headers: readonly TextSource[];
  readonly rows: readonly (readonly TextSource[])[];
  readonly onRowClick?: (index: number) => Action<TMsg>;
  // Phase 801 — the declared sort intent, carried through from `GridSpec.staticRows` so the
  // renderer can surface it as data attributes. Both optional; both absent renders as before.
  readonly sortable?: boolean;
  readonly defaultSort?: DefaultSort;
}

export interface MapSpec<TMsg> {
  readonly source: Binding<readonly MapMarker[]>;
  readonly centreLatitude: number;
  readonly centreLongitude: number;
  readonly zoom: number;
  readonly onMarkerClick?: (marker: MapMarker) => Action<TMsg>;
}

export interface MapMarker {
  readonly latitude: number;
  readonly longitude: number;
  readonly label: TextSource;
}
