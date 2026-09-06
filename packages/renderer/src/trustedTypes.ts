// ============================================================================
//  Phase 1546 - the renderer's Trusted Types policy.
//
//  Every raw-HTML seam in this renderer assigns a string to a DOM sink: React's
//  `dangerouslySetInnerHTML`, or `Element.innerHTML` on the KaTeX enhancement
//  path. A host that sends
//  `Content-Security-Policy: require-trusted-types-for 'script'` makes the
//  browser refuse a plain string at those sinks, and accept only a `TrustedHTML`
//  minted by a named policy the same header lists. This module is that policy,
//  and it is the parity twin of the F# tier's `Fuaran.UI.Renderer.TrustedTypes`:
//  same policy name, same `createHTML` body, same fallback.
//
//  A host pins it beside the require directive:
//
//      Content-Security-Policy: require-trusted-types-for 'script';
//                               trusted-types fuaran-renderer
//
//  WHAT THE POLICY IS. Its `createHTML` is `sanitizeMarkdownHtml`, the same
//  substring floor the markdown seam has always applied, and nothing else. It
//  declares no `createScript` and no `createScriptURL`, so a caller reaching for
//  either through this policy gets a `TypeError` from the browser rather than a
//  value: the renderer mints markup and never script.
//
//  WHY THE FLOOR RUNS EVEN WITHOUT THE API. `trustedHtml` applies `createHtml` on
//  every path, so a browser with no Trusted Types support and one that enforces
//  the directive produce the same bytes, and so does the server renderer that
//  emits the markup a client hydrates over. A floor applied on one side only
//  would present as a React hydration mismatch at every seam whose bytes it
//  changed. What the missing API costs is the trusted wrapper, which is inert
//  where nothing enforces it, and that is the whole of the no-op fallback.
//
//  WHAT THIS DOES NOT COVER. A host-registered custom renderer returns its own
//  element and this renderer does not police its output. If such a renderer
//  reaches a raw-HTML sink it mints its own trusted value, through this policy or
//  another. The policy moves no trust boundary; it makes the boundaries the
//  renderer already declared enforceable by the browser instead of by review.
// ============================================================================

import { sanitizeMarkdownHtml } from './sanitize.js';

/**
 * The Trusted Types policy name this renderer creates and a host pins in its
 * `trusted-types` directive. Stable: a host writes this exact string into its
 * CSP, so changing it is a breaking change for every such host.
 */
export const TRUSTED_TYPES_POLICY_NAME = 'fuaran-renderer';

/**
 * The policy's `createHTML` body, exported so the fallback path and the enforced
 * path cannot diverge. The floor is `sanitizeMarkdownHtml`, defence in depth over
 * input that is already escaped by construction: see that function's own comment
 * for the precondition it rests on.
 */
export const createHtml = (markup: string): string => sanitizeMarkdownHtml(markup);

/**
 * The slice of the Trusted Types API this module uses. Declared structurally
 * rather than taken from `lib.dom`, so the module compiles on a TypeScript whose
 * DOM library predates the API.
 */
interface FuaranTrustedTypesPolicy {
  createHTML(input: string): unknown;
}

interface FuaranTrustedTypesFactory {
  createPolicy(
    name: string,
    rules: { createHTML(input: string): string },
  ): FuaranTrustedTypesPolicy;
}

const trustedTypesFactory = (): FuaranTrustedTypesFactory | undefined => {
  const factory = (globalThis as { trustedTypes?: FuaranTrustedTypesFactory }).trustedTypes;
  return factory && typeof factory.createPolicy === 'function' ? factory : undefined;
};

/**
 * The policy handle, created once on first use.
 *
 * Memoised because a repeat `createPolicy` under the same name THROWS unless the
 * host's directive carries `'allow-duplicates'`, so this is correctness rather
 * than caching. `null` records "resolved, and there is no policy", which is
 * distinct from the `undefined` that means "not yet resolved".
 */
let policy: FuaranTrustedTypesPolicy | null | undefined;

const currentPolicy = (): FuaranTrustedTypesPolicy | null => {
  if (policy !== undefined) return policy;
  const factory = trustedTypesFactory();
  if (factory === undefined) {
    policy = null;
    return policy;
  }
  try {
    policy = factory.createPolicy(TRUSTED_TYPES_POLICY_NAME, { createHTML: createHtml });
  } catch {
    // The host enforces Trusted Types but its `trusted-types` directive does not
    // name this policy, so the browser refused to create it. Say so once, naming
    // the policy and the directive: the sinks will then be refused by the
    // browser, and a silent fallback would leave a blank page with no cause. The
    // fallback is still taken, because throwing here would break a host that is
    // merely misconfigured.
    if (typeof console !== 'undefined') {
      console.warn(
        `Fuaran renderer: the Trusted Types policy '${TRUSTED_TYPES_POLICY_NAME}' could not be ` +
          "created. Add it to the page's `trusted-types` CSP directive, beside " +
          "`require-trusted-types-for 'script'`.",
      );
    }
    policy = null;
  }
  return policy;
};

/**
 * Mint a value for a raw-HTML sink: the sanitisation floor, wrapped as
 * `TrustedHTML` where the browser offers the API and the host has named this
 * policy.
 *
 * The declared return type is `string` because that is what both sinks take.
 * Where the policy exists the value is a `TrustedHTML` object travelling under
 * that type, which is exactly what the sink needs: React assigns
 * `dangerouslySetInnerHTML.__html` through without coercing it, so the object
 * reaches `innerHTML` intact and the browser accepts it. Coercing it to a real
 * string here would throw the trust away at the last step.
 */
export const trustedHtml = (markup: string): string => {
  const p = currentPolicy();
  return p === null ? createHtml(markup) : (p.createHTML(markup) as string);
};

/** Test seam: forget the memoised policy so a suite can exercise both paths. */
export const resetTrustedTypesPolicyForTests = (): void => {
  policy = undefined;
};
