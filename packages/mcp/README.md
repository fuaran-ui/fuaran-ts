# @fuaran-ui/mcp

An [MCP](https://modelcontextprotocol.io) server that exposes **Fuaran** to
coding agents. With it configured, "add an AI-driven UI panel to my app" is a
one-shot agent task: the agent looks up the canonical recipe, generates and
validates a real Fuaran tree, and scaffolds the integration — instead of you
reading docs and hand-wiring.

> The **endpoint URL** and the **paid access token** are the commercial gate.
> This server is a thin, open-source tool layer over public surfaces;
> installing it does not grant access. Four of the five tools
> (`fuaran_validate`, `fuaran_recipe`, `fuaran_scaffold`, `fuaran_ask`) work with
> no credentials at all.

## The five tools

| Tool              | What it does                                                                                                                                                                           | Needs credentials? |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `fuaran_recipe`   | Query → the canonical cookbook recipe for a UI pattern: canonical prompts, the reference target tree (F#), variant points, anti-patterns.                                              | No                 |
| `fuaran_generate` | Prompt (+ optional current tree) → a canonical Fuaran wire-format UI tree via the Fuaran generation endpoint. Pass the previous `treeJson` back to make the turn a cheap repair diff.  | Yes                |
| `fuaran_validate` | Wire JSON → pass/fail + structured diagnostics against the canonical schema (the same codec every conformant host trusts).                                                             | No                 |
| `fuaran_scaffold` | Target stack (`ts-react` / `fsharp-fable`) → the integration boilerplate: the `@fuaran-ui/client` call, renderer wiring, and credential handling.                                      | No                 |
| `fuaran_ask`      | An elicitation envelope (a wire tree + a typed answer contract) → a hosted question the human answers on a loopback page → exactly one typed outcome (a conforming answer, not prose). | No                 |

### `fuaran_ask` — the wire-format-client posture

`fuaran_ask` implements the elicitation envelope **per the public wire-format
spec and its fixtures corpus** — it decodes the envelope (a canonical UI tree
plus a typed answer contract) with the same public codec `fuaran_validate`
trusts, and renders the question through the public server-side render surface.
Any MCP-speaking agent gets rich typed elicitation without adopting the language
tier first: emit a canonical envelope, and receive a conforming answer object
instead of free-text you must re-parse. The answer host is offline by
construction — it binds only to `127.0.0.1`, so nothing leaves the machine.

## Install

### Claude Code (one line)

```sh
claude mcp add fuaran -e FUARAN_ENDPOINT=<endpoint-url> -e FUARAN_ACCESS_TOKEN=<your-token> -e FUARAN_PROVIDER_KEY=<your-provider-key> -- npx -y @fuaran-ui/mcp
```

Omit the three `-e` flags to run credential-free (recipe / validate / scaffold
still work; `fuaran_generate` will explain what is missing).

### Any MCP client (generic config)

```json
{
  "mcpServers": {
    "fuaran": {
      "command": "npx",
      "args": ["-y", "@fuaran-ui/mcp"],
      "env": {
        "FUARAN_ENDPOINT": "<endpoint-url>",
        "FUARAN_ACCESS_TOKEN": "<your-token>",
        "FUARAN_PROVIDER_KEY": "<your-provider-key>"
      }
    }
  }
}
```

## Where the secrets live (and where they never go)

- The access token and BYOK provider key are read from the **server's
  environment config only** (your MCP host's `env` / secret store). They are
  **never tool arguments**, so they never transit the agent transcript.
- They are never logged and never echoed: no code path puts them into a tool
  result, and every outgoing result additionally passes through a redaction
  scrub — even an upstream error that quoted a credential would arrive as
  `[redacted]`. This is asserted by tests, not claimed.
- The BYOK key is your own LLM provider key; the endpoint holds it memory-only
  for the one provider call. See `@fuaran-ui/client`'s README for the
  browser-side patterns the scaffolds emit.

## A worked session — "add a prompt→UI panel to my app"

A transcript shape you can expect from a coding agent with this server
configured (tool calls abridged):

> **You:** Add an AI-driven dashboard panel to my React app — users type what
> they want, the panel renders it.
>
> **Agent →** `fuaran_scaffold { target: "ts-react" }`
> _Returns `src/fuaran/FuaranPanel.tsx` (the panel: prompt box → session →
> renderer) and `server/fuaranProxy.ts` (the same-origin route that injects
> the credentials from server env). The agent writes both files, wires the
> route, and adds the npm installs._
>
> **You:** Make the default view a revenue dashboard with KPI tiles.
>
> **Agent →** `fuaran_recipe { query: "row of KPI metric tiles with trend deltas" }`
> _Returns the metric-strip recipe: canonical prompts, the reference tree, the
> variant points (tile count ↔ `Cols`, formats by metric semantics), and the
> anti-patterns (bind raw floats, not pre-formatted strings; one tile per
> metric)._
>
> **Agent →** `fuaran_generate { prompt: "a metric strip: total revenue (currency, up 12% trend), active users, conversion rate" }`
> _Returns the produced `treeJson` + the surface version._
>
> **Agent →** `fuaran_validate { json: <treeJson> }`
> _`valid: true` — the agent seeds the panel's session with the tree and
> reports done. Follow-up prompts route through the panel itself, where each
> turn is a repair diff against the held tree._

## A worked session — "Claude Code asks a rich question"

When an agent needs a decision from you, it can ask **as a real UI** and receive
a typed answer — no prose to re-parse, no ambiguity:

> **You:** Deploy the release.
>
> **Agent →** `fuaran_ask` with an elicitation envelope — a small tree (a
> Markdown prompt "Which environment should we deploy to?") plus a typed answer
> contract (`choice`, an `enum` over `["staging", "production"]`, required):
>
> ```json
> {
>   "$elicitation": "1",
>   "id": "deploy-target",
>   "tree": {
>     "id": "ask-note",
>     "kind": {
>       "$type": "Markdown",
>       "text": { "$type": "Literal", "text": "Which environment should we deploy to?" }
>     }
>   },
>   "contract": {
>     "fields": [
>       {
>         "name": "choice",
>         "nodeId": "ask-note",
>         "stateKey": "choice",
>         "required": true,
>         "space": { "$type": "enum", "values": ["staging", "production"] }
>       }
>     ]
>   }
> }
> ```
>
> _The tool validates the envelope, hosts the rendered question on
> `http://127.0.0.1:<port>/`, and prints the URL to stderr. You open it, pick
> **production** from the dropdown, and submit — the answer is checked against
> the contract before it is accepted (a value outside the enum is refused in
> place)._
>
> **`fuaran_ask` →** `{ "$type": "Answered", "answer": { "choice": "production" },
"elicitationId": "deploy-target" }`
> _The agent reads a typed `production`, not a sentence — and proceeds to deploy
> there. Decline instead, and it receives
> `{ "$type": "Declined", "elicitationId": "deploy-target" }`._

## Programmatic use

```ts
import { createFuaranMcpServer } from '@fuaran-ui/mcp';

const server = createFuaranMcpServer(); // config from env
// connect it to any MCP transport
```

## License

Apache-2.0.
