// ============================================================================
//  @fuaran-ui/ops/seeds — the `Binding.State` SEEDING pass (Phase 1075).
//
//  A `Binding.State` carrying a `defaultValue` DECLARES the value of its slot
//  rather than merely falling back to it for itself, so a grid bound to
//  `$state.members` and a `Transform` deriving over the same key read the same
//  rows. This module collects those declarations once for a tree; the two
//  renderers lay the result UNDER whatever the host already furnished.
//
//  The rules are the shared-data-source charter's §4/§5, and they are stated
//  once here so the two TypeScript renderers cannot drift on them — the same
//  role `BindingWalk.stateSeeds` plays on the F# side.
//
//   * The declaring reader is ANY `Binding.State` with a present
//     `defaultValue`. There is no separate declaration site; that is the whole
//     economy of the rule.
//   * FIRST declaration in walk order wins. Two declarations of one key are a
//     defect (FUARAN106) but a renderer must still be deterministic, and it
//     must not depend on which host walked the tree.
//   * A host-reserved key is never seeded. A seed is a tree-originated write,
//     and the wire must not gain a way around a deliberate floor.
//   * The seed is the FLOOR, never an override: the host's own value wins.
//
//  THE WALK IS STRUCTURAL, and that is a deliberate difference from the F#
//  tier rather than an accident. The F# collector is a typed walk carrying an
//  explicit forward-coupling duty — a new binding-bearing field on any spec
//  must extend it or its declaration is silently dropped. A structural descent
//  over the decoded value graph has no such duty: it finds a `State` binding in
//  any slot, including one added tomorrow. It is a superset of the typed walk,
//  never a subset, so the two hosts cannot disagree by the TS side missing a
//  slot.
// ============================================================================

import type { Node } from '@fuaran-ui/schema';
import { controlValueDefaults } from '@fuaran-ui/schema';

/**
 * Keys under this prefix are HOST-OWNED: a tree-originated write naming one is
 * refused, so a tree-originated SEED naming one must be too.
 *
 * Declared here rather than imported because the TypeScript tier carries no
 * shared state-key policy module (the F# tier's `Fuaran.UI.StateKeyPolicy`).
 * It must stay in step with that definition — there is one prefix, and a host
 * that names a slot `host.<whatever>` is entitled to have every tier honour it.
 */
export const HOST_RESERVED_PREFIX = 'host.';

const isHostReserved = (key: string): boolean =>
  typeof key === 'string' && key.startsWith(HOST_RESERVED_PREFIX);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A `Binding.State` declaration, as the walk recognises one: the `kind` tag,
 * a string `key`, and a PRESENT `defaultValue`. The `into` target of an
 * `Action.SetState` wears the same tag and carries no `defaultValue`, which is
 * exactly what tells a write destination from a declaring read.
 */
const isStateDeclaration = (v: unknown): v is { key: string; defaultValue: unknown } =>
  isPlainObject(v) &&
  v['kind'] === 'State' &&
  typeof v['key'] === 'string' &&
  'defaultValue' in v &&
  v['defaultValue'] !== undefined;

const controlDefaults: readonly unknown[] = Object.values(controlValueDefaults);

const deepEqual = (a: unknown, b: unknown): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/**
 * A form field with NO `value` slot on the wire is auto-bound at DECODE time to
 * `{kind:'State', key:<field id>, defaultValue:<the control's default>}` — a
 * binding the document never wrote. The F# tier keeps the slot as an absent
 * option and auto-binds at RENDER time instead, so it has no such binding to
 * see.
 *
 * A synthesised default is not a declaration: nothing in the tree said it, and
 * `WIRE_FORMAT.md` has no bytes for it — the encoder recognises exactly this
 * shape and omits the slot again. Seeding it would put a `''` under the field's
 * key in this tier and nothing in the F# tier, from ONE document. So it is
 * recognised by the encoder's own test (key matches the field id, value matches
 * the control default for its kind) and skipped.
 *
 * An author who explicitly writes the control default for a field's own key is
 * skipped too, and that is correct rather than collateral: the encoder omits
 * that slot, so the two spellings are the same document and must seed the same
 * thing.
 */
const isAutoBoundFieldValue = (binding: { key: string; defaultValue: unknown }, fieldId: string) =>
  binding.key === fieldId && controlDefaults.some((d) => deepEqual(d, binding.defaultValue));

/**
 * An EMPTY table declares nothing: it is the value an unseeded slot already
 * resolves to, so `"defaultValue":[]` adds nothing an absent declaration does
 * not already say.
 *
 * Load-bearing rather than tidy, for the same two reasons it is on the F# side.
 * A Transform's source slot cannot spell "I read this key and carry no data" as
 * a bare `{"$type":"State","key":k}` on the wire today — that wrapper is
 * refused as un-unwrappable — so `[]` is how the charter's own §3.1 pair is
 * written. If it seeded, a badge appearing before its grid would seed the slot
 * EMPTY and document order would silently decide what renders.
 */
const isEmptyDeclaration = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) {
    const columns = value['columns'];
    if (isPlainObject(columns)) return Object.keys(columns).length === 0;
  }
  return false;
};

/**
 * Collect the seed map for a tree: the value each `$state.<key>` slot carries
 * before anything else has said anything.
 *
 * Order-independent by construction (charter §5) — the whole tree is walked
 * before any binding resolves, so a badge declared before the grid that carries
 * its rows is not a special case.
 */
export const collectStateSeeds = <TMsg>(tree: Node<TMsg>): Readonly<Record<string, unknown>> => {
  const seeds: Record<string, unknown> = {};
  const seen = new Set<unknown>();

  const visit = (value: unknown, autoBindFieldId: string | undefined): void => {
    if (value === null || typeof value !== 'object') return;
    // A tree is a value, but a host may hand us one with shared sub-objects;
    // the guard keeps the walk linear and makes a cyclic host structure
    // terminate rather than hang.
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, autoBindFieldId);
      return;
    }

    const obj = value as Record<string, unknown>;

    if (isStateDeclaration(obj)) {
      const key = obj.key;
      const shouldSkip =
        isHostReserved(key) ||
        Object.prototype.hasOwnProperty.call(seeds, key) ||
        isEmptyDeclaration(obj.defaultValue) ||
        (autoBindFieldId !== undefined && isAutoBoundFieldValue(obj, autoBindFieldId));

      if (!shouldSkip) seeds[key] = obj.defaultValue;
      // Keep descending: a `Local` re-sync source or an `I18n` arg can nest
      // another binding underneath this one.
    }

    const record = obj as Record<string, unknown>;
    const ownId: unknown = record['id'];

    // A FORM FIELD, and nothing else, is where the decoder's auto-bind lands.
    // It is told from a `Node` — which also carries `id` + `kind` — by
    // `required`, a required boolean on every field and absent from every node.
    // Without that discriminator a `Badge` whose id happened to match a state
    // key would suppress a real declaration.
    const fieldId =
      typeof ownId === 'string' && typeof record['required'] === 'boolean' ? ownId : undefined;

    for (const [k, v] of Object.entries(obj)) {
      // The id follows the field's own `kind` subtree, where the synthesised
      // binding sits (`kind.value`), and is otherwise inherited unchanged so it
      // reaches through the `FormFieldKind` wrapper to the value slot.
      const established = k === 'kind' && fieldId !== undefined ? fieldId : undefined;
      visit(v, established ?? autoBindFieldId);
    }
  };

  visit(tree, undefined);
  return seeds;
};

/**
 * Lay a tree's seeds UNDER a host's own binding sources. The host's map wins on
 * every key it names — a seed is the value before anything else has said
 * anything, never an override, which is the only reading consistent with the
 * wire's standing posture that the host owns named data.
 *
 * Returns the caller's own object unchanged when the tree declares nothing, so
 * an unseeded tree costs one walk and no allocation.
 */
export const withStateSeeds = <
  TMsg,
  S extends { readonly state?: Readonly<Record<string, unknown>> },
>(
  tree: Node<TMsg>,
  sources: S,
): S => {
  const seeds = collectStateSeeds(tree);
  if (Object.keys(seeds).length === 0) return sources;
  return { ...sources, state: { ...seeds, ...(sources.state ?? {}) } };
};
