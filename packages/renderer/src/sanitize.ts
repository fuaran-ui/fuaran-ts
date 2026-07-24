// ============================================================================
//  @fuaran-ui/renderer/sanitize — render-time injection-safety contract.
//
//  Shape-for-shape port of the F# `Fuaran.UI.Renderer.Sanitize` module
//  (Phase 56). Every string the renderer pours into a DOM attribute, URL
//  prop, or raw-HTML sink (`dangerouslySetInnerHTML`) first passes through
//  one of these functions, so the tree-emission layer is not the only gate.
//  Pure, dependency-free, testable in isolation — the XSS-payload corpus
//  lives in test/sanitize.test.ts.
//
//  Threat model (see fuaran/SANITIZATION.md for the full doc):
//    1. extraAttributes — drop `on*` event handlers, `style`, anything
//       outside data-* / aria-*. Reject keys/values containing `<`, `>`,
//       or C0 control bytes (defence in depth — React's encoder already
//       escapes, but we treat custom-attribute emission as "verbatim").
//    2. URL props — block `javascript:` / `vbscript:` / `file:` / raw
//       `data:` schemes. Allow http/https/mailto/tel/ftp/sftp + relative.
//    3. Markdown raw-HTML — strip `<script>` / `<iframe>` / `<object>` /
//       `<embed>` / `<form>` / `<link>` / `<meta>` element blocks + inline
//       `on*=` handlers + `javascript:` / `vbscript:` URLs before the HTML
//       reaches `dangerouslySetInnerHTML`.
//
//  The NodeKind.Custom registered renderer is a HOST trust boundary, not an
//  AI-emission surface — the host's component is expected to do its own
//  escaping; this module does not police it.
// ============================================================================

// ─── extraAttributes key / value sanitization ───────────────────────────────

/**
 * Allowlist predicate for an extra-attribute key: the data-* / aria-* rule,
 * with explicit rejection of `on*` event handlers and `style`.
 */
export const isAllowedExtraAttributeKey = (key: string): boolean => {
  if (key == null) return false;
  const trimmed = key.trim();
  if (trimmed === '') return false;
  if (trimmed.toLowerCase().startsWith('on')) return false;
  if (trimmed.toLowerCase() === 'style') return false;
  return trimmed.startsWith('data-') || trimmed.startsWith('aria-');
};

/**
 * Reject values carrying C0 control bytes (except tab) or angle brackets —
 * attribute-injection vectors under a verbatim-emission contract.
 */
export const isSafeExtraAttributeValue = (value: string): boolean => {
  if (value == null) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && ch !== '\t') return false;
    if (ch === '<' || ch === '>') return false;
  }
  return true;
};

/**
 * Filter a candidate extra-attributes map down to the entries that pass both
 * predicates. Returns a key-sorted record so emission order is deterministic
 * across re-renders (mirrors the F# `Map.toList` natural ordering).
 */
export const sanitizeExtraAttributes = (
  attrs: Readonly<Record<string, string>>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of Object.keys(attrs).sort()) {
    const value = attrs[key];
    if (
      value !== undefined &&
      isAllowedExtraAttributeKey(key) &&
      isSafeExtraAttributeValue(value)
    ) {
      out[key] = value;
    }
  }
  return out;
};

// ─── URL-scheme sanitization ─────────────────────────────────────────────────

const allowedUrlSchemes = new Set(['http', 'https', 'mailto', 'tel', 'ftp', 'sftp']);
const rejectedUrlSchemes = new Set(['javascript', 'vbscript', 'file']);

/**
 * Split a URL into `[scheme | undefined, rest]`. A URL without a `:` before
 * any `/`, `?`, or `#` returns `[undefined, url]` (relative / fragment).
 * ASCII whitespace + C0 controls are stripped from the scheme candidate so
 * `java\tscript:`, ` javascript:`, `JAVASCRIPT:` all classify as `javascript`.
 */
const extractScheme = (url: string): [string | undefined, string] => {
  if (url == null) return [undefined, ''];
  let colonIdx = -1;
  let slashIdx = -1;
  for (let i = 0; i < url.length && colonIdx < 0 && slashIdx < 0; i++) {
    const ch = url[i];
    if (ch === ':') colonIdx = i;
    else if (ch === '/' || ch === '?' || ch === '#') slashIdx = i;
  }
  if (colonIdx < 0 || (slashIdx >= 0 && slashIdx < colonIdx)) return [undefined, url];
  const raw = url.substring(0, colonIdx);
  let cleaned = '';
  for (const ch of raw) {
    if ((ch.codePointAt(0) ?? 0) > 0x20) cleaned += ch;
  }
  return [cleaned.trim().toLowerCase(), url];
};

/**
 * Returns the sanitized URL, or `undefined` if the scheme is rejected.
 * Empty string passes through (a valid same-page href). `data:` is rejected
 * by default (SVG data-URL XSS vector); unknown schemes are rejected
 * conservatively.
 */
export const sanitizeUrl = (url: string): string | undefined => {
  if (url == null) return undefined;
  const trimmed = url.trim();
  if (trimmed === '') return trimmed;
  const [scheme] = extractScheme(trimmed);
  if (scheme === undefined) return trimmed; // relative / fragment / same-origin
  if (rejectedUrlSchemes.has(scheme)) return undefined;
  if (allowedUrlSchemes.has(scheme)) return trimmed;
  return undefined; // unknown scheme — reject by default
};

/**
 * Returns the URL itself if accepted, or `"about:blank"` if rejected. Used by
 * renderer call sites that must emit *some* href to keep the element valid.
 */
export const sanitizeUrlOrBlank = (url: string): string => sanitizeUrl(url) ?? 'about:blank';

// ─── Markdown raw-HTML sanitization ──────────────────────────────────────────

const dangerousElements = ['script', 'iframe', 'object', 'embed', 'form', 'link', 'meta'];
const dangerousProtocols = ['javascript:', 'vbscript:'];

/**
 * Strip dangerous element blocks (`<script>` etc.), inline `on*=` event
 * handlers, and `javascript:` / `vbscript:` URLs from a chunk of HTML before
 * it reaches `dangerouslySetInnerHTML`. Approximate — NOT a full HTML parser,
 * but the render path constrains the input to a markdown library's output (a
 * known shape), so the substring sweep is sufficient defence in depth on top
 * of the parser's own escaping. Hosts needing DOMPurify-level sanitization
 * layer it consumer-side; this is the floor, not the ceiling.
 */
export const sanitizeMarkdownHtml = (html: string): string => {
  if (html == null || html === '') return '';
  let result = html;

  // Remove balanced dangerous element blocks; iterate for nested / siblings.
  for (const tag of dangerousElements) {
    const openTag = '<' + tag;
    const closeTag = '</' + tag + '>';
    let keepGoing = true;
    while (keepGoing) {
      const i = indexOfCI(result, openTag, 0);
      if (i < 0) {
        keepGoing = false;
      } else {
        const j = indexOfCI(result, closeTag, i);
        if (j >= 0) {
          result = result.slice(0, i) + result.slice(j + closeTag.length);
        } else {
          const endBracket = result.indexOf('>', i);
          if (endBracket >= 0) {
            result = result.slice(0, i) + result.slice(endBracket + 1);
          } else {
            result = result.slice(0, i);
            keepGoing = false;
          }
        }
      }
    }
  }

  result = stripEventHandlers(result);

  for (const proto of dangerousProtocols) {
    let keepGoing = true;
    while (keepGoing) {
      const i = result.toLowerCase().indexOf(proto);
      if (i < 0) {
        keepGoing = false;
      } else {
        result = result.slice(0, i) + 'about:blank' + result.slice(i + proto.length);
      }
    }
  }

  return result;
};

const indexOfCI = (haystack: string, needle: string, from: number): number =>
  haystack.toLowerCase().indexOf(needle.toLowerCase(), from);

/**
 * Strip inline `on*="..."` event-handler attributes (tag-interior anchored).
 *
 * The tag-interior anchor is load-bearing: the ` on<letter>` scan matches the
 * leading-whitespace-`on<letter>` pattern in ordinary prose — the English words
 * "one", "only", "once", "onto", "online", … — and the boolean-attribute branch
 * below would then delete the word from body text. Because `sanitizeMarkdownHtml`
 * runs over the deterministic markdown-renderer output (raw HTML already escaped
 * by construction), a real event-handler attribute can only appear inside a tag
 * the renderer itself emitted, so restricting the scan to `<...>` interiors is
 * both correct and removes the body-text false positive.
 */
const stripEventHandlers = (input: string): string => {
  let s = input;
  let keepGoing = true;
  while (keepGoing) {
    const lower = s.toLowerCase();
    let found = -1;
    let insideTag = false;
    for (let i = 0; i < lower.length - 3 && found < 0; i++) {
      const c0 = lower[i];
      if (c0 === '<') {
        insideTag = true;
      } else if (c0 === '>') {
        insideTag = false;
      } else if (
        insideTag &&
        (c0 === ' ' || c0 === '\t' || c0 === '\n') &&
        lower[i + 1] === 'o' &&
        lower[i + 2] === 'n' &&
        isLetter(lower[i + 3])
      ) {
        found = i;
      }
    }
    if (found < 0) {
      keepGoing = false;
    } else {
      const eq = s.indexOf('=', found);
      const nextSpace = indexOfAny(s, [' ', '\t', '\n', '>'], found + 1);
      if (eq < 0 || (nextSpace >= 0 && nextSpace < eq)) {
        // Boolean attribute like `onload` with no `=` — strip the name only.
        const stopAt = nextSpace >= 0 ? nextSpace : s.length;
        s = s.slice(0, found) + s.slice(stopAt);
      } else {
        let v = eq + 1;
        while (v < s.length && (s[v] === ' ' || s[v] === '\t')) v++;
        let stopAt: number;
        const quote = s[v];
        if (v < s.length && (quote === "'" || quote === '"')) {
          const close = s.indexOf(quote, v + 1);
          stopAt = close >= 0 ? close + 1 : s.length;
        } else {
          const candidate = indexOfAny(s, [' ', '\t', '\n', '>'], v);
          stopAt = candidate >= 0 ? candidate : s.length;
        }
        s = s.slice(0, found) + s.slice(stopAt);
      }
    }
  }
  return s;
};

const isLetter = (ch: string | undefined): boolean =>
  ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'));

const indexOfAny = (s: string, chars: readonly string[], from: number): number => {
  let best = -1;
  for (const ch of chars) {
    const idx = s.indexOf(ch, from);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
};
