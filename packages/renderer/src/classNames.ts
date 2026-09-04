// ============================================================================
//  @fuaran-ui/renderer/classNames — the load-bearing class-name contract.
//
//  Shape-for-shape port of the class-name helpers in the F# reference
//  renderer's Theme module (toneVar / weightVar / emphasisVar / motionVar /
//  kindClass / nodeClassName). Class-name parity with the F# renderer is the
//  load-bearing acceptance property of Phase 77 — the packaged reference CSS
//  keys off these exact strings, so any drift here silently breaks styling.
// ============================================================================

import type {
  ToneVariant,
  StyleWeight,
  Emphasis,
  ImageAspect,
  StyleRole,
  FontVoice,
  TextDirection,
  LayoutKind,
  Motion,
  NodeKind,
  SemanticStyle,
  TrendPolarity,
} from '@fuaran-ui/schema';

/** Map a `ToneVariant` to its CSS-variable name root. */
export const toneVar = (tone: ToneVariant): string => {
  switch (tone) {
    case 'Default':
      return 'default';
    case 'Subdued':
      return 'subdued';
    case 'Brand':
      return 'brand';
    case 'Success':
      return 'success';
    case 'Warning':
      return 'warning';
    case 'Critical':
      return 'critical';
    case 'Info':
      return 'info';
  }
};

/**
 * Phase 867 — the `Metric` trend element's SENTIMENT, as the class-modifier
 * fragment (which is also the accessible label) paired with its visible glyph.
 *
 * Until this shipped, `.fuaran-metric-trend` carried exactly one class and the
 * reference stylesheet painted it `--fuaran-tone-success-fg` unconditionally,
 * so EVERY trend rendered as an improvement — in both directions, on every
 * host. Sentiment is `sign(trend) x polarity`, where `HigherIsBetter` is `+1`
 * and `LowerIsBetter` is `−1`: a positive product is an improvement, a negative
 * product a regression, a zero trend neither. So a falling wait time reads as an
 * improvement under `LowerIsBetter` and as a regression without it, and the
 * numeric text — its sign included — is identical in both. Polarity changes how
 * the number READS, never what it SAYS.
 *
 * `tone` is untouched — it colours the TILE and says how the reading STANDS;
 * this says which way the quantity MOVED. A host derives neither from the other,
 * and in particular NOTHING here writes back to `tone`: a renderer that inferred
 * "improving ⇒ tile is Success" would re-create in the render the exact
 * conflation the wire slot exists to remove.
 *
 * The glyphs are U+25B2, U+25BC and U+2192. They carry the sentiment on a
 * NON-COLOUR channel (WCAG 1.4.1 — colour alone fails), and the renderers hang
 * the fragment on the glyph as an `aria-label` so assistive technology hears
 * the sentiment without the numeric text being replaced by it. The glyph tracks
 * SENTIMENT, not the number's direction: under an inverted polarity the triangle
 * deliberately disagrees with the sign, and that disagreement is the visible
 * evidence the declaration was honoured.
 */
export const trendSentiment = (
  polarity: TrendPolarity,
  trend: number,
): readonly [string, string] => {
  const sentiment = trend * (polarity === 'LowerIsBetter' ? -1 : 1);
  if (sentiment > 0) return ['improving', '▲'] as const;
  if (sentiment < 0) return ['regressing', '▼'] as const;
  return ['unchanged', '→'] as const;
};

/**
 * Phase 1077 — map an `ImageAspect` token to its `fuaran-image-aspect-{suffix}`
 * class fragment, leading space included. `'Natural'` returns `''`: the default
 * emits NO class, so a pre-phase tree's class attribute is byte-identical.
 *
 * The token is deliberately not the CSS ratio. The stylesheet owns the
 * `aspect-ratio` value; the wire owns only which of the four boxes was asked
 * for, which is what keeps an author-supplied number out of a style attribute.
 */
export const imageAspectClass = (aspect: ImageAspect): string => {
  switch (aspect) {
    case 'Square':
      return ' fuaran-image-aspect-square';
    case 'FourThree':
      return ' fuaran-image-aspect-four-three';
    case 'ThreeTwo':
      return ' fuaran-image-aspect-three-two';
    case 'SixteenNine':
      return ' fuaran-image-aspect-sixteen-nine';
    case 'Natural':
      return '';
  }
};

/** Map a `StyleWeight` to its CSS-variable name root (padding / density). */
export const weightVar = (weight: StyleWeight): string => {
  switch (weight) {
    case 'Compact':
      return 'compact';
    case 'Standard':
      return 'standard';
    case 'Spacious':
      return 'spacious';
  }
};

/** Map an `Emphasis` to its CSS-variable name root (border / shadow / weight). */
export const emphasisVar = (emphasis: Emphasis): string => {
  switch (emphasis) {
    case 'Quiet':
      return 'quiet';
    case 'Normal':
      return 'normal';
    case 'Loud':
      return 'loud';
  }
};

/** Map a `Motion` token to its `fuaran-motion-{suffix}` class suffix (Phase 12.F). */
export const motionVar = (motion: Motion): string => {
  switch (motion) {
    case 'None':
      return 'none';
    case 'PulseDuringLoad':
      return 'pulse-during-load';
    case 'FadeInOnMount':
      return 'fade-in-on-mount';
    case 'SlideInFromBelow':
      return 'slide-in-from-below';
    case 'ShakeOnError':
      return 'shake-on-error';
    case 'RotateOnRefresh':
      return 'rotate-on-refresh';
    case 'SlideInFromRight':
      return 'slide-in-from-right';
    case 'ExpandCollapse':
      return 'expand-collapse';
  }
};

/**
 * Map a `StyleRole` to its `fuaran-role-{suffix}` class suffix (Phase 147).
 * `'None'` returns `undefined` — the default emits no fragment, so an existing
 * tree renders byte-identically.
 */
export const styleRoleVar = (role: StyleRole | undefined): string | undefined => {
  switch (role) {
    case undefined:
    case 'None':
      return undefined;
    case 'Eyebrow':
      return 'eyebrow';
    case 'Data':
      return 'data';
    case 'Lede':
      return 'lede';
    case 'Caption':
      return 'caption';
  }
};

/**
 * Map a `FontVoice` to its `fuaran-voice-{suffix}` class suffix (Phase 147).
 * `'Default'` returns `undefined` (no fragment, byte-identical default).
 */
export const fontVoiceVar = (voice: FontVoice | undefined): string | undefined => {
  switch (voice) {
    case undefined:
    case 'Default':
      return undefined;
    case 'Display':
      return 'display';
    case 'Structural':
      return 'structural';
  }
};

/**
 * Map a `TextDirection` to its `fuaran-dir-{suffix}` class suffix (Phase 1472).
 * `'auto'` / absent returns `undefined` — no fragment, byte-identical default.
 *
 * The CLASS is what carries the ISOLATION. `dir` alone states a direction; the
 * reference stylesheet's `.fuaran-dir-ltr, .fuaran-dir-rtl { unicode-bidi:
 * isolate }` is what stops the surrounding bidirectional context reordering the
 * run. Stating it in the stylesheet rather than leaning on the user agent's own
 * `[dir]` rule is deliberate: the isolation is the whole point of the slot, and
 * it must not depend on which UA stylesheet a host happens to ship.
 */
export const textDirectionVar = (direction: TextDirection | undefined): string | undefined => {
  switch (direction) {
    case undefined:
    case 'auto':
      return undefined;
    case 'ltr':
      return 'ltr';
    case 'rtl':
      return 'rtl';
  }
};

/**
 * The print-break class SUFFIX for a container's two Phase 1473 declarations —
 * the empty string when neither is declared, so every element a pre-1473
 * document produced carries a byte-identical class string.
 *
 * ONE helper, called from every container arm rather than a fragment assembled
 * per arm: the six `Box` arms would otherwise be six independent chances to
 * spell it differently, and the classes are what the reference stylesheet's
 * `@media print` block hooks against.
 */
export const printBreakClasses = (keepTogether: boolean, breakBefore: boolean): string =>
  (keepTogether ? ' fuaran-break-inside-avoid' : '') +
  (breakBefore ? ' fuaran-break-before-page' : '');

/**
 * The GRID's own two Phase 1473 declarations, on the same rule and separate from
 * the pair above because they name DIFFERENT boundaries: these hook rules at the
 * row and at the header row group, which live INSIDE the element the class sits
 * on, where the container pair applies to the element itself. Collapsing the two
 * into one helper would put four mutually-unrelated flags behind one name.
 */
export const gridPrintBreakClasses = (keepRowsTogether: boolean, repeatHeader: boolean): string =>
  (keepRowsTogether ? ' fuaran-grid-rows-together' : '') +
  (repeatHeader ? ' fuaran-grid-repeat-header' : '');

/** Map a `BadgeVariant` to its `fuaran-badge-{x}` class fragment. */
export const badgeVariantClass = (variant: string): string => variant.toLowerCase();

/** Map a `ButtonVariant` to its `fuaran-button-{x}` class fragment. */
export const buttonVariantClass = (variant: string): string => variant.toLowerCase();

/**
 * The semantic-style className fragment attached to every Fuaran-rendered
 * element — stable shape regardless of component kind. The Phase 147
 * `role`/`voice` fragments are appended only when non-default, so a tree
 * authored before those fields existed yields the identical class string.
 */
export const styleClassName = (style: SemanticStyle): string => {
  const base = `fuaran-node fuaran-tone-${toneVar(style.tone)} fuaran-weight-${weightVar(
    style.weight,
  )} fuaran-emphasis-${emphasisVar(style.emphasis)}`;
  const role = styleRoleVar(style.role);
  const voice = fontVoiceVar(style.voice);
  // Phase 1472 — appended LAST, after the Phase 147 pair, so every class string
  // a pre-1472 document produced is byte-identical.
  const direction = textDirectionVar(style.direction);
  return [
    base,
    role && `fuaran-role-${role}`,
    voice && `fuaran-voice-${voice}`,
    direction && `fuaran-dir-${direction}`,
  ]
    .filter(Boolean)
    .join(' ');
};

/**
 * Sanitize a moduleId / componentId fragment for use inside a class name.
 * Mirrors the F# `sanitiseClassFragment` — lowercases, replaces any
 * non-`[a-z0-9-]` run with a single `-`.
 */
const sanitiseClassFragment = (raw: string): string =>
  raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-');

const layoutKindClass: Record<string, string> = {
  SplitPanel: 'fuaran-kind-split-panel',
  Tabs: 'fuaran-kind-tabs',
  Stepper: 'fuaran-kind-stepper',
  SummaryList: 'fuaran-kind-summary-list',
  Disclosure: 'fuaran-kind-disclosure',
  Modal: 'fuaran-kind-modal',
  ScrollArea: 'fuaran-kind-scroll-area',
};

/**
 * The per-kind class hook for the unified `Box` container (Phase 390), derived
 * from role + layout so each retired kind's `fuaran-kind-*` hook is preserved:
 * Card → card; Dashboard / Group+Auto → dashboard; Group+Grid → grid-layout;
 * Group+Flex → stack; Separator → divider. Mirrors the F# `kindClass` Box arm.
 */
const boxKindClass = (layout: Extract<LayoutKind<unknown>, { kind: 'Box' }>): string => {
  const { role, layout: mode } = layout.spec;
  if (role === 'Card') return 'fuaran-kind-card';
  if (role === 'Dashboard' || mode.kind === 'Auto') return 'fuaran-kind-dashboard';
  if (role === 'Separator') return 'fuaran-kind-divider';
  if (mode.kind === 'Grid') return 'fuaran-kind-grid-layout';
  // Phase 1082 — its own hook, not the grid's: the two modes fill in
  // different directions, so a host styling "the grid container" must not
  // catch both.
  if (mode.kind === 'Masonry') return 'fuaran-kind-masonry';
  return 'fuaran-kind-stack';
};

const displayKindClass: Record<string, string> = {
  Heading: 'fuaran-kind-heading',
  LabelValueRow: 'fuaran-kind-label-value-row',
  Fact: 'fuaran-kind-fact',
  Markdown: 'fuaran-kind-markdown',
  Metric: 'fuaran-kind-metric',
  Badge: 'fuaran-kind-badge',
  Link: 'fuaran-kind-link',
  Image: 'fuaran-kind-image',
  List: 'fuaran-kind-list',
  Toast: 'fuaran-kind-toast',
  CodeBlock: 'fuaran-kind-code-block',
  Math: 'fuaran-kind-math',
  Sparkline: 'fuaran-kind-sparkline',
  Callout: 'fuaran-kind-callout',
  Progress: 'fuaran-kind-progress',
  Skeleton: 'fuaran-kind-skeleton',
  Icon: 'fuaran-kind-icon',
};

const inputKindClass: Record<string, string> = {
  Form: 'fuaran-kind-form',
  Filters: 'fuaran-kind-filters',
  Button: 'fuaran-kind-button',
  FileUpload: 'fuaran-kind-file-upload',
  Select: 'fuaran-kind-select',
};

const visKindClass: Record<string, string> = {
  Grid: 'fuaran-kind-grid',
  Chart: 'fuaran-kind-chart',
  Table: 'fuaran-kind-table',
  Map: 'fuaran-kind-map',
};

/** Per-`NodeKind` class fragment (e.g. `fuaran-kind-metric`). */
export const kindClass = (kind: NodeKind<unknown>): string => {
  switch (kind.kind) {
    case 'Layout':
      return kind.layout.kind === 'Box'
        ? boxKindClass(kind.layout)
        : (layoutKindClass[kind.layout.kind] ?? 'fuaran-kind-layout');
    case 'Display':
      return displayKindClass[kind.display.kind] ?? 'fuaran-kind-display';
    case 'Input':
      return inputKindClass[kind.input.kind] ?? 'fuaran-kind-input';
    case 'Visualisation':
      return visKindClass[kind.visualisation.kind] ?? 'fuaran-kind-visualisation';
    case 'Custom':
      return `fuaran-kind-custom fuaran-custom-${sanitiseClassFragment(
        kind.moduleId,
      )}-${sanitiseClassFragment(kind.componentId)}`;
    case 'ErrorBoundary':
      return 'fuaran-kind-error-boundary';
    case 'Switch':
      return 'fuaran-kind-switch';
    case 'FragmentDecl':
      return 'fuaran-kind-fragment-decl';
    case 'FragmentRef':
      return 'fuaran-kind-fragment-ref';
    case 'Mount':
      return 'fuaran-kind-mount';
  }
};

/** Compose the full className for a node: kind class + semantic style. */
export const nodeClassName = (kind: NodeKind<unknown>, style: SemanticStyle): string =>
  `${kindClass(kind)} ${styleClassName(style)}`;
