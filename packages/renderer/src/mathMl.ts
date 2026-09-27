// Phase 658 — the deterministic LaTeX→MathML translator for the `Math` primitive.
//
// A pure, total function, byte-for-byte port of the F# `Fuaran.UI.Renderer.MathMl`
// module. It is shared by BOTH TypeScript renderers — the React client renderer
// (`@fuaran-ui/renderer`) and the string server renderer (`@fuaran-ui/renderer-server`,
// which imports `mathMl` from here, mirroring how it imports `drawingSvg`). The
// shared byte oracle is the fixture table in `fuaran-dotnet/docs/MATH-DEGRADATION.md`,
// pinned in `test/mathMl.test.ts` against the SAME strings the F# tests pin.
//
// It implements a small, CLOSED expression subset (superscript / subscript / the
// four operators + `=` / parentheses / identifiers / numbers / `\frac` / a fixed
// Greek table; Phase 1853 adds fixed tables of logic / relation / set operators,
// three symbol constants, named terms (`\mathit` / `\mathrm` / `\text`), `,` `.`
// `|`, fixed spacing, and the `[ ]` / `\{ \}` fences). In-subset input translates
// to native MathML that every modern
// browser lays out with real superscripts WITHOUT JavaScript; out-of-subset input
// returns `null`, and the renderer falls back to the raw-source span. It NEVER
// throws on any input (the never-crash rule). No randomness, no clock, no
// environment dependence. The in-subset alphabet contains no `<`, `>`, or `&`, so
// the emitted MathML never needs HTML-escaping by construction; the only character
// references it ever emits are the two fixed, complete `&lt;` / `&gt;` table
// entries for `\lt` / `\gt`.

type MathDisplay = 'Block' | 'Inline';

// Greek command table (closed set — see the design doc).
const GREEK: Readonly<Record<string, string>> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  phi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
};

// Operator command table → `<mo>` (closed set — Phase 1853, see the design doc).
// Logic, relations and set operators. `\lt` / `\gt` are the ONLY entries whose
// value is markup-significant: they are fixed, pre-escaped character references,
// so the emitted alphabet still never carries a bare `<`, `>` or `&` (the
// escaping-floor closure argument in the design doc).
const OPERATOR: Readonly<Record<string, string>> = {
  forall: '∀',
  exists: '∃',
  neg: '¬',
  lnot: '¬',
  land: '∧',
  wedge: '∧',
  lor: '∨',
  vee: '∨',
  Rightarrow: '⇒',
  implies: '⇒',
  Leftrightarrow: '⇔',
  iff: '⇔',
  to: '→',
  rightarrow: '→',
  mapsto: '↦',
  vdash: '⊢',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  equiv: '≡',
  in: '∈',
  notin: '∉',
  subseteq: '⊆',
  subset: '⊂',
  cup: '∪',
  cap: '∩',
  times: '×',
  cdot: '⋅',
  lt: '&lt;',
  gt: '&gt;',
};

// Symbol constants → `<mi>` (closed set — Phase 1853). Ordinary symbols, not
// operators, so they are atoms and may carry scripts.
const SYMBOL: Readonly<Record<string, string>> = {
  top: '⊤',
  bot: '⊥',
  emptyset: '∅',
};

// Spacing commands → `<mspace>` with a fixed width (closed set — Phase 1853).
// `\,` `\:` `\;` are LaTeX's 3/18, 4/18 and 5/18 em; `\ ` is the interword
// space; `\quad` is 1em.
const SPACE: Readonly<Record<string, string>> = {
  ',': '0.1667em',
  ':': '0.2222em',
  ';': '0.2778em',
  ' ': '0.3333em',
  quad: '1em',
};

// A table lookup that sees ONLY the table's own entries. A bare `table[name]`
// would also answer for inherited members (`\constructor`, `\toString`,
// `\valueOf`), emitting a function's source text where the F# `match` — and the
// design doc — say "out of subset".
const lookup = (table: Readonly<Record<string, string>>, name: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;

// Parser state — a mutable index + failure flag over the source string.
// Structurally mirrors the F# `P` record so byte-identity is obvious.
interface P {
  readonly src: string;
  readonly len: number;
  i: number;
  ok: boolean;
}

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isLetter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

// the named-term argument alphabet (`\mathit` / `\mathrm` / `\text`), besides the
// escaped underscore `\_`
const isNameChar = (c: string): boolean => isLetter(c) || isDigit(c);

const skipWs = (p: P): void => {
  while (
    p.i < p.len &&
    (p.src[p.i] === ' ' || p.src[p.i] === '\t' || p.src[p.i] === '\n' || p.src[p.i] === '\r')
  ) {
    p.i += 1;
  }
};

const fail = (p: P): string => {
  p.ok = false;
  return '';
};

// true when the source continues with `s` at the current index
const startsAt = (p: P, s: string): boolean =>
  p.i + s.length <= p.len && p.src.slice(p.i, p.i + s.length) === s;

// The command at `p.i` (which holds a `\`): its name and the index just past it.
// The name is a run of ASCII letters, or else exactly one non-letter character (a
// control symbol such as `\,` or `\{`); a bare trailing `\` has the empty name.
// Does not consume.
const commandAt = (p: P): [string, number] => {
  const start = p.i + 1;
  if (start >= p.len) return ['', start];
  if (isLetter(p.src[start]!)) {
    let j = start;
    while (j < p.len && isLetter(p.src[j]!)) j += 1;
    return [p.src.slice(start, j), j];
  }
  return [p.src[start]!, start + 1];
};

// A named-term argument: `{` + one or more of [A-Za-z0-9] or the escaped underscore
// `\_` (emitted as `_`) + `}`, nothing else (no whitespace inside; a bare `_` is a
// subscript in LaTeX, so it is out of subset here rather than read differently from
// the KaTeX tier). Returns the argument text, or fails.
const parseNameArg = (p: P): string => {
  skipWs(p);
  if (!p.ok || p.i >= p.len || p.src[p.i] !== '{') return fail(p);
  let arg = '';
  let j = p.i + 1;
  let scanning = true;
  while (scanning && j < p.len) {
    if (isNameChar(p.src[j]!)) {
      arg += p.src[j]!;
      j += 1;
    } else if (p.src[j] === '\\' && j + 1 < p.len && p.src[j + 1] === '_') {
      arg += '_';
      j += 2;
    } else {
      scanning = false;
    }
  }
  if (arg.length === 0 || j >= p.len || p.src[j] !== '}') return fail(p);
  p.i = j + 1;
  return arg;
};

// atom without scripts
const parseAtom = (p: P): string => {
  skipWs(p);
  if (!p.ok || p.i >= p.len) return fail(p);
  const c = p.src[p.i]!;

  if (isDigit(c)) {
    const start = p.i;
    while (p.i < p.len && isDigit(p.src[p.i]!)) p.i += 1;
    // one optional decimal point, only when a digit follows it
    if (p.i + 1 < p.len && p.src[p.i] === '.' && isDigit(p.src[p.i + 1]!)) {
      p.i += 1;
      while (p.i < p.len && isDigit(p.src[p.i]!)) p.i += 1;
    }
    return `<mn>${p.src.slice(start, p.i)}</mn>`;
  }

  if (isLetter(c)) {
    p.i += 1;
    return `<mi>${c}</mi>`;
  }

  if (c === '{') {
    p.i += 1;
    const [inner, count] = parseSequence(p, '}');
    if (!p.ok || !startsAt(p, '}') || count === 0) return fail(p);
    p.i += 1;
    // a `{…}` group is invisible: one element stands bare, several are one
    // `<mrow>` (so a script / fraction argument is ONE child)
    return count === 1 ? inner : `<mrow>${inner}</mrow>`;
  }

  if (c === '(') {
    p.i += 1;
    return parseFenced(p, ')', '(', ')');
  }

  if (c === '[') {
    p.i += 1;
    return parseFenced(p, ']', '[', ']');
  }

  if (c === '\\') {
    const [name, next] = commandAt(p);
    p.i = next;
    if (name === '{') return parseFenced(p, '\\}', '{', '}');
    if (name === 'frac') {
      const num = parseAtom(p);
      const den = parseAtom(p);
      if (!p.ok) return fail(p);
      return `<mfrac>${num}${den}</mfrac>`;
    }
    if (name === 'mathit') {
      const arg = parseNameArg(p);
      return p.ok ? `<mi mathvariant="italic">${arg}</mi>` : fail(p);
    }
    if (name === 'mathrm') {
      const arg = parseNameArg(p);
      return p.ok ? `<mi mathvariant="normal">${arg}</mi>` : fail(p);
    }
    if (name === 'text') {
      const arg = parseNameArg(p);
      return p.ok ? `<mtext>${arg}</mtext>` : fail(p);
    }
    const g = lookup(GREEK, name);
    if (g !== undefined) return `<mi>${g}</mi>`;
    const s = lookup(SYMBOL, name);
    return s !== undefined ? `<mi>${s}</mi>` : fail(p);
  }

  return fail(p);
};

// a fenced group, its opener already consumed: a sequence up to `close`, which must
// be present → `<mrow><mo>{openMo}</mo>…<mo>{closeMo}</mo></mrow>`
const parseFenced = (p: P, close: string, openMo: string, closeMo: string): string => {
  const [inner] = parseSequence(p, close);
  if (!p.ok || !startsAt(p, close)) return fail(p);
  p.i += close.length;
  return `<mrow><mo>${openMo}</mo>${inner}<mo>${closeMo}</mo></mrow>`;
};

// atom + optional sub/super scripts (either order, at most one of each)
const parseScripted = (p: P): string => {
  const baseAtom = parseAtom(p);
  if (!p.ok) return fail(p);

  let sub = '';
  let sup = '';
  let hasSub = false;
  let hasSup = false;
  let looping = true;

  while (looping && p.ok) {
    skipWs(p);
    if (p.i < p.len && p.src[p.i] === '^' && !hasSup) {
      p.i += 1;
      sup = parseAtom(p);
      hasSup = true;
    } else if (p.i < p.len && p.src[p.i] === '_' && !hasSub) {
      p.i += 1;
      sub = parseAtom(p);
      hasSub = true;
    } else {
      looping = false;
    }
  }

  if (!p.ok) return fail(p);
  if (hasSub && hasSup) return `<msubsup>${baseAtom}${sub}${sup}</msubsup>`;
  if (hasSup) return `<msup>${baseAtom}${sup}</msup>`;
  if (hasSub) return `<msub>${baseAtom}${sub}</msub>`;
  return baseAtom;
};

// a run of atoms/operators until end-of-input or an unconsumed `stop` string, with
// the number of elements it holds. `stop = ''` means "to end-of-input" (no closing
// delimiter expected).
const parseSequence = (p: P, stop: string): [string, number] => {
  const parts: string[] = [];
  let looping = true;

  while (looping && p.ok) {
    skipWs(p);
    if (p.i >= p.len) {
      // ran out: a failure iff we were expecting a closing `stop`
      if (stop !== '') fail(p);
      looping = false;
    } else if (stop !== '' && startsAt(p, stop)) {
      looping = false; // leave `stop` unconsumed for the caller
    } else {
      const c = p.src[p.i]!;
      if (c === '+') {
        parts.push('<mo>+</mo>');
        p.i += 1;
      } else if (c === '-') {
        parts.push('<mo>−</mo>');
        p.i += 1;
      } else if (c === '*') {
        parts.push('<mo>⋅</mo>');
        p.i += 1;
      } else if (c === '/') {
        parts.push('<mo>/</mo>');
        p.i += 1;
      } else if (c === '=') {
        parts.push('<mo>=</mo>');
        p.i += 1;
      } else if (c === ',') {
        parts.push('<mo separator="true">,</mo>');
        p.i += 1;
      } else if (c === '.') {
        // the quantifier dot. A `.` directly followed by a digit that the number
        // rule did not consume (`.5`, `x.5`, `1.2.3`) is out of subset.
        if (p.i + 1 < p.len && isDigit(p.src[p.i + 1]!)) {
          fail(p);
          looping = false;
        } else {
          parts.push('<mo>.</mo>');
          p.i += 1;
        }
      } else if (c === '|') {
        parts.push('<mo>|</mo>');
        p.i += 1;
      } else if (c === ')' || c === '}' || c === ']') {
        // an unmatched closer (the matched case is handled by `stop`)
        fail(p);
        looping = false;
      } else if (c === '\\') {
        const [name, next] = commandAt(p);
        const op = lookup(OPERATOR, name);
        const width = op === undefined ? lookup(SPACE, name) : undefined;
        if (op !== undefined) {
          parts.push(`<mo>${op}</mo>`);
          p.i = next;
        } else if (width !== undefined) {
          parts.push(`<mspace width="${width}"></mspace>`);
          p.i = next;
        } else if (name === '}') {
          // an unmatched `\}`
          fail(p);
          looping = false;
        } else {
          parts.push(parseScripted(p));
        }
      } else {
        parts.push(parseScripted(p));
      }
    }
  }

  return p.ok ? [parts.join(''), parts.length] : ['', 0];
};

/**
 * Translate a LaTeX `source` in the closed subset (see
 * `fuaran-dotnet/docs/MATH-DEGRADATION.md`) to a native MathML fragment string, or `null`
 * when the input is outside the subset (the renderer then falls back to the
 * raw-source span). Total — never throws on any input.
 */
export const mathMl = (source: string, display: MathDisplay): string | null => {
  const p: P = { src: source, len: source.length, i: 0, ok: true };
  const [body] = parseSequence(p, '');
  if (!p.ok || p.i < p.len || body === '') return null;
  const disp = display === 'Block' ? 'block' : 'inline';
  return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${disp}">${body}</math>`;
};
