# Fuaran TypeScript reference-implementation stability policy

This document declares which `@fuaran-ui/*` surfaces are stable, what counts as a breaking change in each, and the semver rules that govern the npm packages shipped from this repo. It is the contract that downstream consumers can rely on when pinning a `@fuaran-ui/*` version. It mirrors the shape of the F# language tier's [`STABILITY.md`](https://github.com/fuaran-ui/fuaran-dotnet/blob/main/STABILITY.md); where the two tiers describe the same wire format, the [`fuaran-specification`](https://github.com/fuaran-ui/fuaran-specification) spec + conformance corpus are the shared authority.

## Scope

| Package                      | Licence    | Version status |
| ---------------------------- | ---------- | -------------- |
| `@fuaran-ui/schema`          | Apache 2.0 | pre-1.0        |
| `@fuaran-ui/ui`              | Apache 2.0 | pre-1.0        |
| `@fuaran-ui/ops`             | Apache 2.0 | pre-1.0        |
| `@fuaran-ui/renderer`        | Apache 2.0 | pre-1.0        |
| `@fuaran-ui/renderer-server` | Apache 2.0 | pre-1.0        |
| `@fuaran-ui/op-stream`       | Apache 2.0 | pre-1.0        |
| `@fuaran-ui/layout-observer` | Apache 2.0 | pre-1.0        |
| `@fuaran-ui/style-observer`  | Apache 2.0 | pre-1.0        |
| `@fuaran-ui/theme-manifest`  | Apache 2.0 | pre-1.0        |
| `@fuaran-ui/ai-tools`        | Apache 2.0 | pre-1.0        |
| `@fuaran-ui/conformance`     | Apache 2.0 | pre-1.0        |
| `@fuaran-ui/validator`       | Apache 2.0 | pre-1.0        |
| `@fuaran-ui/client`          | Apache 2.0 | pre-1.0        |

The first published line is `0.1.0` across the package set, with no prerelease suffix. The core authoring surface (`schema` / `ui` / `ops` / `renderer`) was validated against a real authoring workload (the `samples/demo` app) before the version was cut; the follow-up packages hold the same version for coherence, with per-surface maturity annotated in the sections below. The core packages bump in lockstep for peer-dependency coherence.

All packages are Apache 2.0 from the first published version.

## Pre-1.0 caveat

**Until `@fuaran-ui/schema` and `@fuaran-ui/ui` ship `1.0.0`, every minor version may break.** The semver rules below take effect from `1.0.0` onward. Pre-1.0 they are aspirational – they describe what _kind_ of change is intended to be a major-vs-minor bump, but the packages do not yet promise to honour them at the package-version layer. Consumers pinning a pre-1.0 version should pin the exact version (`0.1.2`, not `^0.1.0`) and plan on a per-bump audit.

## Semver

For each package, from `1.0.0` onward:

- **Major** (`X.0.0`) – any change to a stable surface that requires consumer source-code edits to compile or behave equivalently.
- **Minor** (`x.Y.0`) – backward-compatible feature addition. Existing consumer code keeps compiling.
- **Patch** (`x.x.Z`) – backward-compatible bug fix. No surface change.

Adding a `NodeKind` tagged-union case (or any new optional spec field) is **minor**, not major – existing consumers' exhaustive `switch` statements keep compiling (TypeScript flags an unhandled case only under a `default: never` exhaustiveness pattern, which is the correct signal, not a break).

## Stable surfaces

### `@fuaran-ui/schema`

The **wire-format-mirroring portion of `@fuaran-ui/schema` is stable**, governed by the wire-format forward-coupling rule (below). This covers:

- The `Node`, `NodeKind`, `LayoutKind`, `DisplayKind`, `InputKind`, `VisKind` tagged unions and every spec type (`MetricSpec`, `DashboardSpec`, `TabsSpec`, …) in [`packages/schema/src/types.ts`](packages/schema/src/types.ts) – the TypeScript shape of the §4b record contract.
- The `Binding`, `Action`, `TextSource`, `CellFormat`, `CellValue`, `ColumnWidth` tagged unions and the bare-string enums (`Orientation`, `ToneVariant`, `BadgeVariant`, …).
- The branded primitives `NodeId`, `FragmentId`, `ApiEndpoint`, `IconSource` and their constructors.
- The `defaults.*` field set per spec ([`packages/schema/src/defaults.ts`](packages/schema/src/defaults.ts)).
- The bounded-primitive kit ([`packages/schema/src/bounded.ts`](packages/schema/src/bounded.ts)) – `nonEmptyString`, `boundedString`, `boundedInt`, `fraction`, and `BoundedConstructionError`.
- The `Result<T, E>` type ([`packages/schema/src/result.ts`](packages/schema/src/result.ts)).

The **discriminant strings** (`kind: 'Layout'`, `kind: 'Dashboard'`, `kind: 'Static'`, …) are part of the stable surface: they map to the wire `$type` discriminators that Phase 76's codec serialises, so renaming one is a wire-format breaking change.

### `@fuaran-ui/ui`

The smart-constructor signatures (`fuaran.dashboard`, `fuaran.metric`, `binding.*`, `action.*`, `format.*`, `column.*`, `node.*`, `formFieldKind.*`, `filterKind.*`) are **stable** as of Phase 78, having been validated against the `samples/demo` authoring workload. The one ergonomic change that window surfaced: every node `id` option (and the positional `id` of `fuaran.markdown` / `fuaran.markdownSpec` / `fuaran.skeleton`) now accepts a bare `string` as well as a pre-branded `NodeId` – a backward-compatible widening that mirrors the F# `Fuaran.X` surface, whose ids are plain string literals. The option-object shapes are otherwise held stable from `0.1.0`.

The `preEmitValidate` defect-code surface (`EMPTY_NODE_ID`, `DUPLICATE_NODE_ID`, `EMPTY_CUSTOM_KIND_IDENTIFIER`, `TAB_HEADER_COUNT_MISMATCH`, `TAB_TAG_COUNT_MISMATCH`, `TAB_ACTIVE_TAG_WITHOUT_TAGS`) matches the F# `PreEmitValidate` defect identities and is held stable so a cross-implementation eval suite scores uniformly; changing a code string is a breaking change.

### `@fuaran-ui/ops`

The **encoder + decoder are wire-conformant and stable**, governed by the wire-format forward-coupling rule (below). Their stability contract is **byte-equality against the workspace [`wire-format-fixtures/`](../wire-format-fixtures/) corpus**, not merely API non-breakage:

- `encodeNode` / `encodeOp` ([`packages/ops/src/encode.ts`](packages/ops/src/encode.ts)) – deterministic canonical-JSON output, byte-identical to the F# `CanonicalJson` encoder for every fixture.
- `decodeNode` / `decodeOp` ([`packages/ops/src/decode.ts`](packages/ops/src/decode.ts)) – `Result<…, DecodeError>` semantics; the six `DecodeErrorCode`s (`INVALID_JSON`, `MISSING_FIELD`, `WRONG_TYPE`, `UNKNOWN_DU_CASE`, `WRONG_NODE_KIND`, `EMPTY_NODE_ID`) and the `$`-rooted error paths match the F# decoder byte-for-byte.
- The `TreeOp` tagged union ([`packages/ops/src/treeOp.ts`](packages/ops/src/treeOp.ts)) and its discriminant strings – they map to the wire `$type` discriminators, so renaming one is a wire-format breaking change.

The **apply engine** (`apply`, `ApplyResult`, `ApplyError`, `OpApplyTelemetryRecord` – [`packages/ops/src/apply.ts`](packages/ops/src/apply.ts)) remains **alpha**: the Phase 78 `samples/demo` app exercises the encoder + decoder (the wire round-trip) but not the op-apply path. The op-stream package (Phase 79) is now the first real op-applying consumer – its `applyTo` / `applyAndPersist` fold ops through `apply` and assert replay reconstructs the same tree direct apply produces – but the `ApplyResult` / telemetry shapes stay alpha until a stateful sample app drives the apply path through a full authoring session. The `ApplyErrorCode` identities mirror the F# `ApplyErrorCode` DU.

The hand-rolled `parse` surface and the `coerce` UpdateProp helpers are internal-leaning: `parse` is stable in behaviour (it backs the decoder), but its `JsonAst` shape and the `coerce.*` set are not part of the consumer-facing contract and may change in a patch release.

### `@fuaran-ui/renderer`

The **`<FuaranRenderer>` prop shape and the emitted class-name + ARIA vocabulary are stable**, subject to the wire-format forward-coupling rule – renderer dispatch must accept any tree the wire spec admits, and the per-`NodeKind` / `LayoutKind` / `DisplayKind` class names are byte-for-byte parity with the F# reference renderer ([`fuaran-dotnet/src/Fuaran.UI.Renderer/Render.fs`](../fuaran-dotnet/src/Fuaran.UI.Renderer/)). This covers:

- The `<FuaranRenderer tree dispatch sources runtime theme egressPolicy>` prop record ([`packages/renderer/src/Renderer.tsx`](packages/renderer/src/Renderer.tsx)).
- The class-name contract (`fuaran-kind-*`, `fuaran-layout-*`, `fuaran-tone-*`, `fuaran-button-*`, `fuaran-badge-*`, `fuaran-motion-*`, …) and the ARIA attribute set ([`packages/renderer/src/classNames.ts`](packages/renderer/src/classNames.ts) + the per-family renderers under `packages/renderer/src/render/`) – renaming a class is a **major-version event**, because the packaged reference CSS and any consumer CSS key off them.
- The packaged **reference CSS** (`@fuaran-ui/renderer/css`, the `./css` export) – declared stable + versioned alongside the package; a breaking class-name change is a major-version event. It is sync-packaged from the F# tier's reference CSS (a maintainers' byte-copy sync discipline).
- The `@fuaran-ui/renderer/sanitize` seam (`sanitizeUrl`, `sanitizeUrlOrBlank`, `sanitizeExtraAttributes`, `sanitizeMarkdownHtml`) – the render-time injection-safety contract mirroring [`fuaran-dotnet/SANITIZATION.md`](../fuaran-dotnet/SANITIZATION.md) (Phase 56). The behaviour (which schemes/keys/elements are blocked) is stable; exact diagnostic strings are not.
- The `@fuaran-ui/renderer/markdown` subpath (`toHtml`, `toHtmlWithEgress`) – the deterministic GFM renderer, React-free so a pure-string host can reach it without React. Its stability contract is **byte-equality with the shared markdown corpus** (`wire-format-fixtures/markdown/corpus.json`) under the policy each fixture names, not merely API non-breakage: the corpus is what makes the F#, TypeScript and Python hosts one equivalence class, so a change to the emitted bytes is a cross-host wire-level change governed by the corpus, whatever this package's version does. The subpath itself is **additive** – `toHtml` and `toHtmlWithEgress` were already exported from the package root's module graph, and no existing entry point changed shape.

The **custom-renderer registry** (`createCustomRendererRegistry`, `registerCustomRenderer`, `CustomRendererRegistry`, `FuaranRuntime`) and the **typed `Theme` + `themeToCss` bridge** are **stable** as of Phase 78, validated by the `samples/demo` app (it registers a `Custom` React component through the registry + `FuaranRuntime`, and applies a sample theme via the `theme` prop). React 19+ is a peer dependency.

The **in-page introspection surface** (`window.__fuaran`, `buildDebugGlobal`, `registerDebugGlobal`) remains explicitly **DEBUG-only and unstable**, excluded from semver. It is `undefined` unless the host sets `debug`.

#### Additive surface — extension affordances (Phase 735)

Three additions, all **additive**; no existing entry point changed shape, so a consumer on the previous version keeps compiling and behaving identically.

- **Change subscription.** `__fuaran.subscribe(cb)` (returning an unsubscribe handle) and `__fuaran.treeRevision()`, over the exported page-wide hub (`pageChangeHub`, `createChangeHub`, `ChangeHub` / `TreeChange` / `ChangeCause`). The revision token is **opaque** — compare for equality; parsing or ordering it is not a supported use, and its format is not part of any contract.
- **Gated apply, widened.** `__fuaran.apply` now accepts a `TreeOp` as a **structured object** as well as the original **JSON string**; the string form is unchanged, including the bytes handed to an op-stream sink. The `ApplyEnvelope` gains optional fields (`treeRevision` on `applied`, `decodeError` on `decodeFailed`, `code` on `rejected`) — additions to a union member, not a change to one. `FuaranDebugGlobal` gains `canApply` and `getBindingState` (the tagged resolution envelope; `getBindingValue`'s bare `Resolution` is unchanged). `<FuaranRenderer>` gains an optional `validate` prop.
- **DevTools relay page peer.** `<FuaranRenderer relay>` plus `createRelayPeer` / `installRelayPeer` / `acceptsRelayMessage` / `parseRelayProfile` and the `Relay*` types. **Off by default**: without the prop no listener is installed, and a peer built with no options is not opted in.

The relay's **stability contract is the `relay@1.0` profile**, not this package's semver: the wire shapes are pinned by the contract's own fixture family (`wire-format-fixtures/devtools-relay/`, run in `packages/renderer/test/relayCorpus.test.tsx`), and they version independently of the wire profile `core@1.0`. Adding a request type, capability, optional payload field, or refusal class is a **minor** relay bump; removing or renaming any of them is a **major** one. A relay change is therefore governed the way a wire-format change is — by the specification and its corpus — and a change to the profile id is a breaking change to every peer, regardless of what this package's version does.

#### `0.11.0` — the destination policy becomes AMBIENT (breaking: rendered output, and `RenderContext`)

Until `0.11.0` the destination policy of WIRE_FORMAT §14.1 was **available** but not **ambient**: `toHtmlWithEgress` took a policy, `checkDestination` answered for one, and the shared corpus's policied fixtures passed — but no node renderer consulted a policy, because `RenderContext` did not carry one. A decoded tree's `<img src>` therefore reached whatever host it named, which is the exfiltration channel §14.1 exists to close: rendering IS the request, so `https://collector.example/?s=<bound state>` needs no user act at all. `0.11.0` closes it. Three consequences, in descending order of what a consumer will notice.

- **Rendered output changes for any tree naming a destination this host has not been told to allow.** The default is `denyNonLocalEgress` at every convenience entry point — an emission cannot declare its own egress, so absent a host's declaration it gets none. A refused `href` / `src` renders `about:blank#fuaran-egress-refused` with a `data-fuaran-egress-refused="<class>:<host>"` marker beside it (`:local` / `:<scheme>` / the bare `unsafe-url` for the other refusal classes). The value **never** carries the path or the query — that is exactly where an exfiltrated payload sits. A same-origin destination renders **unchanged**: the default denies leaving, not linking. The mitigation is one prop: `<FuaranRenderer egressPolicy={permissiveEgress}>` for a hand-authored tree where the author is the trust boundary, or an `allowOrigin`-built declaration for specific destinations. Both are reached BY NAME, so a grep for `permissive` finds every host that opted back out.
  - **A `mailto:` / `tel:` href is refused under the default** (`allowNonNetwork: false`): those are egress channels with no host for a rule to name, so they can only be permitted wholesale, and permitting them by omission is the failure this default exists to prevent. A consequence worth stating separately because it is the one that surprises: a `Link` with `protection: 'email'` never reaches its protected-anchor arm under the default, since that arm is gated on the post-policy href still beginning `mailto:`. Naming a policy that permits it restores the previous rendering exactly.
  - **An unsafe URL now renders the refusal shape, not a bare `about:blank`.** Pre-`0.11.0` the `Link` / `Image` / grid-link call sites emitted `sanitizeUrlOrBlank`'s bare `about:blank` for a `javascript:` URL. It is now `about:blank#fuaran-egress-refused` carrying `data-fuaran-egress-refused="unsafe-url"` — the marker is the bare token because the scheme floor rejected the URL before there was any destination to name a class or host for. Nothing became more permissive; "nothing happened" and "this was refused" stopped being the same bytes.
  - **`Action.Navigate` refuses by performing NO navigation at all**, and warns through `runtime.warn`. Unlike an `href`, where the anchor must stay structurally valid, a navigation the author never asked for is not an improvement on a refused one.
- **`RenderContext<TMsg>` gains a required `egressPolicy` field** ([`packages/renderer/src/context.ts`](packages/renderer/src/context.ts)) — a **source-breaking change for a consumer that constructs a `RenderContext` by hand**, which is a narrow surface (the ordinary path is `<FuaranRenderer>`, whose new prop is optional and additive). Required rather than optional deliberately: an optional policy field defaults by omission, and defaulting a security posture by omission is the shape this change exists to remove.
- **The class assignments are the F# renderer's**, and one of them looks like an oversight and is not: a `download` anchor is the **`hyperlink`** class, not `download`. The class names the SINK the browser reaches, and a `download` anchor is still a hyperlink the user must act on — scoping it separately would let a policy that denied hyperlinks admit the same destination by flipping one boolean on the tree.

Additive alongside it: a React-free **`@fuaran-ui/renderer/egress` subpath** (the whole egress surface, including the new `sanitizeUrlForEgress` one-call render seam and `describeEgressVerdict`), on the same pattern as `/sanitize` and `/markdown`, so a pure-string host can reach it without React. Every name it exports was already exported from the package root; no existing entry point changed shape.

#### `0.20.0` — the sparkline renders through the shared `Drawing` lowering (breaking: rendered output)

A `Sparkline` no longer draws itself. It lowers to a canonical `DrawingSpec` through `@fuaran-ui/charts` `tryLowerSparkline` and emits through the same `drawingSvg` builder the `Drawing` and lowered `Chart` arms already use — so this tier and `@fuaran-ui/renderer-server` produce identical bytes **by construction** rather than by two hand-written builders kept in step. The geometry is unchanged and is now pinned by the shared `wire-format-fixtures/sparkline-lowering/*` goldens the F# reference emits.

The **markup** moves, and a consumer with CSS or DOM queries keyed to the old shape is affected:

- **`fuaran-sparkline` is now a `<div>` CONTAINER, not the `<svg>` itself.** The picture inside it is the shared builder's `<svg class="fuaran-drawing" role="img">`. The container is where the 100×30 sizing and the inherited `color` the `currentColor` stroke reads have always lived, so the packaged reference stylesheet's hook survives and the rendered picture does not move — but a selector like `svg.fuaran-sparkline` no longer matches, and `.fuaran-sparkline > .fuaran-drawing` is the new inner rule (both ship in `@fuaran-ui/renderer/css`).
- **`fuaran-sparkline-line` is gone from the emitted vocabulary.** The polyline carries the shared builder's `fuaran-drawing-polyline`. Consumer CSS keyed off the old class needs the new one.
- **`preserveAspectRatio="none"` is not carried and is not needed**: the container is exactly 100×30 and so is the viewBox, so the default `xMidYMid meet` scales identically.
- **A non-finite series member renders `0` rather than the literal `NaN`.** The retired builder wrote `NaN` straight into the `points` attribute, which is not a valid SVG coordinate — a browser drops the whole polyline. The shared builder's number form emits `0`, which is what every other geometry-bearing kind already does with a sentinel and what the `sparkline-lowering/nonfinite-sentinel` golden fixes.
- **The empty case is unchanged**: an unresolved or empty series still renders `<div class="fuaran-sparkline fuaran-sparkline-empty">—</div>`. That element is a host element rather than a `Shape`, so the lowering reports it in its return type (`null`) instead of drawing an empty canvas.

`packages/charts/test/sparkline-lowering.test.ts` is the byte-parity gate; the rendered markup is pinned by the renderer's corpus snapshots and by the two-tier parity lock below.

### `@fuaran-ui/renderer-server`

The **`renderToHtml` body-fragment output is stable**, subject to the same class-name + ARIA forward-coupling rule as `@fuaran-ui/renderer` – the server renderer is a pure-string twin of the F# `Fuaran.UI.Renderer.Server` that emits the same `fuaran-*` class vocabulary the React client renderer does, with no React and no DOM. This covers:

- The `renderToHtml(tree, { sources, egressPolicy })` entry point + its body-fragment contract (the host owns the document shell + the `<link>` to the packaged `@fuaran-ui/renderer/css`).
- The emitted **class-name + `data-fuaran-node-id` vocabulary**, parity-locked two ways (`test/parity.test.tsx`): the class set + node-id set equal the React client renderer's `renderToStaticMarkup` output for every corpus fixture, and every class is in the F# reference renderer's vocabulary. A drift in either direction is a build failure. This is what makes a server-rendered fragment safe to hand to the client renderer's `hydrate` entry points.
- The **server semantics**: interactivity renders inert (no event handlers); `Link` is a real sanitised `<a href>`; `Static` bindings resolve and the rest fall back; `Map` renders a deterministic placeholder; a lowerable `Chart` and — from `0.19.0` — a resolved `Sparkline` render real first-party inline SVG through the shared `@fuaran-ui/charts` lowering, byte-identical to the client's; `Custom` renders the inert labelled placeholder.
- The **markdown body**, from `0.10.0`: `DisplayKind.Markdown` renders through the same deterministic renderer the client uses (re-exported here as `toHtml` / `toHtmlWithEgress`), so the emitted bytes are governed by the shared markdown corpus and are byte-identical to the client's for the same source. `test/markdownCorpus.test.tsx` locks both halves — the corpus leg and an end-to-end `renderToHtml` vs `<FuaranRenderer>` comparison over every corpus source.

`@fuaran-ui/schema` + `@fuaran-ui/renderer` are peer dependencies (the latter for its React-free `/sanitize` and `/markdown` subpaths + the packaged reference CSS); `react` / `react-dom` are **not** runtime dependencies, and as of `0.10.0` the package declares **no runtime dependencies at all**. The HTML-escaping floor (`escapeText` / `escapeAttr`) and the binding / class-name helpers are re-exported for hosts.

#### `0.10.0` — markdown output change (breaking for documents `marked` rendered differently)

Before `0.10.0` this package parsed markdown with npm `marked` and sanitised the result — a second markdown implementation inside a renderer whose whole contract is being a fidelity twin of the client. Measured over the shared corpus, the two disagreed on **27 of its 57 fixtures**. A consumer whose markdown bodies stay within the corpus's permissive, HTML-free, table-free, task-list-free subset sees no change; anything else moves, and these are the classes:

- **Void-element spelling.** `<img …>` / `<br>` / `<hr>` are emitted `<img … />` / `<br />` / `<hr />`; a hard break also gains its trailing newline. Cosmetic in a browser, not cosmetic to a byte comparison or an XML-consuming pipeline.
- **Raw inline HTML is escaped, not passed through.** `marked` emitted `<div>x</div>` verbatim; it is now `<p>&lt;div&gt;x&lt;/div&gt;</p>`. The largest behavioural change, and a narrowing of what a markdown body can inject.
- **Entity decoding.** `&copy;` / `&#42;` decode to `©` / `*` rather than surviving as entity text.
- **The `fuaran-*` class vocabulary.** GFM tables emit `fuaran-table` / `fuaran-table-header` / `fuaran-table-row` / `fuaran-table-cell` (and lose `marked`'s pretty-printing whitespace); task-list items emit `fuaran-task-item` / `fuaran-task-checkbox`. Consumer CSS keyed off the bare `<table>` shape needs the class selectors.
- **The scheme floor emits a clean sentinel.** A refused `javascript:` URL rendered as `about:blank` rather than as the malformed residue the old parse-then-sanitise order left behind (`about:blankalert(1)`).
- **Destination policy exists at all.** `marked` had no notion of one, so under a deny or declared policy every refused destination rendered live. Refusals now render `about:blank#fuaran-egress-refused` with a `data-fuaran-egress-refused` marker naming the class and host — never the path or the query. Which policy the render call site passes is unchanged in `0.10.0` (it is still the permissive one); what changed is that the server can express a refusal at all, and that the exported surface can be handed a policy. _(That last sentence is what `0.11.0` supersedes — see below.)_

#### `0.11.0` — the destination policy becomes AMBIENT here too (breaking: rendered output)

The server twin of the `@fuaran-ui/renderer` `0.11.0` note above; read it for the full account of what changes and why. Everything there applies here, with the same defaults, the same class assignments and the same refusal shape — which is the point, since a server fragment that refused differently from the client would not hydrate into it.

Two things are specific to this tier:

- **`RenderToHtmlOptions` gains an optional `egressPolicy`**, so this package's own break is **behavioural only** — there is no `RenderContext` to construct here, and `renderToHtml(tree)` keeps compiling. What it emits for a tree naming an undeclared destination changes.
- **The default matters more here than on the client**, and that is not rhetoric: a refused `<img src>` in a server-rendered document is fetched by the browser _before any script runs_, so there is no client-side gate downstream of this one. `0.10.0` closed the gap where the server had no policy notion at all; `0.11.0` closes the one where it had a policy notion its own render path never used.

`test/egressAmbient.test.ts` is this tier's corpus for it, and `test/markdownCorpus.test.tsx` Leg 2 now compares the two tiers under the policy each fixture names — plus one case under **no** policy on either side, which is the only assertion that would catch the two tiers defaulting differently.

#### `0.19.0` — the same sparkline lowering here (breaking: rendered output)

The server twin of the `@fuaran-ui/renderer` `0.20.0` note above; read it for the full account. Everything there applies here, with the same markup, the same class vocabulary and the same empty-series fallback — which is the point, since a server fragment whose sparkline markup differed from the client's would not hydrate into it.

One thing is specific to this tier, and it is the reason the change is worth its cost: **this tier and the client tier each carried a hand-written copy of one scaling algorithm**, in one repository, next door to a `Drawing` arm that had shared its builder since Phase 525. They agreed — but only because nobody had yet changed one of them. Both call `tryLowerSparkline` now, so the two-tier parity lock (`test/parity.test.tsx`) is checking a property that holds by construction rather than by coincidence.

### `@fuaran-ui/op-stream`

The **`OpRecord` wire shape and the hash-chain semantics are stable**, governed by the wire-format forward-coupling rule (below). This covers:

- The `OpRecord<TMsg>`, `OpResultEnvelope`, and `Checkpoint<TMsg>` shapes ([`packages/op-stream/src/types.ts`](packages/op-stream/src/types.ts)) – the TypeScript port of the F# `Fuaran.UI.OpStream.Abstractions` record contract.
- The **hash-chain algorithm** (`computeHash`, `sha256Hex`, `verifyChain`, `genesisPreviousHash` – [`packages/op-stream/src/hashChain.ts`](packages/op-stream/src/hashChain.ts)): `hash[n] = SHA-256(previousHash ++ encodeOp(op) ++ String(sequence) ++ String(timestampUnixSeconds))`, with `genesisPreviousHash` = sixty-four `0` characters. The stability contract is **bit-equality with the F# `HashChain.computeHash`** over the same op sequence (verified by `test/parity.test.ts` against the corpus op fixtures), not merely API non-breakage – changing the payload formula, the genesis constant, or the digest is a wire-level breaking change.
- The `IOpStreamSink<TMsg>` / `IOpStreamCheckpointSink<TMsg>` interfaces and the `VerificationError` / `ReplayError` discriminated unions.

The **in-memory sink** (`InMemorySink`, `createInMemorySink`) is **stable on ship** – the contract is the interface, and the Map-backed implementation has no external surface beyond it. The `applyAndPersist` / `replayStream` / `PersistContext` wrappers track the `@fuaran-ui/ops` apply engine's alpha status (they fold ops through it), so their shapes stay alpha until the apply engine promotes; the persistence + hash-chain semantics they implement are stable. The F# `Fuaran.UI.OpStream.Sqlite` SQL-backed sink is intentionally not ported (an IndexedDB-backed sink is a candidate follow-up); a future persistent TS sink would be an additive package, not a break here.

### `@fuaran-ui/layout-observer`

The **`LayoutFlag` DU shape and the flag JSON encode are stable**, governed by the wire-format forward-coupling rule (below) – the flag set is a load-bearing AI/dev-tooling input shared with the F# tier. This covers:

- The `LayoutFlag` tagged union and its discriminant strings (`OverflowHorizontal`, `OverflowVertical`, `ZeroDimension`, `SqueezedToMin`, `ChildClippedByAncestor`, `AspectRatioWildlyOff` – [`packages/layout-observer/src/flags.ts`](packages/layout-observer/src/flags.ts)), matching the F# `LayoutFlag` cases. **Additive-only**: a new flag case is a minor bump; redefining an existing case is a wire-level breaking change.
- The `encodeFlag` / `encodeObservation` JSON output – **byte-identical to F# `LayoutFlag.encode` / `LayoutObservation.encode`** for the same value (the `{"kind":…}` tagged-object form + 2-decimal invariant floats). The stability contract is byte-equality, not merely API non-breakage.
- The `LayoutObservation` shape and the `ILayoutObserver` interface (`observe` / `observeTree` / `subscribe` / `register` / `unregister`).

The **observers** (`BrowserLayoutObserver`, `InMemoryLayoutObserver`) and the `useFuaranLayoutObserver` React hook are **stable in interface but alpha in detection algorithm** – the per-flag geometric thresholds (the 0.5px collapse floor, the default 3× aspect threshold, the debounce policy) may be tuned in a minor release as browsers' `ResizeObserver` / computed-geometry behaviour is observed in the wild. `react` is an optional peer dependency (only the hook needs it); the observer + flag core are React-free.

### `@fuaran-ui/style-observer`

The **`StyleFlag` DU shape, the `Rgba` / `StyleObservation` shapes, and their JSON encode are stable**, governed by the wire-format forward-coupling rule (below) – the flag set is a load-bearing AI/dev-tooling input shared with the F# tier. This covers:

- The `StyleFlag` tagged union and its discriminant strings (`ContrastBelowAA`, `InvisibleText`, `AccentIndistinct`, `TokenResolutionFailed`, `OffPaletteColour`, `UsageBudgetExceeded`, `ContrastBelowDeclaredFloor` – [`packages/style-observer/src/flags.ts`](packages/style-observer/src/flags.ts)), matching the F# `StyleFlag` cases. **Additive-only**: a new flag case is a minor bump; redefining an existing case is a wire-level breaking change.
- The `encodeStyleFlag` / `encodeStyleObservation` / `encodeRgba` JSON output – **byte-identical to F# `StyleFlag.encode` / `StyleObservation.encode` / `Rgba.encode`** for the same value (the `{"kind":…}` tagged-object form + 2-decimal invariant floats; `emittedTone` is `null` when absent). The stability contract is byte-equality, not merely API non-breakage.
- The `Rgba` / `FontRole` / `StyleObservation` shapes and the `IStyleObserver` interface (`observe` / `observeTree` / `subscribe` / `register` / `unregister`).

The observer derives the **manifest-free** flag tier (`ContrastBelowAA` / `InvisibleText` / `AccentIndistinct`) from resolved colours + WCAG contrast unconditionally, and the four **manifest-aware** flags (`TokenResolutionFailed` / `OffPaletteColour` / `UsageBudgetExceeded` / `ContrastBelowDeclaredFloor`) when an observer is constructed with a `@fuaran-ui/theme-manifest` (graceful degradation – without a manifest only the manifest-free tier fires). `perNodeFlags` + `verifyUsageBudgets` are exported for direct use (the latter joins with `@fuaran-ui/layout-observer` areas for the tree-level 60-30-10 check).

The **observers** (`BrowserStyleObserver`, `InMemoryStyleObserver`) and the `useFuaranStyleObserver` React hook are **stable in interface but alpha in detection algorithm** – the WCAG thresholds are tunable via `StyleObserverOptions`, so the per-flag derivation may evolve in a minor release. `react` is an optional peer dependency (only the hook needs it); the observer + flag core are React-free.

### `@fuaran-ui/theme-manifest`

The **contract shapes are stable**, governed by the same forward-coupling discipline as the rest of the tier. This covers:

- The `ThemeManifest`, `ManifestMeta`, `ManifestToken`, `ManifestRole`, `RoleBinding`, `Invariant`, `InvariantKind`, `MotionBudget` shapes ([`packages/theme-manifest/src/manifest.ts`](packages/theme-manifest/src/manifest.ts)), matching the F# `Fuaran.UI.ThemeManifest` contract.
- The `decodeManifest` / `manifestFromJson` behaviour – the DTCG group-tree walk + the Fuaran wrapper shape, the role / invariant parse, and the `$extensions.fuaran.role` mining. A vanilla DTCG file decodes to tokens with empty roles/invariants.
- The `invariant` vocabulary is **additive-only**: a new `InvariantKind` is a minor bump; redefining one breaks every manifest authored against it.
- The `encodeManifest` bytes – the canonical-JSON emission and its omit-at-default rules, held to the cross-host byte oracle (below).

The projectors (`projectFromFuaranToneVars` / `projectFromCssCustomProperties` / `projectFromDtcg` / `merge`) are **stable in behaviour**; their exact role-inference heuristics may be tuned in a minor release. The F# `ThemeBridge` (typed-`Theme` projector) is not yet ported (follow-up). `@fuaran-ui/schema` and `@fuaran-ui/ops` are the peer dependencies.

### `@fuaran-ui/ai-tools`

The introspection surface stays **alpha** – the F# `Fuaran.UI.AiTools` tier is shaped around an orchestrator's specific needs, and the TS port may grow as adopters surface different ones. Two sub-surfaces are nonetheless pinned to the F# tier, because a cross-implementation eval suite scores against them:

- `kindName` output – the wire-discriminator string per node, matching F# `Introspect.kindName` (including the Layout grid → `GridLayout` / Visualisation grid → `Grid` distinction).
- The binding-slot **expression forms** (`bindingExpression` – `$static` / `$queries.<name>` / `$filters.<name>` / `$selection.<nodeId>` / `$state.<key>` / `$computed` / `$i18n.<key>` / `$local` / `$format`) and the per-kind binding-slot table (`extractBindingSlots`), matching F# `BindingProbe.identify` + `extractBindings`.

The envelope shapes (`NodeIntrospection`, `TreeIntrospection`) and the `getNodeState` / `findNodes` / `inspectTree` / `FuaranIntrospectionProvider` surface may grow additively (e.g. a future `props` block or live binding-value resolution). `@fuaran-ui/schema` is a peer dependency; `react` is an optional peer (only the context provider + hook need it).

### `@fuaran-ui/ai-tools` 0.13.0 — a binding slot names the reactive inputs it reads (fuaran#1674)

**Released in `v0.27.0`** — 0.12.0 was the published version; this advanced it, and the tag has
since published 0.13.0.

`BindingSlotInfo` gains `dependsOn: readonly string[]` — the named reactive inputs the slot reads, as
`filter:<name>` / `state:<key>` / `query:<name>` / `selection:<nodeId>`. `slotDependencies` is exported
beside `bindingExpression` for a caller holding a binding rather than a slot.

**Why it is a field rather than something a caller derives.** Phases 421 and 424 left this as a
deferred leg on BOTH hosts: the edges were all derivable and neither surface offered them, so a
caller wanting the dependency graph had to decode the whole node and re-implement the walk — in
JavaScript, against a vocabulary that moves. The filter→consumer edge is the one an agent needs
before it can predict what changing a chip will redraw, and a transform's `params` carry it where
nothing short of the walk finds it: the filter name is inside `params`, not in the slot's own binding
case.

**What it costs a consumer.** Additive for a READER. A consumer that CONSTRUCTS a `BindingSlotInfo`
literal — a test double, a mock provider — must add the field; TypeScript's structural typing makes
that a compile error rather than a silent omission, which is the intent. Nothing about `slot`,
`expression` or `source` moved.

**A `Computed` binding reports NOTHING, and that is the posture rather than a gap.** Its closure is
handed the whole state bag, so which keys it reads is unknowable statically; inventing an edge would
be worse than omitting one. `Now` participates in no reactive edge either. The F# side takes the same
position because both project the same walk, and a test on each side pins it.

Certified by `packages/ai-tools/test/introspection.test.ts` (the four cases above) and mirrored by the
F# `Fuaran.UI.Tests/DebugGlobalTests.fs`.

### `@fuaran-ui/renderer` 0.24.0, `@fuaran-ui/renderer-server` 0.22.0 — the pointer cursor moves onto a declared row action (fuaran#1701)

**Released in `v0.27.0`, and NO VERSION MOVED.** Both packages already stood on the then-untagged
0.24.0 / 0.22.0 draft Phase 1696 cut (0.23.0 / 0.21.0 were what npm served), and this is the same
class of change that draft already carries: a behaviour change on rendered output, additive to the emitted class set and
moving no exported signature. So it rides the draft rather than advancing it. `@fuaran-ui/schema` is
untouched — the new obligation is a KIND row, which the manifest reader has carried since long before
`traits`.

Both renderers now emit **`fuaran-grid-row-interactive`** beside `fuaran-grid-row`, on exactly the
rows of a grid that declares `onRowClick`, and the bundled reference stylesheet's `cursor: pointer`
moves onto that class — out of the `.fuaran-grid-row:hover, .fuaran-table-row:hover` rule that had
claimed it for every row in every table. A grid declaring no row action, a `staticRows` grid and a
markdown table now render with the ordinary arrow. The hover BACKGROUND is unchanged on all of them:
it says "this is the row under your pointer", which is true of a row you cannot click; only the
promise of a click moved.

**What it costs a consumer.** Two things, and the second is the one to look for. A consumer that
byte-compares rendered output for a grid declaring `onRowClick` sees one added class per row. And a
consumer that shipped its own rule to UNDO the old pointer — scoping `cursor: auto` onto
`.fuaran-table-row:hover`, which at least one site in this project did — now suppresses the pointer
on interactive rows too, and should drop that rule when it takes this version.

**Both tiers moved in the same change-set, deliberately.** The served DOM and the hydrated one must
carry the same classes; marking on one side alone is a hydration mismatch. The server-side parity
lock (`packages/renderer-server/test/parity.test.tsx`, Lock A) compares the two tiers' `fuaran-*`
class sets and is what holds them together.

**Certified by** `packages/renderer/test/interactiveRowClass.test.tsx` (the client tier, both
directions plus the static-rows leg) and the new `DataGrid/interactive-row-only-with-action` checker
in `packages/renderer-server/test/renderObligations.test.ts`, enumerated from the corpus roster's own
declaration (`WIRE_FORMAT.md` §3.6.24 + §13).

### `@fuaran-ui/renderer` 0.24.0, `@fuaran-ui/renderer-server` 0.22.0, `@fuaran-ui/schema` 0.23.0 — the declared text direction is EMITTED (fuaran#1696)

**Released in `v0.27.0`** — 0.23.0 / 0.21.0 / 0.22.0 were the published versions on npm; this
advanced all three, and the tag has since published them.

Both renderers now emit `dir="ltr"` / `dir="rtl"` on a node whose `style.direction` declares one. They
have emitted the isolating `fuaran-dir-*` class since 0.x's Phase 1472 adoption, and that is half the
contract: the class carries `unicode-bidi: isolate`, the attribute states which way the run reads.
Without the attribute an RTL document rendered left-to-right on a tier reporting full CODEC
conformance for the member — the slot decoded, round-tripped and survived every conformance family,
and changed no markup at all.

**Why it took a corpus change to find.** `WIRE_FORMAT.md` §3.1's five numbered render obligations were
normative prose, and prose is not something a gate reaches. The corpus roster now declares them as the
first entry of its new `traits` array (§13) — the subject population for a member that rides the node
ENVELOPE rather than any one kind — so this tier's obligation suite enumerates them from the artefact
and reports any it does not assert. Five checkers land with the emission, in
`packages/renderer-server/test/renderObligations.test.ts`.

**What it costs a consumer.** A consumer that byte-compares rendered output against a stored
expectation for a document declaring `style.direction` sees one added attribute per declaring node;
this repo's own client-renderer corpus snapshots moved on exactly two fixtures, and nothing a document
without a declared direction produces changed at all. Both tiers moved in the same change-set, so a
hydration handoff still finds the DOM it expects.

**`@fuaran-ui/ops` 0.27.0 carries NO code change**, and is here for the one thing a published version
cannot do: correct its own peer range. `ops@0.26.0` is on the registry declaring `@fuaran-ui/schema`
`^0.22.0`, so a publish that ships schema 0.23.0 while SKIPPING ops (already published) would put a
consumer installing both into a peer conflict. The range regenerates from `workspace:^` only on a
republish, which needs a new version. Phase 1695's `check-peer-ranges.mjs` names exactly this, and
the fourteen rows it still reports on this tree all predate Phase 1696 — the one row this phase
would otherwise have added is the one 0.27.0 removes.

**`@fuaran-ui/schema` 0.23.0** is the reader half: `RenderFidelityManifest` gains `traits`, with
`TraitRow` / `TraitObligation` / `TraitScope`, and `allObligations` now spans both subject populations
— the kind rows first, then the trait rows. A consumer that CONSTRUCTS a manifest literal must add
`traits`; a consumer that reads one gains the array. `allObligations`'s element type widens to
`RenderObligation | TraitObligation`, which a caller reading `.id` / `.statement` / `.section` does not
notice.

### Rides `@fuaran-ui/renderer` 0.24.0 and `@fuaran-ui/renderer-server` 0.22.0 — a host-fed float sequence is read element-wise against a CLOSED accept set (fuaran#1704)

**Released in `v0.27.0`, and it rode the standing draft rather than advancing it.** Both slots were
ahead of the newest tag when this was written (`v0.26.0` was then the repo's newest, and the entry
above records 0.23.0 / 0.21.0 as the published pair), and this is a rendered-output change of the
same class that draft already carried.

Both renderers read a `Sparkline` source through `floatSeries` rather than `asArray<number>`. Where
`asArray` handed the elements on with a TYPE ASSERTION — so a host store carrying `["3.5"]` reached
the geometry as a string and JavaScript's own arithmetic coercion decided what it meant — the reading
is now element-wise against `WIRE_FORMAT.md` §24.7's accept set: a number, or one of the three quoted
sentinels `"NaN"` / `"Infinity"` / `"-Infinity"`, and anything else NaN.

**What it costs a consumer.** Only a host whose STORE feeds a float sequence containing a
non-numeric element sees any change, and no document can carry that case: a float-sequence slot types
its elements at decode, so `[1,"3.5",3]` is a `WRONG_TYPE` and is refused. A store that fed `"3.5"`
drew a point at 3.5 and now draws the sentinel; a store that fed a genuine number is unchanged in
every respect. Both tiers move in the same change-set, so a hydration handoff still finds the DOM it
expects.

**Why it is a narrowing rather than a bug fix.** The coerced set was JavaScript's, not the format's:
it also took `"0x10"` and the empty string, so one store drew different pictures on two conformant
hosts — and it contradicted this repo's own decoder, which refuses exactly those spellings at the
same slot. §24.7 is the sentence that settles which set is right, and the corpus's Sparkline row now
carries the two checkable claims (`float-seq-reads-element-wise`,
`float-seq-accept-set-closed`) that hold every adopting host to it.

`floatSeries` is exported from `@fuaran-ui/renderer-server`'s index beside `asArray`, which is
additive. The client tier's copy is module-internal, so its public surface is unchanged.

### `@fuaran-ui/conformance`

The third-party certification kit ([`CONFORMANCE.md`](CONFORMANCE.md)). Two sub-surfaces are **stable** from first ship, because external certification claims depend on them:

- The **`ConformanceAdapter` seam** ([`packages/conformance/src/adapter.ts`](packages/conformance/src/adapter.ts)) – the `decodeNode` / `encodeNode` / `decodeOp` / `encodeOp` hook signatures and the `AdapterDecodeResult` / `AdapterDecodeError` shapes. All hooks are optional by contract; **adding** a hook (e.g. activating the reserved `applyOp` when apply fixtures land) is minor, changing an existing hook's signature is a breaking change.
- The **report semantics** – the `LegId` set, the mandatory/optional tiering, the three-verdict model (`conformant` / `partially-conformant` / `non-conformant`), and the corpus-naming fields (`manifestVersion` + `digest`). A published certification must stay interpretable: removing or re-meaning a leg, or changing how the verdict is computed from leg outcomes, is a breaking change; adding a new leg for a new corpus fixture class is minor.

The **bundled corpus snapshot** versions with the package and is byte-synced from the authoritative workspace corpus (guarded by the package's own test suite); certification is per corpus version, so a kit release that ships an advanced corpus is by nature a re-certification event, not a breakage. The human-readable `formatReport` text layout and the CLI flag surface are **not** stable (the structured `ConformanceReport` JSON is the machine contract).

### `@fuaran-ui/validator`

The build-time TypeScript-source validator (a TS-compiler-API walker over the `@fuaran-ui/ui` surface). One sub-surface is **stable** from first ship, because a cross-implementation eval suite scores against it:

- The **defect codes + severities** – the `FUARAN###` identities and their `error` / `warning` severity match the F# `Fuaran.UI.Validator` tier byte-for-byte for the ported rule subset (001/002/010/020/046/047/048/049/050/060/061/063/064/900). Re-meaning a code or flipping its severity is a breaking change; **adding** a newly-ported rule (e.g. activating a currently-out-of-scope F#-tier code) is minor. The §4d AI-recovery JSON shape (`code` / `severity` / `file` / `line` / `column` / `message` / `available_fields` / `suggestion`) and the manifest wire shape (shared with the F# tier) are likewise stable.

The **rule coverage** (which F#-tier codes are ported) is explicitly a **growing, not pinned** surface – the README "Coverage vs the F# tier" section enumerates the out-of-scope codes; porting more of them is additive. The CLI flag surface, the human-readable plain output layout, and the `RunResult` envelope may grow additively. The walker's syntactic-only boundary (no type resolution, canonical namespace identifiers only) is a documented capability limit, not a stability promise.

### `@fuaran-ui/client`

A small, typed client over the Fuaran generation endpoint – a paid, stateless, bring-your-own-key (BYOK) HTTPS surface that takes a prompt (+ an optional current tree) and returns a new canonical wire-format tree. The endpoint URL + the paid access token are the commercial gate; this package is a thin, **OSS-safe HTTPS + types layer** over it. Its **contract authority** is the generation endpoint's own published surface contract: the request/response _types_ here mirror that surface field-for-field and are kept **in lockstep** – a field added at the surface is added here in the same change, and `wire.ts` pins how each maps onto the HTTP envelope. So the client's stability contract is _faithful mirroring of the surface version it is built against_, the same posture the codec packages take toward the shared `wire-format-fixtures/` corpus. This covers:

- The **`TurnResult`** three-case discriminated union ([`packages/client/src/contract.ts`](packages/client/src/contract.ts)), discriminated on `kind` (`produced` / `accessDenied` / `turnFailed`) – the HTTP status selects the case (see `wire.ts`). Re-meaning a case, or changing which status maps to it, is a breaking change.
- **`AppliedOp`** (`opId` + `opJson`) – `opId` is a stable dedup discriminant carried by equality; `opJson` is canonical wire JSON, decoded with `@fuaran-ui/ops` `decodeOp`. **`RecoverableError`** (`stage` + `code` + `message`) – `code` is a stable discriminant a caller's retry/recovery loop pattern-matches, and `TurnStage` (`access-token` / `provider` / `parse` / `apply`) is a stable enum. These mirror the surface's applied-op + recoverable-error records; changing a discriminant string is a breaking change, adding a case is minor.
- **`SURFACE_VERSION`** + **`isSurfaceVersionCompatible`** – the surface-version echo + the shared-major compatibility check. A produced result echoes the live surface version (`Produced.version`); a differing major signals a breaking surface revision the client predates. The compatibility _semantics_ (major-equality) are stable; the version _string_ moves with the surface.
- The **`FuaranClient`** (`generate` + `FuaranClientConfig`) and **`FuaranSession`** turn-loop helper (holds the tree so the next prompt is a repair diff) – the public API shape is stable as of Phase 215. The `@fuaran-ui/client/render` subpath (decode + mount glue, pulling in React + `@fuaran-ui/renderer`) and the low-level `toWireBody` / `parseTurnResponse` wire mapping (for advanced hosts driving their own transport) are exported; the core entry is dependency-light so it runs in a server-proxy (Node) context.

The BYOK provider key and the paid access token are **memory-only, never bundled or logged** – that discipline is a security contract, not a stability surface. The internal request-body helpers beyond `toWireBody` / `parseTurnResponse` are not part of the consumer contract and may change in a patch release.

## Wire format

The canonical JSON wire format is specified language-neutrally in [`fuaran-dotnet/docs/WIRE_FORMAT.md`](../fuaran-dotnet/docs/WIRE_FORMAT.md), with the workspace [`wire-format-fixtures/`](../wire-format-fixtures/) corpus as the executable conformance suite. `@fuaran-ui/schema` is the TypeScript shape the codec is built on; `@fuaran-ui/ops` (Phase 76) ships the encoder/decoder verified against the corpus byte-for-byte (all 84 fixtures: 56 round-trips byte-identical to the F# encoder – 46 Node + 10 TreeOp – + 28 reject cases surfacing the same `DecodeErrorCode` at the same path).

The wire format is **stable**. Breaking changes (major-version events): changing a discriminant string, removing or retyping an emitted field, changing a sentinel string, or changing a `DecodeError` code. **Non-breaking** (additive): a new tagged-union case or a new optional field omitted when absent.

**Forward-coupling rule (load-bearing).** Per [`WIRE_FORMAT.md` §11](../fuaran-dotnet/docs/WIRE_FORMAT.md), adding a new `NodeKind` / `Spec` / `TreeOp` / `Binding` / `Action` case in any future phase MUST, in the same commit, update the F# encoder + decoder + the `wire-format-fixtures/` corpus **and** bump the `@fuaran-ui/schema` shape + the `@fuaran-ui/ui` smart-ctor (when applicable) + the TS encoder/decoder (Phase 76 onward). The TypeScript and F# implementations move in lockstep against the shared spec + corpus.

### Recorded breaking change — 0.12.0, the retired positional slot becomes a decode error (Phase 687)

The close of the migration window `0.4.0` of the wire format opened. `decodeOp` now **REFUSES** a legacy `position` on `InsertChild` and `newPosition` on `MoveNode`, returning `WRONG_TYPE` at `$.position` / `$.newPosition` with a didactic naming `ReorderChildren`. Through the window the field was accepted and ignored so the hosts could adopt independently; every host is now positionless and no emitter produces it, so the tolerance is withdrawn.

**Breaking by the wire test — "changing a `DecodeError` code" in the list above, in its widest form: an input that decoded now does not.** No exported type or signature moves. A persisted op-stream that was still replaying through the tolerance stops replaying, which is the point: it was applying as an append, so it was already not doing what its ordinal asked.

**Closing the window meant ADDING a refusal, not removing an acceptance.** This decoder reads named fields and ignores the rest, so _not reading_ `position` was the tolerance — there was never a read to delete, and a host that merely stopped mentioning the field would have gone on accepting it forever, indistinguishable from one that had never adopted. The refusal is therefore explicit and BY NAME, on the enumerated-near-miss pattern, so §2 rule 2's tolerance of genuinely-unknown keys survives for a slot a future profile may add. It is ordered ahead of the required-field decodes, identically in all five hosts, so which defect surfaces first is deterministic.

Certified by `reject-op-insertchild-retired-position` / `reject-op-movenode-retired-newposition`; both payloads are otherwise well-formed, deliberately, so a host that merely fails them earlier for some other reason certifies nothing.

### Recorded change — contract cards + the unregistered-degradation obligation (`WIRE_FORMAT.md` §25, fuaran#1108)

Additive throughout: new exports on `@fuaran-ui/schema`, one new optional field on
`RenderToHtmlOptions`, and **no change to any emitted byte for a host that supplies no cards**.

`@fuaran-ui/schema` gains the card artefact — `ContractCard` / `CardPropRow` / `CardContentHash`,
the codec (`decodeContractCard` / `decodeCardBundle` / `encodeContractCard` / `encodeCardBundle`),
the three-way hash verdict (`verifyCardHash` / `cardVerdictMarker`), card-driven prop validation
(`validateAgainstCard`), the §25.4 placeholder derivation (`describeFromCard`), and `CardStore`.
`@fuaran-ui/renderer-server` gains `RenderToHtmlOptions.cards`: an unregistered `Custom` node whose
identity the store knows renders the card-derived labelled placeholder instead of the identity-only
one. Omit `cards` and the placeholder is exactly what it was.

**This tier is the READER, and the divergence from the reference tier is deliberate.** The F#
registry PROJECTS cards out of prop schemas it already holds; nothing here holds a prop schema, so
what landed is the decode side plus the derivations §25.4 states over it. The canonical ENCODER is
here only so a round-trip can be byte-compared against the corpus — a host that never publishes cards
still has to prove it read them faithfully. Do not "unify" this with the renderer's payload-language
registry (fuaran#1107): same vocabulary, same message strings, a different carrier, and the
dependency direction is renderer → schema.

**`@fuaran-ui/conformance` gains a `roundTripContractCard` hook and two legs, both NON-mandatory.**
Every other family's legs are mandatory; these are not, because §25 adoption is a separate bar from
wire conformance (`WIRE_FORMAT.md` §11.0 records it in its own table). A host can be byte-perfect on
the whole node and op vocabulary and hold no card reader at all, and reporting it non-conformant for
that would measure the wrong thing. A host that has not adopted omits the hook and the legs report
`skipped`.

`FixtureKind` and `LegId` are widened, and `CorpusFixture.decoder` gains `contract-card` /
`contract-card-bundle`. Those are exported union types, so a consumer exhaustively switching on one
gains an unhandled case — additive on the wire, source-visible in TypeScript.

### `@fuaran-ui/conformance` 0.22.0 — the teleport family is DECLARED, and deliberately not run (Phase 1589)

The shared corpus gains a teleport fixture family (`WIRE_FORMAT.md` §17.6), so `FixtureKind` is
widened with `teleport-decode` / `teleport-reject` and `CorpusFixture.decoder` gains `teleport`.
Additive, and minor for the same reason the contract-card widening above was: these are exported
union types describing the manifest, so a consumer exhaustively switching on one gains an unhandled
case rather than a break.

**No leg runs over them, and that is structural rather than an oversight.** A teleport decoder is
asynchronous — the bundle is a DEFLATE stream inflated through the platform's own decompressor — and
`runConformance` is synchronous by contract. Giving the kit a teleport leg therefore means an async
runner entry point, which is a change to this package's public shape and its own piece of work; doing
it as a side-effect of landing the corpus family would have been the larger, less reviewable change.
`LegId` is **not** widened here, precisely because there is no leg to name.

What a consumer should read from a report in the meantime: the kit's fixture accounting is over the
legs it runs, and the teleport family is not among them. The family is certified host-side against
the same files (`packages/op-stream/test/teleport.test.ts`), and this repo's self-certification suite
pins the exclusion to exactly those two kinds — so a future family that no leg covers still fails the
accounting rather than slipping through it.

### Recorded breaking change — `@fuaran-ui/ops` 0.20.0, the typed actor on the DAG record (fuaran#1144)

`DagOpRecord.userId: string` becomes `actor: DagActor` — the exported
`{ kind: 'human'; id }` / `{ kind: 'agent'; model; version; id }` union, structurally identical to
`Actor` in `@fuaran-ui/op-stream` and assignable to and from it. It is declared in this package
rather than imported because op-stream depends on ops, not the reverse; importing it would invert the
package dependency to reuse a shape TypeScript already lets the two share structurally.

The canonical wire record changes with it. Top-level keys are Ordinal-sorted, so the trailing
`"userId":"…"` is replaced by a LEADING `"actor":{…}`; the nested actor value is embedded verbatim in
its own pinned member order (`kind` first, then the case fields), exactly as the nested `op` is:

```text
0.19.0  {"hash":…,"op":…,…,"tombstoned":false,"userId":"u1"}
0.20.0  {"actor":{"kind":"human","id":"u1"},"hash":…,"op":…,…,"tombstoned":false}
```

**Why it is breaking beyond the type.** The actor sits inside the F# host's DAG content address, so
typing it re-mints every hash in the shared `wire-format-fixtures/dag/` corpus this package certifies
against — **pre-1144 DAG addresses do not carry forward.** `decodeDagRecord` therefore REFUSES a
pre-1144 `userId` envelope by name instead of lifting it to `human`: a lift would produce a record
carrying a `hash` no host can reproduce, turning a clear refusal at the boundary into a silent
verification failure later. An unknown `kind`, or a case missing one of its fields, is refused for the
same reason rather than defaulted.

`encodeDagRecord` and `decodeDagRecord` keep their signatures; only the record shape moves. Nothing
outside the DAG codec is touched — the Node/TreeOp vocabulary, the linear op-stream chain, and every
non-DAG fixture family are byte-identical to 0.19.0.

### `@fuaran-ui/client` 0.12.0, `@fuaran-ui/mock` 0.12.0, `@fuaran-ui/mcp` 0.12.0 — one generation wire

**Breaking, pre-1.0, and deliberately so: these packages spoke a protocol the generation endpoint
does not serve.** They wrote `{Prompt, CurrentTreeJson, ByokKey, AccessToken, …}` and read
`{TreeJson, Ops, Version}` across a 200/401/422 status map — faithful to the endpoint's published
OpenAPI document, and refused by the endpoint itself, which reads `prompt` / `currentTree`, takes
secrets from HEADERS ONLY, replies `{version, tree, opsApplied, provider, servedModel?, snapshot}`
and refuses with `{error:{code,message,stage?}}` at 400 / 401 / 405 / 422 / 500 / 503. The document
was corrected to describe the deployed surface, and these packages follow it.

**`@fuaran-ui/client`.**

- `toWireBody(args)` takes ONE argument and writes the camelCase body. The secrets parameter is
  gone, because there is no secret member: `FuaranClient` sends the access token as
  `Authorization: Bearer` and the BYOK key as `X-Fuaran-Provider-Key`, and the endpoint refuses a
  body carrying either without reading the value.
- `parseTurnResponse` reads the deployed 200 (an object `tree`, a numeric `opsApplied`) and the one
  nested error envelope at every non-200, keeping the endpoint's own `code` rather than
  synthesising `HTTP_<status>`. The retired PascalCase forms still PARSE — a proxy or mock in front
  of the endpoint may not have moved — but nothing writes them.
- **New:** `generateDetailed` (the result plus `opsApplied` / `provider` / `servedModel` /
  `snapshot`), `CLIENT_CODES`, `isSecureEndpoint`, `parseProducedDetail`, `ProducedDetail`,
  `SnapshotState`, `GenerateOptions`, `GenerateArgs.interactionId`, and four config members:
  `provider`, `timeoutMs`, `allowInsecureEndpoint`, plus the existing `sendBearerHeader` now
  documented as the endpoint's only auth channel.
- **Three new refusals a caller can branch on.** `MALFORMED_RESPONSE` — a 200 with no tree is a
  failure, not a `produced` with `treeJson: ''` that poisons the session's held tree one turn later.
  `INSECURE_ENDPOINT` — a plaintext non-loopback endpoint is refused before the request is built,
  since both credentials ride headers; loopback, `https` and a relative same-origin path are
  admitted, and `allowInsecureEndpoint` is the written-down opt-out. `NETWORK` now carries a FIXED
  message: a fetch error string can quote a URL, a header name or a proxy's internal hostname, and
  this result is routinely rendered straight into the page.
- Every request sets `redirect: 'error'`, so a 307/308 can never re-POST the BYOK key to an origin
  the caller never named.

**`@fuaran-ui/mock`.** It replies in the deployed shape at 200 and in the endpoint's envelope at
every refusal, and it refuses a body carrying a secret exactly as the endpoint does. Three things
that were previously always-200 are now the endpoint's own `400 BAD_REQUEST`: an empty body, an
unparseable body, and a body with no prompt. Six refusals are REQUESTABLE through a `mock:` prompt
marker (`mock:access-denied`, `mock:turn-failed`, `mock:secrets-in-body`, `mock:missing-key`,
`mock:faulted`, `mock:unconfigured`), because a client's error paths are only testable against an
endpoint that can fail and this one cannot fail for the real reasons. `MOCK_SURFACE_VERSION` is
`1.6.0`; `MOCK_PROVIDER` / `MOCK_SERVED_MODEL` are new and deliberately fictional.

**`@fuaran-ui/mcp`.** The emitted `server/fuaranProxy.ts` sends the credentials as headers, rebuilds
the forwarded body rather than spreading the caller's object, sets `redirect: 'error'`, and — new —
authorises the caller, caps prompt length and rate-limits per caller before spending anything. Its
`proxyFuaranRequest` therefore takes a second argument (the caller key). The emitted F#/Fable panel
moves to the same wire, and stays byte-identical to the F# CLI's copy of the template.

### `@fuaran-ui/renderer-server` — the strict-CSP render mode (Phase 1545)

Inline style is the last CSP directive a host serving this renderer could not close: it sets a `style` attribute for the seven slots whose value is genuinely continuous, so every deploying host has had to ship `style-src 'unsafe-inline'`. Under a policy that otherwise forbids everything, inline-style CSS is the remaining exfiltration channel — an injected style attribute reads the document with attribute selectors and leaks what it finds through a background URL.

A render therefore carries a **posture**. `permissiveCsp` is the default at every entry point and is **byte-for-byte the emission this renderer has always produced**; `strictCsp(nonce)` is reached BY NAME and emits no `style` attribute anywhere — each continuous declaration becomes a generated class whose rule rides one nonce-bearing `<style>` element, returned AHEAD of the body fragment.

Additive throughout: one new optional field on `RenderToHtmlOptions` (`csp`), a new `./csp` surface re-exported from the package root, and **no change to any emitted byte for a host that supplies no posture**. A tree carrying no continuous value generates no `<style>` element at all, so the mode costs such a document nothing even under `strictCsp`.

| New export                                               | What it is                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CspMode`, `permissiveCsp`, `strictCsp`                  | The posture and its two constructors. The host mints the nonce per response and puts the same value in its own header; nothing here generates one, because a nonce the document could derive is a nonce an attacker can derive. |
| `declarations`, `Declaration`, `declarationText`         | The canonical CSS pairs per slot, and their text.                                                                                                                                                                               |
| `generatedClass`, `CLASS_ROOT`                           | The derivation: FNV-1a over node id + slot + declarations, under the reserved `fuaran-csp-` root.                                                                                                                               |
| `StyleCollector`, `stylesheetText`, `isCollectableValue` | The per-render accumulator, the rule renderer, and the raw-`<style>`-content floor.                                                                                                                                             |
| `styleSrcDirective`                                      | The host's half in one call — `style-src 'self' 'nonce-…'`, no `'unsafe-inline'`.                                                                                                                                               |

**The generated class name is a property of the DOCUMENT, not of the host that rendered it.** `declarations` reproduces the F# reference renderer's spelling exactly — including `toFixed(6)`, which is what its `sprintf "%f"` produces — even where this renderer's own permissive emission has always formatted the same number differently (its progress fill writes `width:50%` where the canonical form is `width:50.000000%`). The canonical pairs are the HASH INPUT and nothing this package emits, so following one spelling costs no byte here and buys a class name two hosts agree on. `test/strictCsp.test.ts` pins the exact strings the reference host's own suite pins for the same trees, so a drift on either side reddens exactly one suite and names the class it now produces.

**The collected stylesheet is a raw-`<style>`-content sink, and it carries a floor the shared emission grammar does not.** `isSafeCssValue` denies `;`, `{`, `}`, `\` and the C0 range — but not `<`, which is correct for an attribute value (`escapeAttr` handles it) and wrong for element content, where the HTML parser looks for `</style` before any CSS parser reads the text. `isCollectableValue` refuses `<` and `>` on top of the shared grammar. A declaration that fails is dropped and its class registers no rule, so the element keeps a class that styles nothing — which is what a refused value should look like, and the emission site has already marked the refusal in the document.

**What the mode does not claim.** It says nothing about `@fuaran-ui/renderer`, the React client tier, which is untouched by this phase — a document served under a strict posture and hydrated by that tier will have its style attributes written back. It says nothing about a host's own `<head>`, or about CSS a host injects itself. And it narrows nothing on the wire: no decoder refuses anything it accepted before.

### Recorded breaking change — `@fuaran-ui/ops` 0.26.0, `MAX_EXPR_NODES` reaches a pipeline's own expressions (fuaran#1662)

Breaking by the widest of the wire tests in the list above — **an input that decoded now does not**. No exported type, signature or member moves, and `MAX_EXPR_NODES` does not change value; what changes is its SCOPE, and therefore the answer `decodeNode` gives to a document that was inside the limit only because the limit did not look there.

`MAX_EXPR_NODES` (512) bounded a `Binding.Expr`'s expression, and [`WIRE_FORMAT.md` §21.8](../fuaran-dotnet/docs/WIRE_FORMAT.md) declared the expression a `Binding.Transform` PIPELINE embeds — a `derive` step's `expr`, a `filter` step's `pred` — to be deliberately outside it. Both reach the same evaluator, so that exclusion was a documented way to move an expression out from under the bound by wrapping it in a Transform: this decoder accepted a 513-node `derive` expression, including the `param`-leafed shape it refuses at 513 as a `Binding.Expr`. §21.8 is amended and the exclusion is withdrawn — a stated exclusion on the one surface an expression can be moved to is not a scope, it is a bypass.

`decodeBinding`'s `Transform` arm now checks each embedded expression against the SAME budget, at decode, immediately after the pipeline decodes and before `params`, and returns `LIMIT_EXCEEDED` at that step's own member path (`$.kind.source.pipeline[2].pred`) so an author is told which STEP to come back under. `exprAdmissible`'s traversal was split out as `scanExpr` to share it: the previous walk short-circuited on `sawCol`, which on a pipeline expression — where a `col` is perfectly ordinary — would UNDER-count and admit the bypass. `exprAdmissible` is now a thin verdict over `scanExpr` with its refusal order unchanged, so `Binding.Expr`'s behaviour does not move.

**Refused outright, with no profile boundary and no grandfathering**, because §21.2 rules 1 and 2 admit no second acceptance class and the format's one host-narrowing mechanism (§23) is a NARROWING that never appears on the wire. The affected shape is named rather than estimated away: a document that stops decoding carries more than 512 `ColExpr` nodes in ONE pipeline step's expression, which is the blow-up the limit exists to refuse and not a shape an author writes.

Certified by `limit-expr-nodes-pipeline-at-max` — the at-the-bound accept, which this decoder must still take, since rule 1 is symmetric with rule 2 — and the three `reject-limit-expr-nodes-*` vectors, the third of them the bypass itself. **The number does not move**: `@fuaran-ui/ops` 0.26.0 is ahead of the newest tag and unreleased, so this rides it.

### Recorded breaking change — `@fuaran-ui/ops` 0.26.0, `Skeleton.rows` is bounded (fuaran#1666)

Breaking by the same test as the section above — **an input that decoded now does not**. No exported type, signature or member moves; a new `MAX_SKELETON_ROWS` (10 000) is added to `@fuaran-ui/schema`'s limits, and `decodeNode` refuses a `Skeleton` past it.

[`WIRE_FORMAT.md` §21.9](../fuaran-dotnet/docs/WIRE_FORMAT.md) states the bound, and the reason it is a §21 RESOURCE limit rather than a §7.1 slot narrowing is the whole of the change. §7.1 says what a typed integer slot may HOLD, and `2147483647` is finite, fraction-free and inside signed 32-bit, so §7.1 admits it. What no host can do is RENDER it: one placeholder row is emitted per count, so `{"$type":"Skeleton","rows":100000000}` is a document inside every other limit — a handful of bytes, one node, three JSON levels — that names a hundred million rendered rows. That is §21.8's own argument at a different slot, which is why it is stated in §21's vocabulary and inherits it: `LIMIT_EXCEEDED`, the §6 envelope, refused on the way down.

The check sits in `decodeSkeletonSpec` **after** the §7.1 integer read and never before it, so the two rules compose in a stated order and the codes stay distinct: a `1e10` value is still `WRONG_TYPE` (the slot cannot hold it), and a 32-bit-valid `2147483647` is `LIMIT_EXCEEDED` at `$.kind.rows` (the slot can hold it; the format will not carry the work it names). The bound is an UPPER bound only — a negative row count is an authoring defect, not a resource breach, and reporting it as one would be the actively-wrong diagnosis §21.2 rule 2 forbids.

Certified by `limit-skeleton-rows-at-max` — the at-the-bound accept this decoder must still take, rule 1 being symmetric with rule 2 — and `reject-limit-skeleton-rows`, whose value is the 32-bit maximum rather than `10 001` so that the vector pins the §7.1/§21 seam and not merely the arithmetic. **The number does not move**: `@fuaran-ui/ops` 0.26.0 is ahead of the newest tag and unreleased, so this rides it.

### `@fuaran-ui/renderer` 0.23.0 and `@fuaran-ui/renderer-server` 0.21.0 — the accessible name resolves through the scalar arm, and an i18n argument may carry a binding (fuaran#1661, fuaran#1665)

Two behaviour changes on the rendered output, both additive to the prop shapes and neither moving an exported signature — so a minor on each tier, recorded here because the versions they land on (`renderer` 0.22.0, `renderer-server` 0.20.0) were already PUBLISHED and a behaviour change may not ride a published slot.

**`accessibility.label` reads the 1x1 result cell (fuaran#1665).** The slot resolved through `tryResolve`, whose `Transform` arm is ROW-shaped; on an erased host `unbox` is the identity, so the rows array reached the attribute and both tiers emitted `aria-label="[object Object]"` for the one wire spelling of "name this region after what is in it". `tryResolveScalarText` reads the cell through the same coercion every other text slot uses. **Every other binding case resolves exactly as before, so no shipped document changes what it renders** — what changes is the one spelling that rendered wrongly on five hosts, each wrongly in its own way, with every conformance gate green. Certified by the corpus fixture `nodes/a11y-wrapper-transform-label` and the `behaviour` vectors in the corpus's `a11y-contract.json`, which both tiers now READ rather than restate: the hand-written expectation table was the arrangement that let one slot resolve five different ways undetected.

**A `TextSource.I18n` argument may be a binding (fuaran#1661).** An argument that is a `Static` carrying a value — the bare wire form every pre-1661 document decodes to — projects through exactly the rule this slot used before, **so no existing caption changes a character**. Any other arm resolves through the same store-reading path, and an unresolvable one substitutes the empty string rather than leaving `{name}` visible mid-sentence, which is the `Bound` arm's degradation one level down.

Neither change narrows the wire: no decoder refuses anything it accepted before, and a consumer that adopts either tier needs no source edit.

### Recorded breaking change — `@fuaran-ui/renderer` 0.23.0 and `@fuaran-ui/renderer-server` 0.21.0, `Range`'s class names join the F# vocabulary (fuaran#1670)

Breaking by this document's own test for the renderer packages — **a rendered class name changes** — and by nothing else: no exported type, signature, prop or member moves, no wire byte moves, and no other kind's markup is touched.

Both renderers emitted `fuaran-form-range` / `-min` / `-sep` / `-max` for `FormFieldKind.Range`, where the F# reference renderer emits `fuaran-field-range` / `-min` / `-sep` / `-max` for the same case. The class-name vocabulary is **parity-locked** with that reference — this document says so twice, once per renderer package — so this was a standing violation rather than a second dialect, and it had a consequence beyond tidiness: the packaged reference CSS, which is a byte-copy of the F# tier's canonical sheet, styles `fuaran-field-range*` and nothing else. The old names were therefore not merely divergent, they were **unstyled**: one document rendered an unstyled pair control here and a styled one there.

It surfaced from the other end. The `DateRange` arm deliberately used the F# spelling when it landed, because parity is the stated mandate — which left this tier internally inconsistent between its two pair controls until now.

**The reference host is unchanged, and that is the landing order rather than a coincidence:** it already emitted the target vocabulary, so `fuaran-dotnet` needed no edit, its `Theme.vocabularyFingerprint` does not move, and `-- Css` rewrote no tier stylesheet copy. **Consumer CSS or DOM queries selecting `fuaran-form-range*` must be updated**; there is no compatibility alias, because a second name for one control is the condition this change exists to end.

**The numbers RIDE rather than advance.** Both packages stood at their tagged versions when this work began, and the section above moved them to 0.23.0 / 0.21.0 first — untagged, and already carrying the breaking-on-rendered-output class this change is. Under the draft-slot rule a change of that same class rides the standing draft rather than minting a second number for one release.

_What this does NOT close, stated so it is not read as closed._ A filter chip in this tier renders through the shared form-control renderer, so a `Range` chip now emits `fuaran-field-range*` inside a `fuaran-filter` label where the F# tier's separate filter renderer emits `fuaran-filter-range*`. That divergence is structural — two render paths in one tier versus one in the other — and predates this change in a different spelling; it is recorded here rather than half-fixed under a class-rename.

### Recorded change — `@fuaran-ui/charts` 0.14.1, the chart extents fold instead of spreading (fuaran#1670)

A behavioural fix with **no surface change**: no export moves, and every `chart-lowering/*` and `sparkline-lowering/*` golden is byte-identical either side.

Three extent computations took `Math.min(...xs)` / `Math.max(...xs)` where the reference (`Fuaran.UI.Charts`) takes `Array.min` / `List.min` — the temporal domain's `days`, the value domain's `values`, and Scatter's `xValues`. They now use one shared `<` / `>` comparison fold, the same shape Phase 1099 gave `tryLowerSparkline`.

**The defect this actually fixes is the spread's argument-count ceiling, not NaN propagation**, and the distinction is worth recording because the bundle that filed it assumed the opposite. A spread passes one argument per element and every engine has a call-frame limit — measured at roughly 125 000 on Node 25 — so a chart whose value domain is rows × series threw `RangeError: Maximum call stack size exceeded` out of a pure lowering, taking the whole render with it. A sparkline's series never approaches that; a 20 000-row seven-series chart does. `test/chart-extent.test.ts` carries one vector per site, each of which fails with that `RangeError` against the previous code and passes against this one.

The NaN half of the rule is matched too, and is **currently unobservable** at all three sites: every contributor is already guarded — `numericOf`'s non-finite clamp on each series cell, the `Number.isFinite` filter on a `ReferenceLine`, the same on both ends of a `ValueRange` band. That is why no corpus golden discriminates it here, and the same test file pins those three guards so that relaxing one is what goes red. The fold is what makes such a relaxation safe rather than a cross-host divergence.

### The author direction is a stability class of its own (fuaran#1695)

**A widening of an author-facing in-memory type is a BREAKING change for `@fuaran-ui/ui` consumers even when not one wire byte moves, and it advances the version accordingly.** Stated as its own rule because the ordinary tests for a breaking change — does a decoder refuse something it accepted, does an encoder emit different bytes, does an exported signature move — all answer NO for this class, and answered no for the instance below while it was breaking a real consumer.

**The motivating instance: `@fuaran-ui/schema` 0.22.0 in the v0.26.0 release (fuaran#1661).** `TextSource.I18n.args` widened from a bare-value bag to `Readonly<Record<string, Binding<JsonValue>>>`. A `Static` argument carrying a value encodes BARE (`WIRE_FORMAT.md` §5), so every document ever emitted stayed byte-identical, the whole conformance corpus round-tripped, 4,795 tests passed, and the release shipped. Two days later a consumer that CONSTRUCTS a tree rather than decoding one — the only author-direction consumer known to this project — broke on the pin bump, and broke as a throw from inside `encode.ts` (`unreachable case 1908`) rather than as anything naming the slot that had changed.

**Why the suite could not see it, structurally.** Every conformance leg ran wire, `decode`, `encode`, which verifies the decoder and the encoder against each other; the decoder produces the new form and the encoder consumes it, so the pair agrees at every step whatever the form is. Nothing in the repository built a value of that type BY HAND. That gap is now closed by the author-direction leg in `@fuaran-ui/conformance` (`test/author-direction.test.ts` + `test/reauthor.ts`): every node fixture is decoded, rebuilt through the `@fuaran-ui/ui` surface, re-encoded and required to be byte-identical, with the rebuild written against the authoring types — so the same widening now fails to COMPILE, naming the argument slot, before any byte comparison is reached. Its two refusal covers pin the reproduced shapes: a raw `{"$type":"State"}` where a `Binding` belongs, and a bare integer literal — the arm whose bare re-encode is what let the pre-widening reading round-trip by accident.

**What a consumer must do about such a change:** read the section for the version, and expect to edit construction sites even when nothing they emit changes. **What a producer must do:** treat "the bytes are unchanged" as saying nothing about this class, and record the change here under the package whose author surface moved.

### Recorded breaking change — `@fuaran-ui/ui` 0.21.0, the widened i18n argument reaches the author surface (fuaran#1661, fuaran#1695)

`@fuaran-ui/ui` re-exports the whole `@fuaran-ui/schema` surface, so the widening above is part of what this package presents to an author — and `ui` **was not republished in the v0.26.0 release**: its version did not move, so the publish loop skipped it and the registry still serves 0.20.0, whose `TextSource` is the pre-1661 one and whose `@fuaran-ui/schema` peer range is `^0.21.0`, a range that excludes the 0.22.0 that same release published and a hard install failure under `strict-peer-dependencies`.

0.21.0 is that republish. **No source in `packages/ui` changes**; what changes is which `@fuaran-ui/schema` the published package carries and declares. A consumer authoring a `TextSource.I18n` must spell each argument as a `Binding` — `binding.static(1908)` for a literal, which encodes bare and is byte-identical to what it wrote before.

_A note on the number._ A patch would have corrected the peer range and understated the change: the type an author must construct is different, which is the class the section above defines. Pre-1.0, per this document's own caveat, that is a minor.

**The registry set is checked at release time from now on.** [`dev-scripts/check-peer-ranges.mjs`](dev-scripts/check-peer-ranges.mjs), wired into [`publish.yml`](.github/workflows/publish.yml) ahead of the pack step, resolves every `@fuaran-ui/*` range against the versions the same run produces — the PUBLISHED range for a package the run will skip, the workspace range for one it will publish — and refuses the release when a range is unsatisfiable, naming the packages to bump. Its `--self-test` mode proves the verdict offline in the ordinary gate, including this exact pair, so the lookup cannot rot into always-green.

**Seven packages stand in that state today and are NOT cleared here**, because each is a version bump in a package this change does not otherwise touch: `@fuaran-ui/cli` 0.11.0, `@fuaran-ui/client` 0.12.0, `@fuaran-ui/mcp` 0.12.0, `@fuaran-ui/op-stream` 0.11.0, `@fuaran-ui/react` 0.12.0, `@fuaran-ui/renderer` 0.23.0 and `@fuaran-ui/theme-manifest` 0.11.0 each sit on the registry declaring a range that excludes a version the next release will publish. `renderer` is the newest and shows the mechanism plainly: it was published in v0.26.0 with `@fuaran-ui/ai-tools` `^0.12.0`, and `ai-tools` has since advanced to 0.13.0 in the workspace. **The next release tag must bump them**, or the check will refuse it — which is the check working, and is the first time this drift has been measurable at all.

### Recorded release-consistency bumps — 0.27.0 release set (fuaran#1695)

The section above names seven packages sitting on the registry with ranges that exclude versions the next release publishes, and says the next release tag must bump them. **This is that bump.** Six remain: `@fuaran-ui/renderer` left the list on its own account when fuaran#1670 advanced it to 0.24.0, which is the mechanism working — a package that is republished for any reason carries ranges regenerated from `workspace:^`.

**The remedy is a version bump and can only be a version bump.** Each of these ranges was generated at ITS package's pack time from `workspace:^`; the range in the registry's copy of the manifest is not editable, and the workspace's `workspace:^` is already correct. The only way to put a satisfiable range in front of a consumer is to publish the package again.

**The class is decided per package, from what has actually changed since the commit that set its current version — not from the fact that a bump is needed.** A bump forced by a peer's movement does not license a minor, and a package whose own surface moved does not get a patch because the release is about ranges.

| Package                     | From → to       | Class                               | What changed since its current version was set                                                                                                                                                            |
| --------------------------- | --------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@fuaran-ui/cli`            | 0.11.0 → 0.11.1 | patch                               | Nothing. No source, test, README or manifest edit. The tarball differs only in the regenerated `@fuaran-ui/mcp` and `@fuaran-ui/client` ranges.                                                           |
| `@fuaran-ui/client`         | 0.12.0 → 0.12.1 | patch                               | A formatting pass over `README.md`. Nothing under `src/`.                                                                                                                                                 |
| `@fuaran-ui/mcp`            | 0.12.0 → 0.13.0 | **minor, and breaking** — see below | A new `inspect` tool on the public surface, a new `@fuaran-ui/ai-tools` dependency, a per-elicitation nonce through the elicitation server, and a required parameter added to an exported function.       |
| `@fuaran-ui/op-stream`      | 0.11.0 → 0.11.1 | patch                               | Only `test/` — the teleport family certified against the corpus (fuaran#1589) and a record widening carried into the test trees. Test-only surface is outside semver here, per _Unstable surfaces_ above. |
| `@fuaran-ui/react`          | 0.12.0 → 0.12.1 | patch                               | A behavioural fix inside `useFuaranGenerate` with no export, signature or prop change — the `@fuaran-ui/charts` 0.14.1 class. See below.                                                                  |
| `@fuaran-ui/theme-manifest` | 0.11.0 → 0.11.1 | patch                               | Nothing. As `cli`.                                                                                                                                                                                        |

**Why the author-direction class does not make these minors.** `@fuaran-ui/schema` has moved 0.20.0 → 0.23.0 since some of these were published, carrying the widening the section above records as breaking for `@fuaran-ui/ui`. That argument turned on `ui` re-exporting the whole schema surface, so the widened type is part of what `ui` itself presents to an author. **None of these six re-exports it** — there is no `export *` from `@fuaran-ui/schema` in any of their entry points, and for five of the six `schema` is a PEER dependency, which the consumer resolves and constructs against directly. A consumer of these packages meets the widened type through its own `schema` pin, at whatever version that pin names, exactly as it did before. The distinction is the point of the author-direction rule rather than an exception to it: the class attaches to the package whose author surface moved.

#### Recorded breaking change — `@fuaran-ui/mcp` 0.13.0, `buildAnswerPage` takes the nonce (fuaran#1652)

`buildAnswerPage(env)` became `buildAnswerPage(env, nonce)` — a required second parameter on an exported function, so a caller passing one argument stops compiling. Breaking by the ordinary test, and recorded here rather than folded into the release-consistency table because a consumer must act.

**That change landed against a PUBLISHED 0.12.0 without advancing the number**, which is the state this bump corrects. It is the same shape as the drift the peer-range check exists to catch, arriving through a different door: the check measures ranges between packages and cannot see a signature move inside one. Worth stating plainly rather than quietly fixing, because the two together say what "the registry set is checked at release time" does and does not cover.

The nonce itself is the reason for the parameter: a per-elicitation 128-bit value the hosted page carries and a POST to `/resolve` or `/decline` must present in `x-fuaran-nonce`, which is the one of that server's three checks that does not depend on browser behaviour. `ElicitationServerHandle` gained a `nonce` member alongside it — additive, since a caller reads that record rather than constructing it.

The rest of `mcp`'s growth is additive: `runInspect`, `UNTRUSTED_TEXT_OBLIGATION` and the `InspectArgs` / `InspectResult` / `UntrustedTextEntry` types are new exports carrying the untrusted-text obligation into the agent snapshot (fuaran#1547), and `@fuaran-ui/ai-tools` becomes a dependency of this package for it. Pre-1.0, per the versioning caveat below, a breaking change is a minor — so the additive growth and the break land on one number.

#### `@fuaran-ui/react` 0.12.1 — a turn that resolves late no longer writes hook state (fuaran#1652)

`useFuaranGenerate` now carries two guards over the gap between issuing a turn and its result arriving: a sequence number each turn captures when it is issued, and a mounted flag. A result whose captured sequence is no longer current is stale — the caller issued another turn while it was in flight — and a stale or post-unmount result no longer folds into hook state. `reset` bumps the counter, which is the same statement as "nothing outstanding may still land".

**The result is still RETURNED to its caller unchanged.** The guards decide what the hook's own state does, never what the caller is told; a turn that genuinely happened is not swallowed. No export, signature or prop moves, so this is a patch on the `@fuaran-ui/charts` 0.14.1 reading: a behavioural fix with no surface change. What a consumer gains is that two turns resolving out of order can no longer leave the hook holding the first one's tree while the caller believes it is looking at the second's.

### Recorded breaking change — `@fuaran-ui/renderer` 0.25.0 and `@fuaran-ui/renderer-server` 0.23.0, a bare `State` resolves to NOTHING (fuaran#1690)

`WIRE_FORMAT.md` gains §24.8 — the undeclared half of §24's declared-default rule — and both tiers' `resolve` moves onto it: a `Binding.State` carrying no declared `defaultValue`, at a key nothing has written and §24.4 has not seeded, is **UNRESOLVED**. It used to be `{ kind: 'Resolved', value: binding.defaultValue }` unconditionally, which for a bare `State` is a resolved `undefined`.

**What a consumer meets is the literal string `undefined` leaving the output.** At a text slot the runtime stringified that resolved nothing, so `undefined` reached the DOM and the SSR markup; at a numeric slot it read as a value rather than as absence. Both now render the slot's ordinary unresolved state — the em-dash at a `Metric`, the empty string at a text slot, the empty state at a collection — and a node whose `visible` predicate is a bare `State` renders where a fabricated falsy value could have removed it.

**Both tiers move in one change-set, necessarily.** A server that resolved differently from the client it hands over to is a hydration mismatch, so this is one statement about two packages rather than two changes that happen to agree.

**`@fuaran-ui/schema` 0.24.0 carries the predicate the three seams share.** `stateDefaultDeclared` is an additive export: the one definition of "does this `State` declare a default", read by the encoder (which member to emit, §5's absent-default posture) and by both resolvers (whether an unwritten slot has a default to fall back to). It reads `defaultDeclared` and not just the value, because `defaultValue` carries the slot's typed placeholder whether or not the document said anything — the pair Phase 1656 introduced for exactly this reason. Three copies of a predicate whose whole contract is that they agree is a shape this family has shipped a defect in before; `@fuaran-ui/ops` swaps its own copy for the shared one, changing no byte it emits. That swap was cut as an 0.27.1 patch and **never published**: fuaran#1821 landed on the same untagged slot with a wire change of a higher class and advanced it, so 0.28.0 is the version a consumer gets it on.

**What certifies it.** `packages/renderer-server/test/bareStateResolution.test.ts`, which asserts both tiers' resolvers and the rendered markup, and whose go-red is measured: restoring the old arm fails it with `expected { kind: 'Resolved', value: undefined }` and with `undefined` present in the markup. The corpus's render-text family pins the same rule as `bare-state-numeric-slot-unresolved`; neither `@fuaran-ui` renderer has a reader for that family, which is why the pin lives here.

### `@fuaran-ui/theme-manifest` 0.12.0 — the manifest gains an ENCODER (fuaran#1729)

`@fuaran-ui/theme-manifest` exports `encodeManifest(m: ThemeManifest): string`. The package shipped
`decodeManifest` / `manifestFromJson`, the three projectors and `merge` and **no encoder of any
spelling**, so a brand override merged in the browser could not be sent back to a server or
persisted, and the tier could not prove a decoded manifest re-encodes to its bytes.

**The bytes are not this tier's to choose.** `fuaran-rs` is the first host to emit a theme manifest
(Phase 1725), and its literals in `fuaran-rs/tests/manifest.rs` are the portable oracle every later
host is held to. `packages/theme-manifest/test/encode.test.ts` copies them VERBATIM — the sample
manifest's bytes, the projected manifest's bytes, the omit-at-default cases and the three model
states the wire cannot carry — rather than recording them from a run here, because a byte pin whose
recorder is the code under test pins nothing. Read a disagreement as a wire-format question for
every host at once, not as a fixture refresh.

**What it emits.** Always the Fuaran wrapper shape, never a bare DTCG tree: a top-level `tokens` key
is what selects the wrapper branch at decode, so omitting it when empty would read back as vanilla
DTCG and silently discard meta, roles and invariants — which is why the empty manifest is
`{"tokens":{}}` and not `{}`. Every member the decoder tolerates the absence of is omitted at its
default (an empty `$type`, a `DEFAULT_WEIGHT` invariant, an anonymous role binding), so a projected
manifest does not carry a page of empty strings. The round trip is stated precisely on
`encodeManifest`'s own doc comment: an exact model identity for any manifest the decoder produced,
and a FIXPOINT for a projector or `merge` result, whose first-appearance token order the wire's
sorted order normalises while preserving the token set.

**`@fuaran-ui/ops` joins `@fuaran-ui/schema` as a peer dependency**, for `renderAstCanonical` — the
renderer the op-stream and wire codecs already emit through. A canonical renderer local to this
package would be a second one in the tier, which is drift by construction; the `emits canonical
JSON` pin is the host-neutral half of the claim, and the one a sibling host can check without
agreeing with this tier about anything else.

**It did NOT ride a draft — 0.11.1 was the TAGGED version** (`v0.27.0` published it), so the release
gesture advances `@fuaran-ui/theme-manifest` to **0.12.0**: the surface grows. `@fuaran-ui/style-observer`
**0.11.1** is the bump beside it, per the release-consistency rule — the 0.11.0 npm serves declares
`@fuaran-ui/theme-manifest` `^0.11.0` (the range recorded here as `^0.11.1` when this was written was
the workspace's, not the registry's; either spelling excludes 0.12.0). Both belong to the release
sweep rather than to this change, which is why bumping here in isolation would have put
`dev-scripts/check-peer-ranges.mjs` into exactly the unsatisfiable-set failure it exists to catch.
Both land in the 0.28.0 release set recorded below.

### Recorded breaking change — `@fuaran-ui/ops` 0.28.0, the dataframe algebra spells its column members out (fuaran#1821)

**Breaking by the wire test in the list above — "removing or retyping an emitted field".** Three
members of the dataframe algebra change the name they are EMITTED under, so every document this
encoder writes that carries a `project` step, a sort key or a window's frame ordering has different
bytes at 0.28.0 than at 0.27.0:

| Site                                         | 0.27.0 | 0.28.0    | decode alias kept |
| -------------------------------------------- | ------ | --------- | ----------------- |
| a `project` step's rename list               | `cols` | `columns` | `cols`            |
| a sort key                                   | `col`  | `column`  | `col`             |
| a window's frame-ordering entry (same shape) | `col`  | `column`  | `col`             |

The rule it implements is the 0.28.0 substrate one: a wire member whose only honest name is "the
column" or "the columns" is spelled out in full and never abbreviated. `decodeOp` / `decodeNode`
**accept either spelling** through `cFieldAliased`, and **refuse a document that gives both** as the
same ambiguity every other aliased member of this algebra already refuses. So reading is widened,
never narrowed; what moves is what this host WRITES.

**What it costs a consumer.** A decoder that predates the rename — this package at ≤ 0.27.0, or any
sibling host not yet on the 0.28.0 substrate — refuses a `project` step emitted by 0.28.0, as a
missing `cols` field. The two halves differ here and the difference is worth knowing: the sort-key
site is a POLARITY SWAP, since fuaran-core#92 already admitted `column` as an alias of `col`, so a
host carrying that alias reads the new spelling unchanged; the `project` site is genuinely new — it
read a plain `cols`, so `columns` was a missing field there and the both-present ambiguity had no
refusal at all. Upgrade the readers before the writers, which the kept aliases are what make
possible.

**No exported type or signature moves, and the MODEL fields keep their names.** `SortKey.col` and the
`project` case's `cols` are this package's published interface; renaming them would break every
consumer's construction sites to say nothing new on the wire. The doc comments in
`@fuaran-ui/schema`'s `compute.ts` now state the wire spelling beside each one, so the divergence is
deliberate and findable rather than a discrepancy someone will later "fix". This is therefore NOT the
author-direction class recorded above — nothing an author constructs changes shape.

**Deliberately not touched**, and pinned by fixtures that did not move: the `col` EXPRESSION `$type`
tag, which names a kind of expression rather than a column; and the Grid / Masonry box-layout `cols`
integer, a column COUNT outside this algebra, where `cols` stays canonical and `columns` stays its
alias — the opposite direction, through the node-layer `fieldAliased`, which lets the canonical win
rather than refusing. `ColPair`'s `a` / `b` name a POSITION in a pair, which is why the rule does not
reach them either.

**Why the number is 0.28.0 and not 0.27.2.** 0.27.1 was a DRAFT — cut by fuaran#1690, never
published, and carrying a patch (the `stateDefaultDeclared` swap, which moved no emitted byte). A
change of a higher class than the draft already carries advances it rather than riding it, per the
versioning policy below: the number is what tells a consumer what adopting it costs, and a patch
number over a change of emitted bytes says the wrong thing. Pre-1.0, per this document's caveat, a
breaking change is a minor.

**What certifies it.** The corpus families, which are the cross-host oracle for all three sites — the
bundled snapshot re-syncs to authority `14fa1db`, carrying the renamed fixtures plus
`lenient/lenient-transform-column-member-legacy` (the pre-rename spelling still decoding) and the two
both-present refusals, `reject/reject-transform-project-columns-and-cols` and
`reject/reject-transform-sort-key-column-and-col`. `@fuaran-ui/conformance` 0.25.0 is the bundled
corpus that carries them.

### Recorded release-consistency bumps — 0.28.0 release set (fuaran#1690, fuaran#1729, fuaran#1821)

The `v0.27.0` tag left published packages declaring `@fuaran-ui/*` ranges that the versions this
release publishes fall outside, and the publish workflow SKIPS a package whose version has not moved
— so their registry manifests would keep those ranges in front of consumers. **The remedy is a
version bump and can only be a version bump**: each range was generated from `workspace:^` at ITS
package's pack time and is not editable in place.

**The class is decided per package, from what has actually changed since the commit that set its
current version — not from the fact that a bump is needed.**

| Package                     | From → to       | Class     | What changed since its current version was set                                                                                                                   |
| --------------------------- | --------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@fuaran-ui/ai-tools`       | 0.13.0 → 0.13.1 | patch     | Only `test/` — an introspection test. Test-only surface is outside semver here. The tarball otherwise differs only in the regenerated `@fuaran-ui/schema` range. |
| `@fuaran-ui/charts`         | 0.14.1 → 0.14.2 | patch     | Nothing. No source, test, README or manifest edit. The tarball differs only in the regenerated `@fuaran-ui/ops` and `@fuaran-ui/schema` ranges.                  |
| `@fuaran-ui/client`         | 0.12.1 → 0.12.2 | patch     | Nothing, as `charts` — here for `ops`, `schema` and `renderer`.                                                                                                  |
| `@fuaran-ui/mcp`            | 0.13.0 → 0.13.1 | patch     | Nothing, as `charts` — here for `ops`, `schema` and `renderer-server`.                                                                                           |
| `@fuaran-ui/op-stream`      | 0.11.1 → 0.11.2 | patch     | Nothing, as `charts` — here for `ops` and `schema`.                                                                                                              |
| `@fuaran-ui/react`          | 0.12.1 → 0.12.2 | patch     | Nothing, as `charts` — here for `schema` and `renderer`.                                                                                                         |
| `@fuaran-ui/style-observer` | 0.11.0 → 0.11.1 | patch     | Only `test/`. The regenerated range is `@fuaran-ui/theme-manifest`, whose 0.12.0 falls outside the published `^0.11.0`.                                          |
| `@fuaran-ui/ui`             | 0.21.0 → 0.22.0 | **minor** | Nothing under `packages/ui` — and still a minor. See below.                                                                                                      |

**Why `ui` is the one minor in that table.** It is the only package in the set whose entry point
carries `export * from '@fuaran-ui/schema'`, so `@fuaran-ui/schema` 0.24.0's additive
`stateDefaultDeclared` is part of what THIS package presents to an author: its exported surface grows
even though no file under `packages/ui` moved. That is the same distinction the 0.27.0 table drew
when it kept six packages at patch — the class attaches to the package whose author surface moved,
and for the seven above the widened `schema` is reached through the consumer's own peer pin, at
whatever version that pin names.

**`@fuaran-ui/cli` is deliberately NOT bumped**, stated because an absence is otherwise
indistinguishable from an oversight: its published ranges are `@fuaran-ui/client` `^0.12.1` and
`@fuaran-ui/mcp` `^0.13.0`, and both of those bumps stay inside their carets. `@fuaran-ui/mock`,
`@fuaran-ui/layout-observer`, `@fuaran-ui/telemetry`, `@fuaran-ui/validator` and the two defensive
placeholders declare no `@fuaran-ui/*` range at all and are likewise unmoved.

**Riding their drafts, unchanged by this sweep**: `@fuaran-ui/schema` 0.24.0, `@fuaran-ui/renderer`
0.25.0, `@fuaran-ui/renderer-server` 0.23.0 and `@fuaran-ui/conformance` 0.25.0 were each cut after
`v0.27.0` and never published, so they carry their own sections above and fuaran#1821's additions to
them — doc comments in `schema`, rendered-output snapshots in `renderer`, the bundled corpus in
`conformance` — ride those numbers rather than advancing them.

**Verified against the registry before the tag**, which is the check's whole point:
`node dev-scripts/check-peer-ranges.mjs` reports OK over 21 publishable packages, 7 of them already on
the registry and checked against their PUBLISHED ranges.

### `@fuaran-ui/style-observer` 0.11.2 — palette attribution follows the canonical token-path order (Phase 1840)

**Unreleased** — 0.11.2 is ahead of the newest tag (`v0.28.0` published 0.11.1).

**What moved.** `verifyUsageBudgets` attributes a node's rendered fill to ONE palette token — the
first colour token whose value matches — and it used to iterate the tokens in the order
`@fuaran-ui/theme-manifest`'s decoder yields them, which is DOCUMENT order. It now iterates them in
**canonical token-path order**, the ruling Phase 1727 recorded in the theme-manifest contract text:
paths compare segment by segment, a shorter prefix first, each segment by Unicode code point. So when
a manifest declares two same-valued colour tokens (an alias, say), the fill is attributed to the
path-first one, whatever order the file declares them in. Two details are deliberate: the order is
segment-wise, not a sort of the dotted string (`color.brand.base` precedes `color.brand-alt` although
`-` sorts before `.` as a character), and a segment compares by code point, not by JavaScript's
default UTF-16 code-unit comparison, which would put a supplementary-plane character ahead of
U+E000–U+FFFF where every other host puts it after. The decoder is unchanged — it still preserves
document order, which a projection consumer may rely on — so the ordering lives at the attribution
site, the same shape the F# reference and Python hosts took.

**What it costs a consumer.** Nothing for a manifest whose colour values are distinct — attribution
is unambiguous there and no flag moves. For a manifest that carried a tie, the `UsageBudgetExceeded`
flags can change: the area now counts against the path-first token's budget. No exported signature
moved and no wire byte moves (`encodeStyleFlag` / `encodeStyleObservation` are untouched), so this is
a **patch** — a behavioural alignment of an existing function, advancing the TAGGED 0.11.1 rather
than riding a draft, because there was none for this package. `perNodeFlags` asks only whether a fill
is on the palette at all, so its output cannot depend on the order.

**Which hosts moved.** Under the ruling, three hosts' attribution could change: the F# reference and
Python (Phase 1727) and this one. Go and Rust already yielded tokens in that order from their DTCG
walk and were pinned rather than changed. With this change all five hosts in the theme-manifest
family — F#, Python, Go, Rust and TypeScript — attribute the two tie vectors identically.

**What certifies it.** `test/corpusConformance.test.ts` runs every `style-observer` vector in the
shared corpus — all three tiers, the two `budget-same-valued-tokens-*` vectors among them — against
the bytes the reference host recorded when it emitted them; the family was previously certified on
no leg of this tier. `test/manifestFlags.test.ts` pins the order corpus-independently, including the
code-point case the corpus does not carry. Peer ranges are unaffected: no `@fuaran-ui/*` package
depends on `@fuaran-ui/style-observer`, and its own `@fuaran-ui/theme-manifest` range is unchanged.

## Unstable surfaces

The following are explicitly **not** covered by semver and may change in any patch release without notice:

- Anything whose name is prefixed `__` (double underscore) – including the phantom brand fields on branded primitives (`__brand`, `__min`, `__max`, `__validated`).
- The `try*` non-throwing bounded variants' exact error-message strings (the failure is stable; the message text is not).
- The `NOT_PROVIDED_SENTINEL` constant value.
- Test-only surface in any `test/` directory.

## Versioning policy

Per-release semver bump. Pre-1.0: plain `0.x.y` versions, no prerelease suffix (a release bumps the patch, or the minor when the surface grows). The packages are INDEPENDENTLY VERSIONED — a package's version tracks its own surface — while the repository tag `vX.Y.Z` marks a RELEASE GESTURE over the workspace as it then stands. The publish workflow ([`.github/workflows/publish.yml`](.github/workflows/publish.yml)) is triggered by that tag push, packs each publishable package and publishes the tarballs over npm trusted publishing (OIDC), skipping any version already on the registry; `@fuaran-ui/ui` declares `@fuaran-ui/schema` as a peer dependency, so the two ship together.

**A change to a published surface advances that package's version in the same commit; a change that rides an already-advanced, not-yet-tagged version says so.** The second half is what keeps a release honest under several concurrent changes: once a package's version is ahead of the newest tag it is a DRAFT, and an additive or same-class change rides it rather than minting a number nobody will ever install. A change of a HIGHER class than the draft already carries advances it again, because the number is what tells a consumer what adopting it costs.

**What proves a release, as opposed to a build.** Every suite in `ci.yml` runs inside this workspace, against linked packages and built `dist/` — the right lane for "does the code agree with itself", and structurally blind to the two ways a release fails a newcomer: a package that does not install at all, and two hosts whose PUBLISHED bytes disagree while their sources do not. The clean-machine install smoke ([`.github/workflows/install-smoke.yml`](.github/workflows/install-smoke.yml), fixtures in [`dev-scripts/install-smoke/`](dev-scripts/install-smoke/)) installs the current release from npm and restores it from nuget.org with every local source cleared, authors one tree through each tier's own surface, and requires the canonical bytes to match. It runs after a successful publish, weekly, and on demand — its inputs are the registries, not this branch.

### Where the release notes live

**This file is the changelog.** There is no `CHANGELOG.md` in this repository, and adding one would split the record in two: the reason a version moved and the surface it moved are the same paragraph, and that paragraph belongs beside the surface it describes.

The convention, shared with the other producers in this family so a reader crossing between them meets one shape:

- One `###` section per notable change, headed `<package> <version> — <what changed> (<citation>)`, or `Recorded breaking change — <package> <version>, <what changed> (<citation>)` when a consumer must act.
- The section says what moved, **why**, what it costs a consumer, and what certifies it (the fixture, vector or suite). A line that only names the change is not a release note.
- The citation is the bare phase ordinal (`Phase NNN` / `fuaran#NNN`) that carried it — a searchable trail rather than a link that rots.
- A section for a version that is ahead of the newest tag states that it is unreleased, so a reader can tell a shipped change from a queued one.
- The git tag is the release marker; release notes for a tag are the sections naming versions that tag first published.

## Re-confirmation gate before public exposure

Before this repo flips public (public GitHub repository, published-to-npm package, or marketing surface), the licensing posture declared in [`LICENSE`](LICENSE) must be re-confirmed by Diametrical Ltd.

## See also

- [`LICENSE`](LICENSE)
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`CLAUDE.md`](CLAUDE.md)
- [`fuaran-dotnet/STABILITY.md`](../fuaran-dotnet/STABILITY.md) – the F# language-tier counterpart.
- [`fuaran-dotnet/docs/WIRE_FORMAT.md`](../fuaran-dotnet/docs/WIRE_FORMAT.md) – the shared wire-format authority.
