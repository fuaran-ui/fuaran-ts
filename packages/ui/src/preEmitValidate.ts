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
import type { ChartSpec, ColumnErased, ColumnType, GridSpec, Result } from '@fuaran-ui/schema';
import { defaults } from '@fuaran-ui/schema';

import {
  ofPipeline,
  schemaHas,
  schemaNames,
  schemaTypeOf,
  type SchemaKnowledge,
} from './schemaWalk.js';

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
   * FUARAN147 (error) — a `SwitchCase` carries BOTH a string `match` and a
   * predicate `when`, or NEITHER (Phase 1535). Exactly one is meaningful:
   * `match` compares the switch's `on` selector against a literal, `when`
   * evaluates a `Binding<boolean>` and needs no selector at all.
   *
   * The PRE-EMIT twin of the decoder's own refusal, and it exists for the reason
   * every pre-emit shape rule does: a tree AUTHORED in TypeScript never passes
   * through the decoder, so without it the one shape the wire refuses is
   * reachable by construction.
   */
  | {
      readonly code: 'SWITCH_CASE_SELECTOR_SHAPE';
      readonly nodeId: string;
      readonly caseIndex: number;
      readonly bothPresent: boolean;
    }
  /**
   * FUARAN083 (warning) — a `Switch` has an empty `stateKey` (Phase 392): it can
   * never resolve a case and is stuck on its default; name the state key it
   * selects on.
   */
  | { readonly code: 'UNGROUNDED_SWITCH_STATE_KEY'; readonly nodeId: string }
  /**
   * FUARAN090 (warning) — a `Grid` carries `editable: true` but no edit has
   * anywhere to go: it declares no `editStateKey`, and its `source` is not
   * directly a `State` binding. The FUARAN069 inert-control condition replayed
   * for the grid — a `Transform` pipeline is not invertible, `Static` / `Query`
   * rows are host data, and `staticRows` are immutable by definition — so every
   * cell renders read-only and the flag is dead intent.
   *
   * The condition is the renderer's own, not a second statement of it: the
   * grid's `editDestination` (`render/Visualisation.tsx`) resolves a declared
   * `editStateKey` first and falls back to a `State` source, drawing no input
   * when neither is present. This rule fires on exactly the trees that
   * resolution leaves without a destination, so the two cannot disagree about
   * what an emission means.
   */
  | { readonly code: 'INERT_EDITABLE_GRID'; readonly nodeId: string }
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
    }
  /**
   * FUARAN075 (error) — a node DECLARES a filter edge on a name no `Filters`
   * chip in the tree declares. Two shapes carry such an edge: a `Query`'s
   * `dependsOn` entry, and a `Transform` / `Expr` param whose `from` is a
   * `Filter` binding.
   *
   * It is an ERROR, and the reason is that nothing downstream of the tree can
   * notice. An undeclared chip resolves to nothing exactly as an UNSET chip
   * does, and the lenient "unset filter ⇒ no constraint" prune then drops the
   * dependent pipeline step — so a resolver silently returns the UNFILTERED set
   * for a document whose author asked for a filter. On the `dependsOn` arm it
   * is sharper still: that list is an invalidation SUBSCRIPTION, so an
   * undeclared name subscribes a consumer to a slot nothing can ever write.
   * Neither shape is a codec defect — both documents are perfectly legal wire
   * and round-trip byte-identically — so this rule is the whole of the guard.
   *
   * `wire-format-fixtures/nodes/filters-param-source-{declared,undeclared}.json`
   * (Phase 1784, the param-source arm) and `filters-dependson-*.json` (Phase
   * 1800, the `dependsOn` arm) are the corpus twins: each pair differs in
   * exactly one thing, whether the `Filters` node declares the second chip.
   */
  | {
      readonly code: 'DANGLING_FILTER_REFERENCE';
      readonly nodeId: string;
      readonly name: string;
    }
  /**
   * FUARAN086 (error) — a chart's `xField` or a `yFields` entry names a column
   * its own `Transform` source cannot PRODUCE (Phase 1889, porting the
   * reference's Phase 640/1486 rule). The produced schema is the one the static
   * walk (`schemaWalk.ts`) derives over the whole pipeline, and only a CLOSED
   * walk supports the verdict: a `Ref` source, a `pivot`, a live source, or any
   * non-Transform source passes ungrounded. `schemaColumns` is what the source
   * does produce — under a pipeline it is no longer readable off the tree.
   */
  | {
      readonly code: 'CHART_FIELD_UNGROUNDED';
      readonly nodeId: string;
      readonly field: string;
      readonly schemaColumns: readonly string[];
    }
  /**
   * FUARAN087 (error) — a grounded chart VALUE field (a `yFields` entry, or the
   * `xField` of a non-temporal `Scatter`) has a column type the lowering cannot
   * plot numerically; anything outside int/float/bool reads as 0, a silently
   * flat series. Only where the column's type is decidable — a `derive`d column
   * of data-dependent type says nothing here.
   */
  | {
      readonly code: 'CHART_FIELD_TYPE_MISMATCH';
      readonly nodeId: string;
      readonly field: string;
      readonly columnType: string;
    }
  /**
   * FUARAN097 (error) — a chart declaring `xScale: 'Temporal'` whose grounded
   * `xField` is neither a `date` nor a `timestamp` column: every row's x would
   * read as the epoch.
   */
  | {
      readonly code: 'CHART_TEMPORAL_X_NOT_DATE';
      readonly nodeId: string;
      readonly field: string;
      readonly columnType: string;
    }
  /**
   * FUARAN114 (error) — a grid column's `field`, or the grid's `rowKeyField`,
   * names a column its own `Transform` source cannot produce: whatever reads the
   * name (a cell that displays the field, sort, export) reads nothing, or every
   * row keys off one empty string. The read-side twin of FUARAN086, over the
   * same walk and by the same restraint. Phase 1909: an action column's field is
   * never grounded (FUARAN163 below).
   */
  | {
      readonly code: 'GRID_FIELD_UNGROUNDED';
      readonly nodeId: string;
      readonly field: string;
      readonly schemaColumns: readonly string[];
    }
  /**
   * FUARAN114 (error), the `TonedPill` sub-case (Phase 1909) — a column's
   * `TonedPill` cell names, in its OWN `field`, a column the grid's source
   * cannot produce. The field is the pill's label and its tone key, so every row
   * draws an empty pill in the default tone. Same window, same repair as
   * FUARAN114, so the same code; the column label locates the cell.
   */
  | {
      readonly code: 'GRID_PILL_FIELD_UNGROUNDED';
      readonly nodeId: string;
      readonly columnLabel: string;
      readonly field: string;
      readonly schemaColumns: readonly string[];
    }
  /**
   * FUARAN163 (warning, Phase 1909) — an ACTION column (cell kind `Button` /
   * `ButtonGroup`) declares a `field`. The cell draws its own label and hands
   * the whole row to its handler, so the field is never displayed, and sort
   * and export ignore it: drop it. An action column carries no field.
   */
  | {
      readonly code: 'ACTION_COLUMN_FIELD';
      readonly nodeId: string;
      readonly columnLabel: string;
      readonly field: string;
    };

/**
 * Phase 1909 — an ACTION column: cell kind `Button` or `ButtonGroup`. Its cell
 * never displays the column's `field`, so no rule grounds that field, and sort
 * and export ignore it (the renderer's `Visualisation.tsx` reads the same kind
 * test). Parity with the reference's `GridColumn.isAction`.
 */
const isActionColumn = <TMsg>(col: ColumnErased<TMsg>): boolean =>
  col.kind.kind === 'Button' || col.kind.kind === 'ButtonGroup';

/**
 * The schema a reader's `source` slot PRODUCES, when that slot is a non-live
 * `Transform` — the only shape the grounding rules judge. `undefined` for a
 * live Transform (its table is a decode-time snapshot, not a statement about
 * later rows) and for every other binding.
 */
const producedSchemaOf = (source: { readonly kind: string }): SchemaKnowledge | undefined => {
  const b = source as Binding<unknown>;
  return b.kind === 'Transform' && b.source.kind === 'Data'
    ? ofPipeline(b.source.source, b.pipeline)
    : undefined;
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
  return runPreEmit(node, undefined);
}

/** A chart or grid the walk reached: its wire kind name and its row source. */
interface ReachedReader {
  readonly reader: 'Chart' | 'DataGrid';
  readonly source: Binding<unknown>;
}

/**
 * The one walk behind `preEmitValidate` and `bindingChecks`. `onReader` sees
 * every chart and grid the walk reaches, so the report grades exactly the
 * readers the rules judged — one walk, so the two cannot drift.
 */
function runPreEmit<TMsg>(
  node: Node<TMsg>,
  onReader: ((id: string, r: ReachedReader) => void) | undefined,
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

  // ── FUARAN086 / 087 / 097 / 114 — references grounded in the produced schema ──
  //
  // Phase 1889. The reference's rules, in the reference's order, over the same
  // walk: a CLOSED produced schema refuses an absent name; an open one — or no
  // Transform at all — stands down. Nothing here guesses: a column present with
  // a data-dependent type grounds FUARAN086 and says nothing typed.
  const checkChartGrounding = (nodeId: string, spec: ChartSpec<TMsg>): void => {
    const produced = producedSchemaOf(spec.source);
    if (produced === undefined || produced.kind !== 'Closed') return;
    const schemaColumns = schemaNames(produced);
    const numeric = (t: ColumnType): boolean => t === 'int' || t === 'float' || t === 'bool';
    const temporalX = spec.xScale === 'Temporal';

    if (!schemaHas(spec.xField, produced)) {
      defects.push({ code: 'CHART_FIELD_UNGROUNDED', nodeId, field: spec.xField, schemaColumns });
    } else {
      const t = schemaTypeOf(spec.xField, produced);
      if (t !== undefined) {
        if (temporalX && t !== 'date' && t !== 'timestamp')
          defects.push({
            code: 'CHART_TEMPORAL_X_NOT_DATE',
            nodeId,
            field: spec.xField,
            columnType: t,
          });
        // The x arm is narrowed by a temporal declaration: a temporal Scatter
        // reads its x as dates, which FUARAN097 governs.
        if (spec.kind === 'Scatter' && !numeric(t) && !temporalX)
          defects.push({
            code: 'CHART_FIELD_TYPE_MISMATCH',
            nodeId,
            field: spec.xField,
            columnType: t,
          });
      }
    }

    for (const yf of spec.yFields) {
      if (!schemaHas(yf, produced)) {
        defects.push({ code: 'CHART_FIELD_UNGROUNDED', nodeId, field: yf, schemaColumns });
      } else {
        const t = schemaTypeOf(yf, produced);
        if (t !== undefined && !numeric(t))
          defects.push({ code: 'CHART_FIELD_TYPE_MISMATCH', nodeId, field: yf, columnType: t });
      }
    }
  };

  const checkGridGrounding = (nodeId: string, spec: GridSpec<TMsg>): void => {
    const produced = producedSchemaOf(spec.source);
    if (produced === undefined || produced.kind !== 'Closed') return;
    const schemaColumns = schemaNames(produced);
    // Per offending name, not once per grid: a grid pointed at the wrong source
    // names several missing columns, and the author repairs each of them.
    const ground = (field: string): void => {
      if (!schemaHas(field, produced))
        defects.push({ code: 'GRID_FIELD_UNGROUNDED', nodeId, field, schemaColumns });
    };
    // Phase 1909 — an action column's field is read by nothing, so it is not
    // grounded; a TonedPill's OWN field is a column reference and is (FUARAN114's
    // sub-case), in the reference's order: each column's field, then its pill.
    for (const c of spec.columns) {
      if (c.field !== undefined && !isActionColumn(c)) ground(c.field);
      if (c.kind.kind === 'TonedPill' && !schemaHas(c.kind.field, produced))
        defects.push({
          code: 'GRID_PILL_FIELD_UNGROUNDED',
          nodeId,
          columnLabel: c.label,
          field: c.kind.field,
          schemaColumns,
        });
    }
    if (spec.rowKeyField !== undefined) ground(spec.rowKeyField);
  };

  // FUARAN163 (Phase 1909): a declared field on an action column does nothing.
  // Independent of the source — the field is dead whatever the grid reads.
  const checkActionColumns = (nodeId: string, spec: GridSpec<TMsg>): void => {
    for (const c of spec.columns)
      if (isActionColumn(c) && c.field !== undefined)
        defects.push({ code: 'ACTION_COLUMN_FIELD', nodeId, columnLabel: c.label, field: c.field });
  };

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

  // ── FUARAN075's evidence (Phase 1800) ─────────────────────────────────────
  //
  // Both halves are judged AFTER the walk, for FUARAN110's reason: "names a
  // chip this tree declares" is only answerable once the whole tree has been
  // seen, and a consumer may precede its `Filters` sibling in document order.
  //
  // The chip declarations are collected by the walk itself — the `Filters` arm
  // knows exactly where a chip name lives. The EDGES are collected by a
  // structural scan instead, and that choice is worth stating because it is a
  // divergence from the reference host. The reference has a cross-tree binding
  // walk (`BindingWalk`) that enumerates every binding slot of every kind;
  // this host has none, and writing the slot enumeration out by hand here
  // would be a second copy of the schema that goes stale the first time a kind
  // gains a data slot — the failure mode being SILENCE, which is the one this
  // rule exists to remove. So the scan descends generically and recognises the
  // two edge shapes by their wire discriminator.
  //
  // Attribution is by NEAREST ENCLOSING NODE, and the node boundary is not a
  // heuristic: it is the set of node objects the walk above actually visited,
  // so this scan and the walk cannot disagree about what a node is.
  const visitedNodes = new Map<object, string>();
  const filterDeclarations = new Set<string>();
  const filterEdgeUses: { nodeId: string; name: string }[] = [];

  const collectFilterEdges = (value: unknown, owner: string, seen: WeakSet<object>): void => {
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) collectFilterEdges(item, owner, seen);
      return;
    }

    const o = value as Record<string, unknown>;
    const nodeId = visitedNodes.get(value) ?? owner;
    const discriminator = o['kind'];

    // Arm 1 — a `Query`'s declared filter dependency edge (Phase 421).
    if (discriminator === 'Query' && Array.isArray(o['dependsOn'])) {
      for (const name of o['dependsOn'] as readonly unknown[]) {
        if (typeof name === 'string') filterEdgeUses.push({ nodeId, name });
      }
    }

    // Arm 2 — a `Transform` / `Expr` param sourced from a chip (Phase 424 /
    // 1534). A param's `Filter` source is the DECLARED edge; a plain `Filter`
    // binding elsewhere is an ordinary value read and is not judged here.
    if ((discriminator === 'Transform' || discriminator === 'Expr') && Array.isArray(o['params'])) {
      for (const param of o['params'] as readonly unknown[]) {
        if (param === null || typeof param !== 'object') continue;
        const from = (param as Record<string, unknown>)['from'];
        if (from === null || typeof from !== 'object') continue;
        const source = from as Record<string, unknown>;
        if (source['kind'] === 'Filter' && typeof source['name'] === 'string') {
          filterEdgeUses.push({ nodeId, name: source['name'] });
        }
      }
    }

    for (const child of Object.values(o)) collectFilterEdges(child, nodeId, seen);
  };

  const walk = (n: Node<TMsg>): void => {
    visitedNodes.set(n, n.id);

    if (n.kind.kind === 'Input' && n.kind.input.kind === 'Filters') {
      for (const spec of n.kind.input.specs) filterDeclarations.add(spec.name);
    }

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
        // A leaf for tree-walk purposes (form fields / columns are not Nodes).
        break;
      case 'Visualisation': {
        // Also a tree-walk leaf — a grid's columns are not Nodes — but the grid
        // spec carries one invariant above the type level.
        //
        // FUARAN090 (Phase 663, widened by Phase 863): `editable: true` means
        // something only when the whole-rows write has a destination. Asked
        // through the same two-step the renderer resolves — a declared
        // `editStateKey` wins, else the grid's own `source` when that source is
        // directly a `State` binding — so the rule and the render agree by
        // construction rather than by two people writing the same condition.
        const vis = k.visualisation;
        if (vis.kind === 'Chart') {
          onReader?.(n.id, { reader: 'Chart', source: vis.spec.source as Binding<unknown> });
          checkChartGrounding(n.id, vis.spec);
        }
        if (vis.kind === 'Grid') {
          const spec = vis.spec;
          onReader?.(n.id, { reader: 'DataGrid', source: spec.source as Binding<unknown> });
          checkActionColumns(n.id, spec);
          checkGridGrounding(n.id, spec);
          const destination = spec.editStateKey !== undefined || spec.source.kind === 'State';
          if (spec.editable && !destination) {
            defects.push({ code: 'INERT_EDITABLE_GRID', nodeId: n.id });
          }
        }
        break;
      }
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
        //
        // Phase 1535 — over the MATCH cases only. Two predicate cases are not
        // duplicates of each other: `when` carries a binding, two bindings that
        // happen to be equal today may resolve differently tomorrow, and
        // structural equality of two predicates is not the question this rule
        // asks. FUARAN147 below is the shape rule for the case itself.
        const seen = new Set<string>();
        const reported = new Set<string>();
        k.spec.cases.forEach((c, i) => {
          if (c.match !== undefined && c.when !== undefined)
            defects.push({
              code: 'SWITCH_CASE_SELECTOR_SHAPE',
              nodeId: n.id,
              caseIndex: i,
              bothPresent: true,
            });
          else if (c.match === undefined && c.when === undefined)
            defects.push({
              code: 'SWITCH_CASE_SELECTOR_SHAPE',
              nodeId: n.id,
              caseIndex: i,
              bothPresent: false,
            });
          if (c.match !== undefined) {
            if (seen.has(c.match) && !reported.has(c.match)) {
              defects.push({ code: 'DUPLICATE_SWITCH_MATCH', nodeId: n.id, match: c.match });
              reported.add(c.match);
            }
            seen.add(c.match);
          }
          walk(c.child);
        });
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

  // FUARAN075 — a declared filter edge grounded in no chip. The scan runs from
  // the root once, after the walk has recorded what a node is.
  collectFilterEdges(node, node.id, new WeakSet<object>());

  for (const use of filterEdgeUses) {
    if (!filterDeclarations.has(use.name)) {
      defects.push({ code: 'DANGLING_FILTER_REFERENCE', nodeId: use.nodeId, name: use.name });
    }
  }

  return defects.length === 0
    ? { ok: true, value: node as ValidatedNode<TMsg> }
    : { ok: false, error: defects };
}

// ============================================================================
//  Phase 1889 — the binding-check report: every chart and grid, graded.
//
//  The port of the reference's `PreEmitValidate.bindingChecks`. The grounding
//  rules above say what is WRONG; they cannot say which readers were JUDGED —
//  a reader over a `Query`, a `State`, an undeclared `Ref` or a `pivot` passes
//  exactly as a proven-correct one does. This report separates the two: each
//  reader is graded `Checked` or `Unchecked` (with why), and each finding is
//  located by JSONPath into the canonical wire document and paired with the
//  schema the source does produce. It mints no code and changes no verdict.
//
//  Paths address the WIRE document, so the caller passes it: this package has
//  no encoder (that is `@fuaran-ui/ops`), and a path computed from the
//  in-memory shape would address a document nobody receives. The call is
//  `bindingChecks(tree, JSON.parse(encodeNode(tree)))`.
//
//  ONE NAMED DIVERGENCE: a reader the document carries but this host's walk
//  does not reach is graded `NotReached` — the grounding rules did not judge it
//  either, and saying so is the honest answer. The reference's walk reaches
//  every node its encoder emits, so it never produces this grade.
// ============================================================================

/** Why a reader could not be judged — a statement about its SOURCE. */
export type UncheckedReason =
  /** A Transform whose produced column set is open (`why` is the walk's own sentence). */
  | { readonly kind: 'OpenSchema'; readonly why: string }
  /** A live Transform: its table is a decode-time snapshot. */
  | { readonly kind: 'LiveSource' }
  /** Not a Transform at all; `sourceKind` is the source binding's wire `$type`. */
  | { readonly kind: 'NoStaticSchema'; readonly sourceKind: string }
  /** A grid carrying `staticRows`: its rows are in the tree. */
  | { readonly kind: 'StaticRows' }
  /** This host's walk does not reach the reader (see the divergence above). */
  | { readonly kind: 'NotReached' };

export type BindingGrade =
  | { readonly kind: 'Checked' }
  | { readonly kind: 'Unchecked'; readonly reason: UncheckedReason };

/** One produced column; `type` absent where data-dependent. */
export interface ProducedColumn {
  readonly name: string;
  readonly type?: ColumnType;
}

/** One grounding finding about a reader, located. */
export interface BindingDiagnostic {
  /** The FUARAN code (`FUARAN086` / `087` / `097` / `114`). */
  readonly code: string;
  /** JSONPath of the slot the finding is about. */
  readonly path: string;
  readonly defect: PreEmitDefect;
}

export interface BindingCheck {
  readonly nodeId: string;
  /** `Chart` or `DataGrid` — the wire kind name. */
  readonly reader: 'Chart' | 'DataGrid';
  /** JSONPath of the reader's `source` slot (a `staticRows` grid: that slot). */
  readonly path: string;
  readonly grade: BindingGrade;
  readonly produced: readonly ProducedColumn[];
  readonly diagnostics: readonly BindingDiagnostic[];
}

type JsonObject = { readonly [k: string]: unknown };

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const jsonPathMember = (key: string): string =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `.${key}`
    : `['${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;

/** Every Chart / DataGrid node object in the document, in document order, with its path. */
const readerObjects = (
  doc: unknown,
): { id: string; reader: 'Chart' | 'DataGrid'; path: string; kind: JsonObject }[] => {
  const found: { id: string; reader: 'Chart' | 'DataGrid'; path: string; kind: JsonObject }[] = [];
  const go = (path: string, v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach((child, i) => go(`${path}[${i}]`, child));
    } else if (isObject(v)) {
      const kind = v['kind'];
      if (typeof v['id'] === 'string' && isObject(kind)) {
        const t = kind['$type'];
        if (t === 'Chart' || t === 'DataGrid') found.push({ id: v['id'], reader: t, path, kind });
      }
      for (const [k, child] of Object.entries(v)) go(path + jsonPathMember(k), child);
    }
  };
  go('$', doc);
  return found;
};

/** The slots a finding of rule `rule` can be about, in that rule's reading order. */
const referenceSlots = (
  rule: string,
  reader: 'Chart' | 'DataGrid',
  kindPath: string,
  kind: JsonObject,
): { field: string; path: string }[] => {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  if (reader === 'Chart') {
    const xf = str(kind['xField']);
    const x = xf === undefined ? [] : [{ field: xf, path: `${kindPath}.xField` }];
    const yRaw = kind['yFields'];
    const ys = Array.isArray(yRaw)
      ? yRaw.flatMap((y, i) => {
          const f = str(y);
          return f === undefined ? [] : [{ field: f, path: `${kindPath}.yFields[${i}]` }];
        })
      : [];
    const scatter = kind['kind'] === 'Scatter';
    const temporal = kind['xScale'] === 'Temporal';
    if (rule === 'FUARAN097') return x;
    if (rule === 'FUARAN087') return [...(scatter && !temporal ? x : []), ...ys];
    return [...x, ...ys];
  }
  const colsRaw = kind['columns'];
  const cellTypeOf = (c: JsonObject): string | undefined => {
    const k = c['kind'];
    return isObject(k) ? str(k['$type']) : undefined;
  };
  // Phase 1909 — FUARAN114's TonedPill sub-case names the cell's OWN field.
  if (rule === 'FUARAN114-pill')
    return Array.isArray(colsRaw)
      ? colsRaw.flatMap((c, i) => {
          if (!isObject(c) || cellTypeOf(c) !== 'TonedPill') return [];
          const k = c['kind'] as JsonObject;
          const f = str(k['field']);
          return f === undefined
            ? []
            : [{ field: f, path: `${kindPath}.columns[${i}].kind.field` }];
        })
      : [];
  // An action column's field is never grounded, so it is no slot a finding is about.
  const cols = Array.isArray(colsRaw)
    ? colsRaw.flatMap((c, i) => {
        if (!isObject(c)) return [];
        const t = cellTypeOf(c);
        if (t === 'Button' || t === 'ButtonGroup') return [];
        const f = str(c['field']);
        return f === undefined ? [] : [{ field: f, path: `${kindPath}.columns[${i}].field` }];
      })
    : [];
  const rk = str(kind['rowKeyField']);
  return [...cols, ...(rk === undefined ? [] : [{ field: rk, path: `${kindPath}.rowKeyField` }])];
};

/** The FUARAN code and the reader a grounding defect is about, or undefined for any other defect. */
const groundingOf = (
  d: PreEmitDefect,
):
  | { code: string; rule?: string; reader: 'Chart' | 'DataGrid'; nodeId: string; field: string }
  | undefined => {
  switch (d.code) {
    case 'CHART_FIELD_UNGROUNDED':
      return { code: 'FUARAN086', reader: 'Chart', nodeId: d.nodeId, field: d.field };
    case 'CHART_FIELD_TYPE_MISMATCH':
      return { code: 'FUARAN087', reader: 'Chart', nodeId: d.nodeId, field: d.field };
    case 'CHART_TEMPORAL_X_NOT_DATE':
      return { code: 'FUARAN097', reader: 'Chart', nodeId: d.nodeId, field: d.field };
    case 'GRID_FIELD_UNGROUNDED':
      return { code: 'FUARAN114', reader: 'DataGrid', nodeId: d.nodeId, field: d.field };
    case 'GRID_PILL_FIELD_UNGROUNDED':
      return {
        code: 'FUARAN114',
        rule: 'FUARAN114-pill',
        reader: 'DataGrid',
        nodeId: d.nodeId,
        field: d.field,
      };
    default:
      return undefined;
  }
};

/**
 * Every chart and grid in `node`, graded, with the grounding findings about each
 * located by JSONPath into `document` — the node's canonical wire JSON, parsed —
 * and paired with the schema its source produces. A repeated node id is
 * reported once, at its first occurrence.
 */
export function bindingChecks<TMsg>(node: Node<TMsg>, document: unknown): readonly BindingCheck[] {
  const reached = new Map<string, ReachedReader>();
  const result = runPreEmit(node, (id, r) => {
    if (!reached.has(id)) reached.set(id, r);
  });
  const findings = result.ok ? [] : result.error;
  const seen = new Set<string>();

  return readerObjects(document)
    .filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    })
    .map(({ id, reader, path, kind }) => {
      const kindPath = `${path}.kind`;
      const staticRows = reader === 'DataGrid' && kind['staticRows'] !== undefined;
      let grade: BindingGrade;
      let produced: readonly ProducedColumn[] = [];
      const site = reached.get(id);
      if (staticRows) {
        grade = { kind: 'Unchecked', reason: { kind: 'StaticRows' } };
      } else if (site === undefined) {
        grade = { kind: 'Unchecked', reason: { kind: 'NotReached' } };
      } else if (site.source.kind === 'Transform' && site.source.source.kind === 'Live') {
        grade = { kind: 'Unchecked', reason: { kind: 'LiveSource' } };
      } else if (site.source.kind === 'Transform') {
        const knowledge = producedSchemaOf(site.source) as SchemaKnowledge;
        produced = knowledge.columns;
        grade =
          knowledge.kind === 'Closed'
            ? { kind: 'Checked' }
            : { kind: 'Unchecked', reason: { kind: 'OpenSchema', why: knowledge.reason } };
      } else {
        const src = kind['source'];
        const t = isObject(src) && typeof src['$type'] === 'string' ? src['$type'] : 'absent';
        grade = { kind: 'Unchecked', reason: { kind: 'NoStaticSchema', sourceKind: t } };
      }

      const consumed = new Set<string>();
      const locate = (rule: string, field: string): string => {
        const slot = referenceSlots(rule, reader, kindPath, kind).find(
          (s) => s.field === field && !consumed.has(rule + s.path),
        );
        if (slot === undefined) return kindPath;
        consumed.add(rule + slot.path);
        return slot.path;
      };

      const diagnostics = findings.flatMap((d) => {
        const g = groundingOf(d);
        return g !== undefined && g.nodeId === id && g.reader === reader
          ? [{ code: g.code, path: locate(g.rule ?? g.code, g.field), defect: d }]
          : [];
      });

      return {
        nodeId: id,
        reader,
        path: kindPath + (staticRows ? '.staticRows' : '.source'),
        grade,
        produced,
        diagnostics,
      };
    });
}
