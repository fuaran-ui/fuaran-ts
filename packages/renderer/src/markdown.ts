// ============================================================================
//  @fuaran-ui/renderer/markdown — deterministic GFM markdown → HTML (Phase 292).
//
//  A faithful port of the F# reference renderer (Fuaran.UI.Renderer.Markdown.toHtml
//  in Fuaran.UI.Renderer.Core): the output is byte-identical to the F# and Python
//  hosts, verified against the shared corpus at
//  ../../../wire-format-fixtures/markdown/corpus.json. Replaces the old npm
//  `marked` dependency (and the .NET-side Markdig) with one deterministic
//  renderer, so SSR'd markdown matches client markdown byte-for-byte.
//
//  Targets the GFM spec (github.github.com/gfm) at the common-case bar. Buckets
//  (see ../../../fuaran-dotnet/docs/MARKDOWN.md):
//   IN  — CommonMark core + GFM tables / strikethrough / task lists / bare URLs.
//   OUT — raw/inline HTML escaped (no passthrough); math + Mermaid live as a
//         Custom node / client-only pass (they would break byte-parity).
//   DEFERRED — emoji / footnotes / heading anchors / sub-sup / definition lists /
//         the full named-entity table render escaped-literal until added.
//
//  Escapes by construction (no raw-HTML passthrough; URLs via sanitizeUrlOrBlank);
//  the result still passes through sanitizeMarkdownHtml as defence in depth.
// ============================================================================

import { sanitizeMarkdownHtml, sanitizeUrlOrBlank } from './sanitize.js';

// ─── Host-parity primitives ──────────────────────────────────────────────────
// Explicit whitespace/digit classes (NOT \s / isDigit) so F#, TS, and Python
// classify identically — their Unicode sets differ at the edges, a parity
// hazard. This fixed ASCII set is the cross-host contract.

const repeatChar = (c: string, n: number): string => (n <= 0 ? '' : c.repeat(n));
// space (32) + tab/LF/VT/FF/CR (9-13) — the cross-host whitespace set.
const isWs = (c: string): boolean => {
  const n = c.charCodeAt(0);
  return c === ' ' || (n >= 9 && n <= 13);
};
const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isAsciiPunct = (c: string): boolean =>
  (c >= '!' && c <= '/') ||
  (c >= ':' && c <= '@') ||
  (c >= '[' && c <= '`') ||
  (c >= '{' && c <= '~');

// Match the F# escape set exactly: & < > " (and NOT ').
const escapeHtml = (s: string): string =>
  !s
    ? ''
    : s
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');

const trimStartChars = (s: string, chars: string): string => {
  let i = 0;
  while (i < s.length && chars.includes(s[i]!)) i++;
  return s.slice(i);
};
const trimEndChars = (s: string, chars: string): string => {
  let j = s.length;
  while (j > 0 && chars.includes(s[j - 1]!)) j--;
  return s.slice(0, j);
};
const trimChars = (s: string, chars: string): string =>
  trimEndChars(trimStartChars(s, chars), chars);
const indexOfAny = (s: string, chars: string): number => {
  for (let i = 0; i < s.length; i++) if (chars.includes(s[i]!)) return i;
  return -1;
};

// ─── Entity decoding (common subset; the rest is DEFERRED) ────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup2: '²',
  sup3: '³',
  middot: '·',
  bull: '•',
  dagger: '†',
  euro: '€',
  pound: '£',
  cent: '¢',
  yen: '¥',
  sect: '§',
  para: '¶',
};

const tryDecodeEntity = (text: string, i: number): [string, number] | null => {
  const semi = text.indexOf(';', i);
  if (semi < 0 || semi === i + 1) return null;
  const body = text.slice(i + 1, semi);
  if (body.startsWith('#')) {
    const isHex = body.length > 1 && (body[1] === 'x' || body[1] === 'X');
    const digits = isHex ? body.slice(2) : body.slice(1);
    if (digits === '') return null;
    let code = 0;
    let ok = true;
    for (const ch of digits) {
      const cc = ch.charCodeAt(0);
      if (isHex) {
        if (ch >= '0' && ch <= '9') code = code * 16 + (cc - 48);
        else if (ch >= 'a' && ch <= 'f') code = code * 16 + (cc - 97 + 10);
        else if (ch >= 'A' && ch <= 'F') code = code * 16 + (cc - 65 + 10);
        else ok = false;
      } else if (ch >= '0' && ch <= '9') code = code * 10 + (cc - 48);
      else ok = false;
    }
    if (!ok) return null;
    const cp = code === 0 || code > 0x10ffff ? 0xfffd : code;
    return [String.fromCodePoint(cp), semi + 1];
  }
  const s = NAMED_ENTITIES[body];
  return s !== undefined ? [s, semi + 1] : null;
};

// ─── Inline AST ───────────────────────────────────────────────────────────────

type Inline =
  | { k: 'text'; v: string }
  | { k: 'raw'; v: string }
  | { k: 'emph'; c: Inline[] }
  | { k: 'strong'; c: Inline[] }
  | { k: 'strike'; c: Inline[] }
  | { k: 'soft' }
  | { k: 'hard' };

type Refs = Map<string, [string, string | null]>;

// ASCII-only case fold (NOT String.toLowerCase) so the F#, TS, and Python hosts
// case-fold reference labels identically — the JS Unicode casing table and the
// .NET invariant-culture table disagree at edge code points, which would resolve a
// reference link on one host and not another. ASCII A–Z → a–z is the cross-host
// contract (workspace roadmap Phase 299).
const asciiLower = (ch: string): string => {
  const c = ch.charCodeAt(0);
  return c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : ch;
};

const normLabel = (s: string): string => {
  let out = '';
  let inWs = false;
  for (const ch of s.trim()) {
    if (isWs(ch)) inWs = true;
    else {
      if (inWs) out += ' ';
      inWs = false;
      out += asciiLower(ch);
    }
  }
  return out;
};

const scanCodeSpan = (text: string, i: number): [Inline, number] | null => {
  const n = text.length;
  let j = i;
  while (j < n && text[j] === '`') j++;
  const openLen = j - i;
  let k = j;
  let closeStart = -1;
  while (k < n && closeStart < 0) {
    if (text[k] === '`') {
      let m = k;
      while (m < n && text[m] === '`') m++;
      if (m - k === openLen) closeStart = k;
      k = m;
    } else k++;
  }
  if (closeStart < 0) return null;
  const raw = text.slice(j, closeStart);
  let collapsed = raw.replaceAll('\r\n', ' ').replaceAll('\n', ' ').replaceAll('\r', ' ');
  if (
    collapsed.length >= 2 &&
    collapsed[0] === ' ' &&
    collapsed[collapsed.length - 1] === ' ' &&
    collapsed.trim() !== ''
  )
    collapsed = collapsed.slice(1, collapsed.length - 1);
  return [{ k: 'raw', v: '<code>' + escapeHtml(collapsed) + '</code>' }, closeStart + openLen];
};

const isSchemeChar = (c: string): boolean =>
  (c >= 'a' && c <= 'z') ||
  (c >= 'A' && c <= 'Z') ||
  (c >= '0' && c <= '9') ||
  c === '+' ||
  c === '.' ||
  c === '-';

const scanAutolink = (text: string, i: number): [Inline, number] | null => {
  const close = text.indexOf('>', i);
  if (close < 0) return null;
  const body = text.slice(i + 1, close);
  if (body === '' || body.includes(' ') || body.includes('<')) return null;
  const colon = body.indexOf(':');
  const looksUri =
    colon >= 2 &&
    colon <= 32 &&
    [...body.slice(0, colon)].every(isSchemeChar) &&
    ((body[0]! >= 'a' && body[0]! <= 'z') || (body[0]! >= 'A' && body[0]! <= 'Z'));
  const looksEmail =
    !looksUri && body.includes('@') && !body.includes(':') && body.indexOf('@') > 0;
  if (looksUri) {
    const safe = sanitizeUrlOrBlank(body);
    return [
      { k: 'raw', v: '<a href="' + escapeHtml(safe) + '">' + escapeHtml(body) + '</a>' },
      close + 1,
    ];
  }
  if (looksEmail)
    return [
      { k: 'raw', v: '<a href="mailto:' + escapeHtml(body) + '">' + escapeHtml(body) + '</a>' },
      close + 1,
    ];
  return null;
};

const scanInlineDestination = (
  text: string,
  start: number,
): [string, string | null, number] | null => {
  const n = text.length;
  let i = start;
  while (i < n && (text[i] === ' ' || text[i] === '\n' || text[i] === '\t')) i++;
  let url = '';
  let ok = true;
  if (i < n && text[i] === '<') {
    const close = text.indexOf('>', i);
    if (close < 0) ok = false;
    else {
      url = text.slice(i + 1, close);
      i = close + 1;
    }
  } else {
    let depth = 0;
    let buf = '';
    let go = true;
    while (go && i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n') go = false;
      else if (c === '(') {
        depth++;
        buf += c;
        i++;
      } else if (c === ')') {
        if (depth === 0) go = false;
        else {
          depth--;
          buf += c;
          i++;
        }
      } else if (c === '\\' && i + 1 < n && isAsciiPunct(text[i + 1]!)) {
        buf += text[i + 1];
        i += 2;
      } else {
        buf += c;
        i++;
      }
    }
    url = buf;
  }
  let title: string | null = null;
  if (ok) {
    let j = i;
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    if (j < n && (text[j] === '"' || text[j] === "'")) {
      const q = text[j]!;
      const tClose = text.indexOf(q, j + 1);
      if (tClose >= 0) {
        title = text.slice(j + 1, tClose);
        i = tClose + 1;
        while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) i++;
      }
    }
  }
  if (!ok) return null;
  if (i < n && text[i] === ')') return [url, title, i + 1];
  return null;
};

const matchBracket = (text: string, open0: number): number => {
  const n = text.length;
  let i = open0 + 1;
  let depth = 1;
  while (i < n) {
    const c = text[i];
    if (c === '\\' && i + 1 < n) i += 2;
    else if (c === '`') {
      const cs = scanCodeSpan(text, i);
      i = cs ? cs[1] : i + 1;
    } else if (c === '[') {
      depth++;
      i++;
    } else if (c === ']') {
      depth--;
      if (depth === 0) return i;
      i++;
    } else i++;
  }
  return -1;
};

function renderInlines(nodes: Inline[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.k) {
      case 'text':
        out += escapeHtml(node.v);
        break;
      case 'raw':
        out += node.v;
        break;
      case 'emph':
        out += '<em>' + renderInlines(node.c) + '</em>';
        break;
      case 'strong':
        out += '<strong>' + renderInlines(node.c) + '</strong>';
        break;
      case 'strike':
        out += '<del>' + renderInlines(node.c) + '</del>';
        break;
      case 'soft':
        out += '\n';
        break;
      case 'hard':
        out += '<br />\n';
        break;
    }
  }
  return out;
}

function plainText(nodes: Inline[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.k === 'text') out += node.v;
    else if (node.k === 'emph' || node.k === 'strong' || node.k === 'strike')
      out += plainText(node.c);
    else if (node.k === 'soft' || node.k === 'hard') out += ' ';
  }
  return out;
}

const scanBareAutolink = (text: string, i: number): [Inline, number] | null => {
  const n = text.length;
  const starts = (p: string): boolean => text.slice(i, i + p.length) === p;
  if (!starts('https://') && !starts('http://') && !starts('www.')) return null;
  let j = i;
  while (j < n && !isWs(text[j]!) && text[j] !== '<') j++;
  while (j > i && '.,;:!?)"\''.includes(text[j - 1]!)) j--;
  if (j <= i + 4) return null;
  const raw = text.slice(i, j);
  const href = raw.startsWith('www.') ? 'http://' + raw : raw;
  const safe = sanitizeUrlOrBlank(href);
  return [{ k: 'raw', v: '<a href="' + escapeHtml(safe) + '">' + escapeHtml(raw) + '</a>' }, j];
};

type Tok =
  | { kind: 'node'; node: Inline }
  | {
      kind: 'delim';
      ch: string;
      count: number;
      canOpen: boolean;
      canClose: boolean;
      active: boolean;
    };

function tokenize(refs: Refs, text: string): Tok[] {
  const toks: Tok[] = [];
  const n = text.length;
  let i = 0;
  let pending = '';

  const flush = (): void => {
    if (pending !== '') {
      toks.push({ kind: 'node', node: { k: 'text', v: pending } });
      pending = '';
    }
  };
  const prevChar = (): string => (i === 0 ? ' ' : text[i - 1]!);

  const makeImage = (labelText: string, url: string, titleOpt: string | null): void => {
    flush();
    const alt = plainText(parseInlines(refs, labelText));
    const safe = sanitizeUrlOrBlank(url);
    const titleAttr = titleOpt !== null ? ' title="' + escapeHtml(titleOpt) + '"' : '';
    toks.push({
      kind: 'node',
      node: {
        k: 'raw',
        v: '<img src="' + escapeHtml(safe) + '" alt="' + escapeHtml(alt) + '"' + titleAttr + ' />',
      },
    });
  };
  const makeLink = (labelText: string, url: string, titleOpt: string | null): void => {
    flush();
    const inner = renderInlines(parseInlines(refs, labelText));
    const safe = sanitizeUrlOrBlank(url);
    const titleAttr = titleOpt !== null ? ' title="' + escapeHtml(titleOpt) + '"' : '';
    toks.push({
      kind: 'node',
      node: {
        k: 'raw',
        v: '<a href="' + escapeHtml(safe) + '"' + titleAttr + '>' + inner + '</a>',
      },
    });
  };

  while (i < n) {
    const c = text[i];
    if (c === '\\' && i + 1 < n && text[i + 1] === '\n') {
      flush();
      toks.push({ kind: 'node', node: { k: 'hard' } });
      i += 2;
    } else if (c === '\\' && i + 1 < n && isAsciiPunct(text[i + 1]!)) {
      pending += text[i + 1];
      i += 2;
    } else if (c === '`') {
      const cs = scanCodeSpan(text, i);
      if (cs) {
        flush();
        toks.push({ kind: 'node', node: cs[0] });
        i = cs[1];
      } else {
        pending += c;
        i++;
      }
    } else if (c === '&') {
      const ent = tryDecodeEntity(text, i);
      if (ent) {
        pending += ent[0];
        i = ent[1];
      } else {
        pending += c;
        i++;
      }
    } else if (c === '<') {
      const al = scanAutolink(text, i);
      if (al) {
        flush();
        toks.push({ kind: 'node', node: al[0] });
        i = al[1];
      } else {
        pending += c;
        i++;
      }
    } else if (c === '!' && i + 1 < n && text[i + 1] === '[') {
      const close = matchBracket(text, i + 1);
      if (close === -1) {
        pending += c;
        i++;
      } else {
        const labelText = text.slice(i + 2, close);
        if (close + 1 < n && text[close + 1] === '(') {
          const dest = scanInlineDestination(text, close + 2);
          if (dest) {
            makeImage(labelText, dest[0], dest[1]);
            i = dest[2];
          } else {
            pending += c;
            i++;
          }
        } else {
          let refLabel = labelText;
          let consumedTo = close + 1;
          if (close + 1 < n && text[close + 1] === '[') {
            const r2 = matchBracket(text, close + 1);
            if (r2 > 0) {
              const inner = text.slice(close + 2, r2);
              refLabel = inner.trim() === '' ? labelText : inner;
              consumedTo = r2 + 1;
            }
          }
          const found = refs.get(normLabel(refLabel));
          if (found !== undefined) {
            makeImage(labelText, found[0], found[1]);
            i = consumedTo;
          } else {
            pending += c;
            i++;
          }
        }
      }
    } else if (c === '[') {
      const close = matchBracket(text, i);
      if (close === -1) {
        pending += c;
        i++;
      } else {
        const labelText = text.slice(i + 1, close);
        if (close + 1 < n && text[close + 1] === '(') {
          const dest = scanInlineDestination(text, close + 2);
          if (dest) {
            makeLink(labelText, dest[0], dest[1]);
            i = dest[2];
          } else {
            pending += c;
            i++;
          }
        } else {
          let refLabel = labelText;
          let consumedTo = close + 1;
          if (close + 1 < n && text[close + 1] === '[') {
            const r2 = matchBracket(text, close + 1);
            if (r2 > 0) {
              const inner = text.slice(close + 2, r2);
              refLabel = inner.trim() === '' ? labelText : inner;
              consumedTo = r2 + 1;
            }
          }
          const found = refs.get(normLabel(refLabel));
          if (found !== undefined) {
            makeLink(labelText, found[0], found[1]);
            i = consumedTo;
          } else {
            pending += c;
            i++;
          }
        }
      }
    } else if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && text[j] === c) j++;
      const runLen = j - i;
      const before = prevChar();
      const after = j < n ? text[j]! : ' ';
      const beforeWs = isWs(before);
      const afterWs = isWs(after);
      const beforePunct = isAsciiPunct(before);
      const afterPunct = isAsciiPunct(after);
      const leftFlank = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlank = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen: boolean;
      let canClose: boolean;
      if (c === '_') {
        canOpen = leftFlank && (!rightFlank || beforePunct);
        canClose = rightFlank && (!leftFlank || afterPunct);
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      flush();
      if (c === '~' && runLen !== 2) {
        toks.push({ kind: 'node', node: { k: 'text', v: repeatChar(c, runLen) } });
      } else {
        toks.push({ kind: 'delim', ch: c, count: runLen, canOpen, canClose, active: true });
      }
      i = j;
    } else if (c === '\n') {
      const s = pending;
      const trimmedEnd = trimEndChars(s, ' ');
      const hard = s.length - trimmedEnd.length >= 2;
      pending = trimmedEnd;
      flush();
      toks.push({ kind: 'node', node: hard ? { k: 'hard' } : { k: 'soft' } });
      i++;
    } else if (
      (c === 'h' || c === 'w') &&
      (i === 0 || isWs(prevChar()) || '(*_~'.includes(prevChar()))
    ) {
      const ba = scanBareAutolink(text, i);
      if (ba) {
        flush();
        toks.push({ kind: 'node', node: ba[0] });
        i = ba[1];
      } else {
        pending += c;
        i++;
      }
    } else {
      pending += c;
      i++;
    }
  }
  flush();
  return toks;
}

function processEmphasis(toks: Tok[]): Inline[] {
  let closerIdx = 0;
  while (closerIdx < toks.length) {
    const closer = toks[closerIdx]!;
    if (!(closer.kind === 'delim' && closer.canClose && closer.active && closer.count > 0)) {
      closerIdx++;
      continue;
    }
    let openerIdx = closerIdx - 1;
    let found = -1;
    while (openerIdx >= 0 && found < 0) {
      const o = toks[openerIdx]!;
      if (o.kind === 'delim' && o.ch === closer.ch && o.canOpen && o.active && o.count > 0) {
        let sumOk: boolean;
        if ((o.canClose || closer.canOpen) && closer.ch !== '~')
          sumOk =
            (o.count + closer.count) % 3 !== 0 || (o.count % 3 === 0 && closer.count % 3 === 0);
        else sumOk = true;
        if (sumOk) found = openerIdx;
        else openerIdx--;
      } else openerIdx--;
    }
    if (found < 0) {
      if (!closer.canOpen) {
        toks[closerIdx] = {
          kind: 'node',
          node: { k: 'text', v: repeatChar(closer.ch, closer.count) },
        };
      }
      closerIdx++;
      continue;
    }
    const opener = toks[found]!;
    if (opener.kind !== 'delim') {
      closerIdx++;
      continue;
    }
    let useCount: number;
    if (closer.ch === '~') useCount = 2;
    else if (opener.count >= 2 && closer.count >= 2) useCount = 2;
    else useCount = 1;
    const inner: Inline[] = [];
    for (let k = found + 1; k < closerIdx; k++) {
      const tk = toks[k]!;
      if (tk.kind === 'node') inner.push(tk.node);
      else if (tk.kind === 'delim' && tk.count > 0)
        inner.push({ k: 'text', v: repeatChar(tk.ch, tk.count) });
    }
    const wrapped: Inline =
      closer.ch === '~'
        ? { k: 'strike', c: inner }
        : useCount === 2
          ? { k: 'strong', c: inner }
          : { k: 'emph', c: inner };
    opener.count -= useCount;
    closer.count -= useCount;
    const rebuilt: Tok[] = [];
    for (let k = 0; k < found; k++) rebuilt.push(toks[k]!);
    if (opener.count > 0)
      rebuilt.push({ kind: 'node', node: { k: 'text', v: repeatChar(opener.ch, opener.count) } });
    rebuilt.push({ kind: 'node', node: wrapped });
    if (closer.count > 0)
      rebuilt.push({ kind: 'node', node: { k: 'text', v: repeatChar(closer.ch, closer.count) } });
    for (let k = closerIdx + 1; k < toks.length; k++) rebuilt.push(toks[k]!);
    toks.length = 0;
    toks.push(...rebuilt);
    closerIdx = found;
  }
  const result: Inline[] = [];
  for (const t of toks) {
    if (t.kind === 'node') result.push(t.node);
    else if (t.kind === 'delim' && t.count > 0)
      result.push({ k: 'text', v: repeatChar(t.ch, t.count) });
  }
  return result;
}

function parseInlines(refs: Refs, text: string): Inline[] {
  return processEmphasis(tokenize(refs, text));
}

const renderInline = (refs: Refs, text: string): string => renderInlines(parseInlines(refs, text));

// ─── Block parsing ─────────────────────────────────────────────────────────

interface ListItem {
  task: boolean | null;
  blocks: Block[];
}
type Block =
  | { t: 'heading'; level: number; text: string }
  | { t: 'paragraph'; text: string }
  | { t: 'hr' }
  | { t: 'fenced'; lang: string; content: string }
  | { t: 'indented'; content: string }
  | { t: 'blockquote'; blocks: Block[] }
  | { t: 'bullet'; tight: boolean; items: ListItem[] }
  | { t: 'ordered'; start: number; tight: boolean; items: ListItem[] }
  | { t: 'table'; headers: string[]; aligns: string[]; rows: string[][] };

const leadingIndent = (s: string): number => {
  let n = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ') {
      n++;
      i++;
    } else if (s[i] === '\t') {
      n += 4 - (n % 4);
      i++;
    } else break;
  }
  return n;
};
const isBlank = (s: string): boolean => s.trim() === '';
const isThematicBreak = (line: string): boolean => {
  const t = line.trim().replaceAll(' ', '').replaceAll('\t', '');
  return (
    t.length >= 3 &&
    ([...t].every((c) => c === '-') ||
      [...t].every((c) => c === '*') ||
      [...t].every((c) => c === '_'))
  );
};

const tryAtxHeading = (line: string): [number, string] | null => {
  if (leadingIndent(line) >= 4) return null;
  const t = trimStartChars(line, ' ');
  let lvl = 0;
  while (lvl < t.length && lvl < 7 && t[lvl] === '#') lvl++;
  if (lvl === 0 || lvl > 6) return null;
  if (lvl < t.length && t[lvl] !== ' ' && t[lvl] !== '\t') return null;
  const body = t.slice(lvl).trim();
  const stripped = trimEndChars(trimEndChars(body, '#'), ' \t');
  const final = body !== '' && [...body].every((c) => c === '#') ? '' : stripped;
  return [lvl, final];
};

const parseAlignRow = (line: string): string[] | null => {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return null;
  const body = trimChars(trimmed, '|');
  const cells = body.split('|').map((s) => s.trim());
  if (cells.length === 0) return null;
  const aligns: string[] = [];
  for (const core of cells) {
    if (core === '') return null;
    const left = core.startsWith(':');
    const right = core.endsWith(':');
    const dashes = trimChars(core, ':');
    if (dashes === '' || ![...dashes].every((c) => c === '-')) return null;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : 'none');
  }
  return aligns;
};

const splitTableRow = (line: string): string[] => {
  const t = line.trim();
  const body = t.startsWith('|') ? t.slice(1) : t;
  const body2 = body.endsWith('|') && !body.endsWith('\\|') ? body.slice(0, body.length - 1) : body;
  const cells: string[] = [];
  let buf = '';
  let i = 0;
  while (i < body2.length) {
    const c = body2[i];
    if (c === '\\' && i + 1 < body2.length && body2[i + 1] === '|') {
      buf += '|';
      i += 2;
    } else if (c === '|') {
      cells.push(buf.trim());
      buf = '';
      i++;
    } else {
      buf += c;
      i++;
    }
  }
  cells.push(buf.trim());
  return cells;
};

const splitWs = (s: string): string[] => {
  const idx = indexOfAny(s, ' \t');
  return idx < 0 ? [s] : [s.slice(0, idx), s.slice(idx + 1)];
};

const extractRefDefs = (lines: string[]): [Refs, string[]] => {
  const refs: Refs = new Map();
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    let handled = false;
    if (t.startsWith('[') && leadingIndent(line) < 4) {
      const close = t.indexOf(']');
      if (close > 1 && close + 1 < t.length && t[close + 1] === ':') {
        const label = t.slice(1, close);
        const rest = t.slice(close + 2).trim();
        if (rest !== '' && !label.includes(']')) {
          const spaceIdx = indexOfAny(rest, ' \t');
          const url = spaceIdx < 0 ? rest : rest.slice(0, spaceIdx);
          const titlePart = spaceIdx < 0 ? '' : rest.slice(spaceIdx).trim();
          const urlClean =
            url.startsWith('<') && url.endsWith('>') ? url.slice(1, url.length - 1) : url;
          let title: string | null = null;
          if (titlePart.length >= 2 && (titlePart[0] === '"' || titlePart[0] === "'")) {
            const q = titlePart[0];
            const tc = titlePart.indexOf(q, 1);
            if (tc > 0) title = titlePart.slice(1, tc);
          }
          refs.set(normLabel(label), [urlClean, title]);
          handled = true;
        }
      }
    }
    if (!handled) kept.push(line);
  }
  return [refs, kept];
};

const isListMarker = (s: string): boolean => {
  if (s === '') return false;
  if ('-*+'.includes(s[0]!) && s.length >= 2 && (s[1] === ' ' || s[1] === '\t')) return true;
  let k = 0;
  while (k < s.length && k < 9 && isDigit(s[k]!)) k++;
  return (
    k > 0 &&
    k + 1 < s.length &&
    (s[k] === '.' || s[k] === ')') &&
    (s[k + 1] === ' ' || s[k + 1] === '\t')
  );
};

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (isThematicBreak(line) && tryAtxHeading(line) === null) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    const atx = tryAtxHeading(line);
    if (atx !== null) {
      blocks.push({ t: 'heading', level: atx[0], text: atx[1] });
      i++;
      continue;
    }
    const indent = leadingIndent(line);
    const trimmedStart = trimStartChars(line, ' \t');
    if (trimmedStart.startsWith('```') || trimmedStart.startsWith('~~~')) {
      const fence = trimmedStart.startsWith('```') ? '```' : '~~~';
      const info = trimmedStart.slice(3).trim();
      const lang = info === '' ? '' : splitWs(info)[0]!;
      const content: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < n && !closed) {
        const ln = lines[j]!;
        if (
          trimStartChars(ln, ' \t').startsWith(fence) &&
          trimEndChars(ln.trim(), fence[0]!) === ''
        ) {
          closed = true;
          j++;
        } else {
          content.push(ln);
          j++;
        }
      }
      blocks.push({ t: 'fenced', lang, content: content.join('\n') });
      i = j;
    } else if (indent >= 4) {
      const content: string[] = [];
      let j = i;
      while (j < n && (leadingIndent(lines[j]!) >= 4 || isBlank(lines[j]!))) {
        const ln = lines[j]!;
        content.push(isBlank(ln) ? '' : ln.slice(Math.min(4, ln.length)));
        j++;
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      blocks.push({ t: 'indented', content: content.join('\n') });
      i = j;
    } else if (trimmedStart.startsWith('>')) {
      const inner: string[] = [];
      let j = i;
      while (j < n && trimStartChars(lines[j]!, ' \t').startsWith('>')) {
        const ln = trimStartChars(lines[j]!, ' \t').slice(1);
        inner.push(ln.startsWith(' ') ? ln.slice(1) : ln);
        j++;
      }
      blocks.push({ t: 'blockquote', blocks: parseBlocks(inner) });
      i = j;
    } else if (
      line.includes('|') &&
      i + 1 < n &&
      parseAlignRow(lines[i + 1]!) !== null &&
      parseAlignRow(lines[i + 1]!)!.length === splitTableRow(line).length
    ) {
      const headers = splitTableRow(line);
      const aligns = parseAlignRow(lines[i + 1]!)!;
      const rows: string[][] = [];
      let j = i + 2;
      while (j < n && !isBlank(lines[j]!) && lines[j]!.includes('|')) {
        rows.push(splitTableRow(lines[j]!));
        j++;
      }
      blocks.push({ t: 'table', headers, aligns, rows });
      i = j;
    } else if (isListMarker(trimmedStart)) {
      const [listBlock, nxt] = parseList(lines, i);
      blocks.push(listBlock);
      i = nxt;
    } else {
      const para: string[] = [];
      let j = i;
      let stop = false;
      let setext = 0;
      while (j < n && !stop) {
        const ln = lines[j]!;
        if (isBlank(ln)) stop = true;
        else if (
          j > i &&
          leadingIndent(ln) < 4 &&
          ln.trim() !== '' &&
          ([...ln.trim()].every((c) => c === '=') || [...ln.trim()].every((c) => c === '-'))
        ) {
          setext = ln.trim()[0] === '=' ? 1 : 2;
          stop = true;
          j++;
        } else if (
          j > i &&
          (isThematicBreak(ln) ||
            tryAtxHeading(ln) !== null ||
            trimStartChars(ln, ' ').startsWith('>') ||
            isListMarker(trimStartChars(ln, ' \t')))
        ) {
          stop = true;
        } else {
          para.push(trimStartChars(ln, ' \t'));
          j++;
        }
      }
      const text = trimEndChars(para.join('\n'), ' \t\n');
      if (setext > 0 && text !== '') blocks.push({ t: 'heading', level: setext, text });
      else if (text !== '') blocks.push({ t: 'paragraph', text });
      i = j;
    }
  }
  return blocks;
}

function parseList(lines: string[], start: number): [Block, number] {
  const n = lines.length;
  const first = trimStartChars(lines[start]!, ' \t');
  const ordered = isDigit(first[0]!);
  let startNum = 1;
  if (ordered) {
    let k = 0;
    while (k < first.length && isDigit(first[k]!)) k++;
    const parsed = parseInt(first.slice(0, k), 10);
    startNum = Number.isNaN(parsed) ? 1 : parsed;
  }
  const markerWidth = (s: string): number => {
    if (!ordered) return 2;
    let k = 0;
    while (k < s.length && isDigit(s[k]!)) k++;
    return k + 2;
  };
  const items: ListItem[] = [];
  let i = start;
  let tight = true;
  let sawBlankBetween = false;
  let go = true;
  while (go && i < n) {
    const raw = lines[i]!;
    const trimmed = trimStartChars(raw, ' \t');
    const baseIndent = leadingIndent(raw);
    if (isBlank(raw)) {
      sawBlankBetween = true;
      i++;
    } else if (isListMarker(trimmed) && ordered === isDigit(trimmed[0]!) && baseIndent < 4) {
      if (sawBlankBetween && items.length > 0) tight = false;
      sawBlankBetween = false;
      const contentOffset = baseIndent + markerWidth(trimmed);
      const mw = markerWidth(trimmed);
      const afterMarker = trimmed.length > mw ? trimmed.slice(mw) : '';
      let task: boolean | null;
      let firstContent: string;
      if (afterMarker.startsWith('[ ]')) {
        task = false;
        firstContent = trimStartChars(afterMarker.slice(3), ' ');
      } else if (afterMarker.startsWith('[x]') || afterMarker.startsWith('[X]')) {
        task = true;
        firstContent = trimStartChars(afterMarker.slice(3), ' ');
      } else {
        task = null;
        firstContent = afterMarker;
      }
      const itemLines: string[] = [firstContent];
      i++;
      let inItem = true;
      while (inItem && i < n) {
        const ln = lines[i]!;
        if (isBlank(ln)) {
          itemLines.push('');
          i++;
        } else if (leadingIndent(ln) >= contentOffset) {
          itemLines.push(ln.slice(Math.min(contentOffset, ln.length)));
          i++;
        } else if (isListMarker(trimStartChars(ln, ' \t')) && leadingIndent(ln) < 4) {
          inItem = false;
        } else if (leadingIndent(ln) > 0 && !isListMarker(trimStartChars(ln, ' \t'))) {
          itemLines.push(ln.trim());
          i++;
        } else {
          inItem = false;
        }
      }
      while (itemLines.length > 0 && itemLines[itemLines.length - 1] === '') {
        itemLines.pop();
        sawBlankBetween = true;
      }
      if (itemLines.some((ln) => ln === '')) tight = false;
      items.push({ task, blocks: parseBlocks(itemLines) });
    } else {
      go = false;
    }
  }
  const block: Block = ordered
    ? { t: 'ordered', start: startNum, tight, items }
    : { t: 'bullet', tight, items };
  return [block, i];
}

// ─── Block rendering ────────────────────────────────────────────────────────

const alignAttr = (a: string): string =>
  a === 'left'
    ? ' align="left"'
    : a === 'center'
      ? ' align="center"'
      : a === 'right'
        ? ' align="right"'
        : '';

function renderBlocks(refs: Refs, blocks: Block[]): string {
  let out = '';
  for (const b of blocks) out += renderBlock(refs, b);
  return out;
}

function renderBlock(refs: Refs, b: Block): string {
  switch (b.t) {
    case 'hr':
      return '<hr />\n';
    case 'heading':
      return '<h' + b.level + '>' + renderInline(refs, b.text) + '</h' + b.level + '>\n';
    case 'paragraph':
      return '<p>' + renderInline(refs, b.text) + '</p>\n';
    case 'fenced': {
      const cls = b.lang === '' ? '' : ' class="language-' + escapeHtml(b.lang) + '"';
      return '<pre><code' + cls + '>' + escapeHtml(b.content) + '\n</code></pre>\n';
    }
    case 'indented':
      return '<pre><code>' + escapeHtml(b.content) + '\n</code></pre>\n';
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(refs, b.blocks) + '</blockquote>\n';
    case 'table': {
      let out = '<table class="fuaran-table"><thead><tr>';
      b.headers.forEach((h, idx) => {
        const a = idx < b.aligns.length ? b.aligns[idx]! : 'none';
        out +=
          '<th class="fuaran-table-header"' + alignAttr(a) + '>' + renderInline(refs, h) + '</th>';
      });
      out += '</tr></thead><tbody>';
      for (const row of b.rows) {
        out += '<tr class="fuaran-table-row">';
        for (let idx = 0; idx < b.headers.length; idx++) {
          const cell = idx < row.length ? row[idx]! : '';
          const a = idx < b.aligns.length ? b.aligns[idx]! : 'none';
          out +=
            '<td class="fuaran-table-cell"' +
            alignAttr(a) +
            '>' +
            renderInline(refs, cell) +
            '</td>';
        }
        out += '</tr>';
      }
      out += '</tbody></table>\n';
      return out;
    }
    case 'bullet':
      return '<ul>\n' + renderItems(refs, b.tight, b.items) + '</ul>\n';
    case 'ordered': {
      const startAttr = b.start === 1 ? '' : ' start="' + b.start + '"';
      return '<ol' + startAttr + '>\n' + renderItems(refs, b.tight, b.items) + '</ol>\n';
    }
  }
}

function renderItems(refs: Refs, tight: boolean, items: ListItem[]): string {
  let out = '';
  for (const item of items) {
    let checkbox: string;
    if (item.task === null) checkbox = '';
    else if (item.task === false)
      checkbox = '<input class="fuaran-task-checkbox" disabled="" type="checkbox" /> ';
    else
      checkbox = '<input class="fuaran-task-checkbox" checked="" disabled="" type="checkbox" /> ';
    const liClass = item.task !== null ? ' class="fuaran-task-item"' : '';
    if (tight) {
      let inner = '';
      for (const blk of item.blocks) {
        if (blk.t === 'paragraph') inner += renderInline(refs, blk.text);
        else inner += '\n' + renderBlock(refs, blk);
      }
      out += '<li' + liClass + '>' + checkbox + inner + '</li>\n';
    } else {
      out += '<li' + liClass + '>\n' + checkbox + renderBlocks(refs, item.blocks) + '</li>\n';
    }
  }
  return out;
}

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Render GFM markdown `source` to deterministic, cross-host HTML — byte-identical
 * to the F# and Python hosts (verified against the shared markdown corpus).
 * Escaped by construction; the result still passes through `sanitizeMarkdownHtml`.
 */
export const toHtml = (source: string): string => {
  if (!source) return '';
  const normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const rawLines = normalized.split('\n');
  const [refs, lines] = extractRefDefs(rawLines);
  const blocks = parseBlocks(lines);
  const html = renderBlocks(refs, blocks);
  return sanitizeMarkdownHtml(html);
};
