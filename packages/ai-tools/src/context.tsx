// ============================================================================
//  @fuaran-ui/ai-tools — React context provider + useFuaranIntrospection hook.
//
//  Wrap a <FuaranRenderer> in a <FuaranIntrospectionProvider tree={tree}>; any
//  descendant can call useFuaranIntrospection() to read the typed Fuaran tree's
//  runtime introspection surface (getNodeState / findNodes / inspectTree)
//  rather than traversing the raw React tree.
// ============================================================================

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

import type { Node } from '@fuaran-ui/schema';

import {
  findNodes,
  getNodeState,
  inspectTree,
  type NodeIntrospection,
  type TreeIntrospection,
} from './introspection.js';

/** The introspection API bound to one tree, exposed via context. */
export interface FuaranIntrospection<TMsg> {
  /** The tree the API is bound to. */
  readonly tree: Node<TMsg>;
  /** The introspection envelope for a node by id, or `undefined`. */
  getNodeState(nodeId: string): NodeIntrospection | undefined;
  /** Every node matching the predicate, depth-first. */
  findNodes(predicate: (node: Node<TMsg>) => boolean): Node<TMsg>[];
  /** A recursive structural snapshot of the whole tree. */
  inspectTree(): TreeIntrospection;
}

const IntrospectionContext = createContext<FuaranIntrospection<unknown> | null>(null);

export interface FuaranIntrospectionProviderProps<TMsg> {
  readonly tree: Node<TMsg>;
  readonly children: ReactNode;
}

/** Provide the introspection API for `tree` to descendants. */
export function FuaranIntrospectionProvider<TMsg>(
  props: FuaranIntrospectionProviderProps<TMsg>,
): ReactNode {
  const { tree, children } = props;
  const api = useMemo<FuaranIntrospection<TMsg>>(
    () => ({
      tree,
      getNodeState: (nodeId: string) => getNodeState(tree, nodeId),
      findNodes: (predicate: (node: Node<TMsg>) => boolean) => findNodes(tree, predicate),
      inspectTree: () => inspectTree(tree),
    }),
    [tree],
  );
  return (
    <IntrospectionContext.Provider value={api as FuaranIntrospection<unknown>}>
      {children}
    </IntrospectionContext.Provider>
  );
}

/**
 * Access the introspection API for the nearest `<FuaranIntrospectionProvider>`.
 * Throws if called outside a provider.
 */
export function useFuaranIntrospection<TMsg = unknown>(): FuaranIntrospection<TMsg> {
  const ctx = useContext(IntrospectionContext);
  if (ctx === null) {
    throw new Error('useFuaranIntrospection must be used within a <FuaranIntrospectionProvider>.');
  }
  return ctx as FuaranIntrospection<TMsg>;
}
