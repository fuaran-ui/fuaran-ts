// @fuaran-ui/client/render — the renderer glue.
//
// A one-liner to turn a produced result into rendered DOM: decode its wire tree
// via `@fuaran-ui/ops` and mount it with `@fuaran-ui/renderer`, so a developer
// wires no decode/validate of their own. Import the reference stylesheet once:
//
//   import '@fuaran-ui/renderer/css';
//
// This subpath pulls in React + the renderer; the core `@fuaran-ui/client`
// entry stays dependency-light for server-proxy (Node) use.

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { decodeNode, type DecodeError } from '@fuaran-ui/ops';
import { FuaranRenderer, type FuaranRendererProps } from '@fuaran-ui/renderer';
import type { Node } from '@fuaran-ui/schema';

import type { Produced } from './contract.js';

/** Decode the wire tree carried by a produced result into a typed `Node`. The
 *  developer never parses raw model output themselves — the endpoint emits
 *  canonical wire JSON and this decodes it through the same codec the renderer
 *  trusts. */
export function decodeProducedTree<TMsg = unknown>(
  produced: Produced,
): { ok: true; tree: Node<TMsg> } | { ok: false; error: DecodeError } {
  const decoded = decodeNode(produced.treeJson);
  return decoded.ok
    ? { ok: true, tree: decoded.value as Node<TMsg> }
    : { ok: false, error: decoded.error };
}

/** The renderer props for {@link mountProduced} — everything `FuaranRenderer`
 *  takes except `tree`, which is decoded from the produced result. */
export type MountProps<TMsg> = Omit<FuaranRendererProps<TMsg>, 'tree'>;

/** Decode a produced result and mount it into `container` with React
 *  `createRoot`. Returns the React root (call `root.render(...)` for later
 *  updates, or hold it and remount the next turn's produced tree), or a decode
 *  error. Remember to `import '@fuaran-ui/renderer/css'` for the reference
 *  styles. */
export function mountProduced<TMsg = unknown>(
  container: Element | DocumentFragment,
  produced: Produced,
  props?: MountProps<TMsg>,
): { ok: true; root: Root } | { ok: false; error: DecodeError } {
  const decoded = decodeProducedTree<TMsg>(produced);
  if (!decoded.ok) {
    return decoded;
  }
  const rendererProps = { ...(props ?? {}), tree: decoded.tree } as FuaranRendererProps<TMsg>;
  const root = createRoot(container);
  root.render(createElement(FuaranRenderer<TMsg>, rendererProps));
  return { ok: true, root };
}
