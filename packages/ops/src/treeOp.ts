// ============================================================================
//  @fuaran-ui/ops — TreeOp tagged union.
//
//  Port of the F# `Fuaran.UI.Ops.Types.TreeOp<'Msg>` DU — the atomic tree-edit
//  vocabulary the apply engine consumes and the canonical codec serialises.
//  Each case's in-memory `kind` literal is the F# case name verbatim and maps
//  1:1 to the wire `$type` discriminator (WIRE_FORMAT.md §3.4).
//
//  `ReplaceBinding` carries a `Binding<unknown>` — on the wire the binding's
//  typed payload is opaque (the encoder erases it to "<opaque>" / "<closure>"),
//  so the storage-shape decode yields `Binding<unknown>`; the apply engine
//  re-casts it against the target slot's expected type.
// ============================================================================

import type {
  Accessibility,
  Binding,
  Emphasis,
  FontVoice,
  Node,
  NodeId,
  NodeKind,
  SemanticStyle,
  StateBehaviour,
  StyleRole,
  StyleWeight,
  TextDirection,
  TextSource,
  ToneVariant,
  JsonValue,
} from '@fuaran-ui/schema';

/**
 * Phase 2291 — the field-level style edit's payload (WIRE_FORMAT.md §3.4,
 * `PatchStyle`). The six `SemanticStyle` members, each optional: an ABSENT
 * member leaves the node's field as it is, a PRESENT one sets it — a default
 * token included. So unlike `SemanticStyle` there is no omit-when-default
 * rule: `{ tone: 'Default' }` is a real edit. A delta naming no field is not
 * an edit and is refused at decode.
 */
export interface StyleDelta {
  readonly direction?: TextDirection;
  readonly emphasis?: Emphasis;
  readonly role?: StyleRole;
  readonly tone?: ToneVariant;
  readonly voice?: FontVoice;
  readonly weight?: StyleWeight;
}

export type TreeOp<TMsg> =
  | { readonly kind: 'EditNode'; readonly target: NodeId; readonly newKind: NodeKind<TMsg> }
  | {
      readonly kind: 'UpdateProp';
      readonly target: NodeId;
      readonly path: string;
      readonly value: JsonValue;
    }
  | {
      readonly kind: 'ReplaceBinding';
      readonly target: NodeId;
      readonly slot: string;
      readonly binding: Binding<unknown>;
    }
  | { readonly kind: 'UpdateStyle'; readonly target: NodeId; readonly style: SemanticStyle }
  | { readonly kind: 'PatchStyle'; readonly target: NodeId; readonly style: StyleDelta }
  | { readonly kind: 'UpdateState'; readonly target: NodeId; readonly state: StateBehaviour<TMsg> }
  // Phase 2527 — the trait edits. The whole record replaces the trait, and a
  // record setting no member removes it; an absent `tooltip` clears the tooltip.
  | {
      readonly kind: 'UpdateAccessibility';
      readonly target: NodeId;
      readonly accessibility: Accessibility;
    }
  | { readonly kind: 'UpdateTooltip'; readonly target: NodeId; readonly tooltip?: TextSource }
  | {
      readonly kind: 'InsertChild';
      readonly parentId: NodeId;
      readonly child: Node<TMsg>;
    }
  | { readonly kind: 'RemoveNode'; readonly target: NodeId }
  | {
      readonly kind: 'MoveNode';
      readonly target: NodeId;
      readonly newParentId: NodeId;
    }
  | {
      readonly kind: 'ReorderChildren';
      readonly parentId: NodeId;
      readonly newOrder: readonly NodeId[];
    }
  | { readonly kind: 'ReplaceRoot'; readonly node: Node<TMsg> }
  | { readonly kind: 'Batch'; readonly ops: readonly TreeOp<TMsg>[] };
