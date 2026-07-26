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
  Binding,
  Node,
  NodeId,
  NodeKind,
  SemanticStyle,
  StateBehaviour,
  JsonValue,
} from '@fuaran-ui/schema';

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
  | { readonly kind: 'UpdateState'; readonly target: NodeId; readonly state: StateBehaviour<TMsg> }
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
