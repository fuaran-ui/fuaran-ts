// ============================================================================
//  @fuaran-ui/renderer-server/html — a tiny string-HTML builder + escaping floor.
//
//  The server renderer emits HTML *strings* — no DOM, no React, no template
//  engine. This module is the single seam where a string becomes HTML, so the
//  escaping floor lives here (mirroring the React-escaping floor the client
//  renderer leans on; see fuaran-dotnet/SANITIZATION.md "React's escaping floor"). It
//  is the TypeScript analogue of the Python host's `html.py`.
//
//  Attribute *values* are escaped here; attribute *keys* the caller passes are
//  renderer-controlled (the class vocabulary, data-* markers, ARIA keys) — the
//  untrusted seams (ExtraAttributes, URLs) are filtered upstream by the
//  @fuaran-ui/renderer/sanitize functions before they reach this module.
// ============================================================================

/** An attribute pair. `true` → bare attribute (`disabled`); `false`/`undefined` → omitted. */
export type Attr = readonly [name: string, value: string | number | boolean | undefined];

/** Escape a string for HTML *text* content (the `prop.text` floor). */
export const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Escape a string for an HTML double-quoted *attribute* value. */
export const escapeAttr = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

/**
 * Positive character allowlist for an attribute NAME: ASCII letters, digits, `-`.
 *
 * Attribute *values* are escaped by `escapeAttr`; attribute *names* are written
 * verbatim, and HTML has no escape for an illegal character in a name — a space
 * starts a NEW attribute and an `=` starts its value. So a name is either
 * conforming or dropped; there is no third option, and "escape the name" is a
 * plausible-looking fix that cannot work.
 *
 * This duplicates the gate in `@fuaran-ui/renderer/sanitize` deliberately rather
 * than importing it: this package is dependency-light by design, and the point of
 * a defence-in-depth re-check is that it does not rely on the upstream one having
 * run. Every name this renderer emits is already `[A-Za-z0-9-]`, so the guard
 * costs nothing in the ordinary path — it exists for the untrusted seam.
 */
const isSafeAttributeName = (name: string): boolean => {
  if (name === '') return false;
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

const attrString = (attrs: readonly Attr[]): string => {
  let out = '';
  for (const [name, value] of attrs) {
    if (value === undefined || value === false) continue;
    // Drop, never escape — see `isSafeAttributeName`.
    if (!isSafeAttributeName(name)) continue;
    if (value === true) {
      out += ` ${name}`;
    } else {
      out += ` ${name}="${escapeAttr(String(value))}"`;
    }
  }
  return out;
};

// HTML void elements — no closing tag, no children (WHATWG §12.1.2).
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/** Render a non-void element with pre-escaped / pre-rendered `inner` HTML. */
export const el = (tag: string, attrs: readonly Attr[] = [], inner = ''): string =>
  `<${tag}${attrString(attrs)}>${inner}</${tag}>`;

/** Render a void element (`input` / `img` / …) — self-closing, no children. */
export const voidEl = (tag: string, attrs: readonly Attr[] = []): string => {
  if (!VOID_ELEMENTS.has(tag)) throw new Error(`voidEl called with non-void tag '${tag}'`);
  return `<${tag}${attrString(attrs)} />`;
};

/** Render an element whose only child is escaped text content. */
export const textEl = (tag: string, attrs: readonly Attr[], text: string): string =>
  el(tag, attrs, escapeText(text));
