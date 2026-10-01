// ============================================================================
//  @fuaran-ui/ops — deliberate repair of malformed canonical JSON
//  (WIRE_FORMAT.md §28).
//
//  A decoder is strict: it parses, or it refuses with `INVALID_JSON`. Repair is
//  a separate, pure, text-to-text act a caller invokes deliberately, and every
//  repair it performs is named by a stable id from a closed, versioned
//  catalogue:
//
//    implied-node-close   insert the node-wrapper closers a `children[]` /
//                         `cases[]` element (or the root) owes
//    over-close-unique    delete one or two surplus closers, iff exactly one
//                         deletion decodes clean
//    wrong-type-close     (catalogue version 2) put right a `}` that met a
//                         `children[]` / `cases[]` array, iff its two readings
//                         yield exactly one distinct document
//
//  Repair touches STRUCTURE only: it inserts or deletes closing brackets and
//  never invents or edits a key or a value. Its output is not trusted — decode
//  it strictly and validate the tree, exactly as for text that needed no repair.
//
//  A port of the reference host's catalogue with the same ids, the same
//  admissibility conditions and the same output bytes; the `repair/` corpus
//  family is where the two are held to it. Positions are UTF-16 code units in
//  both hosts, so the insert/delete offsets agree by construction.
// ============================================================================

import { MAX_JSON_DEPTH } from '@fuaran-ui/schema';

import { decodeNode } from './decode.js';
import { parse, type JsonAst } from './parse.js';

/** The catalogue version (WIRE_FORMAT.md §28.2). */
export const REPAIR_CATALOGUE_VERSION = 2;

/** The stable repair ids, in the order `repair` tries them (§28.2). */
export const REPAIR_CATALOGUE = [
  'implied-node-close',
  'over-close-unique',
  'wrong-type-close',
] as const;

/** A catalogue id. */
export type RepairId = (typeof REPAIR_CATALOGUE)[number];

/** Why `repair` declined (§28.4) — stable tokens. */
export type RepairRefusal =
  | 'limit-exceeded'
  | 'not-in-catalogue'
  | 'over-close-ambiguous'
  | 'over-close-no-clean-candidate'
  | 'over-close-bounds'
  | 'wrong-type-close-ambiguous'
  | 'wrong-type-close-no-candidate';

/**
 * The result of `repair` (§28.3). A document that already parses is returned
 * unchanged with `applied: []` — `repair` is the identity on well-formed input,
 * which is what makes "repair, then strictly decode" a total composition.
 */
export type RepairOutcome =
  | { readonly kind: 'Repaired'; readonly text: string; readonly applied: readonly RepairId[] }
  | { readonly kind: 'NotRepairable'; readonly reason: RepairRefusal };

/** The over-close enumeration's document-length ceiling, in UTF-16 code units (§28.2). */
export const MAX_OVER_CLOSE_LENGTH = 65536;

// The over-close enumeration bounds (§28.2).
const MAX_SURPLUS = 2;
const MAX_CLOSER_POSITIONS = 512;
const MAX_DELETION_SETS = 8192;
const MAX_DISTINCT_CANDIDATES = 32;

type Verdict =
  | { readonly kind: 'Parsed'; readonly ast: JsonAst }
  | { readonly kind: 'Malformed' }
  | { readonly kind: 'OverLimit' };

const parseVerdict = (text: string): Verdict => {
  const r = parse(text);
  if (r.ok) return { kind: 'Parsed', ast: r.value };
  return r.error.limit === true ? { kind: 'OverLimit' } : { kind: 'Malformed' };
};

const astEqual = (a: JsonAst, b: JsonAst): boolean => {
  switch (a.kind) {
    case 'JNull':
      return b.kind === 'JNull';
    case 'JBool':
      return b.kind === 'JBool' && a.value === b.value;
    case 'JNumber':
      return b.kind === 'JNumber' && a.value === b.value;
    case 'JString':
      return b.kind === 'JString' && a.value === b.value;
    case 'JArray':
      return (
        b.kind === 'JArray' &&
        a.items.length === b.items.length &&
        a.items.every((x, i) => astEqual(x, b.items[i]!))
      );
    case 'JObject': {
      if (b.kind !== 'JObject' || a.fields.size !== b.fields.size) return false;
      for (const [k, v] of a.fields) {
        const w = b.fields.get(k);
        if (w === undefined || !astEqual(v, w)) return false;
      }
      return true;
    }
  }
};

// ─── implied-node-close (§28.2.1) ────────────────────────────────────────────

type FrameKind = 'Obj' | 'Arr';
type FrameState = 'KeyOrClose' | 'Key' | 'Colon' | 'Value' | 'CommaOrClose' | 'ValueOrClose';

interface Frame {
  readonly kind: FrameKind;
  state: FrameState;
  /** Arr frames only: the object key whose value this array is. */
  readonly arrKey: string | undefined;
  /** Obj frames only: the most recently read member key. */
  lastKey: string | undefined;
}

/** The array keys the mid-document close may close owed wrappers into. */
const RECOVERY_ARRAY_KEYS: readonly string[] = ['children', 'cases'];

/**
 * Scan `text`, closing owed node wrappers at ancestor-legal tokens. The repaired
 * text when the profile matched and a bounded repair exists; `undefined`
 * otherwise. A line-for-line port of the reference host's scanner.
 */
const tryImpliedNodeClose = (text: string): string | undefined => {
  const n = text.length;
  let i = 0;
  const stack: Frame[] = [];
  const inserts: number[] = [];
  let rootDone = false;
  let failed = false;
  let finished = false;

  const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const skipWsLocal = (): void => {
    while (i < n && isWs(text[i]!)) i += 1;
  };
  const skipString = (): boolean => {
    i += 1;
    let closed = false;
    while (!closed && i < n) {
      const c = text[i]!;
      if (c === '\\') i += 2;
      else if (c === '"') {
        i += 1;
        closed = true;
      } else i += 1;
    }
    return closed;
  };
  const readKey = (): string | undefined => {
    const start = i;
    return skipString() ? text.substring(start + 1, i - 1) : undefined;
  };
  const top = (): Frame => stack[stack.length - 1]!;
  const completeValue = (): void => {
    if (stack.length === 0) rootDone = true;
    else top().state = 'CommaOrClose';
  };
  const isScalarStart = (c: string): boolean =>
    c === '-' || (c >= '0' && c <= '9') || c === 't' || c === 'f' || c === 'n';
  const skipScalar = (): void => {
    const isScalarChar = (c: string): boolean =>
      c === '-' ||
      c === '+' ||
      c === '.' ||
      (c >= '0' && c <= '9') ||
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z');
    while (i < n && isScalarChar(text[i]!)) i += 1;
  };
  const openValue = (): boolean => {
    const c = text[i]!;
    if (c === '{') {
      stack.push({ kind: 'Obj', state: 'KeyOrClose', arrKey: undefined, lastKey: undefined });
      i += 1;
      return true;
    }
    if (c === '[') {
      const key = stack.length > 0 && top().kind === 'Obj' ? top().lastKey : undefined;
      stack.push({ kind: 'Arr', state: 'ValueOrClose', arrKey: key, lastKey: undefined });
      i += 1;
      return true;
    }
    if (c === '"') {
      if (skipString()) {
        completeValue();
        return true;
      }
      return false;
    }
    if (isScalarStart(c)) {
      skipScalar();
      completeValue();
      return true;
    }
    return false;
  };
  const isClosableObj = (f: Frame): boolean =>
    f.kind === 'Obj' && (f.state === 'CommaOrClose' || f.state === 'KeyOrClose');
  const closeOwedWrappers = (): boolean => {
    if (stack.length === 0 || !isClosableObj(top())) return false;
    let k = 1;
    while (
      k < stack.length &&
      stack[stack.length - 1 - k]!.kind === 'Obj' &&
      stack[stack.length - 1 - k]!.state === 'Value'
    ) {
      k += 1;
    }
    if (k >= stack.length) return false;
    const target = stack[stack.length - 1 - k]!;
    const profileOk =
      target.kind === 'Arr' &&
      target.arrKey !== undefined &&
      RECOVERY_ARRAY_KEYS.includes(target.arrKey);
    if (!profileOk) return false;
    for (let x = 0; x < k; x += 1) {
      inserts.push(i);
      stack.pop();
    }
    target.state = 'CommaOrClose';
    return true;
  };

  skipWsLocal();
  if (i >= n || text[i] !== '{') return undefined;
  openValue();

  while (!failed && !finished) {
    skipWsLocal();
    if (i >= n) {
      finished = true;
    } else if (rootDone) {
      failed = true;
    } else {
      const f = top();
      const c = text[i]!;
      if (f.kind === 'Obj') {
        switch (f.state) {
          case 'KeyOrClose':
            if (c === '}') {
              i += 1;
              stack.pop();
              completeValue();
            } else if (c === '"') {
              const key = readKey();
              if (key === undefined) failed = true;
              else {
                f.lastKey = key;
                f.state = 'Colon';
              }
            } else failed = true;
            break;
          case 'Key':
            if (c === '"') {
              const key = readKey();
              if (key === undefined) failed = true;
              else {
                f.lastKey = key;
                f.state = 'Colon';
              }
            } else failed = true;
            break;
          case 'Colon':
            if (c === ':') {
              i += 1;
              f.state = 'Value';
            } else failed = true;
            break;
          case 'Value':
            failed = !openValue();
            break;
          case 'CommaOrClose':
            if (c === ',') {
              const save = i;
              i += 1;
              skipWsLocal();
              if (i < n && text[i] === '"') f.state = 'Key';
              else if (i < n && text[i] === '{') {
                i = save;
                if (!closeOwedWrappers()) failed = true;
              } else failed = true;
            } else if (c === '}') {
              i += 1;
              stack.pop();
              completeValue();
            } else if (c === ']') {
              if (!closeOwedWrappers()) failed = true;
            } else failed = true;
            break;
          case 'ValueOrClose':
            failed = true;
            break;
        }
      } else if (f.state === 'ValueOrClose' || f.state === 'Value') {
        if (c === ']' && f.state === 'ValueOrClose') {
          i += 1;
          stack.pop();
          completeValue();
        } else failed = !openValue();
      } else if (f.state === 'CommaOrClose') {
        if (c === ',') {
          i += 1;
          f.state = 'Value';
        } else if (c === ']') {
          i += 1;
          stack.pop();
          completeValue();
        } else failed = true;
      } else failed = true;
    }
  }

  if (failed) return undefined;

  const eofCloses: string[] = [];
  if (!rootDone) {
    if (stack.length === 0) return undefined;
    const t = top();
    const topClosable =
      t.kind === 'Obj'
        ? t.state === 'CommaOrClose' || t.state === 'KeyOrClose'
        : t.state === 'CommaOrClose' || t.state === 'ValueOrClose';
    if (!topClosable) return undefined;
    for (let idx = stack.length - 1; idx >= 0; idx -= 1)
      eofCloses.push(stack[idx]!.kind === 'Obj' ? '}' : ']');
  }
  if (inserts.length === 0 && eofCloses.length === 0) return undefined;
  if (inserts.length + eofCloses.length > MAX_JSON_DEPTH) return undefined;

  let out = '';
  let prev = 0;
  for (const pos of inserts) {
    out += text.substring(prev, pos) + '}';
    prev = pos;
  }
  out += text.substring(prev);
  return out + eofCloses.join('');
};

// ─── over-close-unique (§28.2.2) ─────────────────────────────────────────────

interface OverCloseProfile {
  readonly surplus: number;
  readonly closers: readonly number[];
  readonly runLo: number;
  readonly runHi: number;
}

/** String-aware structural scan — the reference host's `OverClose.profile`. */
const overCloseProfile = (text: string): OverCloseProfile | undefined => {
  if (text.length === 0) return undefined;
  const n = text.length;
  const closers: number[] = [];
  const opens: string[] = [];
  let depth = 0;
  let minDepth = 0;
  let firstMismatch = -1;
  let inString = false;
  for (let i = 0; i < n; i += 1) {
    const c = text[i]!;
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') {
      depth += 1;
      opens.push(c);
    } else if (c === '}' || c === ']') {
      closers.push(i);
      depth -= 1;
      if (opens.length === 0) {
        if (firstMismatch < 0) firstMismatch = i;
      } else {
        const opened = opens.pop()!;
        if ((opened === '{') !== (c === '}') && firstMismatch < 0) firstMismatch = i;
      }
      if (depth < minDepth) minDepth = depth;
    }
  }
  const surplus = -depth;
  if (inString) return undefined;
  if (depth >= 0 || minDepth !== depth) return undefined;
  if (surplus > MAX_SURPLUS) return undefined;
  if (firstMismatch < 0) return undefined;
  let lo = firstMismatch;
  let j = firstMismatch - 1;
  let scanning = true;
  while (scanning && j >= 0) {
    const c = text[j]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') j -= 1;
    else if (c === '}' || c === ']') {
      lo = j;
      j -= 1;
    } else scanning = false;
  }
  return { surplus, closers, runLo: lo, runHi: firstMismatch };
};

/**
 * The candidate repaired documents, failure-run-first (§28.2.2 enumeration
 * order), or `undefined` past the bounds. A generator, so each candidate is
 * built, parsed and dropped before the next exists.
 */
const overCloseCandidates = (text: string, p: OverCloseProfile): Iterable<string> | undefined => {
  const m = p.closers.length;
  const sets = p.surplus === 1 ? m : (m * (m - 1)) / 2;
  if (m > MAX_CLOSER_POSITIONS || sets > MAX_DELETION_SETS) return undefined;
  const inRun = (pos: number): boolean => pos >= p.runLo && pos <= p.runHi;
  const repaired = (a: number, b: number): string =>
    b < 0
      ? text.substring(0, a) + text.substring(a + 1)
      : text.substring(0, a) + text.substring(a + 1, b) + text.substring(b + 1);
  return (function* () {
    for (let pass = 0; pass <= 1; pass += 1) {
      if (p.surplus === 1) {
        for (let x = 0; x < m; x += 1) {
          const a = p.closers[x]!;
          if (inRun(a) === (pass === 0)) yield repaired(a, -1);
        }
      } else {
        for (let x = 0; x < m - 1; x += 1) {
          for (let y = x + 1; y < m; y += 1) {
            const a = p.closers[x]!;
            const b = p.closers[y]!;
            if ((inRun(a) || inRun(b)) === (pass === 0)) yield repaired(a, b);
          }
        }
      }
    }
  })();
};

// ─── wrong-type-close (§28.2.3, catalogue version 2) ─────────────────────────
//
// A `}` read while the innermost open container is a node-list array. Two owed
// readings — the array's `]` was dropped (insert it before the `}`), or the `}`
// was written for the `]` (replace it) — each completed at most once by
// `implied-node-close`; the entry repairs iff they yield exactly one distinct
// document. The surplus reading is deliberately not one: a surplus closer has
// as many homes as there are enclosing levels, which is `over-close-unique`'s
// enumeration to make. Profile-gated to `children` / `cases` like
// `implied-node-close`, and the `]`-meets-object mirror is that entry's class.

/**
 * String-aware scan to the FIRST structural mismatch: its offset when it is a
 * `}` read while the innermost open container is an array that is the value of
 * a member keyed `children` / `cases`; `undefined` for every other document.
 */
const wrongTypeCloseProfile = (text: string): number | undefined => {
  const n = text.length;
  // [isArray, the member key the array is the value of]
  const opens: Array<readonly [boolean, string | undefined]> = [];
  // The most recent string literal, while only whitespace and at most one `:`
  // have followed it: what makes `"children": [` a keyed array.
  let lastString: string | undefined;
  let colon = false;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      let closed = false;
      i += 1;
      while (!closed && i < n) {
        const d = text[i]!;
        if (d === '\\') i += 2;
        else if (d === '"') {
          closed = true;
          i += 1;
        } else i += 1;
      }
      if (!closed) return undefined; // cut inside a string
      lastString = text.substring(start + 1, i - 1);
      colon = false;
      continue;
    }
    if (c === ':' && lastString !== undefined && !colon) {
      colon = true;
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      // whitespace keeps the pending key
    } else if (c === '[') {
      opens.push([true, colon ? lastString : undefined]);
      lastString = undefined;
    } else if (c === '{') {
      opens.push([false, undefined]);
      lastString = undefined;
    } else if (c === '}' || c === ']') {
      const top = opens[opens.length - 1];
      if (top === undefined) return undefined;
      const [isArr, key] = top;
      if (isArr === (c === ']')) {
        opens.pop();
      } else {
        const keyed = key !== undefined && RECOVERY_ARRAY_KEYS.includes(key);
        return c === '}' && isArr && keyed ? i : undefined;
      }
      lastString = undefined;
    } else {
      lastString = undefined;
    }
    i += 1;
  }
  return undefined;
};

/** The two owed readings of the `}` at `at`, in order: insert `]`, replace with `]`. */
const wrongTypeCloseReadings = (text: string, at: number): readonly string[] => {
  const before = text.substring(0, at);
  const after = text.substring(at + 1);
  return [before + ']}' + after, before + ']' + after];
};

const wrongTypeClose = (text: string, at: number): RepairOutcome => {
  const distinct: Array<{ text: string; ast: JsonAst; applied: readonly RepairId[] }> = [];
  for (const reading of wrongTypeCloseReadings(text, at)) {
    let kept: { text: string; ast: JsonAst; applied: readonly RepairId[] } | undefined;
    const v = parseVerdict(reading);
    if (v.kind === 'Parsed') {
      kept = { text: reading, ast: v.ast, applied: ['wrong-type-close'] };
    } else {
      const completed = tryImpliedNodeClose(reading);
      if (completed !== undefined) {
        const w = parseVerdict(completed);
        if (w.kind === 'Parsed')
          kept = {
            text: completed,
            ast: w.ast,
            applied: ['wrong-type-close', 'implied-node-close'],
          };
      }
    }
    if (kept !== undefined && !distinct.some((d) => astEqual(d.ast, kept.ast))) distinct.push(kept);
  }
  if (distinct.length === 1) {
    const only = distinct[0]!;
    return { kind: 'Repaired', text: only.text, applied: only.applied };
  }
  return {
    kind: 'NotRepairable',
    reason: distinct.length === 0 ? 'wrong-type-close-no-candidate' : 'wrong-type-close-ambiguous',
  };
};

/**
 * Repair a malformed canonical-JSON NODE document, deliberately (WIRE_FORMAT.md
 * §28). Pure: text in, text out.
 *
 * The procedure, in the order the specification states it: a text that parses
 * is returned unchanged; a §21 limit breach is `limit-exceeded`;
 * `implied-node-close` if its insert-only scan yields a text that parses;
 * `over-close-unique` if the text is in the over-close profile and exactly one
 * distinct candidate decodes clean (the output is the FIRST candidate text, in
 * enumeration order, that parses to it); `wrong-type-close` if the text is in
 * its profile (§28.2.3); otherwise `not-in-catalogue`.
 *
 * The uniqueness gate decodes candidates with no admission policy — repair is a
 * property of the text, and a §23 policy applies at the decode that follows.
 */
export const repair = (text: string): RepairOutcome => {
  const first = parseVerdict(text);
  if (first.kind === 'Parsed') return { kind: 'Repaired', text, applied: [] };
  if (first.kind === 'OverLimit') return { kind: 'NotRepairable', reason: 'limit-exceeded' };

  const implied = tryImpliedNodeClose(text);
  if (implied !== undefined && parseVerdict(implied).kind === 'Parsed') {
    return { kind: 'Repaired', text: implied, applied: ['implied-node-close'] };
  }

  const p = overCloseProfile(text);
  if (p === undefined) {
    const at = wrongTypeCloseProfile(text);
    return at === undefined
      ? { kind: 'NotRepairable', reason: 'not-in-catalogue' }
      : wrongTypeClose(text, at);
  }
  if (text.length > MAX_OVER_CLOSE_LENGTH)
    return { kind: 'NotRepairable', reason: 'over-close-bounds' };
  const cands = overCloseCandidates(text, p);
  if (cands === undefined) return { kind: 'NotRepairable', reason: 'over-close-bounds' };

  const seen: JsonAst[] = [];
  let clean = 0;
  let accepted: string | undefined;
  for (const candidate of cands) {
    const v = parseVerdict(candidate);
    if (v.kind !== 'Parsed') continue;
    if (seen.some((s) => astEqual(s, v.ast))) continue;
    seen.push(v.ast);
    if (seen.length > MAX_DISTINCT_CANDIDATES)
      return { kind: 'NotRepairable', reason: 'over-close-bounds' };
    if (decodeNode(candidate).ok) {
      clean += 1;
      if (clean === 1) accepted = candidate;
    }
  }
  if (clean === 1 && accepted !== undefined)
    return { kind: 'Repaired', text: accepted, applied: ['over-close-unique'] };
  return {
    kind: 'NotRepairable',
    reason: clean === 0 ? 'over-close-no-clean-candidate' : 'over-close-ambiguous',
  };
};
