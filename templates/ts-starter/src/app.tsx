// The host application — owns state + the dispatch loop and renders the Fuaran
// tree through <FuaranRenderer>.
//
// Demonstrates, end to end:
//   • authoring a tree via @fuaran-ui/ui smart-ctors (src/tree.ts)
//   • rendering it through <FuaranRenderer> with a typed (msg) => void dispatch
//   • a host runtime carrying the custom-renderer registry + effect ports
//
// This is the file you wire to your real app: replace the effect-port stubs
// (warn/notify/navigate/writeToClipboard) with your HTTP client, router, etc.

import { useMemo, useReducer, type ReactElement } from 'react';

import { FuaranRenderer, type FuaranRuntime } from '@fuaran-ui/renderer';

import { buildRegistry } from './custom-renderers';
import { type AppMsg, initialModel, update } from './model';
import { buildSources, buildTree } from './tree';

const buildRuntime = (): FuaranRuntime => ({
  registry: buildRegistry(),
  // Effect ports — Dispatch/Chain/CommitLocal are renderer-native; the rest
  // route through these host stubs. A real consumer app wires these to its
  // HTTP client, router, clipboard, etc.
  warn: (message) => console.warn('[fuaran]', message),
  notify: (channel, payload) => console.info('[fuaran] notify', channel, payload),
  navigate: (route) => console.info('[fuaran] navigate', route),
  writeToClipboard: (text) => void navigator.clipboard?.writeText(text),
});

export function App(): ReactElement {
  const [model, dispatch] = useReducer(update, initialModel);

  const runtime = useMemo(buildRuntime, []);
  const tree = buildTree(model);
  const sources = buildSources(model);

  return (
    <FuaranRenderer<AppMsg>
      tree={tree}
      dispatch={dispatch}
      sources={sources}
      runtime={runtime}
      debug={import.meta.env.DEV}
    />
  );
}
