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
//  fix, "declared and holding nothing" is a fact about the tree. This table is
//  the missing half: the declared slot NAMES per kind, mirroring the branch
//  structure of `bindingForSlot` exactly.
//
//  Forward-coupling: a new binding slot on a kind updates `bindingForSlot`
//  (@fuaran-ui/ai-tools), `extractBindingSlots`, and this table together. A
//  test pins the two in agreement for every slot the ai-tools table can return.
// ============================================================================

import type { NodeKind } from '@fuaran-ui/schema';

const NONE: readonly string[] = [];

/**
 * The binding-slot names a node kind declares — whether or not the slot
 * currently holds a binding. Empty for kinds with no binding slots.
 */
export const declaredSlots = (kind: NodeKind<unknown>): readonly string[] => {
  switch (kind.kind) {
    case 'Display':
      switch (kind.display.kind) {
        case 'Metric':
          return ['Value', 'Trend'];
        case 'Sparkline':
          return ['Source'];
        case 'Progress':
          return ['Fraction'];
        case 'LabelValueRow':
          return ['Value'];
        default:
          return NONE;
      }
    case 'Layout':
      switch (kind.layout.kind) {
        case 'Stepper':
          return ['ActiveStep'];
        case 'Tabs':
          return ['ActiveIndex', 'ActiveTag'];
        case 'Disclosure':
          return ['Open'];
        default:
          return NONE;
      }
    case 'Input':
      switch (kind.input.kind) {
        case 'Button':
          return ['Disabled'];
        case 'Select':
          return ['Source', 'Value', 'Disabled'];
        case 'Form':
          return ['Disabled'];
        case 'FileUpload':
          return ['Disabled'];
        default:
          return NONE;
      }
    case 'Visualisation':
      switch (kind.visualisation.kind) {
        case 'Grid':
          return ['Source'];
        case 'Chart':
          return ['Source'];
        case 'Map':
          return ['Source'];
        default:
          return NONE;
      }
    default:
      return NONE;
  }
};

/** Whether `slotName` is a declared binding slot on `kind` (bound or not). */
export const isDeclaredSlot = (kind: NodeKind<unknown>, slotName: string): boolean =>
  declaredSlots(kind).includes(slotName);
