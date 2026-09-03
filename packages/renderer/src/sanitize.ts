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
//  Threat model (see fuaran-dotnet/SANITIZATION.md for the full doc):
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
 * Positive character allowlist for an HTML attribute NAME: ASCII letters, digits
 * and `-`. Everything else — `=`, quotes, backtick, `<`, `>`, `/`, space, tab,
 * newline, C0 controls, and any non-ASCII byte — is rejected.
 *
 * This is a REJECTION gate, not an escape, because HTML has no escape for an
 * illegal character in an attribute name: a space inside a name simply starts a
 * NEW attribute, and an `=` starts its value. So `data-x=1 onmouseover=alert(1) z`
 * is not a mangled attribute name — it is three attributes, one of them a live
 * event handler. The server renderer writes names verbatim (values are escaped,
 * names are not), so dropping the entry is the only sound response.
 *
 * Exported so the emission site can re-check it as defence in depth rather than
 * trusting upstream validation alone.
 */
export const isSafeAttributeName = (name: string): boolean => {
  if (name == null || name === '') return false;
  for (const ch of name) {
    const ok =
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '-';
    if (!ok) return false;
  }
  return true;
};

/**
 * Allowlist predicate for an extra-attribute key: the data-* / aria-* rule, with
 * explicit rejection of `on*` event handlers and `style`, plus
 * `isSafeAttributeName` over the whole trimmed key.
 *
 * Without that last check a key like `data-x=1 onmouseover=alert(1) z` satisfies
 * the `data-` prefix and smuggles a live event handler into server-rendered HTML.
 *
 * The predicate answers "is this key admissible", judged on its TRIMMED form; a
 * caller using it directly must trim before emission too.
 */
export const isAllowedExtraAttributeKey = (key: string): boolean => {
  if (key == null) return false;
  const trimmed = key.trim();
  if (trimmed === '') return false;
  if (trimmed.toLowerCase().startsWith('on')) return false;
  if (trimmed.toLowerCase() === 'style') return false;
  if (!isSafeAttributeName(trimmed)) return false;
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
      // The re-key is load-bearing: the predicate judges `key.trim()`, so emitting
      // the untrimmed key would emit something the gate never inspected.
      out[key.trim()] = value;
    }
  }
  return out;
};

// ─── URL-scheme sanitization ─────────────────────────────────────────────────

const allowedUrlSchemes = new Set(['http', 'https', 'mailto', 'tel', 'ftp', 'sftp']);
const rejectedUrlSchemes = new Set(['javascript', 'vbscript', 'file']);

/**
 * ASCII-only lowercase — length-preserving by construction, which
 * `String.prototype.toLowerCase` is NOT (U+0130 LATIN CAPITAL LETTER I WITH DOT
 * ABOVE folds to a two-code-unit sequence). Every place below that searches a
 * case-folded COPY and then splices indices back into the ORIGINAL depends on
 * the two strings staying index-aligned; a locale-aware fold silently shifts
 * the removal window and leaves a fragment of the element it meant to remove.
 * The scheme/tag/protocol vocabulary this module matches is ASCII, so an
 * ASCII-only fold loses no matches.
 */
const asciiLower = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/**
 * A protocol-relative URL: `//host/path`, plus the backslash forms browsers
 * normalise to it. WHATWG URL parsing treats `\` as `/` for special schemes,
 * so `\\host`, `/\host` and `\/host` all resolve exactly as `//host` does.
 *
 * These carry no scheme, so the schemeless branch of `sanitizeUrl` would
 * otherwise admit them — but the browser resolves them against the CURRENT
 * page's scheme and lands on an OFF-ORIGIN host, defeating the same-origin
 * intent that makes a schemeless URL safe in the first place. On an `href`
 * that is off-origin navigation; on an `img src` it is an off-origin request
 * that leaks the Referer.
 */
const isProtocolRelative = (url: string): boolean => {
  if (url.length < 2) return false;
  const c0 = url[0];
  const c1 = url[1];
  return (c0 === '/' || c0 === '\\') && (c1 === '/' || c1 === '\\');
};

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
 * §19 rule 1 — normalise a URL string exactly as the WHATWG URL Standard's basic
 * URL parser does before it parses anything, ASCII-exact, in this order:
 *
 *   1. remove leading and trailing C0 control or space — ALL of U+0000–U+0020,
 *      not merely the whitespace subset;
 *   2. remove every U+0009 / U+000A / U+000D from anywhere in what remains.
 *
 * This is deliberately NOT `String.prototype.trim()`. A native trim answers a
 * different question in every language — Python's `strip` also removes
 * U+001C–U+001F where JS, .NET, Go and Rust do not; JS alone keeps U+0085 NEL
 * where the other four drop it — and all of them remove non-ASCII whitespace
 * (U+00A0, U+2028, …) that the parser keeps. The floor's whole purpose is that a
 * tree vetted on one host is safe on another, so the normalisation has to be
 * defined by the parser that will actually consume the string rather than by the
 * host's standard library.
 *
 * Step 2 is those three code points ONLY: the parser removes U+000B and U+000C at
 * the edges (step 1) and KEEPS them in the interior, so `/<VT>/host/x` is an
 * ordinary same-origin path and must stay one.
 */
const normalizeUrlForFloor = (url: string): string => {
  let lo = 0;
  let hi = url.length - 1;
  while (lo <= hi && url.charCodeAt(lo) <= 0x20) lo++;
  while (hi >= lo && url.charCodeAt(hi) <= 0x20) hi--;
  let out = '';
  for (let i = lo; i <= hi; i++) {
    const c = url.charCodeAt(i);
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    out += url[i];
  }
  return out;
};

/**
 * Returns the sanitized URL, or `undefined` if the scheme is rejected.
 * Empty string passes through (a valid same-page href). `data:` is rejected
 * by default (SVG data-URL XSS vector); unknown schemes are rejected
 * conservatively. Protocol-relative URLs (`//host`, and the `\\` / `/\` / `\/`
 * forms browsers normalise to it) are rejected despite carrying no scheme —
 * see `isProtocolRelative`.
 *
 * The input is first normalised per §19 rule 1 (see `normalizeUrlForFloor`), and
 * that normalised form is also what is EMITTED on acceptance — so an accepted URL
 * carrying an interior tab loses it, which is what the browser would have parsed
 * anyway.
 */
export const sanitizeUrl = (url: string): string | undefined => {
  if (url == null) return undefined;
  const trimmed = normalizeUrlForFloor(url);
  if (trimmed === '') return trimmed;
  const [scheme] = extractScheme(trimmed);
  if (scheme === undefined) {
    if (isProtocolRelative(trimmed)) return undefined; // off-origin despite having no scheme
    return trimmed; // relative / fragment / same-origin
  }
  if (rejectedUrlSchemes.has(scheme)) return undefined;
  if (allowedUrlSchemes.has(scheme)) return trimmed;
  return undefined; // unknown scheme — reject by default
};

/**
 * Returns the URL itself if accepted, or `"about:blank"` if rejected. Used by
 * renderer call sites that must emit *some* href to keep the element valid.
 */
export const sanitizeUrlOrBlank = (url: string): string => sanitizeUrl(url) ?? 'about:blank';

/**
 * Phase 1111 — the `embed` SCHEME floor. §19-class, and deliberately NOT §19.
 *
 * `https` is the only accepted scheme, and the two exclusions worth naming are
 * the ones §19 accepts. `http`, because an embed is fetched and then EXECUTED,
 * so a document delivered over a channel any intermediary can rewrite is an
 * intermediary's script running in a frame this page created. And a SCHEMELESS
 * reference, because it names a same-origin document — which is exactly where
 * `AllowSameOrigin` together with `AllowScripts` lets the framed document reach
 * its own frame element and remove the sandbox attribute.
 *
 * One accepted scheme and NO positional test, which is the second reason this
 * is its own function rather than a parameter on the §19 floor: rule 5's
 * protocol-relative check exists because a schemeless reference is otherwise
 * admitted, and a class that admits none cannot inherit its evasion surface.
 * Rule 1's normalisation is still shared — it is what makes the scheme
 * extraction see the string the parser will see.
 *
 * `undefined` means REFUSED, and the caller drops the attribute rather than
 * substituting anything: an `<iframe>` with no `src` is a well-defined empty
 * frame that fetches nothing.
 */
export const sanitizeEmbedSrc = (url: string): string | undefined => {
  if (url == null) return undefined;
  const normalized = normalizeUrlForFloor(url);
  if (normalized === '') return undefined;
  const [scheme] = extractScheme(normalized);
  return scheme === 'https' ? normalized : undefined;
};

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
      const i = asciiLower(result).indexOf(proto);
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
  asciiLower(haystack).indexOf(asciiLower(needle), from);

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
    const lower = asciiLower(s);
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
