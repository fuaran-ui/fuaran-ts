// ============================================================================
//  @fuaran-ui/renderer/declaredSlots — which binding slots a NodeKind DECLARES.
//
//  `bindingForSlot` (from @fuaran-ui/ai-tools) answers "give me the binding
//  backing this slot" and returns `undefined` for two very different questions:
//
//    1. this kind has no such binding slot at all  →  a caller error; and
//    2. this kind declares the slot, but it is OPTIONAL and currently absent
//       (Metric.Trend, Tabs.ActiveTag, Button/Select/Form/FileUpload.Disabled).
//
//  A reader must be able to tell those apart — "no such slot" is a mistake to
//  fix, "declared and holding nothing" is a fact about the tree. This is the
//  missing half: the declared slot NAMES per kind.
//
//  Both halves read ONE table, `BINDING_SLOTS` in @fuaran-ui/schema — every
//  `Binding<…>` member of every kind, projected from the IDL (Phase 2073) —
//  so a binding slot the vocabulary gains reaches both with no edit here, and
//  the three hand-kept copies this and the ai-tools table were (each of which
//  had fallen behind the IDL by the same nine slots) cannot drift apart again.
// ============================================================================

import { BINDING_SLOTS, idlKindName, type NodeKind } from '@fuaran-ui/schema';

/**
 * The binding-slot names a node kind declares — whether or not the slot
 * currently holds a binding. Empty for kinds with no binding slots.
 */
export const declaredSlots = (kind: NodeKind<unknown>): readonly string[] =>
  BINDING_SLOTS[idlKindName(kind)].map((s) => s.slot);

/** Whether `slotName` is a declared binding slot on `kind` (bound or not). */
export const isDeclaredSlot = (kind: NodeKind<unknown>, slotName: string): boolean =>
  declaredSlots(kind).includes(slotName);
