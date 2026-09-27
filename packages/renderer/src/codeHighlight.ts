// Phase 1854 — the deterministic highlighting tier for the `CodeBlock` primitive.
//
// A pure, total function, byte-for-byte port of the F#
// `Fuaran.UI.Renderer.CodeHighlight` module. It is shared by BOTH TypeScript
// renderers — the React client renderer (`@fuaran-ui/renderer`) and the string
// server renderer (`@fuaran-ui/renderer-server`, which imports `codeHighlight`
// from here, as it imports `mathMl`). The shared byte oracle is the fixture
// table in `fuaran-dotnet/docs/CODE-HIGHLIGHT.md` §5, pinned in
// `test/codeHighlight.test.ts` against the SAME strings the F# tests pin.
//
// LEXICAL, not a parser: each grammar is a fixed keyword table, a fixed type
// table and two string-form switches over one shared ML-family lexical core. No
// regular expression is used: every decision compares UTF-16 code units, which
// JS and .NET index identically. Output is class-only `tok-*` spans around
// `& < >`-escaped text; no span ever contains a line break. A language with no
// grammar returns `null` and the renderer keeps its escaped text unchanged.

/** The `data-highlighted` value a highlighted `<code>` carries. */
export const CODE_HIGHLIGHT_TIER = 'deterministic';

export interface CodeGrammar {
  readonly name: string;
  readonly keywords: ReadonlySet<string>;
  readonly types: ReadonlySet<string>;
  readonly tripleQuotedStrings: boolean;
  readonly verbatimStrings: boolean;
}

export const FSTAR: CodeGrammar = {
  name: 'fstar',
  keywords: new Set([
    'abstract',
    'and',
    'as',
    'assert',
    'assert_norm',
    'assume',
    'attributes',
    'begin',
    'by',
    'calc',
    'class',
    'decreases',
    'effect',
    'else',
    'end',
    'ensures',
    'exception',
    'exists',
    'false',
    'forall',
    'friend',
    'fun',
    'function',
    'if',
    'in',
    'include',
    'inline',
    'inline_for_extraction',
    'instance',
    'introduce',
    'irreducible',
    'layered_effect',
    'let',
    'logic',
    'match',
    'module',
    'new',
    'new_effect',
    'noeq',
    'noextract',
    'of',
    'open',
    'opaque',
    'private',
    'rec',
    'reflectable',
    'reifiable',
    'reify',
    'requires',
    'returns',
    'sub_effect',
    'then',
    'total',
    'true',
    'try',
    'type',
    'unfold',
    'unopteq',
    'val',
    'when',
    'with',
  ]),
  types: new Set([
    'Div',
    'Dv',
    'GTot',
    'Ghost',
    'Lemma',
    'ML',
    'Pure',
    'ST',
    'Stack',
    'Tot',
    'Type',
    'Type0',
    'Type1',
    'bool',
    'int',
    'list',
    'nat',
    'option',
    'pos',
    'prop',
    'squash',
    'string',
    'unit',
  ]),
  tripleQuotedStrings: false,
  verbatimStrings: false,
};

export const FSHARP: CodeGrammar = {
  name: 'fsharp',
  keywords: new Set([
    'abstract',
    'and',
    'as',
    'assert',
    'base',
    'begin',
    'class',
    'const',
    'default',
    'delegate',
    'do',
    'done',
    'downcast',
    'downto',
    'elif',
    'else',
    'end',
    'exception',
    'extern',
    'false',
    'finally',
    'fixed',
    'for',
    'fun',
    'function',
    'global',
    'if',
    'in',
    'inherit',
    'inline',
    'interface',
    'internal',
    'lazy',
    'let',
    'match',
    'member',
    'module',
    'mutable',
    'namespace',
    'new',
    'null',
    'of',
    'open',
    'or',
    'override',
    'private',
    'public',
    'rec',
    'return',
    'static',
    'struct',
    'then',
    'to',
    'true',
    'try',
    'type',
    'upcast',
    'use',
    'val',
    'when',
    'while',
    'with',
    'yield',
  ]),
  types: new Set([
    'array',
    'bool',
    'byte',
    'char',
    'decimal',
    'double',
    'exn',
    'float',
    'float32',
    'int',
    'int16',
    'int32',
    'int64',
    'int8',
    'list',
    'nativeint',
    'obj',
    'option',
    'sbyte',
    'seq',
    'single',
    'string',
    'uint',
    'uint16',
    'uint32',
    'uint64',
    'uint8',
    'unativeint',
    'unit',
    'voption',
  ]),
  tripleQuotedStrings: true,
  verbatimStrings: true,
};

// ASCII-only lowering (A-Z only) — no platform case table is consulted.
const asciiLower = (s: string): string => {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
};

/** The grammar a CodeBlock `language` tag selects, or `null` (plain output). */
export const codeGrammarFor = (language: string): CodeGrammar | null => {
  switch (asciiLower(language)) {
    case 'fstar':
    case 'fst':
      return FSTAR;
    case 'fsharp':
    case 'fs':
    case 'f#':
      return FSHARP;
    default:
      return null;
  }
};

// ─── The shared ML-family lexical core ──────────────────────────────────────

type Cls = '' | 'tok-kw' | 'tok-com' | 'tok-str' | 'tok-num' | 'tok-op' | 'tok-ty';

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isLetter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isIdentStart = (c: string): boolean => isLetter(c) || c === '_';
const isIdentChar = (c: string): boolean => isLetter(c) || isDigit(c) || c === '_' || c === "'";

// The operator-character table (CODE-HIGHLIGHT.md §2.6).
const OPERATOR_CHARS = '!$%&*+-/:<=>?@^|~\\';
const isOperatorChar = (c: string): boolean => c.length === 1 && OPERATOR_CHARS.indexOf(c) >= 0;

const startsAt = (s: string, i: number, p: string): boolean =>
  i + p.length <= s.length && s.substring(i, i + p.length) === p;

// The `& < >` text floor both renderers apply to text content.
const escape = (s: string): string => {
  let out = '';
  for (const c of s.split('')) {
    out += c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c;
  }
  return out;
};

// Emit one token's text, split at `\n` so no span ever contains a line break.
const emit = (cls: Cls, text: string): string => {
  const segments = text.split('\n');
  let out = '';
  for (let k = 0; k < segments.length; k++) {
    if (k > 0) out += '\n';
    const seg = segments[k] as string;
    if (seg !== '') {
      out += cls === '' ? escape(seg) : `<span class="${cls}">${escape(seg)}</span>`;
    }
  }
  return out;
};

const blockCommentEnd = (s: string, i: number): number => {
  const n = s.length;
  let depth = 1;
  let j = i + 2;
  while (j < n && depth > 0) {
    if (startsAt(s, j, '(*)')) j += 3;
    else if (startsAt(s, j, '*)')) {
      depth -= 1;
      j += 2;
    } else if (startsAt(s, j, '(*')) {
      depth += 1;
      j += 2;
    } else j += 1;
  }
  return j;
};

const lineCommentEnd = (s: string, i: number): number => {
  let j = i + 2;
  while (j < s.length && s[j] !== '\n') j += 1;
  return j;
};

const stringEnd = (s: string, i: number): number => {
  const n = s.length;
  let j = i + 1;
  let fin = false;
  while (j < n && !fin) {
    const c = s[j];
    if (c === '\\') j += 2;
    else if (c === '"') {
      j += 1;
      fin = true;
    } else j += 1;
  }
  return j > n ? n : j;
};

const verbatimEnd = (s: string, i: number): number => {
  const n = s.length;
  let j = i + 2;
  let fin = false;
  while (j < n && !fin) {
    if (s[j] === '"') {
      if (j + 1 < n && s[j + 1] === '"') j += 2;
      else {
        j += 1;
        fin = true;
      }
    } else j += 1;
  }
  return j;
};

const tripleEnd = (s: string, i: number): number => {
  const n = s.length;
  let j = i + 3;
  let fin = false;
  while (j < n && !fin) {
    if (startsAt(s, j, '"""')) {
      j += 3;
      fin = true;
    } else j += 1;
  }
  return j;
};

// 0 = not a character literal (the quote is plain text).
const charLiteralEnd = (s: string, i: number): number => {
  const n = s.length;
  if (i + 2 < n && s[i + 1] !== '\\' && s[i + 1] !== '\n' && s[i + 2] === "'") return i + 3;
  if (i + 1 < n && s[i + 1] === '\\') {
    let k = i + 3;
    let found = 0;
    while (found === 0 && k < n && k <= i + 11 && s[k - 1] !== '\n') {
      if (s[k] === "'") found = k + 1;
      k += 1;
    }
    return found;
  }
  return 0;
};

const numberEnd = (s: string, i: number): number => {
  const n = s.length;
  const isHex = s[i] === '0' && i + 1 < n && (s[i + 1] === 'x' || s[i + 1] === 'X');
  let j = i + 1;
  let fin = false;
  while (j < n && !fin) {
    const d = s[j] as string;
    if (isLetter(d) || isDigit(d) || d === '_') j += 1;
    else if (d === '.' && j + 1 < n && isDigit(s[j + 1] as string)) j += 2;
    else if (
      (d === '-' || d === '+') &&
      !isHex &&
      (s[j - 1] === 'e' || s[j - 1] === 'E') &&
      j + 1 < n &&
      isDigit(s[j + 1] as string)
    )
      j += 2;
    else fin = true;
  }
  return j;
};

const identEnd = (s: string, i: number): number => {
  let j = i + 1;
  while (j < s.length && isIdentChar(s[j] as string)) j += 1;
  return j;
};

const operatorEnd = (g: CodeGrammar, s: string, i: number): number => {
  let j = i + 1;
  while (
    j < s.length &&
    isOperatorChar(s[j] as string) &&
    !startsAt(s, j, '//') &&
    !(g.verbatimStrings && startsAt(s, j, '@"'))
  )
    j += 1;
  return j;
};

// The class and end of the token at `i`; the arm order is the normative
// precedence (CODE-HIGHLIGHT.md §2.1).
const tokenAt = (g: CodeGrammar, s: string, i: number): readonly [Cls, number] => {
  const c = s[i] as string;
  if (startsAt(s, i, '(*)')) return ['tok-op', i + 3];
  if (startsAt(s, i, '(*')) return ['tok-com', blockCommentEnd(s, i)];
  if (startsAt(s, i, '//')) return ['tok-com', lineCommentEnd(s, i)];
  if (g.tripleQuotedStrings && startsAt(s, i, '"""')) return ['tok-str', tripleEnd(s, i)];
  if (g.verbatimStrings && startsAt(s, i, '@"')) return ['tok-str', verbatimEnd(s, i)];
  if (c === '"') return ['tok-str', stringEnd(s, i)];
  if (c === "'") {
    const j = charLiteralEnd(s, i);
    return j === 0 ? ['', i + 1] : ['tok-str', j];
  }
  if (isDigit(c)) return ['tok-num', numberEnd(s, i)];
  if (isIdentStart(c)) {
    const j = identEnd(s, i);
    const word = s.substring(i, j);
    if (g.keywords.has(word)) return ['tok-kw', j];
    if (g.types.has(word)) return ['tok-ty', j];
    return ['', j];
  }
  if (isOperatorChar(c)) return ['tok-op', operatorEnd(g, s, i)];
  return ['', i + 1];
};

/**
 * Tokenise `code` under `g` and return the inner markup of the `<code>`
 * element: escaped text and class-only spans, adjacent same-class tokens
 * coalesced before the per-line split. Total and pure.
 */
export const codeHighlightWith = (g: CodeGrammar, code: string): string => {
  const n = code.length;
  let out = '';
  let i = 0;
  let runCls: Cls = '';
  let runStart = 0;
  while (i < n) {
    const [cls, j] = tokenAt(g, code, i);
    if (cls !== runCls) {
      if (i > runStart) out += emit(runCls, code.substring(runStart, i));
      runCls = cls;
      runStart = i;
    }
    i = j;
  }
  if (n > runStart) out += emit(runCls, code.substring(runStart, n));
  return out;
};

/**
 * The highlighted inner markup for a CodeBlock, or `null` when `language` has
 * no grammar — the renderer then emits its escaped text unchanged.
 */
export const codeHighlight = (language: string, code: string): string | null => {
  const g = codeGrammarFor(language);
  return g === null ? null : codeHighlightWith(g, code);
};
