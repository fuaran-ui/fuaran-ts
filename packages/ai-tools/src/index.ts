// @fuaran-ui/ai-tools — runtime tree-introspection surface for the Fuaran UI
// typed Node tree.
//
// Canonical import:
//   import { getNodeState, findNodes, inspectTree } from '@fuaran-ui/ai-tools';
//   import { FuaranIntrospectionProvider, useFuaranIntrospection } from '@fuaran-ui/ai-tools';
//
// The read-only introspection subset of the F# Fuaran.UI.AiTools tier: walk a
// typed Node tree and report each node's kind, its bound binding slots (with
// the canonical wire-form expression), and its structure — for a TS host's own
// AI integrations, dev tooling, accessibility audits, or integration tests,
// without traversing the raw React tree and losing the typed-Fuaran semantics.

export {
  type BindingSource,
  type BindingSlotInfo,
  type NodeIntrospection,
  type TreeIntrospection,
  kindName,
  bindingExpression,
  extractBindingSlots,
  bindingForSlot,
  childNodes,
  walkNodes,
  findNode,
  findNodes,
  getNodeState,
  inspectTree,
} from './introspection.js';

export {
  type FuaranIntrospection,
  type FuaranIntrospectionProviderProps,
  FuaranIntrospectionProvider,
  useFuaranIntrospection,
} from './context.js';
