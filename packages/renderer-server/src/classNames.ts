// ============================================================================
//  @fuaran-ui/renderer-server/classNames — the load-bearing class-name contract.
//
//  Verbatim copy of @fuaran-ui/renderer's classNames module (which is React-free
//  but only reachable through the React barrel). Kept local so the server
//  renderer carries no React dependency. The two copies must not diverge — the
//  parity tests (`test/parity.test.ts`) lock the emitted class set against both
//  the React renderer and the F# reference renderer, so any drift here fails CI.
// ============================================================================

import type {
  ToneVariant,
  StyleWeight,
  Emphasis,
  StyleRole,
  FontVoice,
  LayoutKind,
  Motion,
  NodeKind,
  SemanticStyle,
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

/** Map a `Motion` token to its `fuaran-motion-{suffix}` class suffix. */
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

/** Map a `StyleRole` to its `fuaran-role-{suffix}` class suffix; `'None'`/absent → undefined. */
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

/** Map a `FontVoice` to its `fuaran-voice-{suffix}` class suffix; `'Default'`/absent → undefined. */
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

/** Map a `BadgeVariant` to its `fuaran-badge-{x}` class fragment. */
export const badgeVariantClass = (variant: string): string => variant.toLowerCase();

/** Map a `ButtonVariant` to its `fuaran-button-{x}` class fragment. */
export const buttonVariantClass = (variant: string): string => variant.toLowerCase();

/** The semantic-style className fragment attached to every Fuaran-rendered element. */
export const styleClassName = (style: SemanticStyle): string => {
  const base = `fuaran-node fuaran-tone-${toneVar(style.tone)} fuaran-weight-${weightVar(
    style.weight,
  )} fuaran-emphasis-${emphasisVar(style.emphasis)}`;
  const role = styleRoleVar(style.role);
  const voice = fontVoiceVar(style.voice);
  return [base, role && `fuaran-role-${role}`, voice && `fuaran-voice-${voice}`]
    .filter(Boolean)
    .join(' ');
};

/** Sanitize a moduleId / componentId fragment for use inside a class name. */
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
