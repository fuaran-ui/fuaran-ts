// @fuaran-ui/mcp — the MCP server wiring.
//
// Five tools over Fuaran's public surfaces:
//   fuaran_recipe    — query → a matching cookbook recipe (bundled bank)
//   fuaran_generate  — prompt (+ optional tree) → a canonical UI tree
//   fuaran_validate  — wire JSON → pass/fail + canonical-codec diagnostics
//   fuaran_scaffold  — target stack → the SDK integration boilerplate
//   fuaran_ask       — elicitation envelope → hosted question → typed outcome
//
// Secret hygiene: the endpoint URL, access token, and BYOK key are read from
// the environment at construction (never tool inputs), and every outgoing
// tool result passes through `redactSecrets` before it reaches the transport.
// Diagnostics go to stderr only — stdout belongs to the protocol.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { FetchLike } from '@fuaran-ui/client';

import { readConfigFromEnv, redactSecrets, type FuaranMcpConfig } from './config.js';
import { runAsk } from './tools/ask.js';
import { runGenerate } from './tools/generate.js';
import { listRecipes, runRecipe } from './tools/recipe.js';
import { runScaffold } from './tools/scaffold.js';
import { runValidate } from './tools/validate.js';

export const SERVER_NAME = 'fuaran';
export const SERVER_VERSION = '0.1.0';

export interface CreateServerOptions {
  /** Server configuration; defaults to `readConfigFromEnv()`. */
  readonly config?: FuaranMcpConfig;
  /** Injectable fetch for `fuaran_generate` (tests). */
  readonly fetch?: FetchLike;
}

export function createFuaranMcpServer(options?: CreateServerOptions): McpServer {
  const config = options?.config ?? readConfigFromEnv();

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Every result funnels through here: serialise, scrub, wrap. The scrub is
  // defence-in-depth — no code path puts a secret into a result to begin with.
  const asContent = (result: unknown): { content: [{ type: 'text'; text: string }] } => ({
    content: [{ type: 'text', text: redactSecrets(JSON.stringify(result, null, 2), config) }],
  });

  server.registerTool(
    'fuaran_recipe',
    {
      title: 'Find a Fuaran cookbook recipe',
      description:
        'Look up the canonical Fuaran recipe for a UI pattern. Returns the best match: ' +
        'canonical prompts, the canonical F# emission (the reference target tree), the ' +
        'variant points (which slots to substitute and how), and the anti-patterns to ' +
        'avoid. Use it BEFORE generating or hand-authoring a tree, as the reference answer.',
      inputSchema: {
        query: z
          .string()
          .describe('The UI pattern wanted, e.g. "a row of KPI tiles with trend deltas"'),
      },
    },
    ({ query }) => {
      const result = runRecipe({ query });
      // Nothing matched: return the whole index so the agent can pick, not guess.
      return asContent(result.match === null ? { ...result, allRecipes: listRecipes() } : result);
    },
  );

  server.registerTool(
    'fuaran_generate',
    {
      title: 'Generate a Fuaran UI tree from a prompt',
      description:
        'Turn a natural-language prompt into a canonical Fuaran wire-format UI tree via ' +
        'the Fuaran generation endpoint. Pass the previous result’s treeJson as ' +
        'currentTreeJson to make the turn a cheap repair diff instead of a regeneration. ' +
        'Requires FUARAN_ENDPOINT, FUARAN_ACCESS_TOKEN, and FUARAN_PROVIDER_KEY in the ' +
        'server’s environment config; credentials are never tool arguments and never ' +
        'appear in output.',
      inputSchema: {
        prompt: z.string().describe('The authoring prompt'),
        currentTreeJson: z
          .string()
          .optional()
          .describe('Canonical wire JSON of the tree to edit (omit for a fresh generation)'),
        disableCorpusRead: z.boolean().optional().describe('Opt OUT of corpus reads this turn'),
        contributeCorpus: z
          .boolean()
          .optional()
          .describe('Opt IN to contributing this turn to the corpus'),
      },
    },
    async (args) => asContent(await runGenerate(args, config, options?.fetch)),
  );

  server.registerTool(
    'fuaran_validate',
    {
      title: 'Validate Fuaran wire JSON',
      description:
        'Check a Fuaran wire-format payload against the canonical schema using the same ' +
        'codec every conformant host trusts. Returns pass/fail plus structured ' +
        'diagnostics (stable error code, $-rooted path, message, expected shape) designed ' +
        'for self-repair. Set kind to "op" to validate a TreeOp instead of a Node tree.',
      inputSchema: {
        json: z.string().describe('The wire JSON to validate'),
        kind: z
          .enum(['node', 'op'])
          .optional()
          .describe('What the payload claims to be (default: node)'),
      },
    },
    (args) => asContent(runValidate(args)),
  );

  server.registerTool(
    'fuaran_scaffold',
    {
      title: 'Scaffold a Fuaran integration',
      description:
        'Emit the boilerplate that wires Fuaran into an app: the @fuaran-ui/client SDK ' +
        'call, the renderer wiring, and the credential handling for the chosen pattern. ' +
        'Targets: ts-react (a React panel + a same-origin proxy route) or fsharp-fable ' +
        '(a Feliz panel module). Patterns: server-proxied (default — secrets stay in ' +
        'server-side env) or browser-byok (runtime-supplied user credentials).',
      inputSchema: {
        target: z.enum(['ts-react', 'fsharp-fable']).describe('The stack to emit for'),
        pattern: z
          .enum(['server-proxied', 'browser-byok'])
          .optional()
          .describe('How credentials reach the endpoint (default: server-proxied)'),
      },
    },
    (args) => asContent(runScaffold(args)),
  );

  server.registerTool(
    'fuaran_ask',
    {
      title: 'Ask the human a rich, typed question',
      description:
        'Elicitation as a tool: supply a canonical elicitation envelope (a Fuaran wire tree ' +
        'plus a typed answer contract, the WIRE_FORMAT §18 shape). The tool validates the ' +
        'envelope with the same codec fuaran_validate trusts, hosts the rendered question on ' +
        'a loopback page, blocks until the human submits or declines, and returns exactly one ' +
        'typed ElicitationOutcome (Answered / Declined / TimedOut) — a conforming answer, ' +
        'never prose to re-parse. The answer host binds to 127.0.0.1 only.',
      inputSchema: {
        envelope: z
          .string()
          .describe('The elicitation envelope as canonical wire JSON (WIRE_FORMAT §18)'),
        port: z
          .number()
          .int()
          .optional()
          .describe('Loopback port for the answer host (default: an ephemeral port)'),
      },
    },
    async (args) => asContent(await runAsk(args)),
  );

  return server;
}
