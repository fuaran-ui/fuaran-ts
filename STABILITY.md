# Fuaran TypeScript reference-implementation stability policy

This document declares which `@fuaran-ui/*` surfaces are stable, what counts as a breaking change in each, and the semver rules that govern the npm packages shipped from this repo. It is the contract that downstream consumers can rely on when pinning a `@fuaran-ui/*` version. It mirrors the shape of the F# language tier's [`STABILITY.md`](https://github.com/fuaran-ui/fuaran-dotnet/blob/main/STABILITY.md); where the two tiers describe the same wire format, the [`fuaran-specification`](https://github.com/fuaran-ui/fuaran-specification) spec + conformance corpus are the shared authority.

## Scope

| Package                      | Licence    | Version status    |
| ---------------------------- | ---------- | ----------------- |
| `@fuaran-ui/schema`          | Apache 2.0 | pre-1.0           |
| `@fuaran-ui/ui`              | Apache 2.0 | pre-1.0           |
| `@fuaran-ui/ops`             | Apache 2.0 | pre-1.0           |
| `@fuaran-ui/renderer`        | Apache 2.0 | pre-1.0           |
| `@fuaran-ui/renderer-server` | Apache 2.0 | pre-1.0           |
| `@fuaran-ui/op-stream`       | Apache 2.0 | pre-1.0           |
| `@fuaran-ui/layout-observer` | Apache 2.0 | pre-1.0           |
| `@fuaran-ui/style-observer`  | Apache 2.0 | pre-1.0           |
| `@fuaran-ui/theme-manifest`  | Apache 2.0 | pre-1.0           |
| `@fuaran-ui/ai-tools`        | Apache 2.0 | pre-1.0           |
| `@fuaran-ui/conformance`     | Apache 2.0 | pre-1.0           |
| `@fuaran-ui/validator`       | Apache 2.0 | pre-1.0           |
| `@fuaran-ui/client`          | Apache 2.0 | pre-1.0           |

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

The **`<FuaranRenderer>` prop shape and the emitted class-name + ARIA vocabulary are stable**, subject to the wire-format forward-coupling rule – renderer dispatch must accept any tree the wire spec admits, and the per-`NodeKind` / `LayoutKind` / `DisplayKind` class names are byte-for-byte parity with the F# reference renderer ([`fuaran/src/Fuaran.UI.Renderer/Render.fs`](../fuaran/src/Fuaran.UI.Renderer/)). This covers:

- The `<FuaranRenderer tree dispatch sources runtime theme>` prop record ([`packages/renderer/src/Renderer.tsx`](packages/renderer/src/Renderer.tsx)).
- The class-name contract (`fuaran-kind-*`, `fuaran-layout-*`, `fuaran-tone-*`, `fuaran-button-*`, `fuaran-badge-*`, `fuaran-motion-*`, …) and the ARIA attribute set ([`packages/renderer/src/classNames.ts`](packages/renderer/src/classNames.ts) + the per-family renderers under `packages/renderer/src/render/`) – renaming a class is a **major-version event**, because the packaged reference CSS and any consumer CSS key off them.
- The packaged **reference CSS** (`@fuaran-ui/renderer/css`, the `./css` export) – declared stable + versioned alongside the package; a breaking class-name change is a major-version event. It is sync-packaged from the F# tier's reference CSS (a maintainers' byte-copy sync discipline).
- The `@fuaran-ui/renderer/sanitize` seam (`sanitizeUrl`, `sanitizeUrlOrBlank`, `sanitizeExtraAttributes`, `sanitizeMarkdownHtml`) – the render-time injection-safety contract mirroring [`fuaran/SANITIZATION.md`](../fuaran/SANITIZATION.md) (Phase 56). The behaviour (which schemes/keys/elements are blocked) is stable; exact diagnostic strings are not.

The **custom-renderer registry** (`createCustomRendererRegistry`, `registerCustomRenderer`, `CustomRendererRegistry`, `FuaranRuntime`) and the **typed `Theme` + `themeToCss` bridge** are **stable** as of Phase 78, validated by the `samples/demo` app (it registers a `Custom` React component through the registry + `FuaranRuntime`, and applies a sample theme via the `theme` prop). React 19+ is a peer dependency.

### `@fuaran-ui/renderer-server`

The **`renderToHtml` body-fragment output is stable**, subject to the same class-name + ARIA forward-coupling rule as `@fuaran-ui/renderer` – the server renderer is a pure-string twin of the F# `Fuaran.UI.Renderer.Server` that emits the same `fuaran-*` class vocabulary the React client renderer does, with no React and no DOM. This covers:

- The `renderToHtml(tree, { sources })` entry point + its body-fragment contract (the host owns the document shell + the `<link>` to the packaged `@fuaran-ui/renderer/css`).
- The emitted **class-name + `data-fuaran-node-id` vocabulary**, parity-locked two ways (`test/parity.test.tsx`): the class set + node-id set equal the React client renderer's `renderToStaticMarkup` output for every corpus fixture, and every class is in the F# reference renderer's vocabulary. A drift in either direction is a build failure. This is what makes a server-rendered fragment safe to hand to the client renderer's `hydrate` entry points.
- The **server semantics**: interactivity renders inert (no event handlers); `Link` is a real sanitised `<a href>`; `Static` bindings resolve and the rest fall back; `Chart` / `Map` render a deterministic placeholder; `Custom` renders the inert labelled placeholder.

`@fuaran-ui/schema` + `@fuaran-ui/renderer` are peer dependencies (the latter only for its React-free `/sanitize` subpath + the packaged reference CSS); `react` / `react-dom` are **not** runtime dependencies. The HTML-escaping floor (`escapeText` / `escapeAttr`) and the binding / class-name helpers are re-exported for hosts.

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

The projectors (`projectFromFuaranToneVars` / `projectFromCssCustomProperties` / `projectFromDtcg` / `merge`) are **stable in behaviour**; their exact role-inference heuristics may be tuned in a minor release. Manifest JSON **encode** and the F# `ThemeBridge` (typed-`Theme` projector) are not yet ported (follow-up). `@fuaran-ui/schema` is the only peer dependency.

### `@fuaran-ui/ai-tools`

The introspection surface stays **alpha** – the F# `Fuaran.UI.AiTools` tier is shaped around an orchestrator's specific needs, and the TS port may grow as adopters surface different ones. Two sub-surfaces are nonetheless pinned to the F# tier, because a cross-implementation eval suite scores against them:

- `kindName` output – the wire-discriminator string per node, matching F# `Introspect.kindName` (including the Layout grid → `GridLayout` / Visualisation grid → `Grid` distinction).
- The binding-slot **expression forms** (`bindingExpression` – `$static` / `$queries.<name>` / `$filters.<name>` / `$selection.<nodeId>` / `$state.<key>` / `$computed` / `$i18n.<key>` / `$local` / `$format`) and the per-kind binding-slot table (`extractBindingSlots`), matching F# `BindingProbe.identify` + `extractBindings`.

The envelope shapes (`NodeIntrospection`, `TreeIntrospection`) and the `getNodeState` / `findNodes` / `inspectTree` / `FuaranIntrospectionProvider` surface may grow additively (e.g. a future `props` block or live binding-value resolution). `@fuaran-ui/schema` is a peer dependency; `react` is an optional peer (only the context provider + hook need it).

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

The canonical JSON wire format is specified language-neutrally in [`fuaran/docs/WIRE_FORMAT.md`](../fuaran/docs/WIRE_FORMAT.md), with the workspace [`wire-format-fixtures/`](../wire-format-fixtures/) corpus as the executable conformance suite. `@fuaran-ui/schema` is the TypeScript shape the codec is built on; `@fuaran-ui/ops` (Phase 76) ships the encoder/decoder verified against the corpus byte-for-byte (all 84 fixtures: 56 round-trips byte-identical to the F# encoder – 46 Node + 10 TreeOp – + 28 reject cases surfacing the same `DecodeErrorCode` at the same path).

The wire format is **stable**. Breaking changes (major-version events): changing a discriminant string, removing or retyping an emitted field, changing a sentinel string, or changing a `DecodeError` code. **Non-breaking** (additive): a new tagged-union case or a new optional field omitted when absent.

**Forward-coupling rule (load-bearing).** Per [`WIRE_FORMAT.md` §11](../fuaran/docs/WIRE_FORMAT.md), adding a new `NodeKind` / `Spec` / `TreeOp` / `Binding` / `Action` case in any future phase MUST, in the same commit, update the F# encoder + decoder + the `wire-format-fixtures/` corpus **and** bump the `@fuaran-ui/schema` shape + the `@fuaran-ui/ui` smart-ctor (when applicable) + the TS encoder/decoder (Phase 76 onward). The TypeScript and F# implementations move in lockstep against the shared spec + corpus.

## Unstable surfaces

The following are explicitly **not** covered by semver and may change in any patch release without notice:

- Anything whose name is prefixed `__` (double underscore) – including the phantom brand fields on branded primitives (`__brand`, `__min`, `__max`, `__validated`).
- The `try*` non-throwing bounded variants' exact error-message strings (the failure is stable; the message text is not).
- The `NOT_PROVIDED_SENTINEL` constant value.
- Test-only surface in any `test/` directory.

## Versioning policy

Per-release semver bump. Pre-1.0: plain `0.x.y` versions, no prerelease suffix (a release bumps the patch, or the minor when the surface grows). The publish workflow ([`.github/workflows/publish.yml`](.github/workflows/publish.yml)) is triggered by a `vX.Y.Z` tag push and runs `pnpm -r publish --access public`; `@fuaran-ui/ui` declares `@fuaran-ui/schema` as a peer dependency, so the two ship together.

## Re-confirmation gate before public exposure

Before this repo flips public (public GitHub repository, published-to-npm package, or marketing surface), the licensing posture declared in [`LICENSE`](LICENSE) must be re-confirmed by Diametrical Ltd.

## See also

- [`LICENSE`](LICENSE)
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`CLAUDE.md`](CLAUDE.md)
- [`fuaran/STABILITY.md`](../fuaran/STABILITY.md) – the F# language-tier counterpart.
- [`fuaran/docs/WIRE_FORMAT.md`](../fuaran/docs/WIRE_FORMAT.md) – the shared wire-format authority.
