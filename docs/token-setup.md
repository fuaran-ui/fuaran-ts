# Token & key setup – where the access token and BYOK key live

The endpoint needs two secrets: your **access token** (paid credential for the endpoint)
and your **BYOK provider key** (your own LLM provider key, used in memory for one call and
never stored). This doc is about _where they live_ so the BYOK key never leaks into shipped
code. There are two patterns; pick by who supplies the key.

## Pattern A – server-proxy (recommended for browser apps)

Your browser app calls **your own server**; your server holds both secrets and forwards the
request to the Fuaran endpoint. No secret ever reaches the browser bundle. This is the
default for any app you ship to end users.

<!-- drift-check:symbols @fuaran-ui/client FuaranClient -->

```ts
// Browser: no secrets — target your own same-origin proxy route.
import { FuaranClient } from '@fuaran-ui/client';

const client = new FuaranClient({ endpoint: '/api/fuaran' });
```

Your server route (`/api/fuaran`) reads the access token + BYOK key from server-side env
and forwards the request body to the real endpoint. The secrets live in your server's
environment (or secret store), never in shipped JavaScript. Because the client's request /
response shape is exactly the endpoint's, your proxy is a pass-through plus the two headers.

## Pattern B – browser-BYOK (the user supplies their own key)

For a playground-style app where the **user** pastes their **own** provider key, the key may
travel straight from their browser to the endpoint – because it is _their_ key, entered at
runtime, not a key you ship.

<!-- drift-check:symbols @fuaran-ui/client FuaranClient -->

```ts
import { FuaranClient } from '@fuaran-ui/client';

// The values come from runtime input (a form field), never from bundled constants.
const client = new FuaranClient({
  endpoint: 'https://<your-fuaran-endpoint>/generate',
  accessToken: userAccessToken, // the user's paid token
  providerKey: userProvidedKey, // the user's OWN provider key, entered at runtime
});
```

Per-call overrides work too – pass `accessToken` / `providerKey` in the `generate` args to
override the client config for one turn.

## The one rule

**Never bundle a BYOK key – or a long-lived access token – into shipped client-side code.**
A key is safe in the browser only when it is the _user's own_ key, supplied at runtime
(Pattern B). Anything you ship to every user goes through a server (Pattern A). When in
doubt, use the server-proxy pattern.

## Headers

By default the client also sends the access token as an `Authorization: Bearer <token>`
header (in addition to the request body), because many edge gateways gate on it. Set
`sendBearerHeader: false` in the client config for a deployment that reads the token from
the body only. Add any extra gateway/proxy auth headers via the `headers` config.

## See also

- [quickstart.md](quickstart.md) – the three-call shape.
- [integration.md](integration.md) – the full recipe incl. the editing loop + corpus opt-in.
- [`@fuaran-ui/client` README](../packages/client/README.md) – the complete SDK reference.
