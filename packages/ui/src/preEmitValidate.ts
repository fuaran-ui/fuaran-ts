// ============================================================================
//  @fuaran-ui/ui — pre-emit tree-invariant checks (port of
//  Fuaran.UI/PreEmitValidate.fs).
//
//  The type system enforces node-level invariants (every Node has required
//  state + style; every spec's fields are typed). Two invariants live above
//  the type level — tree-wide NodeId uniqueness + non-emptiness of identifier
//  strings — and must be checked by walking the tree. This is the canonical
//  walker.
//
//  `validate` returns a `Result`: `ok` carries the input branded as a
//  `ValidatedNode<TMsg>` (proof it passed); `error` carries EVERY defect found
//  (NOT short-circuited on the first) so an AI author can repair the whole tree
//  in one turn. Defect `code` values are SCREAMING_SNAKE strings that match the
//  F# defect identities byte-for-byte (`EMPTY_NODE_ID`, …) so a future
//  cross-implementation eval suite scores uniformly.
// ============================================================================

import type { Node } from '@fuaran-ui/schema';
import type { Result } from '@fuaran-ui/schema';

/** A pre-emit defect surfaced by `validate`. Discriminated by `code`. */
export type PreEmitDefect =
  /** An `id` is the empty string. The wire form requires a non-empty identifier. */
  | { readonly code: 'EMPTY_NODE_ID' }
  /** `id` appears as the NodeId of multiple nodes (`count` ≥ 2). Breaks op addressing. */
  | { readonly code: 'DUPLICATE_NODE_ID'; readonly id: string; readonly count: number }
  /** A `Custom` node has an empty `moduleId` or `componentId`. */
  | {
      readonly code: 'EMPTY_CUSTOM_KIND_IDENTIFIER';
      readonly moduleId: string;
      readonly componentId: string;
    }
  /** FUARAN047 — `tabHeaders` length ≠ `children` length. */
  | {
      readonly code: 'TAB_HEADER_COUNT_MISMATCH';
      readonly nodeId: string;
      readonly headerCount: number;
      readonly childrenCount: number;
    }
  /** FUARAN048 — `tabTags` length ≠ `children` length. */
  | {
      readonly code: 'TAB_TAG_COUNT_MISMATCH';
      readonly nodeId: string;
      readonly tagCount: number;
      readonly childrenCount: number;
    }
  /** FUARAN049 (warning) — `activeTag` set but `tabTags` absent. */
  | { readonly code: 'TAB_ACTIVE_TAG_WITHOUT_TAGS'; readonly nodeId: string }
  /**
   * FUARAN069 (warning) — an interactive control's event handler is omitted
   * (the Phase 426 write-back shape) but its value binding is NOT a writable
   * store binding (directly `State` / `Filter`), so the control is inert.
   * `control` is a short descriptor (`FormField(<id>)`, `Select`, `Tabs`,
   * `Modal`, `Disclosure`).
   */
  | { readonly code: 'INERT_CONTROL'; readonly nodeId: string; readonly control: string }
  /**
   * FUARAN082 (error) — a `Switch` has two or more cases with the same `match`
   * value (Phase 392). First-match-wins makes the later case dead; give each
   * case a distinct match value.
   */
  | { readonly code: 'DUPLICATE_SWITCH_MATCH'; readonly nodeId: string; readonly match: string }
  /**
   * FUARAN083 (warning) — a `Switch` has an empty `stateKey` (Phase 392): it can
   * never resolve a case and is stuck on its default; name the state key it
   * selects on.
   */
  | { readonly code: 'UNGROUNDED_SWITCH_STATE_KEY'; readonly nodeId: string };

/**
 * A `Node` proven to have passed `validate`. The phantom brand makes "I have
 * validated this tree" a fact downstream code can require in a type signature
 * rather than re-checking.
 */
export type ValidatedNode<TMsg> = Node<TMsg> & { readonly __validated: 'PreEmitValidate' };

/**
 * Walk `node` (depth-first, pre-order) and surface every pre-emit defect.
 * `ok` on a clean tree (carrying the branded node); `error` carries every
 * defect found.
 */
export function preEmitValidate<TMsg>(
  node: Node<TMsg>,
): Result<ValidatedNode<TMsg>, readonly PreEmitDefect[]> {
  const defects: PreEmitDefect[] = [];
  const nodeIdCounts = new Map<string, number>();

  const recordNodeId = (raw: string): void => {
    if (raw === '') {
      defects.push({ code: 'EMPTY_NODE_ID' });
    } else {
      nodeIdCounts.set(raw, (nodeIdCounts.get(raw) ?? 0) + 1);
    }
  };

  // A binding the Phase 426 control write-back default can write to: directly
  // `State` or `Filter`. A `Local` binding also counts as live — its Phase 62
  // commit pipeline carries the change independently of the handler.
  const isWriteBackTarget = (binding: { readonly kind: string }): boolean =>
    binding.kind === 'State' || binding.kind === 'Filter' || binding.kind === 'Local';

  const walk = (n: Node<TMsg>): void => {
    recordNodeId(n.id);
    const k = n.kind;
    switch (k.kind) {
      case 'Layout': {
        const layout = k.layout;
        switch (layout.kind) {
          case 'Tabs': {
            const spec = layout.spec;
            const childrenCount = spec.children.length;
            if (spec.tabHeaders !== undefined && spec.tabHeaders.length !== childrenCount) {
              defects.push({
                code: 'TAB_HEADER_COUNT_MISMATCH',
                nodeId: n.id,
                headerCount: spec.tabHeaders.length,
                childrenCount,
              });
            }
            if (spec.tabTags !== undefined && spec.tabTags.length !== childrenCount) {
              defects.push({
                code: 'TAB_TAG_COUNT_MISMATCH',
                nodeId: n.id,
                tagCount: spec.tabTags.length,
                childrenCount,
              });
            }
            if (spec.activeTag !== undefined && spec.tabTags === undefined) {
              defects.push({ code: 'TAB_ACTIVE_TAG_WITHOUT_TAGS', nodeId: n.id });
            }
            // FUARAN069 (Phase 426): tabs are live when either channel can
            // carry a click — a handler, or a writable slot the write-back
            // default targets.
            const indexLive = spec.onSelect !== undefined || isWriteBackTarget(spec.activeIndex);
            const tagLive =
              spec.tabTags !== undefined &&
              (spec.onSelectTag !== undefined ||
                (spec.activeTag !== undefined && isWriteBackTarget(spec.activeTag)));
            if (!indexLive && !tagLive) {
              defects.push({ code: 'INERT_CONTROL', nodeId: n.id, control: 'Tabs' });
            }
            spec.children.forEach(walk);
            break;
          }
          case 'Disclosure': {
            const spec = layout.spec;
            // FUARAN069 (Phase 426): no toggle handler and no writable `open`
            // slot — the model never hears the native toggle.
            if (spec.onToggle === undefined && !isWriteBackTarget(spec.open)) {
              defects.push({ code: 'INERT_CONTROL', nodeId: n.id, control: 'Disclosure' });
            }
            spec.children.forEach(walk);
            break;
          }
          case 'Modal': {
            const spec = layout.spec;
            // FUARAN069 (Phase 426): a dismissable modal with no dismiss
            // action and no writable `open` slot can never close.
            if (spec.dismissable && spec.onDismiss === undefined && !isWriteBackTarget(spec.open)) {
              defects.push({ code: 'INERT_CONTROL', nodeId: n.id, control: 'Modal' });
            }
            spec.children.forEach(walk);
            break;
          }
          case 'Box':
          case 'SplitPanel':
          case 'Stepper':
          case 'SummaryList':
          case 'ScrollArea':
            layout.spec.children.forEach(walk);
            break;
        }
        break;
      }
      case 'Display':
      case 'Visualisation':
        // Leaves for tree-walk purposes (form fields / columns are not Nodes).
        break;
      case 'Input': {
        // FUARAN069 (Phase 426): an interactive input whose handler is omitted
        // needs a writable value binding for the write-back default to target.
        // Filter chips are exempt — a handler-free chip always writes its own
        // `$filters.<name>` (Phase 423).
        const input = k.input;
        if (input.kind === 'Form') {
          for (const field of input.spec.fields) {
            const fk = field.kind;
            const handler = fk.kind === 'Checkbox' ? fk.onToggle : fk.onChange;
            if (handler === undefined && !isWriteBackTarget(fk.value)) {
              defects.push({
                code: 'INERT_CONTROL',
                nodeId: n.id,
                control: `FormField(${field.id})`,
              });
            }
          }
        } else if (input.kind === 'Select') {
          const spec = input.spec;
          if (spec.multiple === true) {
            const valuesLive = spec.values !== undefined && isWriteBackTarget(spec.values);
            if (spec.onChangeMulti === undefined && !valuesLive) {
              defects.push({ code: 'INERT_CONTROL', nodeId: n.id, control: 'Select(multiple)' });
            }
          } else if (spec.onChange === undefined && !isWriteBackTarget(spec.value)) {
            defects.push({ code: 'INERT_CONTROL', nodeId: n.id, control: 'Select' });
          }
        }
        break;
      }
      case 'Custom':
        if (k.moduleId === '' || k.componentId === '') {
          defects.push({
            code: 'EMPTY_CUSTOM_KIND_IDENTIFIER',
            moduleId: k.moduleId,
            componentId: k.componentId,
          });
        }
        break;
      case 'ErrorBoundary':
        walk(k.spec.child);
        walk(k.spec.fallback);
        break;
      case 'Switch': {
        // FUARAN083 (Phase 392): an empty state key is ungrounded.
        if (k.spec.stateKey === '') {
          defects.push({ code: 'UNGROUNDED_SWITCH_STATE_KEY', nodeId: n.id });
        }
        // FUARAN082 (Phase 392): duplicate match values make the later case
        // dead (first-match-wins). Report each duplicated value once.
        const seen = new Set<string>();
        const reported = new Set<string>();
        for (const c of k.spec.cases) {
          if (seen.has(c.match) && !reported.has(c.match)) {
            defects.push({ code: 'DUPLICATE_SWITCH_MATCH', nodeId: n.id, match: c.match });
            reported.add(c.match);
          }
          seen.add(c.match);
          walk(c.child);
        }
        walk(k.spec.default);
        break;
      }
      case 'FragmentDecl':
        walk(k.spec.body);
        break;
      case 'FragmentRef':
        break;
    }
  };

  walk(node);

  for (const [id, count] of nodeIdCounts) {
    if (count >= 2) {
      defects.push({ code: 'DUPLICATE_NODE_ID', id, count });
    }
  }

  return defects.length === 0
    ? { ok: true, value: node as ValidatedNode<TMsg> }
    : { ok: false, error: defects };
}
