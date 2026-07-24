// @fuaran-ui/mcp — environment-sourced configuration + secret hygiene.
//
// The BYOK provider key and the paid access token are supplied by the MCP
// host's server config (its `env` block / secret store) and read from the
// process environment ONLY. They are never accepted as tool inputs (so they
// cannot transit the agent transcript), never logged, and never echoed back
// in tool output — `redactSecrets` is the defence-in-depth scrub applied to
// every outgoing tool result.

/** Env var naming the Fuaran generation endpoint URL. */
export const ENV_ENDPOINT = 'FUARAN_ENDPOINT';
/** Env var naming the paid access token for the endpoint. */
export const ENV_ACCESS_TOKEN = 'FUARAN_ACCESS_TOKEN';
/** Env var naming the BYOK provider key forwarded (memory-only) per call. */
export const ENV_PROVIDER_KEY = 'FUARAN_PROVIDER_KEY';

/** Resolved server configuration. Absent fields mean the corresponding env
 *  var was unset/blank — `fuaran_generate` reports which are missing by NAME
 *  (never by value). */
export interface FuaranMcpConfig {
  readonly endpoint?: string;
  readonly accessToken?: string;
  readonly providerKey?: string;
}

/** Read the server configuration from the environment (injectable for tests). */
export function readConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FuaranMcpConfig {
  const pick = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v !== undefined && v !== '' ? v : undefined;
  };
  const endpoint = pick(ENV_ENDPOINT);
  const accessToken = pick(ENV_ACCESS_TOKEN);
  const providerKey = pick(ENV_PROVIDER_KEY);
  return {
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(accessToken !== undefined ? { accessToken } : {}),
    ...(providerKey !== undefined ? { providerKey } : {}),
  };
}

/** Scrub any literal occurrence of the configured secrets from outgoing text.
 *  The primary guarantee is structural (secrets are never put INTO a result);
 *  this is the belt-and-braces pass every tool result goes through anyway, so
 *  an upstream error message that quoted a credential could still never reach
 *  the agent transcript. */
export function redactSecrets(text: string, config: FuaranMcpConfig): string {
  let out = text;
  for (const secret of [config.accessToken, config.providerKey]) {
    if (secret !== undefined && secret.length > 0) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}
