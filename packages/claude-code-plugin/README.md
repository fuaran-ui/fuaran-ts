# Fuaran — Claude Code plugin

The Claude-Code-native packaging of Fuaran generative UI. Installing it makes
**"add Fuaran to my app"** a recognised, one-shot capability inside Claude Code:
a developer describes what they want and gets a wired, compiling, rendering
integration — SDK call, renderer, turn-loop, and secure secret handling.

## What's inside

- **A bundled MCP server** (`@fuaran-ui/mcp`) exposing the Fuaran tools —
  `recipe` (canonical prompt shapes), `generate` (prompt → tree), `validate`
  (canonical-schema diagnostics), `scaffold` (integration boilerplate). Declared
  in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json); installing the
  plugin registers and configures it.
- **The `fuaran-integration` skill**
  ([`skills/fuaran-integration/SKILL.md`](skills/fuaran-integration/SKILL.md)) —
  the integration playbook the agent follows: detect the stack + pattern, look up
  a recipe, scaffold the wiring, wire the turn-loop, validate emissions, and the
  safe-default guardrails.
- **A worked transcript** ([`TRANSCRIPT.md`](TRANSCRIPT.md)) — an "add a
  prompt→UI panel" session from empty app to rendered output.

## Configure

On install, the plugin prompts for (all optional, stored in the OS keychain /
credentials store — never in the repo):

- **Generation endpoint URL** — leave blank to develop offline against the local
  mock (`npx @fuaran-ui/mock`).
- **Access token** and **BYOK provider key** — your paid endpoint credentials.

These are surfaced to the bundled MCP server as `FUARAN_ENDPOINT`,
`FUARAN_ACCESS_TOKEN`, `FUARAN_PROVIDER_KEY`.

## Install

```bash
claude plugin install ./packages/claude-code-plugin      # from a local checkout
claude plugin validate ./packages/claude-code-plugin     # verify the structure
```

or install by name once it is listed in a marketplace.

## Safe defaults

The skill enforces: never commit the BYOK key or access token; server-proxy the
key for any browser app; corpus contribution stays opt-in. See the skill for the
full playbook.
