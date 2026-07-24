// The host application — owns state + the dispatch loop and renders the Fuaran
// tree through <FuaranRenderer>.
//
// Demonstrates, end to end:
//   • authoring a representative tree via @fuaran-ui/ui smart-ctors (src/tree.ts)
//   • rendering it through <FuaranRenderer> with a typed (msg) => void dispatch
//   • a host runtime carrying the custom-renderer registry + effect ports
//   • the canonical-JSON wire round-trip (src/devTools.tsx, @fuaran-ui/ops)
//   • a Custom-node escape hatch (src/customRenderers.tsx)
//   • typed-Theme application (light / dark) via the `theme` prop

import { useMemo, useReducer, useState, type ReactElement } from 'react';

import { FuaranRenderer, type BindingSources, type FuaranRuntime } from '@fuaran-ui/renderer';
import type { Node } from '@fuaran-ui/schema';

import { buildRegistry } from './customRenderers';
import { DevTools } from './devTools';
import { type AppMsg, type Model, initialModel, update } from './model';
import { darkTheme, defaultTheme } from './theme';
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
  // Phase 194 — live default-deny demonstration toggle for the policy-gated
  // `window.__fuaran.apply`: deny an `ApplyTreeOp` when `window.__fuaranAllowApply`
  // is explicitly set to `false` (an absent/undefined flag allows, matching every
  // other dispatch path). Flip it from the DevTools console to watch the same op
  // be refused (deny envelope, tree unchanged) then permitted (mutates + re-renders).
  canDispatch: (d) =>
    d.kind !== 'ApplyTreeOp' ||
    (globalThis as Record<string, unknown>)['__fuaranAllowApply'] !== false,
});

const withI18n = (sources: BindingSources): BindingSources => ({
  ...sources,
  // i18n resolver stub — returns the key's last segment as a human-ish label.
  i18nResolver: (key) => key.split('.').slice(-1)[0] ?? key,
});

export function App(): ReactElement {
  const [model, dispatch] = useReducer(update, initialModel);
  const [override, setOverride] = useState<Node<unknown> | null>(null);
  // Phase 190 — holds the post-apply tree from `window.__fuaran.apply(opJson)`
  // so a console-driven mutation re-renders. Null until the first apply.
  const [applied, setApplied] = useState<Node<AppMsg> | null>(null);

  const runtime = useMemo(buildRuntime, []);
  const authoredTree = buildTree(model);
  const sources = withI18n(buildSources(model));
  const theme = model.dark ? darkTheme : defaultTheme;

  const toggleTheme = (): void => dispatch({ t: 'ToggleTheme' } satisfies AppMsg);

  return (
    <>
      <header className="demo-header">
        <div>
          <h1>Fuaran UI — TypeScript reference demo</h1>
          <p>
            @fuaran-ui/schema · ui · ops · renderer — one typed tree, authored, rendered, and
            round-tripped through the canonical wire format.
          </p>
        </div>
        <div className="demo-header-actions">
          <button className="demo-btn ghost" type="button" onClick={toggleTheme}>
            {model.dark ? '☀ Light theme' : '☾ Dark theme'}
          </button>
        </div>
      </header>

      <div className="demo-layout">
        <main className="demo-stage">
          {override !== null ? (
            <>
              <div className="demo-banner">
                <span>
                  Rendering a <strong>decoded</strong> tree from the round-trip panel — structure +
                  static content are preserved; closures (interactivity) are inert by design.
                </span>
              </div>
              <FuaranRenderer tree={override} sources={sources} runtime={runtime} theme={theme} />
            </>
          ) : (
            <FuaranRenderer<AppMsg>
              tree={applied ?? authoredTree}
              dispatch={dispatch}
              sources={sources}
              runtime={runtime}
              theme={theme}
              debug={import.meta.env.DEV}
              onApply={setApplied}
            />
          )}
        </main>

        <DevTools
          tree={authoredTree as Node<unknown>}
          onLoad={(tree) => setOverride(tree)}
          overriding={override !== null}
          onReset={() => setOverride(null)}
        />
      </div>
    </>
  );
}

export type { Model };
