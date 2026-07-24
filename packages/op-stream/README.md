# @fuaran-ui/op-stream

Hash-chained op-stream persistence + replay for the [Fuaran UI](https://github.com/fuaran-ui/fuaran-ts) wire format — the TypeScript port of the F# `Fuaran.UI.OpStream.{Abstractions,InMemory,Replay}` tier.

Every applied `TreeOp` becomes an append-only, SHA-256-chained `OpRecord`. Because the chain consumes [`@fuaran-ui/ops`](../ops)'s canonical encoder for input determinism, an `OpRecord` hash is **bit-identical to the F# tier** over the same op sequence — so a TypeScript-authored stream is a full op-history peer of the F# tier: replayable and tamper-evident (FGP 5 — the op stream is the source of truth).

## Install

```sh
npm install @fuaran-ui/op-stream
```

Peer dependencies: `@fuaran-ui/schema`, `@fuaran-ui/ops`.

## Usage

```ts
import {
  createInMemorySink,
  applyAndPersist,
  replayStream,
  verifyChain,
} from '@fuaran-ui/op-stream';
import type { PersistContext } from '@fuaran-ui/op-stream';

const sink = createInMemorySink();
const ctx: PersistContext = { streamId: 'session-1', userId: 'alice' };

// Apply an op and durably record it in one call.
let tree = initialTree;
const result = await applyAndPersist(sink, ctx, op, tree);
if (result.ok) tree = result.value;

// Reconstruct the tree from the stream (resume from any sequence / checkpoint).
const replayed = await replayStream(sink, 'session-1', initialTree);

// Prove the stream was not tampered with.
const violation = verifyChain(
  await sink.replay('session-1', 1, await sink.latestSequence('session-1')),
);
// violation === undefined ⟺ clean chain
```

## Surface

| Export                                      | Role                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `InMemorySink` / `createInMemorySink`       | Map-backed `IOpStreamCheckpointSink` — tests + client-side authoring.                   |
| `applyAndPersist`                           | Apply once, then persist a hash-chained `OpRecord` on success (best-effort durability). |
| `applyTo` / `replayStream`                  | Fold a record sequence through the `@fuaran-ui/ops` apply engine.                       |
| `computeHash` / `verifyChain` / `sha256Hex` | The hash-chain primitive — dependency-free, synchronous, isomorphic.                    |
| `genesisPreviousHash`                       | Sixty-four `0` characters — the genesis link of every stream.                           |

The SQLite sink (`Fuaran.UI.OpStream.Sqlite`) is intentionally out of scope; an IndexedDB-backed sink is a candidate follow-up. The in-memory sink is sufficient for the client-side authoring loop.

## Stability

The `OpRecord` wire shape + hash-chain semantics are declared stable in [`STABILITY.md`](../../STABILITY.md). The in-memory sink is stable on ship.

Apache-2.0.
