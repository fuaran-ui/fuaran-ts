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
  registerDebugGlobal,
  type FuaranDebugGlobal,
  type DebugError,
  type NodeGeometry,
  type ApplyEnvelope,
  type DebugGlobalOptions,
} from './debugGlobal.js';

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
