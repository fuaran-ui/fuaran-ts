# Integration recipe – from access token to a live editing loop

The end-to-end story for wiring the Fuaran generation endpoint into a real app: get an
access token, plug in a BYOK provider key, run the cheap-diff editing loop, and handle
keys safely. Read the [quickstart](quickstart.md) first for the three-call shape; this
doc is the surrounding recipe.

## 1. Get access

Two credentials, two different jobs:

- **Access token** – your paid credential for the endpoint. It gates access and is
  checked at the edge before any model call. A missing / expired / invalid token comes
  back as `accessDenied` with the BYOK key never used.
- **BYOK provider key** – your own LLM provider key. The endpoint builds a provider from
  it in memory for one call and never stores it. This is _bring your own key_: you pay
  your provider directly; the endpoint does the Fuaran-specific prompt-to-tree work.

Where each lives, and how to keep the BYOK key off the wire, is [token-setup.md](token-setup.md).
The one rule up front: **never bundle a key into shipped client-side code.**

## 2. The editing loop (why it is cheap)

A naïve integration regenerates the whole UI on every prompt. Fuaran's model is a
**repair loop**: hold the tree the last turn produced, and the next prompt edits _that_
tree – the endpoint returns a small set of ops, not a fresh tree from scratch. Fewer
tokens, faster turns, stable identity across edits.

`FuaranSession` runs the loop for you: it carries the produced tree forward automatically
and advances only when a turn succeeds, so a failed turn leaves the held tree intact and
you can retry the same repair.

<!-- drift-check:compile integration-loop -->

```ts
import { FuaranClient, FuaranSession } from '@fuaran-ui/client';

const client = new FuaranClient({ endpoint: '/api/fuaran' });
const session = new FuaranSession(client);

// Turn one generates; the corpus flags are per-turn and opt-in (see below).
const created = await session.next('a pricing table with three tiers', {
  disableCorpusRead: true, // opt OUT of corpus reads for this turn
  contributeCorpus: false, // opt IN to contribute this turn to the next corpus version
});

if (created.kind === 'produced') {
  // The ops the turn applied — each has a dedup id + the canonical wire JSON of a TreeOp.
  for (const op of created.ops) {
    console.log(op.opId, op.opJson.length);
  }
}

// Every later turn is a repair against the held tree — a cheap diff.
const edited = await session.next('make the middle tier the highlighted one');
if (edited.kind === 'turnFailed') {
  // The held tree is unchanged — safe to retry. `stage` says where it failed:
  // 'access-token' | 'provider' | 'parse' | 'apply'.
  console.error(`retry — failed at ${edited.error.stage}: ${edited.error.message}`);
}
```

For a fresh start mid-conversation, `session.reset()` forgets the held tree so the next
turn generates again. To seed a session with a tree you already have, construct it with
`new FuaranSession(client, { initialTreeJson })`.

## 3. Corpus opt-in / opt-out

Two per-turn flags on every `generate` / `session.next` call control the learning corpus,
and both default to the privacy-preserving choice:

- **`disableCorpusRead`** – absent / `false` keeps corpus reads on (better results). Set
  `true` to run a turn without the learning corpus.
- **`contributeCorpus`** – absent / `false` contributes nothing. Set `true` to offer this
  turn (prompt + emitted tree) as a candidate for the next corpus version. **Contribution
  is opt-in** – nothing you send is retained for the corpus unless you set this flag.

## 4. Reading the result

Both calls resolve to a `TurnResult` discriminated on `kind`:

| `kind`         | Meaning                               | Carries                          |
| -------------- | ------------------------------------- | -------------------------------- |
| `produced`     | new tree (HTTP 200)                   | `treeJson`, `ops`, `version`     |
| `accessDenied` | token missing/expired/invalid (401)   | `reason`                         |
| `turnFailed`   | provider / parse / apply failed (422) | `error.{ stage, code, message }` |

`turnFailed.error.message` at the `apply` stage carries the apply-error envelope, so a
follow-up prompt can re-emit against the hint. It never carries your BYOK key.

## 5. The richer path (optional)

If your integrator is a **coding agent**, point it at [`@fuaran-ui/mcp`](../packages/mcp/README.md)
instead of hand-wiring: the same endpoint plus recipe lookup, wire-format validation, and
scaffold generation, exposed as MCP tools. The docs here are the low-install floor that
works with no MCP server at all; the MCP server is the richer, agent-native path.

---

_The `ts` block above is compile-checked against the current SDK by
[`check-drift.mjs`](check-drift.mjs)._
