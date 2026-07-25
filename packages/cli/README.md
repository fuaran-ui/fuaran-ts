# @fuaran-ui/cli

The Fuaran generative-UI CLI — `fuaran generate | validate | recipe | scaffold`
over the public surfaces, with **zero MCP config**. Works against the real
generation endpoint or the local mock. The npm front-end of the Fuaran CLI
(sibling to the `Fuaran.UI.Cli` dotnet tool).

```bash
npx @fuaran-ui/cli generate "a metric strip showing revenue" --mock   # offline, no secret
npx @fuaran-ui/cli validate tree.json                                 # canonical-schema check
npx @fuaran-ui/cli recipe "a row of KPI tiles"                        # a matching cookbook recipe
npx @fuaran-ui/cli scaffold --target ts                               # integration boilerplate
```

## Commands

- **`generate <prompt> [--tree <file>] [--mock [url]]`** — a prompt (optionally
  repairing `--tree`) → a canonical wire tree. Against the real endpoint (env
  config) or the local `@fuaran-ui/mock` (`--mock`, no secret).
- **`validate <file>`** — wire JSON → pass/fail + canonical decode diagnostics.
- **`recipe <query>`** — query → a matching cookbook recipe (canonical prompts +
  target emission).
- **`scaffold --target ts|fsharp [--pattern server-proxied|browser-byok]`** — the
  integration boilerplate. `ts` supports `browser-byok`; the F#/Fable leg is
  always server-proxied.

The CLI is a thin shell over the same tool implementations the MCP server
exposes (`@fuaran-ui/mcp`) plus the `@fuaran-ui/client` SDK, so `fuaran <cmd>`
and the MCP tool behave identically. `generate` / `validate` also match the
`Fuaran.UI.Cli` dotnet tool (shared wire substrate).

## Secrets

`FUARAN_ENDPOINT` / `FUARAN_ACCESS_TOKEN` / `FUARAN_PROVIDER_KEY` are read from
the **environment only** — never a flag, never printed. `--mock` needs no secret.
The endpoint URL + paid access token are the commercial gate; this CLI is a thin,
OSS-safe client over the public surfaces.
