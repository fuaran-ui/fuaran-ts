# @fuaran-ui/client

A small, typed TypeScript client over the **Fuaran generation endpoint** — a
paid, stateless, bring-your-own-key (BYOK) HTTPS surface that turns a prompt
(plus an optional current tree) into a canonical Fuaran wire-format UI tree.

It collapses the integration to three things: **call, render, remember the
tree**. You write no hand-rolled `fetch`, no JSON wrangling, and no token
plumbing — and you never parse or validate raw model output yourself.

> The **endpoint URL** and the **paid access token** are the commercial gate.
> This package is a thin, open-source HTTPS + types layer over that endpoint;
> installing it does not grant access.

## Install

```sh
npm install @fuaran-ui/client
# for the renderer glue (decode + mount), also:
npm install @fuaran-ui/renderer @fuaran-ui/ops @fuaran-ui/schema react react-dom
```

## Quickstart (≈10 lines)

```ts
import { FuaranClient, FuaranSession } from '@fuaran-ui/client';
import { mountProduced } from '@fuaran-ui/client/render';
import '@fuaran-ui/renderer/css';

const client = new FuaranClient({ endpoint: '/api/fuaran' }); // server-proxied
const session = new FuaranSession(client); // holds the tree between turns

const first = await session.next('a metric card showing revenue');
if (first.kind === 'produced') mountProduced(document.getElementById('app')!, first);

const repair = await session.next('rename the metric to ARR'); // a cheap repair diff
if (repair.kind === 'produced') mountProduced(document.getElementById('app')!, repair);
```

`session.next(prompt)` remembers the tree the last turn produced and sends it as
the `currentTreeJson` of the next turn, so each subsequent prompt is a **repair**
(a cheap diff) rather than a from-scratch regeneration. That tree-carrying loop
is the token-saving ergonomic the whole model hinges on.

## The result is typed three ways

`generate` / `session.next` resolve to a discriminated `TurnResult` — they never
throw for an endpoint outcome (a transport error becomes a `turnFailed` with a
`provider`-stage envelope):

```ts
const result = await client.generate({ prompt: 'a login form' });
switch (result.kind) {
  case 'produced': // result.treeJson, result.ops, result.version
    break;
  case 'accessDenied': // result.reason — token missing/expired/invalid
    break;
  case 'turnFailed': // result.error.{ stage, code, message }
    break;
}
```

This mirrors the endpoint's surface contract exactly (request shape, the
three-way result, and the echoed surface version — see `SURFACE_VERSION` and
`isSurfaceVersionCompatible`). The TS types are kept in lockstep with the
endpoint's published surface contract; drift is a defect.

## Where the access token and BYOK key live

The **access token** is your paid credential for the endpoint. The **BYOK
provider key** is your own LLM provider key — the endpoint builds a provider
from it in memory for one call and never stores it. Two integration patterns,
both supported:

### Server-proxied (recommended for browser apps)

Your browser app calls **your own server**; your server holds the access token +
BYOK key and forwards the request to the Fuaran endpoint. No secret ever reaches
the browser bundle.

```ts
// Browser: no secrets — target your same-origin proxy.
const client = new FuaranClient({ endpoint: '/api/fuaran' });
```

```ts
// Your server (the /api/fuaran route): inject the secrets, forward the body.
// The access token + BYOK key live in server-side env, never in shipped JS.
```

### Browser-BYOK (the user supplies their own key at runtime)

For a playground-style app where the **user** pastes their **own** provider key,
the key may be sent straight from their browser to the endpoint:

```ts
const client = new FuaranClient({
  endpoint: 'https://<the-fuaran-endpoint>/generate',
  accessToken: userAccessToken, // the user's paid token
  providerKey: userProvidedKey, // the user's own key, entered at runtime
});
```

**Never bundle a BYOK key (or a long-lived access token) into shipped
client-side code.** A key is safe in the browser only when it is the _user's
own_ key, supplied at runtime — never a key you ship. When in doubt, use the
server-proxied pattern.

## Where the credentials go, and where the endpoint refuses them

Both credentials travel as HEADERS — the access token as `Authorization: Bearer`
and the provider key as `X-Fuaran-Provider-Key` — and **never in the request
body**. A body is the thing most likely to be logged wholesale by an
intermediary; a header is the thing most likely to be redacted by one. The
endpoint enforces it: a body carrying `ByokKey` or `AccessToken` is refused
`400 SECRETS_IN_BODY` and the value is not read. This package gives you no way
to write one.

`sendBearerHeader: false` suppresses the `Authorization` header. That is the
endpoint's only auth channel, so set it only when pointing at a proxy that
authenticates some other way — and supply that header via `headers`.

## The endpoint must be https, or loopback, or opted out of

Because both credentials ride headers on every call, a plaintext hop hands them
to anyone on the path. `http://127.0.0.1` and `http://localhost` are admitted
(that is where the offline mock and a local proxy live, and no packet leaves the
machine); a relative path like `/api/fuaran` is admitted (its security is the
page's own origin); anything else plaintext is refused as `INSECURE_ENDPOINT`
before the request is built, unless you set `allowInsecureEndpoint: true`. Every
request also sets `redirect: 'error'`, so a 307/308 can never re-POST your key
to an origin you never named.

## Failures the CLIENT reports, as distinct from the endpoint's

`RecoverableError.code` carries the endpoint's own code whenever there is one
(`ACCESS_DENIED`, `APPLY_REJECTED`, `SECRETS_IN_BODY`, `MISSING_PROVIDER_KEY`,
…). Three codes are this client's own, exported as `CLIENT_CODES`:

| Code                 | Means                                                                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NETWORK`            | the call did not complete — the fetch rejected, a redirect was refused, your `AbortSignal` fired, or `timeoutMs` elapsed. The message is fixed: upstream error text can quote a URL or an internal hostname, and this result is often rendered straight into the page. |
| `MALFORMED_RESPONSE` | a 200 with no usable tree. Not a success — accepting it would leave the session holding `''` and silently repairing nothing on every later turn.                                                                                                                       |
| `INSECURE_ENDPOINT`  | the endpoint is plaintext and not loopback; see above.                                                                                                                                                                                                                 |

## API surface

- `FuaranClient` — `generate(args, options?)` → `TurnResult`, and
  `generateDetailed(args, options?)` → the result plus `opsApplied` /
  `provider` / `servedModel` / `snapshot`. Config: `endpoint`, `accessToken?`,
  `providerKey?`, `provider?`, `fetch?` (injectable), `headers?`,
  `sendBearerHeader?`, `timeoutMs?`, `allowInsecureEndpoint?`. Per-call options:
  `{ signal? }`.
- `FuaranSession` — the turn loop. `next(prompt, opts?)`, `currentTreeJson`,
  `reset()`; seed with `{ initialTreeJson }`.
- `@fuaran-ui/client/render` — `mountProduced(container, produced, props?)` and
  `decodeProducedTree(produced)`.
- `isSecureEndpoint(url)` — the same rule the client applies, so a host can
  check a URL it is about to configure rather than discovering it on the first
  turn.
- Types: `TurnResult` (`Produced` | `AccessDenied` | `TurnFailed`),
  `GenerateArgs`, `AppliedOp`, `RecoverableError`, `TurnStage`,
  `ProducedDetail`, `SnapshotState`.

## License

Apache-2.0.
