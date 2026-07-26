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
// Greek table). In-subset input translates to native MathML that every modern
// browser lays out with real superscripts WITHOUT JavaScript; out-of-subset input
// returns `null`, and the renderer falls back to the raw-source span. It NEVER
// throws on any input (the never-crash rule). No randomness, no clock, no
// environment dependence. The in-subset alphabet contains no `<`, `>`, or `&`, so
// the emitted MathML never needs HTML-escaping by construction.

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
    const inner = parseSequence(p, '}');
    if (!p.ok || p.i >= p.len || p.src[p.i] !== '}') return fail(p);
    p.i += 1;
    return inner; // a `{…}` group is invisible; parseSequence already wrapped multi-child in <mrow>
  }

  if (c === '(') {
    p.i += 1;
    const inner = parseSequence(p, ')');
    if (!p.ok || p.i >= p.len || p.src[p.i] !== ')') return fail(p);
    p.i += 1;
    return `<mrow><mo>(</mo>${inner}<mo>)</mo></mrow>`;
  }

  if (c === '\\') {
    // a command: backslash + a run of letters
    const start = p.i + 1;
    let j = start;
    while (j < p.len && isLetter(p.src[j]!)) j += 1;
    const name = p.src.slice(start, j);
    p.i = j;
    if (name === 'frac') {
      const num = parseAtom(p);
      const den = parseAtom(p);
      if (!p.ok) return fail(p);
      return `<mfrac>${num}${den}</mfrac>`;
    }
    const g = GREEK[name];
    return g !== undefined ? `<mi>${g}</mi>` : fail(p);
  }

  return fail(p);
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

// a run of atoms/operators until end-of-input or an unconsumed `stop` char.
// `stop = ''` means "to end-of-input" (no closing delimiter expected).
const parseSequence = (p: P, stop: string): string => {
  const parts: string[] = [];
  let looping = true;

  while (looping && p.ok) {
    skipWs(p);
    if (p.i >= p.len) {
      // ran out: a failure iff we were expecting a closing `stop`
      if (stop !== '') fail(p);
      looping = false;
    } else {
      const c = p.src[p.i]!;
      if (stop !== '' && c === stop) {
        looping = false; // leave `stop` unconsumed for the caller
      } else if (c === '+') {
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
      } else if (c === ')' || c === '}') {
        // an unmatched closer (the matched case is handled by `c === stop`)
        fail(p);
        looping = false;
      } else {
        parts.push(parseScripted(p));
      }
    }
  }

  return p.ok ? parts.join('') : '';
};

/**
 * Translate a LaTeX `source` in the closed subset (see
 * `fuaran-dotnet/docs/MATH-DEGRADATION.md`) to a native MathML fragment string, or `null`
 * when the input is outside the subset (the renderer then falls back to the
 * raw-source span). Total — never throws on any input.
 */
export const mathMl = (source: string, display: MathDisplay): string | null => {
  const p: P = { src: source, len: source.length, i: 0, ok: true };
  const body = parseSequence(p, '');
  if (!p.ok || p.i < p.len || body === '') return null;
  const disp = display === 'Block' ? 'block' : 'inline';
  return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${disp}">${body}</math>`;
};
