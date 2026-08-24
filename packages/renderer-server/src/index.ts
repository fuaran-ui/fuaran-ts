// @fuaran-ui/renderer-server — pure-string server-HTML renderer for the Fuaran
// UI typed Node tree.
//
// Canonical import:
//   import { renderToHtml } from '@fuaran-ui/renderer-server';
//   import '@fuaran-ui/renderer/css'; // the host serves the packaged reference CSS
//
// The TypeScript twin of Fuaran.UI.Renderer.Server: walks a typed tree and emits
// a body-fragment HTML string carrying the reference fuaran-* class vocabulary,
// with NO React and NO DOM — for a fast first paint, a crawlable / no-JavaScript
// page, and an isomorphic-hydration handoff to @fuaran-ui/renderer on the client.
// Interactivity renders inert; a Link is a real <a href>; client-library
// visualisations render a deterministic placeholder. The emitted class vocabulary
// is parity-locked to both the React client renderer and the F# reference renderer
// (see test/parity.test.ts).

export { renderToHtml, renderNodeToHtml, type RenderToHtmlOptions } from './render.js';

export {
  type BindingSources,
  type Resolution,
  emptySources,
  resolve,
  tryResolve,
  renderText,
  formatNumber,
  formatLocaleValue,
  renderCellValue,
  asArray,
} from './bindings.js';

export {
  nodeClassName,
  kindClass,
  styleClassName,
  toneVar,
  weightVar,
  emphasisVar,
  motionVar,
  styleRoleVar,
  fontVoiceVar,
} from './classNames.js';

export { accessibilityAttributes } from './accessibility.js';

export { escapeText, escapeAttr, el, voidEl, textEl, type Attr } from './html.js';

export { toHtml, toHtmlWithEgress } from './markdown.js';
