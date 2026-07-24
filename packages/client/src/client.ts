// @fuaran-ui/client — the HTTPS client over the Fuaran generation endpoint.
//
// `client.generate({ prompt, currentTreeJson? })` collapses the integration to
// one call: it builds the request, sends it, and returns the typed three-way
// result. No hand-rolled `fetch`, no JSON wrangling, no token plumbing.

import type { GenerateArgs, TurnResult } from './contract.js';
import { parseTurnResponse, toWireBody, type ResolvedSecrets } from './wire.js';

/** The minimal `fetch` shape the client needs — satisfied by the global
 *  browser/Node `fetch`, and trivial to mock in a test. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Construction-time configuration. The secrets are optional here: in the
 *  server-proxied pattern the client targets your own proxy path and the proxy
 *  injects the access token + BYOK key, so neither is set client-side. */
export interface FuaranClientConfig {
  /** The Fuaran generation endpoint URL, or a same-origin proxy path
   *  (e.g. `/api/fuaran`) in the server-proxied pattern. */
  readonly endpoint: string;
  /** Paid access token. Omit in the server-proxied pattern (the proxy adds it).
   *  Per-call {@link GenerateArgs.accessToken} overrides this. */
  readonly accessToken?: string;
  /** BYOK provider key. Memory-only — never bundle a key into shipped code (see
   *  the README). Omit in the server-proxied pattern. Per-call
   *  {@link GenerateArgs.providerKey} overrides this. */
  readonly providerKey?: string;
  /** Injectable `fetch` (tests / non-browser runtimes). Defaults to global. */
  readonly fetch?: FetchLike;
  /** Extra headers merged into every request (e.g. a proxy auth header). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Also send the access token as `Authorization: Bearer <token>` (in addition
   *  to the request body) — many edge gateways gate on it. Default `true`; set
   *  `false` for a deployment that reads the token from the body only. */
  readonly sendBearerHeader?: boolean;
}

function resolveFetch(configured: FetchLike | undefined): FetchLike {
  if (configured !== undefined) {
    return configured;
  }
  const g = (globalThis as { fetch?: unknown }).fetch;
  if (typeof g !== 'function') {
    throw new Error(
      '@fuaran-ui/client: no global fetch available — pass `fetch` in the client config.',
    );
  }
  return g as FetchLike;
}

/** A thin, typed client over the Fuaran generation endpoint. Construct once
 *  with the endpoint (+ credentials, in the browser-BYOK pattern) and reuse it
 *  across turns; {@link FuaranSession} wraps it with the tree-carrying loop. */
export class FuaranClient {
  readonly #config: FuaranClientConfig;
  readonly #fetch: FetchLike;

  constructor(config: FuaranClientConfig) {
    if (config.endpoint.trim() === '') {
      throw new Error('@fuaran-ui/client: `endpoint` is required.');
    }
    this.#config = config;
    this.#fetch = resolveFetch(config.fetch);
  }

  /** Run one generation turn. Resolves to a typed {@link TurnResult}
   *  (`produced` / `accessDenied` / `turnFailed`); it never rejects for an
   *  endpoint-level outcome — a transport error surfaces as a `turnFailed`
   *  with a `provider`-stage envelope. */
  async generate(args: GenerateArgs): Promise<TurnResult> {
    const accessToken = args.accessToken ?? this.#config.accessToken;
    const providerKey = args.providerKey ?? this.#config.providerKey;
    const secrets: ResolvedSecrets = {
      ...(providerKey !== undefined ? { providerKey } : {}),
      ...(accessToken !== undefined ? { accessToken } : {}),
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.#config.headers,
    };
    if (accessToken !== undefined && this.#config.sendBearerHeader !== false) {
      headers['authorization'] = `Bearer ${accessToken}`;
    }

    const body = JSON.stringify(toWireBody(args, secrets));

    let response: { status: number; text(): Promise<string> };
    try {
      response = await this.#fetch(this.#config.endpoint, { method: 'POST', headers, body });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'turnFailed', error: { stage: 'provider', code: 'NETWORK', message } };
    }

    const text = await response.text();
    return parseTurnResponse(response.status, text);
  }
}
