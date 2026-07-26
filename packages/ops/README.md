# @fuaran-ui/ops

Canonical-JSON codec (encoder + structural decoder) and tree-op apply engine for
the Fuaran UI wire format — a conformant **TypeScript host** of the
language-neutral contract specified in
[`fuaran-dotnet/docs/WIRE_FORMAT.md`](../../../fuaran-dotnet/docs/WIRE_FORMAT.md), sibling to the
F# host. Built on the typed shapes from
[`@fuaran-ui/schema`](../schema/) (a peer dependency).

```bash
npm install @fuaran-ui/ops @fuaran-ui/schema
```

## What it is

The _correctness_ layer of the TypeScript reference implementation. `@fuaran-ui/schema`
gives you the typed tree; this package makes a TS-authored tree **wire-conformant** —
it can be serialised, persisted, replayed, and exchanged with the F# tier
byte-for-byte. Verified end-to-end against the workspace
[`wire-format-fixtures/`](../../../wire-format-fixtures/) corpus: every valid fixture
round-trips byte-identically to the F# encoder, and every reject fixture surfaces
the same `DecodeErrorCode` at the same JSON path.

## API

```ts
import { encodeNode, decodeNode, encodeOp, decodeOp, apply } from '@fuaran-ui/ops';
import type { TreeOp, DecodeError, ApplyError } from '@fuaran-ui/ops';

// Encode (typed tree → canonical JSON string)
const json: string = encodeNode(node);

// Decode (canonical JSON string → storage-shape Node<unknown> | DecodeError)
const decoded = decodeNode(json); // Result<Node<unknown>, DecodeError>
if (decoded.ok) {
  /* decoded.value : Node<unknown> */
}

// TreeOp codec
const opJson = encodeOp(op);
const op = decodeOp(opJson); // Result<TreeOp<unknown>, DecodeError>

// Apply a tree-op (→ new tree + telemetry | ApplyError)
const result = apply(tree, op); // ApplyResult<TMsg>
if (result.ok) {
  /* result.value.newTree, result.value.emittedTelemetry */
}
```

### Three modules

| Module   | Role                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| `encode` | Symmetric port of the F# `CanonicalJson` encoder. Deterministic, byte-stable output.  |
| `decode` | Port of the F# `JsonDecode` decoder. Structural, `Result`-returning, six error codes. |
| `apply`  | Port of the F# apply engine. Atomic (`Batch`), revert-on-error, emits telemetry.      |

### `DecodeError` codes (WIRE_FORMAT.md §6)

`INVALID_JSON`, `MISSING_FIELD`, `WRONG_TYPE`, `UNKNOWN_DU_CASE`, `WRONG_NODE_KIND`,
`EMPTY_NODE_ID` — byte-identical to the F# decoder's codes, surfaced at a `$`-rooted
dotted path.

## Storage-shape erasure

Decode is **storage-shape erased**: it always yields `Node<unknown>` / `TreeOp<unknown>`,
because the wire carries no typed-`'Msg` information (every `'Msg` payload and every
closure encodes as the `"<closure>"` sentinel). Opaque `Binding.Static` payloads the
encoder couldn't decompose decode to the literal string `"<opaque>"`. Both placeholders
re-encode to the same sentinel, so the round-trip stays byte-stable; typed re-attachment
of the erased payloads is the host's responsibility.

## Conformance is the stability contract

Per the wire-format **forward-coupling rule**
([`WIRE_FORMAT.md` §11](../../../fuaran-dotnet/docs/WIRE_FORMAT.md)), adding a `NodeKind` / `Spec`
/ `TreeOp` / `Binding` / `Action` case updates the F# encoder + decoder + the corpus
**and** this TS codec + `@fuaran-ui/schema` in the same commit. Byte-equality against the
corpus — not just API non-breakage — is the contract.

## Licence

Apache-2.0. See [`STABILITY.md`](../../STABILITY.md) for the per-surface stability
declaration.
