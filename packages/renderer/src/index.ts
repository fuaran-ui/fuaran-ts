// @fuaran-ui/renderer — React renderer + reference CSS + custom-renderer
// registry for the Fuaran UI typed Node tree.
//
// Canonical import:
//   import { FuaranRenderer, registerCustomRenderer, createCustomRendererRegistry } from '@fuaran-ui/renderer';
//   import '@fuaran-ui/renderer/css';
//
// A conformant TypeScript host of the language-neutral wire-format contract in
// fuaran-dotnet/docs/WIRE_FORMAT.md — renders any tree @fuaran-ui/ui authors or
// @fuaran-ui/ops decodes, with class-name + ARIA parity to the F# renderer.
// The sanitisation seam is also published as the @fuaran-ui/renderer/sanitize
// subpath.

export { FuaranRenderer, type FuaranRendererProps } from './Renderer.js';

// In-page introspection REPL — `window.__fuaran` (DEBUG-only). Registered by
// `<FuaranRenderer debug>`; the builder + register helpers are exported so a
// host can wire the global on its own terms (e.g. a non-renderer debug surface).
export {
  DEBUG_GLOBAL_KEY,
  DEBUG_GLOBAL_VERSION,
  buildDebugGlobal,
  readRegisteredDebugGlobal,
  registerDebugGlobal,
  type FuaranDebugGlobal,
  type DebugError,
  type NodeGeometry,
  type ApplyEnvelope,
  type DebugGlobalOptions,
  type BindingState,
  type BindingStateError,
  type BindingStatus,
  type TreeOpJson,
} from './debugGlobal.js';

// Committed-tree-change signal — what `__fuaran.subscribe(cb)` is built on, and
// what a non-renderer host commits its own tree changes to.
export {
  createChangeHub,
  pageChangeHub,
  type ChangeCause,
  type ChangeHub,
  type ChangeListener,
  type TreeChange,
} from './changeHub.js';

export { declaredSlots, isDeclaredSlot } from './declaredSlots.js';

// The DevTools relay page peer — OFF by default; installing it is a deliberate
// host act (see `relay.ts` and the relay contract's opt-in section).
export {
  RELAY_KEY,
  RELAY_PROFILE,
  acceptsRelayMessage,
  createRelayPeer,
  installRelayPeer,
  parseRelayProfile,
  type InstallRelayPeerOptions,
  type RelayCapability,
  type RelayDirection,
  type RelayEnvelope,
  type RelayPeer,
  type RelayPeerOptions,
  type RelayRefusalClass,
  type RelaySurfaceSource,
} from './relay.js';

export {
  CustomRendererRegistry,
  createCustomRendererRegistry,
  registerCustomRenderer,
  emptyRuntime,
  describeActionDescriptor,
  type CustomRenderer,
  type CustomRendererProps,
  type FuaranRuntime,
  type ActionDescriptor,
} from './customRegistry.js';

export {
  type BindingSources,
  type Resolution,
  emptySources,
  resolve,
  tryResolve,
  renderText,
  formatNumber,
  renderCellValue,
} from './bindings.js';

export {
  type RenderContext,
  runAction,
  collectFragments,
  namespaceNode,
  containsUnwiredAction,
} from './context.js';

export {
  nodeClassName,
  kindClass,
  toneVar,
  motionVar,
  styleClassName,
  styleRoleVar,
  fontVoiceVar,
} from './classNames.js';
export { accessibilityAttributes } from './accessibility.js';
export { drawingSvg } from './drawingSvg.js';
export { mathMl } from './mathMl.js';
// The `Chart` node → chart-lowering bridge. Exported for the same reason
// `drawingSvg` is: the string server renderer must lower from the SAME declared
// fields this renderer does, and a second copy of that decision is how the two
// surfaces come to draw different pictures from one tree.
export { chartLowerSpecOf } from './chartLowerSpec.js';

// Isomorphic hydration: in-browser decode (@fuaran-ui/ops) + React hydrateRoot.
export {
  hydrate,
  hydrateEmbedded,
  hydrationScriptId,
  type HydrateEmbeddedOptions,
  type HydrateEmbeddedResult,
} from './hydrate.js';

export {
  type ColorValue,
  type Theme,
  type Tones,
  type ToneStops,
  type Spacing,
  type FontScale,
  type FontWeight,
  type LineHeight,
  type Radius,
  themeToCss,
  themeToCssVariables,
  themeToStyle,
  defaultTheme,
} from './theme.js';

// Re-export the sanitisation seam from the barrel as well as the subpath.
export {
  sanitizeUrl,
  sanitizeUrlOrBlank,
  sanitizeExtraAttributes,
  sanitizeMarkdownHtml,
  isAllowedExtraAttributeKey,
  isSafeExtraAttributeValue,
} from './sanitize.js';

// Phase 293 — the client-only KaTeX math enhancement (also at the
// `@fuaran-ui/renderer/enhance-math` subpath for React-free consumers).
export { enhanceMath, parseMathSegments } from './enhanceMath.js';
