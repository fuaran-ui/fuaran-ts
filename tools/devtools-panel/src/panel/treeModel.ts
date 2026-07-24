// ============================================================================
//  treeModel — pure projection of a TreeIntrospection into renderable rows.
//
//  The panel renders the typed Node tree (via @fuaran-ui/ai-tools
//  introspection), never the DOM tree. Flattening is pure so the collapse /
//  selection logic is unit-testable without a DOM.
// ============================================================================

import type { TreeIntrospection } from '@fuaran-ui/ai-tools';

/** One renderable tree row. */
export interface TreeRow {
  readonly id: string;
  readonly kind: string;
  readonly depth: number;
  readonly bindingCount: number;
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
}

/**
 * Depth-first flatten of the introspection tree, honouring `collapsed`:
 * a collapsed node emits its own row but none of its descendants.
 */
export const flattenTree = (tree: TreeIntrospection, collapsed: ReadonlySet<string>): TreeRow[] => {
  const rows: TreeRow[] = [];
  const walk = (node: TreeIntrospection, depth: number): void => {
    const isCollapsed = collapsed.has(node.id);
    rows.push({
      id: node.id,
      kind: node.kind,
      depth,
      bindingCount: node.bindings.length,
      hasChildren: node.children.length > 0,
      collapsed: isCollapsed,
    });
    if (!isCollapsed) for (const child of node.children) walk(child, depth + 1);
  };
  walk(tree, 0);
  return rows;
};

/** Find one node's introspection by id (depth-first). */
export const findIntrospection = (
  tree: TreeIntrospection,
  id: string,
): TreeIntrospection | undefined => {
  if (tree.id === id) return tree;
  for (const child of tree.children) {
    const found = findIntrospection(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
};
