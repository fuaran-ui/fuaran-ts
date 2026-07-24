// @fuaran-ui/renderer/hydrate — isomorphic hydration: in-browser decode + mount.
//
// The browser counterpart to the server's hydration-ready emission (the F#
// `Fuaran.UI.Renderer.Server` `renderHydratable`, or any host that embeds the
// canonical wire tree). The server renders the tree to HTML AND embeds it as a
// `<script type="application/json" id="fuaran-hydrate-<rootId>">` payload; this
// module reads that script, **decodes it via `@fuaran-ui/ops`**, and attaches
// React with `hydrateRoot` (NOT `createRoot`, which would clobber the server
// DOM and re-render from scratch).
//
// This is the in-browser-decode hydration path: unlike an Elmish client that
// reconstructs the tree in code, here the client receives the canonical wire
// tree from the server and decodes it — the TS decoder (`@fuaran-ui/ops`) is
// browser-native, so a server in any conformant tier (F# or TS) can drive a TS
// hydration. Parity (the shared class+ARIA contract) makes hydration
// mismatch-free.

import { createElement } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';

import { decodeNode } from '@fuaran-ui/ops';

import { FuaranRenderer, type FuaranRendererProps } from './Renderer.js';

/** The embedded-tree `<script>` id for a render-root id — mirror of the F#
 *  `Fuaran.UI.Renderer.Server` `scriptId` (`fuaran-hydrate-<rootId>`). */
export const hydrationScriptId = (rootId: string): string => `fuaran-hydrate-${rootId}`;

/** Hydrate the server-rendered DOM in `container` with a Fuaran `tree` via React
 *  `hydrateRoot` (NOT `createRoot`). Returns the React root; call
 *  `root.render(...)` for subsequent updates. The server + client markup must
 *  agree (the shared class+ARIA parity contract) or React logs a
 *  hydration-mismatch warning. */
export function hydrate<TMsg>(
  container: Element | Document,
  props: FuaranRendererProps<TMsg>,
): Root {
  return hydrateRoot(container, createElement(FuaranRenderer<TMsg>, props));
}

/** Options for {@link hydrateEmbedded}: the container to hydrate + the render-root
 *  id the server keyed the embedded `<script>` by, plus the usual renderer props
 *  (minus `tree`, which comes from decoding the embed). */
export interface HydrateEmbeddedOptions<TMsg> extends Omit<FuaranRendererProps<TMsg>, 'tree'> {
  /** Id of the element wrapping the server-rendered HTML (the hydration target). */
  readonly containerId: string;
  /** Render-root id the server keyed the embedded `<script>` by. */
  readonly rootId: string;
}

/** Result of {@link hydrateEmbedded}. */
export type HydrateEmbeddedResult =
  | { readonly ok: true; readonly root: Root }
  | { readonly ok: false; readonly error: string };

/** Read the server-embedded wire-format tree (the `<script type="application/json">`
 *  keyed `fuaran-hydrate-<rootId>`), **decode it via `@fuaran-ui/ops`**, and
 *  hydrate `#containerId` with it. The in-browser-decode hydration path: the
 *  server emits the embed; the client decodes + `hydrateRoot`s. Returns the React
 *  root, or an error (missing script / container, or a decode failure). */
export function hydrateEmbedded<TMsg = unknown>(
  opts: HydrateEmbeddedOptions<TMsg>,
): HydrateEmbeddedResult {
  const script = document.getElementById(hydrationScriptId(opts.rootId));
  if (script == null) {
    return {
      ok: false,
      error: `embedded tree script #${hydrationScriptId(opts.rootId)} not found`,
    };
  }
  const container = document.getElementById(opts.containerId);
  if (container == null) {
    return { ok: false, error: `container #${opts.containerId} not found` };
  }
  const decoded = decodeNode(script.textContent ?? '');
  if (!decoded.ok) {
    return { ok: false, error: `wire-tree decode failed: ${decoded.error.message}` };
  }
  const { containerId: _c, rootId: _r, ...rendererProps } = opts;
  const props = { ...rendererProps, tree: decoded.value } as unknown as FuaranRendererProps<TMsg>;
  return { ok: true, root: hydrate<TMsg>(container, props) };
}
