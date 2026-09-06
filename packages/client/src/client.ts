// @fuaran-ui/client — the client over the Fuaran generation endpoint.
//
// `client.generate({ prompt, currentTreeJson? })` collapses the integration to
// one call: it builds the request, sends it, and returns the typed three-way
// result. No hand-rolled `fetch`, no JSON wrangling, no token plumbing.
//
// THE ENDPOINT MUST BE https, OR LOOPBACK, OR EXPLICITLY OPTED OUT OF. Both
// credentials ride headers on every call, so a plaintext hop hands them to
// anyone on the path. `http://127.0.0.1` and `http://localhost` are admitted
// because that is where the offline mock and a local proxy live and no packet
// leaves the machine; anything else plaintext is refused as `INSECURE_ENDPOINT`
// unless `allowInsecureEndpoint` is set — an opt-in that has to be written
// down, not a default that has to be noticed. A relative path (`/api/fuaran`,
// the server-proxied pattern) carries no scheme and is admitted: its security
// is the page's own origin.
//
// EVERY REQUEST SETS `redirect: 'error'`. A 307/308 re-POSTs the body AND the
// headers to wherever the redirect points, which for this client means handing
// the BYOK key to an origin the caller never named. There is no legitimate
// reason for a generation endpoint to redirect a POST, so the safe reading of
// one is that something is wrong.
//
// NO UPSTREAM ERROR TEXT REACHES THE CALLER. A rejected fetch and an elapsed
// timeout are `NETWORK` with a FIXED message. This result is routinely rendered
// straight into the page, and a fetch error string can quote a URL, a header
// name, or a proxy's internal hostname.

import {
  CLIENT_CODES,
  type GenerateArgs,
  type ProducedDetail,
  type TurnResult,
} from './contract.js';
import { parseProducedDetail, parseTurnResponse, toWireBody } from './wire.js';

/** The minimal `fetch` shape the client needs — satisfied by the global
 *  browser/Node `fetch`, and trivial to mock in a test. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    redirect?: 'error' | 'follow' | 'manual';
    signal?: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Per-call options that are about the CALL rather than the turn. */
export interface GenerateOptions {
  /** Caller-owned cancellation. Composed with `timeoutMs` when both are set:
   *  whichever fires first ends the call. */
  readonly signal?: AbortSignal;
}

/** Construction-time configuration. The secrets are optional here: in the
 *  server-proxied pattern the client targets your own proxy path and the proxy
 *  injects the access token + BYOK key, so neither is set client-side. */
export interface FuaranClientConfig {
  /** The Fuaran generation endpoint URL, or a same-origin proxy path
   *  (e.g. `/api/fuaran`) in the server-proxied pattern. */
  readonly endpoint: string;
  /** Paid access token, sent as `Authorization: Bearer <token>`. Omit in the
   *  server-proxied pattern (the proxy adds it). Per-call
   *  {@link GenerateArgs.accessToken} overrides this. */
  readonly accessToken?: string;
  /** BYOK provider key, sent as `X-Fuaran-Provider-Key`. Memory-only — never
   *  bundle a key into shipped code (see the README). Omit in the
   *  server-proxied pattern. Per-call {@link GenerateArgs.providerKey}
   *  overrides this. */
  readonly providerKey?: string;
  /** Which allowlisted provider id to ask for (`X-Fuaran-Provider`). Omitted,
   *  the deployment chooses its own default. */
  readonly provider?: string;
  /** Injectable `fetch` (tests / non-browser runtimes). Defaults to global. */
  readonly fetch?: FetchLike;
  /** Extra headers merged into every request (e.g. a proxy auth header). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Send the access token as `Authorization: Bearer <token>` — the endpoint's
   *  ONLY auth channel, since a body-carried token is refused. Default `true`.
   *  Set `false` only when pointing at a proxy that authenticates some other
   *  way, and supply that header via `headers`. */
  readonly sendBearerHeader?: boolean;
  /** Wall-clock ceiling on one turn, in milliseconds. Omitted, the call waits
   *  as long as `fetch` does. An elapsed timeout is `turnFailed` / `NETWORK`,
   *  never a rejection — from the caller's side it is a transport failure. */
  readonly timeoutMs?: number;
  /** Permit a plaintext, non-loopback endpoint. Off by default; see the module
   *  header for why this is an opt-in rather than a warning. */
  readonly allowInsecureEndpoint?: boolean;
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

/** `true` when credentials may be sent to this endpoint. A relative path (no
 *  scheme) is same-origin by construction and admitted; an absolute `https` URL
 *  is admitted; plaintext is admitted only to loopback. Exported so a host can
 *  apply the same rule to a URL it is about to configure rather than
 *  discovering it on the first turn. */
export function isSecureEndpoint(endpoint: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    // Not an absolute URL: a same-origin path.
    return true;
  }
  if (parsed.protocol === 'https:') {
    return true;
  }
  return (
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname === '::1'
  );
}

function networkFailure(message: string): TurnResult {
  return { kind: 'turnFailed', error: { stage: 'provider', code: CLIENT_CODES.network, message } };
}

const INSECURE_ENDPOINT: TurnResult = {
  kind: 'turnFailed',
  error: {
    stage: 'provider',
    code: CLIENT_CODES.insecureEndpoint,
    message:
      'the endpoint is plaintext http and is not loopback; the access token and BYOK key would ' +
      'travel in the clear. Use https, or set allowInsecureEndpoint if you genuinely mean it.',
  },
};

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

  /** Run one generation turn, returning the typed result AND the deployment
   *  facts the reply carried (`opsApplied`, `provider`, `servedModel`, the
   *  snapshot state). The detail is `undefined` for every non-produced
   *  outcome. */
  async generateDetailed(
    args: GenerateArgs,
    options?: GenerateOptions,
  ): Promise<{ result: TurnResult; detail?: ProducedDetail }> {
    if (this.#config.allowInsecureEndpoint !== true && !isSecureEndpoint(this.#config.endpoint)) {
      // Refused BEFORE the request is built, so neither credential is ever
      // handed to `fetch`.
      return { result: INSECURE_ENDPOINT };
    }

    const accessToken = args.accessToken ?? this.#config.accessToken;
    const providerKey = args.providerKey ?? this.#config.providerKey;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.#config.headers,
    };
    if (accessToken !== undefined && this.#config.sendBearerHeader !== false) {
      headers['authorization'] = `Bearer ${accessToken}`;
    }
    if (providerKey !== undefined) {
      headers['x-fuaran-provider-key'] = providerKey;
    }
    if (this.#config.provider !== undefined) {
      headers['x-fuaran-provider'] = this.#config.provider;
    }

    const body = JSON.stringify(toWireBody(args));

    const controller = new AbortController();
    const timer =
      this.#config.timeoutMs !== undefined
        ? setTimeout(() => controller.abort(), this.#config.timeoutMs)
        : undefined;
    const onCallerAbort = (): void => controller.abort();
    options?.signal?.addEventListener('abort', onCallerAbort);
    let timedOut = false;
    if (timer !== undefined) {
      // Distinguishable from a caller's own abort, so the message can say which.
      controller.signal.addEventListener('abort', () => {
        timedOut = options?.signal?.aborted !== true;
      });
    }

    try {
      const response = await this.#fetch(this.#config.endpoint, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      const text = await response.text();
      const detail = parseProducedDetail(response.status, text);
      return {
        result: parseTurnResponse(response.status, text),
        ...(detail !== undefined ? { detail } : {}),
      };
    } catch {
      // Deliberately no upstream text — see the module header. A rejected
      // `fetch` also covers the redirect refusal, which is the correct
      // treatment: a redirected POST did not reach the endpoint.
      return {
        result: networkFailure(
          timedOut
            ? 'the request to the generation endpoint timed out'
            : 'the request to the generation endpoint did not complete',
        ),
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      options?.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /** Run one generation turn. Resolves to a typed {@link TurnResult}
   *  (`produced` / `accessDenied` / `turnFailed`); it never rejects for an
   *  endpoint-level outcome — a transport error, a refused redirect or an
   *  elapsed `timeoutMs` surfaces as a `turnFailed` with a `provider`-stage
   *  `NETWORK` envelope. */
  async generate(args: GenerateArgs, options?: GenerateOptions): Promise<TurnResult> {
    const { result } = await this.generateDetailed(args, options);
    return result;
  }
}
