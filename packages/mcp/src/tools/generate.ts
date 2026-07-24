// fuaran_generate — prompt (+ optional current tree) → a canonical UI tree.
//
// A thin seam over `@fuaran-ui/client`'s `FuaranClient`: the request/response
// contract, status discrimination, and secret plumbing all live there. The
// endpoint URL, paid access token, and BYOK provider key come from the MCP
// host's environment config (see `config.ts`) — they are never tool inputs
// and never appear in tool output.

import { FuaranClient, type FetchLike } from '@fuaran-ui/client';

import {
  ENV_ACCESS_TOKEN,
  ENV_ENDPOINT,
  ENV_PROVIDER_KEY,
  type FuaranMcpConfig,
} from '../config.js';

export interface GenerateToolArgs {
  /** The authoring prompt, e.g. "a dashboard with revenue and churn tiles". */
  readonly prompt: string;
  /** Canonical wire JSON of the tree to edit — makes the turn a cheap repair
   *  diff instead of a fresh generation. Pass the previous turn's `treeJson`. */
  readonly currentTreeJson?: string | undefined;
  /** Opt OUT of corpus reads for this turn. Absent keeps reads on. */
  readonly disableCorpusRead?: boolean | undefined;
  /** Opt IN to contributing this turn to the corpus. Absent contributes nothing. */
  readonly contributeCorpus?: boolean | undefined;
}

export type GenerateToolResult =
  | {
      readonly status: 'produced';
      readonly treeJson: string;
      readonly ops: readonly { readonly opId: string; readonly opJson: string }[];
      readonly version: string;
    }
  | { readonly status: 'accessDenied'; readonly reason: string }
  | {
      readonly status: 'failed';
      readonly stage: string;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly status: 'notConfigured';
      readonly missing: readonly string[];
      readonly help: string;
    };

export async function runGenerate(
  args: GenerateToolArgs,
  config: FuaranMcpConfig,
  fetchLike?: FetchLike,
): Promise<GenerateToolResult> {
  const missing: string[] = [];
  if (config.endpoint === undefined) missing.push(ENV_ENDPOINT);
  if (config.accessToken === undefined) missing.push(ENV_ACCESS_TOKEN);
  if (config.providerKey === undefined) missing.push(ENV_PROVIDER_KEY);
  if (missing.length > 0) {
    return {
      status: 'notConfigured',
      missing,
      help:
        'Set the named environment variables in the MCP server config (the agent ' +
        "host's env/secret block for this server). They are read from the process " +
        'environment only — never passed as tool arguments, never echoed back.',
    };
  }

  const client = new FuaranClient({
    endpoint: config.endpoint as string,
    accessToken: config.accessToken as string,
    providerKey: config.providerKey as string,
    ...(fetchLike !== undefined ? { fetch: fetchLike } : {}),
  });

  const result = await client.generate({
    prompt: args.prompt,
    ...(args.currentTreeJson !== undefined ? { currentTreeJson: args.currentTreeJson } : {}),
    ...(args.disableCorpusRead !== undefined ? { disableCorpusRead: args.disableCorpusRead } : {}),
    ...(args.contributeCorpus !== undefined ? { contributeCorpus: args.contributeCorpus } : {}),
  });

  switch (result.kind) {
    case 'produced':
      return {
        status: 'produced',
        treeJson: result.treeJson,
        ops: result.ops,
        version: result.version,
      };
    case 'accessDenied':
      return { status: 'accessDenied', reason: result.reason };
    case 'turnFailed':
      return {
        status: 'failed',
        stage: result.error.stage,
        code: result.error.code,
        message: result.error.message,
      };
  }
}
