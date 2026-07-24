# Fuaran integration docs

Agent- and human-readable docs for integrating the Fuaran generation endpoint with the
`@fuaran-ui/client` SDK. A coding agent (or a person) can wire a working integration from
these files alone – no MCP server or plugin required.

- **[llms.txt](llms.txt)** – the agent index. Point a coding agent here first.
- **[quickstart.md](quickstart.md)** – install → generate → render → turn-loop.
- **[integration.md](integration.md)** – the end-to-end recipe + editing loop + corpus opt-in.
- **[token-setup.md](token-setup.md)** – where the access token and BYOK key live.

The richer, agent-native path is the [`@fuaran-ui/mcp`](../packages/mcp/README.md) server
(generate / validate / recipe / scaffold as MCP tools). These docs are the low-install
floor beneath it.

## Freshness

The runnable code in these docs is checked against the current SDK:

```sh
pnpm --filter @fuaran-ui/client build   # build the client types the check compiles against
node docs/check-drift.mjs               # compile the quickstart/recipe blocks + verify SDK exports
```

`check-drift.mjs` extracts every code block marked `<!-- drift-check:compile -->` and
type-checks it against the built `@fuaran-ui/client` types, and asserts every export named
in a `<!-- drift-check:symbols … -->` marker still exists. If the SDK surface drifts, the
check fails – the docs cannot go stale unnoticed.
