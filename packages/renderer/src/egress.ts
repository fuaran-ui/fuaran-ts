// ============================================================================
//  Destination policy — typed egress allowlists (WIRE_FORMAT §14.1).
//
//  `sanitize.ts` answers "is this URL SAFE TO HAVE" (the §19 scheme floor).
//  Nothing there answers "is this DESTINATION one the composition declared", and
//  only the second question closes exfiltration:
//  `https://collector.example/?s=<bound state>` passes every check in the floor
//  — allowlisted scheme, well-formed host, no script anywhere in it — and in an
//  `<img src>` the browser contacts it with NO user act at all, because
//  rendering IS the request.
//
//  So the floor gains a second, orthogonal gate: a scheme allowlist says what a
//  URL may BE, an origin allowlist says where it may GO. Both are positive
//  lists; neither substitutes for the other, and this one runs after the other
//  because there is no point asking where an unsafe URL points.
//
//  Two shapes are deliberate and both look like omissions:
//
//    - A rule names a HOST, never a scheme and never a path. Scheme is already
//      reduced to the allowlisted set by the floor, and every "scheme wildcard"
//      spelling anyone reaches for (`*://`, `http*://`, `https?://`) parses
//      differently on different hosts — which makes the wildcard itself the
//      vulnerability. Path scoping is likewise refused: a path is not a security
//      boundary, and a policy that appears to bound one invites reliance on a
//      bound it does not have.
//    - The policy is HOST-CONSTRUCTED. It is never carried on the wire and there
//      is deliberately no decoder for it: a policy a tree could supply is a
//      policy a hostile tree can widen, which is not a policy.
// ============================================================================

import { sanitizeUrl } from './sanitize.js';

/**
 * The classes of destination a rule can be scoped to. Closed by construction: a
 * policy can say something only about a class this union can name.
 *
 * `hyperlink` is an `href` the reader must ACT on. `media` is a `src` the
 * browser fetches with NO user act — THE exfiltration class, which is why it is
 * scoped separately rather than folded in.
 */
export type EgressClass = 'hyperlink' | 'media' | 'route' | 'download' | 'fileRead';

export const egressClasses: readonly EgressClass[] = [
  'hyperlink',
  'media',
  'route',
  'download',
  'fileRead',
];

/**
 * One allowed destination. Hosts only — no scheme, no port, no path.
 *
 * `exact` matches that host and nothing else. `suffix` matches the host and any
 * subdomain of it, at a LABEL BOUNDARY — `docs.example` matches
 * `eu.docs.example` and never `notdocs.example`. A suffix, not a substring, and
 * not a wildcard.
 */
export interface EgressOrigin {
  readonly match: 'exact' | 'suffix';
  readonly host: string;
}

/** One rule: an origin, and the classes it is declared FOR. */
export interface EgressRule {
  readonly origin: EgressOrigin;
  /**
   * An EMPTY list allows no class — a rule that names nothing permits nothing,
   * which is the only reading consistent with a positive list. Use
   * `egressClasses` to mean "every class".
   */
  readonly classes: readonly EgressClass[];
}

export interface EgressPolicy {
  readonly rules: readonly EgressRule[];
  /**
   * When true, EVERY network origin is permitted and `rules` is not consulted.
   *
   * A FIELD rather than the absence of rules on purpose: an empty allowlist must
   * read as "nothing is declared", never as "everything is fine". Those are
   * opposite postures, and the empty list is what a half-built policy looks
   * like.
   */
  readonly allowAnyOrigin: boolean;
  /**
   * Whether SAME-ORIGIN destinations (a relative path, a fragment, an empty URL)
   * are permitted. True in both shipped policies: a tree pointing at its own
   * host has not left, and denying it would make ordinary in-app links
   * unrenderable.
   */
  readonly allowLocal: boolean;
  /**
   * Whether destinations with no network host (`mailto:`, `tel:`) are permitted.
   * False by default: `mailto:` IS an egress channel — a body parameter carries
   * arbitrary text off the machine — and it has no host for a rule to name, so
   * it cannot be allowlisted, only permitted wholesale.
   */
  readonly allowNonNetwork: boolean;
}

/**
 * Deny every destination that leaves the origin. THE DEFAULT FOR A DECODED
 * (WIRE) TREE: an emission cannot declare its own egress, so absent a host's
 * declaration it gets none.
 */
export const denyNonLocalEgress: EgressPolicy = {
  rules: [],
  allowAnyOrigin: false,
  allowLocal: true,
  allowNonNetwork: false,
};

/**
 * Permit every destination. The posture for a HAND-AUTHORED tree, where the
 * author is the trust boundary. Named rather than default so reaching it is a
 * deliberate, greppable act.
 */
export const permissiveEgress: EgressPolicy = {
  rules: [],
  allowAnyOrigin: true,
  allowLocal: true,
  allowNonNetwork: true,
};

/**
 * Declare an origin for a set of classes. An empty class list is taken as EVERY
 * class — the ergonomic reading of "allow this origin", distinct from an
 * `EgressRule` whose `classes` is empty, which permits nothing.
 */
export const allowOrigin = (
  origin: EgressOrigin,
  classes: readonly EgressClass[],
  policy: EgressPolicy,
): EgressPolicy => ({
  ...policy,
  rules: [...policy.rules, { origin, classes: classes.length === 0 ? egressClasses : classes }],
});

/** Network schemes — the ones that reach a host a rule can name. */
const networkSchemes = new Set(['http', 'https', 'ftp', 'sftp']);

/**
 * Lowercase, trim, and drop a single trailing root dot: `example.com.` and
 * `example.com` are the same host to a resolver, so they must be the same host
 * to a policy — otherwise the dotted spelling walks straight past an exact rule.
 */
const normalizeHost = (h: string): string => {
  if (h == null) return '';
  const t = h.trim().toLowerCase();
  return t.endsWith('.') ? t.slice(0, -1) : t;
};

/** The scheme of an absolute URL, lowercased; `undefined` when there is none. */
const schemeOf = (url: string): string | undefined => {
  let colonIdx = -1;
  let slashIdx = -1;
  for (let i = 0; i < url.length && colonIdx < 0 && slashIdx < 0; i++) {
    const ch = url[i];
    if (ch === ':') colonIdx = i;
    else if (ch === '/' || ch === '?' || ch === '#') slashIdx = i;
  }
  if (colonIdx < 0 || (slashIdx >= 0 && slashIdx < colonIdx)) return undefined;
  let cleaned = '';
  for (const ch of url.substring(0, colonIdx)) {
    if ((ch.codePointAt(0) ?? 0) > 0x20) cleaned += ch;
  }
  return cleaned.trim().toLowerCase();
};

/**
 * Extract the host from an absolute URL's authority, WHATWG-style: `\` counts as
 * `/` when locating the authority, userinfo before the LAST `@` is discarded, a
 * port is dropped, and an IPv6 literal keeps its brackets.
 *
 * The LAST `@` is load-bearing rather than fussy:
 * `https://good.example@evil.example/x` is a request to `evil.example`, and a
 * naive first-`@` split reads it as the opposite — the classic
 * credential-confusion spelling an allowlist exists to refuse.
 */
const authorityHost = (url: string): string | undefined => {
  const colon = url.indexOf(':');
  if (colon < 0) return undefined;
  let i = colon + 1;
  let slashes = 0;
  while (i < url.length && (url[i] === '/' || url[i] === '\\')) {
    slashes++;
    i++;
  }
  if (slashes < 2) return undefined;
  const start = i;
  let j = i;
  while (j < url.length && !'/\\?#'.includes(url[j]!)) j++;
  const authority = url.slice(start, j);
  const at = authority.lastIndexOf('@');
  const afterUserInfo = at >= 0 ? authority.slice(at + 1) : authority;
  if (afterUserInfo === '') return undefined;
  if (afterUserInfo.startsWith('[')) {
    const close = afterUserInfo.indexOf(']');
    if (close < 0) return undefined;
    return afterUserInfo.slice(0, close + 1).toLowerCase();
  }
  const port = afterUserInfo.indexOf(':');
  const h = normalizeHost(port >= 0 ? afterUserInfo.slice(0, port) : afterUserInfo);
  return h === '' ? undefined : h;
};

/** What a URL resolves to, once the scheme floor has accepted it. */
export type Destination =
  | { readonly kind: 'local' }
  | { readonly kind: 'remote'; readonly host: string }
  | { readonly kind: 'nonNetwork'; readonly scheme: string }
  | { readonly kind: 'rejected' };

/**
 * Resolve a URL to the destination a policy reasons about. Runs the scheme floor
 * FIRST — there is nothing to say about where an unsafe URL points.
 */
export const classifyDestination = (url: string): Destination => {
  const safe = sanitizeUrl(url);
  if (safe === undefined) return { kind: 'rejected' };
  if (safe === '') return { kind: 'local' };
  const scheme = schemeOf(safe);
  // No scheme reaching here is same-origin: `sanitizeUrl` has already refused
  // every protocol-relative spelling, the one schemeless shape that leaves.
  if (scheme === undefined) return { kind: 'local' };
  if (networkSchemes.has(scheme)) {
    const host = authorityHost(safe);
    return host === undefined ? { kind: 'rejected' } : { kind: 'remote', host };
  }
  return { kind: 'nonNetwork', scheme };
};

/** Why a destination was refused, or that it was not. */
export type EgressVerdict =
  | { readonly kind: 'allowed'; readonly url: string }
  | { readonly kind: 'unsafeUrl' }
  /** Carries the HOST ONLY — never the path or query, which is exactly where an
   * exfiltrated payload would be sitting. */
  | { readonly kind: 'undeclaredOrigin'; readonly host: string; readonly cls: EgressClass }
  | { readonly kind: 'localDenied'; readonly cls: EgressClass }
  | { readonly kind: 'nonNetworkDenied'; readonly scheme: string; readonly cls: EgressClass };

const originMatches = (origin: EgressOrigin, host: string): boolean => {
  const h = normalizeHost(origin.host);
  if (h === '') return false;
  return origin.match === 'exact' ? h === host : host === h || host.endsWith('.' + h);
};

/** Is this host declared for this class by this policy? */
export const isDeclaredOrigin = (policy: EgressPolicy, cls: EgressClass, host: string): boolean => {
  const h = normalizeHost(host);
  if (h === '') return false;
  return (
    policy.allowAnyOrigin ||
    policy.rules.some((r) => r.classes.includes(cls) && originMatches(r.origin, h))
  );
};

/** The whole check: scheme floor, then destination policy, for one class. */
export const checkDestination = (
  policy: EgressPolicy,
  cls: EgressClass,
  url: string,
): EgressVerdict => {
  const dest = classifyDestination(url);
  switch (dest.kind) {
    case 'rejected':
      return { kind: 'unsafeUrl' };
    case 'local':
      return policy.allowLocal
        ? { kind: 'allowed', url: sanitizeUrl(url) ?? '' }
        : { kind: 'localDenied', cls };
    case 'nonNetwork':
      return policy.allowNonNetwork
        ? { kind: 'allowed', url: sanitizeUrl(url) ?? '' }
        : { kind: 'nonNetworkDenied', scheme: dest.scheme, cls };
    case 'remote':
      return isDeclaredOrigin(policy, cls, dest.host)
        ? { kind: 'allowed', url: sanitizeUrl(url) ?? '' }
        : { kind: 'undeclaredOrigin', host: dest.host, cls };
  }
};

/**
 * The `href` / `src` a REFUSED destination renders as.
 *
 * Deliberately NOT the bare `about:blank` the scheme floor emits: a silent
 * neuter is indistinguishable from an authoring mistake, and "nothing happened"
 * and "this was refused" are different facts. The fragment is inert in every
 * browser and greppable in a rendered document.
 */
export const egressRefusalUrl = 'about:blank#fuaran-egress-refused';

/**
 * The attribute name an emission site attaches beside a refused destination.
 * Passes the attribute-name allowlist and the `data-` prefix rule by
 * construction, so it survives `sanitizeExtraAttributes` unchanged.
 */
export const egressRefusalAttribute = 'data-fuaran-egress-refused';

/**
 * The refusal marker for a verdict, or `undefined` when allowed. The VALUE names
 * the class and — where there is one — the host; it never carries the URL, for
 * the reason `undeclaredOrigin` gives.
 */
export const egressRefusalMarker = (v: EgressVerdict): [string, string] | undefined => {
  switch (v.kind) {
    case 'allowed':
      return undefined;
    case 'unsafeUrl':
      return [egressRefusalAttribute, 'unsafe-url'];
    case 'undeclaredOrigin':
      return [egressRefusalAttribute, v.cls + ':' + v.host];
    case 'localDenied':
      return [egressRefusalAttribute, v.cls + ':local'];
    case 'nonNetworkDenied':
      return [egressRefusalAttribute, v.cls + ':' + v.scheme];
  }
};

/**
 * Log-safe description of a verdict. Carries the HOST and the CLASS, never the
 * URL — the same discipline the refusal marker keeps, and for the same reason:
 * a refusal record outlives the session, and the query string of a refused
 * exfiltration attempt is the payload itself.
 */
export const describeEgressVerdict = (v: EgressVerdict): string => {
  switch (v.kind) {
    case 'allowed':
      return 'destination allowed';
    case 'unsafeUrl':
      return 'destination refused: the URL is not safe to render';
    case 'undeclaredOrigin':
      return `destination refused: origin '${v.host}' is not declared for '${v.cls}' egress`;
    case 'localDenied':
      return `destination refused: this policy denies same-origin '${v.cls}' egress`;
    case 'nonNetworkDenied':
      return `destination refused: scheme '${v.scheme}' has no origin to declare for '${v.cls}' egress`;
  }
};

/**
 * The one-call render seam: the URL to emit, plus the attributes that record a
 * refusal in the document itself. An emission site adopts this by replacing its
 * `sanitizeUrlOrBlank` call and splicing the returned attribute list — which is
 * the whole adoption, per call site.
 *
 * A refusal returns `egressRefusalUrl`, never the bare `about:blank` the scheme
 * floor emits: "nothing happened" and "this was refused" are different facts,
 * and only one of them is debuggable. That INCLUDES the `unsafeUrl` verdict,
 * whose marker value is the bare `unsafe-url` — the floor rejected the URL
 * before there was any destination to name a class or host for.
 */
export const sanitizeUrlForEgress = (
  policy: EgressPolicy,
  cls: EgressClass,
  url: string,
): [string, readonly [string, string][]] => {
  const verdict = checkDestination(policy, cls, url);
  if (verdict.kind === 'allowed') return [verdict.url, []];
  const marker = egressRefusalMarker(verdict);
  return [egressRefusalUrl, marker === undefined ? [] : [marker]];
};
