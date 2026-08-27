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

import type {
  Accessibility,
  AriaRole,
  Binding,
  InputKind,
  Node,
  TextSource,
} from '@fuaran-ui/schema';
import type { Result } from '@fuaran-ui/schema';
import { defaults } from '@fuaran-ui/schema';

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
  | { readonly code: 'UNGROUNDED_SWITCH_STATE_KEY'; readonly nodeId: string }
  /**
   * FUARAN109 (warning) — an INTERACTIVE node that reaches a screen reader with
   * no name: its structural naming slot is an empty literal and the node
   * declares neither `accessibility.label` nor `accessibility.labelledBy`, so
   * its accessible name would have to come from its own text content and there
   * is none.
   *
   * Which kinds are interactive is READ from `defaults.accessibility.*` — the
   * per-kind trait the smart constructors pass — rather than tabled here: give
   * a kind a non-interactive default and it stops being audited in the same
   * edit. The lock is one-directional, so a newly interactive kind whose naming
   * slot is not wired below goes un-audited rather than falsely flagged.
   */
  | {
      readonly code: 'INTERACTIVE_WITHOUT_ACCESSIBLE_NAME';
      readonly nodeId: string;
      readonly kind: string;
      readonly slot: string;
    }
  /**
   * FUARAN110 (warning) — an `accessibility.labelledBy` / `describedBy` naming
   * a node id this tree does not carry. The renderer emits the reference
   * unconditionally, so the DOM gets an `aria-labelledby` pointing at nothing
   * and the browser ignores it: the element is announced as though the
   * reference had never been written.
   */
  | {
      readonly code: 'DANGLING_ACCESSIBILITY_REFERENCE';
      readonly nodeId: string;
      readonly slot: string;
      readonly target: string;
    }
  /**
   * FUARAN111 (warning) — an accessibility slot the node DECLARES and leaves
   * empty. Worse than an absent one in both directions: the renderer drops an
   * empty `aria-label`, so the declared name reaches nobody; and a declared
   * `label` is what tells FUARAN109 the node is named, so an empty one silences
   * the rule that would otherwise have caught it — the defect suppresses its
   * own detection. That is why the two ship together.
   */
  | {
      readonly code: 'EMPTY_ACCESSIBILITY_DECLARATION';
      readonly nodeId: string;
      readonly slot: string;
    };

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

  // ── The accessibility family (FUARAN109/110/111) ───────────────────────────
  //
  // Ported alongside the reference rules rather than after them, so the two
  // hosts do not disagree about what an emission means the moment the rules
  // exist. Three things are worth reading before changing any of it.
  //
  //  · The interactive KIND SET is read from `defaults.accessibility.*` — the
  //    per-kind trait the smart constructors pass — not tabled here. The
  //    language's own statement about a kind is the gate.
  //  · The accessible NAME is the browser's computation, in the browser's
  //    order: the declared trait label, then an `aria-labelledby` target, then
  //    the element's text content. Not "what the renderer emits": a button's
  //    structural label becomes the button's TEXT CONTENT and no `aria-label`,
  //    so a filled label with no trait at all is correctly named.
  //  · All three ERR TOWARDS SILENCE. Only literal text and static bindings are
  //    judged; anything that resolves at render time is left alone, because
  //    calling it empty would be a guess. An un-audited node is affordable; a
  //    false accusation against a correct tree is not.
  //
  // ONE DIVERGENCE from the reference, named rather than left to be discovered:
  // TypeScript's `AriaRole` is an OPEN string union (`(string & {})` tail), so
  // the exhaustive match that makes the reference's role classification fail to
  // compile when the vocabulary grows has no analogue here. The admitted set
  // below is the same one the reference admits; keeping it so is a discipline,
  // not something the compiler enforces on this side.
  const interactiveRoles: ReadonlySet<string> = new Set([
    'button',
    'link',
    'form',
    'tab',
    // The one widget role reached by any default the language ships (`select`).
    // The rest of the open role space is deliberately not judged.
    'combobox',
  ]);

  const declaresInteractive = (a11yDefault: Accessibility | undefined): boolean =>
    a11yDefault?.role !== undefined && interactiveRoles.has(a11yDefault.role as AriaRole & string);

  /** Text statically known to render nothing. Whitespace counts as empty. */
  const isEmptyTextSource = (t: TextSource): boolean =>
    t.kind === 'Literal' && t.value.trim() === '';

  /** A binding statically known to carry nothing — an empty or absent static. */
  const isEmptyStaticText = (b: Binding<string>): boolean =>
    b.kind === 'Static' && (b.value === undefined || b.value.trim() === '');

  /**
   * The naming slot of a kind the language pairs with an interactive default.
   * The interactivity verdict comes from the default; this only says WHICH slot
   * names the element — `submitLabel` for a form (through its submit button),
   * `label` for the other three.
   */
  const interactiveNaming = (
    input: InputKind<TMsg>,
  ):
    | {
        readonly a11yDefault: Accessibility | undefined;
        readonly naming: TextSource;
        readonly slot: string;
      }
    | undefined => {
    switch (input.kind) {
      case 'Button':
        return {
          a11yDefault: defaults.accessibility.button,
          naming: input.spec.label,
          slot: 'label',
        };
      case 'Select':
        return {
          a11yDefault: defaults.accessibility.select,
          naming: input.spec.label,
          slot: 'label',
        };
      case 'Form':
        return {
          a11yDefault: defaults.accessibility.form,
          naming: input.spec.submitLabel,
          slot: 'submitLabel',
        };
      case 'FileUpload':
        return {
          a11yDefault: defaults.accessibility.fileUpload,
          naming: input.spec.label,
          slot: 'label',
        };
      default:
        return undefined;
    }
  };

  // FUARAN110's evidence. Judged after the walk for the same reason the
  // reference judges it there: "names a node in this tree" is only answerable
  // once the whole tree has been seen.
  const accessibilityRefUses: { nodeId: string; slot: string; target: string }[] = [];

  const checkAccessibility = (n: Node<TMsg>): void => {
    const a11y = n.accessibility;

    // FUARAN109. Tested on the DECLARATION, not the emission: a bound label
    // resolves to nothing in a pre-emit walk and is still a name. An empty
    // declaration is FUARAN111's finding, not this one's — which is exactly the
    // hole the two rules close between them.
    if (n.kind.kind === 'Input') {
      const naming = interactiveNaming(n.kind.input);
      const declaresName = a11y?.label !== undefined || a11y?.labelledBy !== undefined;
      if (
        naming !== undefined &&
        declaresInteractive(naming.a11yDefault) &&
        isEmptyTextSource(naming.naming) &&
        !declaresName
      ) {
        defects.push({
          code: 'INTERACTIVE_WITHOUT_ACCESSIBLE_NAME',
          nodeId: n.id,
          kind: n.kind.input.kind,
          slot: naming.slot,
        });
      }
    }

    if (a11y === undefined) {
      return;
    }

    // FUARAN111 for the label slot, then both reference slots. A reference that
    // is present-but-empty is FUARAN111's, and is NOT also collected as a
    // dangling reference — reporting one value under two codes is noise rather
    // than coverage.
    if (a11y.label !== undefined && isEmptyStaticText(a11y.label)) {
      defects.push({ code: 'EMPTY_ACCESSIBILITY_DECLARATION', nodeId: n.id, slot: 'label' });
    }

    for (const slot of ['labelledBy', 'describedBy'] as const) {
      const target = a11y[slot];
      if (target === undefined) {
        continue;
      }
      if (target.trim() === '') {
        defects.push({ code: 'EMPTY_ACCESSIBILITY_DECLARATION', nodeId: n.id, slot });
      } else {
        accessibilityRefUses.push({ nodeId: n.id, slot, target });
      }
    }
  };

  const walk = (n: Node<TMsg>): void => {
    recordNodeId(n.id);
    // Sited before the per-kind switch because the trait it reads lives on the
    // NODE: one call covers every kind, and a kind the language newly declares
    // interactive is reached with no arm to remember.
    checkAccessibility(n);
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
            // Toggle (Phase 766) shares Checkbox's onToggle handler shape.
            const handler =
              fk.kind === 'Checkbox' || fk.kind === 'Toggle' ? fk.onToggle : fk.onChange;
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
        // FUARAN083 (Phase 392, widened by 768): an empty-key State selector is
        // ungrounded; any other Binding names its source and is grounded by
        // construction.
        if (k.spec.on.kind === 'State' && k.spec.on.key === '') {
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

  // FUARAN110 — a reference naming a node the tree does not carry.
  //
  // Judged against the ids THIS walk recorded. A second named divergence from
  // the reference, which judges against its cross-tree binding walk's node map:
  // that walk is machinery this host does not have, and the two universes agree
  // on everything a reference can honestly name. Where they could differ is a
  // boundary neither walk crosses (a fragment reference's body), and there both
  // answer "not in this tree", which is the correct answer for a host-tree
  // reference into a separate id space.
  for (const use of accessibilityRefUses) {
    if (!nodeIdCounts.has(use.target)) {
      defects.push({
        code: 'DANGLING_ACCESSIBILITY_REFERENCE',
        nodeId: use.nodeId,
        slot: use.slot,
        target: use.target,
      });
    }
  }

  return defects.length === 0
    ? { ok: true, value: node as ValidatedNode<TMsg> }
    : { ok: false, error: defects };
}
