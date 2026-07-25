# Worked transcript — "add a prompt→UI panel" from empty app to rendered output

A representative session showing the skill driving the bundled MCP tools end to
end. The developer starts in a plain React app and ends with a compiling,
rendering Fuaran panel.

---

**Developer:** I want users to type a description and have a dashboard render in
my React app. Add Fuaran.

**Claude** _(the `fuaran-integration` skill activates):_

I'll wire the Fuaran generative-UI loop into your app. You're on React/TS, and
this is user-facing in the browser, so I'll use the **server-proxied** pattern —
your access token and BYOK key stay server-side and never reach the bundle.

_Calls the `recipe` MCP tool → "dashboard metric strip":_ the canonical shape is
a `GridLayout` of `Metric` tiles bound to queries, each with loading/error
slots. That's what good output looks like here.

_Calls the `scaffold` MCP tool → `{ target: "ts-react", pattern: "server-proxied" }`:_
emits three files —

- `src/FuaranPanel.tsx` — the panel component: a `useFuaranGenerate` loop over
  `@fuaran-ui/client`, rendering the returned tree via `@fuaran-ui/renderer`.
- `src/api/fuaran.ts` — a same-origin proxy route that injects the token + key
  from server-side env and forwards to the endpoint.
- `.env.example` — `FUARAN_ENDPOINT`, `FUARAN_ACCESS_TOKEN`, `FUARAN_PROVIDER_KEY`
  (server-side only).

_Writes the files, then:_ run `npm i @fuaran-ui/client @fuaran-ui/renderer`.

You don't have an endpoint configured yet, so let's build offline first: run
`npx @fuaran-ui/mock` and the panel works against it with no token. When you're
ready to go live, set the three env vars on your server and the only change is
the base URL.

**Developer:** It rendered against the mock. Now this tree came back malformed
from the real endpoint.

**Claude:** _Calls the `validate` MCP tool on the wire JSON:_ the diagnostic is
`WRONG_TYPE` at `$.kind.children[0].value` — a `Metric` value bound to a string
where a number is expected. The repair loop threads that hint into the next turn
automatically; the follow-up emission self-corrects.

---

## What this demonstrates

- The skill recognised the intent and picked the safe (server-proxied) pattern.
- It drove the MCP tools in order: `recipe` (ground the shape) → `scaffold`
  (emit the wiring) → `validate` (diagnose a bad emission).
- The turn-loop (`useFuaranGenerate`) makes follow-up prompts cheap repairs.
- Secrets stayed in server-side env; nothing was committed or bundled.
- Offline-first development via the local mock, then a one-line swap to go live.
