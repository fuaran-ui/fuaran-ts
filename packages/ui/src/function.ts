// ============================================================================
//  @fuaran-ui/ui/function — the signature-searchable function registry
//  (Phase 558). The native-TS reimplementation of the F# reference
//  `Fuaran.Core.FunctionRegistry.findBySignature` (Phase 50/512) + the
//  deterministic compose-path resolution (the twin of the Python
//  `fuaran_py.function` registry, Phase 523).
//
//  Composition-by-lookup, not composition-by-generation: register functions by
//  the node-kind they *produce* and the typed *holes* they require, then ask the
//  registry "what can I run to produce X with the context I have?" (a total,
//  in-memory structural search — no model call, no server) and compose a result
//  by chaining matched functions rather than prompting. This is the Pattern
//  Bank's deterministic no-model-call fast path.
//
//  Reference semantics (canonical = F#):
//    - a query is `(resultType, available)` — the node-kind to produce
//      (`null` = any) + the context holes on offer; only a function's REQUIRED
//      holes gate a match; matching is BY ADDRESS.
//    - Subsumes — result type matches (or wildcard) and every required hole is
//      satisfiable from context (`available ⊆ required` for value spaces, a
//      slot-kind match for slots). Assignable/subtype matching.
//    - Exact — the required-hole address set equals the context address set and
//      each pair is shape-EQUAL (kind + space + slot).
//    - candidates return in deterministic lexicographic id order (no ranking).
//    - a compose that cannot reach the target returns a typed `NoPath`, never a
//      guess.
//
//  Certified against the shared `wire-format-fixtures/function-registry/`
//  goldens — byte/shape-identical resolution across the F#, py, ts, go, rs
//  hosts. NOTE on the one host divergence: the F# reference `spaceSubsumes`
//  treats an `AnyString` required space as subsuming an `Enum` available; the
//  Python host does not. This host follows the F# reference (the canonical
//  semantics); the shared goldens deliberately avoid that single edge so every
//  host agrees on every fixture.
// ============================================================================

import type { HoleValueSpace, Result } from '@fuaran-ui/schema';
import { err, ok } from '@fuaran-ui/schema';

// ─── signature shapes (port of Fuaran.Core.Function SigEntry / FunctionEntry) ─

/** A hole kind — the role a hole plays in a function's signature. */
export type RegistryHoleKind = 'value' | 'slot' | 'repeat' | 'action';

/**
 * One hole in a function signature — matched by absolute `addr` (hygiene). A
 * `value` / `repeat` hole carries a value `space`; a `slot` hole carries a
 * node-kind `slot` constraint. Port of F# `SigEntry`.
 */
export interface RegistrySigEntry {
  readonly addr: string;
  readonly name: string;
  readonly kind: RegistryHoleKind;
  readonly space?: HoleValueSpace;
  readonly slot?: string;
  readonly required: boolean;
}

/**
 * A registered function: an id, the node-kind it *produces* (`resultType`), and
 * its required-hole shape. Port of F# `FunctionEntry`.
 */
export interface FunctionEntry {
  readonly id: string;
  readonly resultType: string;
  readonly holes: readonly RegistrySigEntry[];
}

/**
 * A signature search: the node-kind to produce (`null` = any — a produce-axis
 * wildcard) + the context holes on offer, keyed by absolute address. Port of F#
 * `SignatureQuery`.
 */
export interface SignatureQuery {
  readonly resultType: string | null;
  readonly available: readonly RegistrySigEntry[];
}

/** How strictly an entry's signature must match a query. Port of F# `MatchMode`. */
export type MatchMode = 'Subsumes' | 'Exact';

/**
 * Why a registration was refused — a duplicate id is a named error, never a
 * throw (default-deny by shape, the same posture as the capability registry).
 */
export type RegisterError = { readonly kind: 'DuplicateFunction'; readonly id: string };

/**
 * A signature-typed function registry — the artifact-function catalogue, queried
 * BY SIGNATURE. `byResult` is the result-type index (result-kind → the ids
 * producing it), maintained additively so a "produces a Box" query narrows
 * before the hole-shape filter runs. Immutable; `registerFunction` returns a
 * fresh registry. Port of F# `FunctionRegistry`.
 */
export interface FunctionRegistry {
  readonly entries: ReadonlyMap<string, FunctionEntry>;
  readonly byResult: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The empty registry. */
export const emptyFunctionRegistry: FunctionRegistry = {
  entries: new Map(),
  byResult: new Map(),
};

/**
 * Register an entry — additive, no silent overwrite (a duplicate id is a named
 * error). Maintains both the id map and the result-type index. Port of F#
 * `FunctionRegistry.register`.
 */
export const registerFunction = (
  entry: FunctionEntry,
  reg: FunctionRegistry,
): Result<FunctionRegistry, RegisterError> => {
  if (reg.entries.has(entry.id)) return err({ kind: 'DuplicateFunction', id: entry.id });
  const entries = new Map(reg.entries);
  entries.set(entry.id, entry);
  const byResult = new Map<string, Set<string>>();
  for (const [k, v] of reg.byResult) byResult.set(k, new Set(v));
  const ids = byResult.get(entry.resultType) ?? new Set<string>();
  ids.add(entry.id);
  byResult.set(entry.resultType, ids);
  return ok({ entries, byResult });
};

/** Build a registry from a list of entries (duplicate id → named error). */
export const functionRegistryOf = (
  entries: readonly FunctionEntry[],
): Result<FunctionRegistry, RegisterError> => {
  let reg = emptyFunctionRegistry;
  for (const e of entries) {
    const r = registerFunction(e, reg);
    if (!r.ok) return r;
    reg = r.value;
  }
  return ok(reg);
};

// ─── value-space + slot subsumption (available ⊆ required) ────────────────────

/**
 * Does `required` value-space subsume `available` — is every value the context
 * can supply acceptable to the function? I.e. `available ⊆ required`, the
 * direction that makes the function runnable from the context. Same-constructor
 * numeric/length ranges compare by bounds; an `Enum` subsumes a subset `Enum`;
 * an `AnyString` required space subsumes any string-valued space. Cross-type
 * never subsumes. Port of F# `spaceSubsumes` (the canonical reference).
 */
export const spaceSubsumes = (required: HoleValueSpace, available: HoleValueSpace): boolean => {
  switch (required.kind) {
    case 'IntRange':
      return (
        available.kind === 'IntRange' &&
        required.min <= available.min &&
        available.max <= required.max
      );
    case 'FloatRange':
      return (
        available.kind === 'FloatRange' &&
        required.min <= available.min &&
        available.max <= required.max
      );
    case 'StringLen':
      return (
        available.kind === 'StringLen' &&
        required.minLen <= available.minLen &&
        available.maxLen <= required.maxLen
      );
    case 'Enum':
      return (
        available.kind === 'Enum' && available.choices.every((v) => required.choices.includes(v))
      );
    case 'AnyString':
      return (
        available.kind === 'StringLen' ||
        available.kind === 'Enum' ||
        available.kind === 'AnyString'
      );
  }
};

/**
 * Is a required slot constraint satisfied by an available slot? An unconstrained
 * required slot (`undefined`) accepts any; a constrained one needs the same
 * kind. Port of F# `slotSubsumes`.
 */
const slotSubsumes = (required: string | undefined, available: string | undefined): boolean => {
  if (required === undefined) return true;
  return available !== undefined && required === available;
};

/** Structural equality of two value-spaces — the `Exact`-mode shape check. */
const spaceEqual = (a: HoleValueSpace | undefined, b: HoleValueSpace | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'IntRange':
    case 'FloatRange':
      return a.min === (b as typeof a).min && a.max === (b as typeof a).max;
    case 'StringLen':
      return a.minLen === (b as typeof a).minLen && a.maxLen === (b as typeof a).maxLen;
    case 'Enum': {
      const bc = (b as typeof a).choices;
      return a.choices.length === bc.length && a.choices.every((v, i) => v === bc[i]);
    }
    case 'AnyString':
      return true;
  }
};

/**
 * Is a single required hole satisfied by the matching available-context entry
 * (same address)? value/repeat: kinds agree and the available value-space ⊆ the
 * required space; slot: kinds agree and the available slot satisfies the
 * required. Port of F# `holeSatisfied`.
 */
const holeSatisfied = (req: RegistrySigEntry, av: RegistrySigEntry): boolean => {
  if (req.kind !== av.kind) return false;
  if (req.kind === 'slot') return slotSubsumes(req.slot, av.slot);
  if (req.space === undefined || av.space === undefined) return false;
  return spaceSubsumes(req.space, av.space);
};

const holeSatisfiedIn = (
  req: RegistrySigEntry,
  byAddr: ReadonlyMap<string, RegistrySigEntry>,
): boolean => {
  const av = byAddr.get(req.addr);
  return av !== undefined && holeSatisfied(req, av);
};

const requiredHoles = (entry: FunctionEntry): RegistrySigEntry[] =>
  entry.holes.filter((h) => h.required);

const matchesQuery = (mode: MatchMode, query: SignatureQuery, entry: FunctionEntry): boolean => {
  const availByAddr = new Map(query.available.map((e) => [e.addr, e] as const));
  const required = requiredHoles(entry);
  const resultMatches = query.resultType === null || query.resultType === entry.resultType;
  if (!resultMatches) return false;

  if (mode === 'Subsumes') {
    return required.every((req) => holeSatisfiedIn(req, availByAddr));
  }
  // Exact — required-hole address set equals the context set, shape-equal per pair.
  const reqAddrs = new Set(required.map((h) => h.addr));
  const avAddrs = new Set(query.available.map((e) => e.addr));
  if (reqAddrs.size !== avAddrs.size || [...reqAddrs].some((a) => !avAddrs.has(a))) return false;
  return required.every((req) => {
    const av = availByAddr.get(req.addr);
    return (
      av !== undefined &&
      req.kind === av.kind &&
      spaceEqual(req.space, av.space) &&
      req.slot === av.slot
    );
  });
};

/**
 * Find every registered function whose signature matches the query under `mode`.
 * A `Some` result type narrows the candidate set via the `byResult` index first;
 * a `null` result type scans all entries. Survivors are filtered by the
 * hole-shape predicate and returned id-stable (lexicographic). Port of F#
 * `FunctionRegistry.findBySignature`.
 */
export const findBySignature = (
  mode: MatchMode,
  query: SignatureQuery,
  reg: FunctionRegistry,
): FunctionEntry[] => {
  const candidateIds =
    query.resultType === null
      ? [...reg.entries.keys()]
      : [...(reg.byResult.get(query.resultType) ?? new Set<string>())];
  return candidateIds
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((id) => reg.entries.get(id))
    .filter((e): e is FunctionEntry => e !== undefined)
    .filter((e) => matchesQuery(mode, query, e));
};

// ─── deterministic composition (the Pattern-Bank fast path) ───────────────────

/** One function applied in a composition — its id + the slot it fills (`null` at the root). */
export interface ComposeStep {
  readonly functionId: string;
  readonly fillsSlot: string | null;
}

/**
 * A deterministic composition reaching the target (`ok: true`, the ordered
 * steps, root last), or a typed no-path (`ok: false`, a reason). Port of the
 * Python `ComposePath` / `NoPath` sum.
 */
export type ComposeResult =
  | { readonly ok: true; readonly steps: readonly ComposeStep[] }
  | { readonly ok: false; readonly reason: string };

const composeSteps = (
  reg: FunctionRegistry,
  output: string,
  available: readonly RegistrySigEntry[],
  mode: MatchMode,
  depth: number,
  seen: ReadonlySet<string>,
): ComposeStep[] | null => {
  if (depth <= 0 || seen.has(output)) return null;

  // Direct match: a function producing `output` whose every required hole is in context.
  const direct = findBySignature(mode, { resultType: output, available }, reg);
  const [directHead] = direct;
  if (directHead !== undefined) return [{ functionId: directHead.id, fillsSlot: null }];

  const seenNext = new Set(seen).add(output);
  const byAddr = new Map(available.map((a) => [a.addr, a] as const));

  // Otherwise: a producer whose only unmet required holes are slots we can compose.
  const producers = [...(reg.byResult.get(output) ?? new Set<string>())].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const functionId of producers) {
    const entry = reg.entries.get(functionId);
    if (entry === undefined) continue;
    const subSteps: ComposeStep[] = [];
    let satisfiable = true;
    for (const hole of requiredHoles(entry)) {
      if (holeSatisfiedIn(hole, byAddr)) continue;
      if (hole.kind === 'slot' && hole.slot !== undefined) {
        const child = composeSteps(reg, hole.slot, available, mode, depth - 1, seenNext);
        if (child === null || child.length === 0) {
          satisfiable = false;
          break;
        }
        // tag the child's root with the slot it fills
        const root = child[child.length - 1]!;
        child[child.length - 1] = { functionId: root.functionId, fillsSlot: hole.addr };
        subSteps.push(...child);
      } else {
        satisfiable = false;
        break;
      }
    }
    if (satisfiable) return [...subSteps, { functionId, fillsSlot: null }];
  }
  return null;
};

/**
 * Chain functions to produce `output` from the `inputs` context deterministically
 * (`ok: true` + ordered steps, root last), or return a typed no-path. A direct
 * signature match is a single step; an unfilled slot hole is recursively composed
 * from the same context. No model call, no guess. Port of the Python
 * `FunctionRegistry.compose`.
 */
export const compose = (
  reg: FunctionRegistry,
  output: string,
  inputs: readonly RegistrySigEntry[],
  mode: MatchMode = 'Subsumes',
  maxDepth = 4,
): ComposeResult => {
  const steps = composeSteps(reg, output, inputs, mode, maxDepth, new Set());
  if (steps === null)
    return {
      ok: false,
      reason: `no deterministic function chain reaches '${output}' from the given context`,
    };
  return { ok: true, steps };
};

// ─── registry-shape attestation (548-style cross-host drift guard) ────────────

const spaceDesc = (space: HoleValueSpace | undefined): string => {
  if (space === undefined) return '-';
  switch (space.kind) {
    case 'IntRange':
      return `intRange(${space.min},${space.max})`;
    case 'FloatRange':
      return `floatRange(${space.min},${space.max})`;
    case 'StringLen':
      return `stringLen(${space.minLen},${space.maxLen})`;
    case 'Enum':
      return `enum(${space.choices.join('|')})`;
    case 'AnyString':
      return 'anyString';
  }
};

const holeDesc = (h: RegistrySigEntry): string =>
  `${h.addr}:${h.kind}:${spaceDesc(h.space)}:${h.slot ?? '-'}:${h.required ? 'req' : 'opt'}`;

const entryDesc = (e: FunctionEntry): string =>
  `${e.id}|${e.resultType}|${e.holes.map(holeDesc).join(';')}`;

/**
 * The canonical per-entry shape descriptors of a registry, sorted — the
 * 548-style attestation surface. A host whose registry model drops a hole
 * field, reorders holes, or mistypes a space produces a divergent descriptor,
 * so a cross-host shape drift fails the conformance gate with the entry named,
 * rather than silently diverging.
 */
export const registrySignatureShape = (reg: FunctionRegistry): string[] =>
  [...reg.entries.values()].map(entryDesc).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
