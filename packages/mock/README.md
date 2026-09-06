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
- **Fresh vs. repair.** A request with no `currentTree` is a fresh generation
  (`opsApplied: 0`); a request carrying a current tree is a repair (a small
  canonical `TreeOp`, counted).
- **The endpoint's own shape.** A 200 is `{version, tree, opsApplied, provider,
  servedModel, snapshot}` with `tree` as a JSON OBJECT, and every refusal is
  `{"error": {"code", "message", "stage"?}}` — so a client this mock certifies
  can talk to a deployment. (`ops` is carried beside `opsApplied` even though
  the endpoint sends only the count: withholding it would make the repair half
  of a turn loop untestable, and every conformant client prefers the count.)
- **Zero-secret.** The access token and provider key are read from nowhere and
  required by nothing; nothing is logged per request. A body CARRYING one is
  refused `400 SECRETS_IN_BODY`, exactly as the endpoint does, so a client that
  has not moved its secrets into headers fails here rather than in production.
- **Refusals you can ask for.** A client's error paths are only testable
  against an endpoint that can fail, and this one cannot fail for the real
  reasons (an expired token, a provider outage). Put a marker in the prompt and
  the mock replies with that refusal: `mock:access-denied` (401),
  `mock:turn-failed` (422, apply stage), `mock:secrets-in-body` (400),
  `mock:missing-key` (400), `mock:faulted` (500), `mock:unconfigured` (503). An
  empty, unparseable or prompt-less body is `400 BAD_REQUEST` on its own.
- **Surface version.** Every produced turn echoes the surface-version stamp the
  SDKs are built against.

## Library use

The handler and server are also importable for embedding in a test harness:

```ts
import { handleTurn, createMockServer, startMockServer, matchTree } from '@fuaran-ui/mock';

const { server, port } = await startMockServer({ port: 0 }); // 0 → an ephemeral free port
```
