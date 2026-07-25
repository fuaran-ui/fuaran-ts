# @fuaran-ui/mock

A local, **offline** stand-in for the Fuaran generation endpoint. It speaks the
same `TurnRequest → TurnResult` contract but returns **canonical trees by prompt
match** from the bundled conformance corpus — so you can build and test a full
SDK integration loop with **no access token and no BYOK token spend**, then swap
to the real endpoint with a single base-URL change.

Deterministic, zero-secret, and dependency-light (Node stdlib only) — safe to
run in CI and agent sandboxes.

## One-command start

```bash
npx @fuaran-ui/mock            # listens on http://127.0.0.1:8123
npx @fuaran-ui/mock --port 9000
FUARAN_MOCK_PORT=9000 npx @fuaran-ui/mock
```

`GET /health` is a readiness probe; `POST <any path>` with a `TurnRequest` body
returns a `TurnResult`.

## Point an SDK at it

The only change from the real endpoint is the base URL — no token, no key:

**TypeScript (`@fuaran-ui/client`):**

```ts
import { FuaranClient } from '@fuaran-ui/client';

const client = new FuaranClient({ endpoint: 'http://127.0.0.1:8123' });
const result = await client.generate({ prompt: 'a metric strip showing revenue' });
// result.kind === 'produced'; result.treeJson decodes to a real Node.
```

**F# (`Fuaran.UI.Client`):**

```fsharp
open Fuaran.UI.Client
let client = FuaranClient(FuaranClientConfig.create "http://127.0.0.1:8123")
// client.Generate(GenerateArgs.prompt "a metric strip showing revenue")
```

When you are ready to go live, change `endpoint` to the real generation endpoint
URL and supply your access token + BYOK key — nothing else in your code changes.

## Behaviour

- **Prompt → tree.** The prompt is matched to a bundled fixture by keyword
  (`metric` / `dashboard` / `form` / `button` / `callout` / `heading` / `badge`);
  a no-match returns a deterministic **placeholder** tree, never an error.
- **Fresh vs. repair.** A request with no `CurrentTreeJson` is a fresh
  generation (an empty op list); a request carrying a current tree is a repair
  (a small canonical `TreeOp` in `Ops`).
- **Zero-secret.** `AccessToken` / `ByokKey` are read from nowhere and required
  by nothing; nothing is logged per request.
- **Surface version.** Every produced turn echoes the surface-version stamp the
  SDKs are built against.

## Library use

The handler and server are also importable for embedding in a test harness:

```ts
import { handleTurn, createMockServer, startMockServer, matchTree } from '@fuaran-ui/mock';

const { server, port } = await startMockServer({ port: 0 }); // 0 → an ephemeral free port
```
