// ============================================================================
//  Core twin — the canonical float layout (port of the Fuaran.Core wire
//  canonical number rule, WIRE_FORMAT.md §2 rule 5).
//
//  Moved here from @fuaran-ui/ops's encoder (Phase 1861), which re-exports both
//  functions unchanged. It lives inside the core-twins boundary because the
//  DataFrame evaluator's cell rendering depends on it, and the boundary imports
//  nothing from the host's domain packages. Pure: no imports at all.
// ============================================================================

/**
 * Render a finite double in .NET `Double.ToString("R", InvariantCulture)`
 * layout — the canonical numeric form mandated by WIRE_FORMAT.md §2 rule 5.
 *
 * Both runtimes compute the SAME shortest round-trip *digits* (.NET "R" and
 * JS `Number.prototype.toString()` are both shortest-round-trip since .NET
 * Core 3.0). They diverge only in *layout*: the fixed-vs-scientific threshold
 * and the scientific spelling. .NET uses fixed notation iff the leading-digit
 * decimal exponent `e` is in `[-4, 16]`, else scientific with an uppercase
 * `E`, an always-present sign, and a ≥2-digit zero-padded exponent
 * (`1E+21`, `1E-07`, `1.2345678901234568E+17`). JS's thresholds are wider
 * (scientific only for `e ≥ 21` or `e ≤ -7`) and its scientific form is
 * lowercase with an unpadded exponent (`1e+21`, `1e-7`).
 *
 * This normaliser extracts the shared shortest digits + exponent from JS's
 * own `toString()` and re-lays them out in .NET form, so the TS encoder is
 * byte-identical to the F# encoder across the whole finite-double range — not
 * just the int53 plain-decimal sub-range the two happened to already agree on
 * (Phase 117).
 */
export const formatFiniteDouble = (n: number): string => {
  if (n === 0) return '0';
  const neg = n < 0;
  const s = Math.abs(n).toString();

  // Decompose into significant `digits` (no point) + `exp`, the base-10
  // exponent of the leading digit (value = d0.d1d2… × 10^exp).
  let digits: string;
  let exp: number;
  const eIdx = s.indexOf('e');
  if (eIdx >= 0) {
    const mant = s.slice(0, eIdx);
    const mantExp = parseInt(s.slice(eIdx + 1), 10);
    const dot = mant.indexOf('.');
    if (dot < 0) {
      digits = mant;
      exp = mantExp + (mant.length - 1);
    } else {
      digits = mant.slice(0, dot) + mant.slice(dot + 1);
      exp = mantExp + (dot - 1);
    }
  } else {
    const dot = s.indexOf('.');
    if (dot < 0) {
      digits = s;
      exp = s.length - 1;
    } else {
      const intPart = s.slice(0, dot);
      const fracPart = s.slice(dot + 1);
      if (intPart === '0') {
        const leadingZeros = fracPart.length - fracPart.replace(/^0+/, '').length;
        digits = fracPart.slice(leadingZeros);
        exp = -(leadingZeros + 1);
      } else {
        digits = intPart + fracPart;
        exp = intPart.length - 1;
      }
    }
  }

  // Reduce to shortest significant digits (the leading digit is already
  // significant, so only trailing zeros can be dropped).
  digits = digits.replace(/0+$/, '') || '0';

  let out: string;
  if (exp >= -4 && exp <= 16) {
    // Fixed-point layout.
    if (exp >= 0) {
      if (digits.length <= exp + 1) {
        out = digits + '0'.repeat(exp + 1 - digits.length);
      } else {
        out = digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
      }
    } else {
      out = '0.' + '0'.repeat(-exp - 1) + digits;
    }
  } else {
    // Scientific layout: uppercase E, signed, ≥2-digit zero-padded exponent.
    const mantissa = digits.length === 1 ? digits : digits[0] + '.' + digits.slice(1);
    const expSign = exp >= 0 ? '+' : '-';
    const expDigits = Math.abs(exp).toString().padStart(2, '0');
    out = mantissa + 'E' + expSign + expDigits;
  }

  return neg ? '-' + out : out;
};

/**
 * Number rule (§2 rule 5): finite via .NET "R" layout; specials as quoted sentinels; −0 → 0.
 *
 * The leading coercion is a TOTALITY guard, not a convenience. A float slot's
 * value can reach the encoder spelled the way the WIRE spells a non-finite —
 * the quoted sentinel string of §5/§7 — because `Binding.Static` carries an
 * untyped payload and a projected or hand-authored tree is never typechecked at
 * the slot. Without the coercion those three spellings fall through to
 * `formatFiniteDouble`, whose arithmetic on a string yields a BARE `NaN` /
 * `Infinity` / `-Infinity` token: output that is not JSON at all, so nothing
 * downstream can even parse it back. That is a correctness defect independent
 * of any consumer, which is why this is a guard here rather than a rule imposed
 * on callers.
 *
 * `Number` maps exactly the three sentinel spellings the DECODER accepts at a
 * float slot onto exactly the three values encoded back to them, so the two
 * halves are symmetric by construction. Any other unrepresentable value becomes
 * `NaN` and is emitted as the quoted `"NaN"` sentinel — never a bare token —
 * which keeps `encodeNode` total: it cannot emit invalid JSON. Note `Number` is
 * the identity on a real number (`-0` included, which `formatFiniteDouble`
 * still normalises to `0`), so the finite path is byte-unchanged.
 */
export const num = (n: number): string => {
  const v = Number(n);
  if (Number.isNaN(v)) return '"NaN"';
  if (v === Infinity) return '"Infinity"';
  if (v === -Infinity) return '"-Infinity"';
  return formatFiniteDouble(v);
};
