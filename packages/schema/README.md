# @fuaran-ui/schema

The TypeScript shape of the **Fuaran UI typed record contract** (§4b). This package is the foundational layer of the `@fuaran-ui/*` set: the types every other package is built on.

It is **one conformant host** of the canonical Fuaran wire format, declared language-neutrally in [`WIRE_FORMAT.md`](https://github.com/fuaran-ui/fuaran-specification/blob/main/WIRE_FORMAT.md) (the `fuaran-specification` repo: spec + schema + conformance corpus). The F# `Fuaran.UI` tier is the other host. The spec + its conformance corpus — not any single implementation — are the authority.

## What's in here

- **`types.ts`** — tagged unions for every `NodeKind` / `LayoutKind` / `DisplayKind` / `InputKind` / `VisKind` / `Binding` / `Action` / `TextSource` / `CellFormat`, every spec record (`MetricSpec`, `DashboardSpec`, `TabsSpec`, …), and branded primitives (`NodeId`, `FragmentId`, `ApiEndpoint`, `IconSource`). F# discriminated unions become TS unions discriminated by a `kind: '<CaseName>'` literal; F# `option` becomes an optional property (absent key = the wire format's "field absent" / `None` semantics — `undefined`, never `null`).
- **`defaults.ts`** — a typed default for every spec, composed with object spread: `{ ...defaults.metric, label: ... }`.
- **`bounded.ts`** — parse-don't-validate bounded scalars: `nonEmptyString`, `boundedString`, `boundedInt`, `fraction`. The constructor is the only way to obtain the branded type; out-of-range input throws `BoundedConstructionError`.
- **`result.ts`** — the vanilla `Result<T, E>` discriminated union.

## Usage

```ts
import { type Node, type NodeKind, defaults, boundedInt } from '@fuaran-ui/schema';

// A bounded value is in-range by construction:
const cols = boundedInt(1, 12, 4); // BoundedInt<1, 12>

// Compose specs from defaults:
const metricSpec = { ...defaults.metric, format: { kind: 'Currency', code: 'GBP' } as const };
```

To author trees ergonomically, use the smart constructors in [`@fuaran-ui/ui`](https://www.npmjs.com/package/@fuaran-ui/ui) rather than building `Node` literals by hand.

## Stability

The wire-format-mirroring surface of this package is **stable** (see [`../../STABILITY.md`](https://github.com/fuaran-ui/fuaran-ts/blob/main/STABILITY.md)), governed by the wire-format forward-coupling rule.

## Licence

Apache 2.0. See [`../../LICENSE`](https://github.com/fuaran-ui/fuaran-ts/blob/main/LICENSE).
