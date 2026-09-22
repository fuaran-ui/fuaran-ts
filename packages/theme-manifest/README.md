# @fuaran-ui/theme-manifest

The machine-readable theme contract for [Fuaran UI](https://github.com/fuaran-ui/fuaran-ts) — the TypeScript twin of the F# `Fuaran.UI.ThemeManifest` tier.

A design-token system says what the values _are_. It does not say what must remain _true_ of the rendered result. This package is a **DTCG-compatible** token model (a vanilla DTCG file decodes cleanly) extended with the two things DTCG lacks:

1. **Semantic role bindings** — a mapping from a role a node plays (`Tone.Brand`, `"body-text"`) to the token that realises it, so "what colour did the AI's `Tone.Brand` actually become?" is answerable against a declared contract.
2. **Quantified invariants** — properties that must hold of the rendered result: per-role **contrast floors** (stricter than WCAG AA), colour **usage budgets** (the 60-30-10 heuristic as `targetPct ± tolerancePct`), and a **motion voice** ceiling. Each is soft-weighted.

It is the contract [`@fuaran-ui/style-observer`](../style-observer) verifies resolved computed styles against — deterministically, with no vision model.

## Install

```sh
npm install @fuaran-ui/theme-manifest
```

`@fuaran-ui/schema` (for `ToneVariant`) and `@fuaran-ui/ops` (for the tier's canonical-JSON renderer) are peer dependencies. No other runtime dependency.

## Usage

```ts
import { decodeManifest, resolveRole } from '@fuaran-ui/theme-manifest';

const result = decodeManifest(tokensJson); // DTCG file or { meta, tokens, roles, invariants }
if (result.ok) {
  const brandToken = resolveRole('Brand', result.value); // → ManifestToken | undefined
}
```

### Projecting an existing token surface

Lower the adoption floor — project your app's existing tokens into a baseline manifest, then enrich with invariants:

```ts
import {
  projectFromFuaranToneVars,
  projectFromCssCustomProperties,
  projectFromDtcg,
  merge,
} from '@fuaran-ui/theme-manifest';

const fromTones = projectFromFuaranToneVars(referenceCss); // roles inferred (the contract is semantic)
const fromVars = projectFromCssCustomProperties(appCss); // roles left unbound
const combined = merge(fromVars, fromTones); // last-write-wins, CSS-cascade order
```

### Handing a manifest back

`encodeManifest` is the inverse of `decodeManifest` — so a manifest derived in the browser (a projector, or a brand override `merge`d over a base) can be sent to a server or persisted:

```ts
import {
  decodeManifest,
  encodeManifest,
  merge,
  projectFromCssCustomProperties,
} from '@fuaran-ui/theme-manifest';

const merged = merge(base, brandOverride);
const json = encodeManifest(merged); // canonical JSON — sorted keys, no whitespace
```

The bytes are canonical and cross-host: the same manifest encodes identically here, in `fuaran-rs` and in `fuaran-go`. Every member the decoder tolerates the absence of is omitted at its default, and `decodeManifest(encodeManifest(m))` returns `m` for any manifest the decoder produced.

## API

| Export                                                                             | What it does                                                |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `decodeManifest(json)` / `manifestFromJson(value)`                                 | JSON (DTCG file or Fuaran wrapper) → `ThemeManifest`        |
| `encodeManifest(manifest)`                                                         | `ThemeManifest` → canonical JSON, the cross-host wire bytes |
| `projectFromFuaranToneVars` / `projectFromCssCustomProperties` / `projectFromDtcg` | an existing token surface → a baseline manifest             |
| `merge(base, over)`                                                                | last-write-wins combination, CSS-cascade order              |
| `resolveRole` / `resolveNamedRole` / `tryGetToken` / `paletteColours`              | lookups against a decoded manifest                          |
| `invariant` / `weightedInvariant` / `invariantKindName`                            | the soft-weighted invariant vocabulary                      |

## Stability

The contract shapes (`ThemeManifest`, `ManifestToken`, `ManifestRole`, `Invariant`) and the decode behaviour are declared stable in [`STABILITY.md`](../../STABILITY.md). The invariant vocabulary is **additive-only** (a new `InvariantKind` is a minor bump; redefining one is breaking). The encoded BYTES are equally stable — they are held to the `fuaran-rs` byte oracle, so changing one is a wire-format change for every host. The F# `ThemeBridge` (typed-`Theme` projector) is not yet ported (follow-up).

Apache-2.0.
