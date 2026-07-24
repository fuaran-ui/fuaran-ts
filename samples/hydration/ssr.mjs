// ssr.mjs — the "server" half of the in-browser-decode hydration demo.
//
// Run once (node ssr.mjs) before serving. It:
//   1. builds the canonical Fuaran tree with @fuaran-ui/ui smart constructors,
//   2. server-renders it to static HTML with @fuaran-ui/renderer (the SAME
//      renderer the browser uses — that parity is what makes hydration
//      mismatch-free),
//   3. encodes the tree to the canonical wire format with @fuaran-ui/ops,
//   4. writes index.html: the server HTML inside #host + the wire JSON embedded
//      in <script type="application/json" id="fuaran-hydrate-<rootId>">.
//
// The browser then runs src/main.tsx, which decodes that <script> via
// @fuaran-ui/ops and hydrates #host with hydrateRoot. One canonical tree, two
// pipelines (Node server render + browser hydrate), zero hand-written HTML.
//
// The tree is deliberately STATIC (no dispatch Actions): wire-decode reconstructs
// structure, not closures — an interactive Action encodes as a `<closure>`
// sentinel and cannot be rebuilt by the decoder. So the in-browser-decode path is
// for server-rendered content that comes alive structurally (links, native
// disclosure, layout) — interactivity over a decoded tree needs the client to
// re-attach handlers (the F#-tier "model-b" reconstruct path, or a host that
// rehydrates handlers by id). This demo proves decode + hydrate + zero mismatch.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { encodeNode } from '@fuaran-ui/ops';
import { FuaranRenderer, hydrationScriptId } from '@fuaran-ui/renderer';
import { action, fuaran } from '@fuaran-ui/ui';

const here = dirname(fileURLToPath(import.meta.url));
const rootId = 'hydration-root';

// 1. The canonical tree — neutral domain, static content only.
const tree = fuaran.dashboard({
  id: rootId,
  children: [
    fuaran.heading({ id: 'title', text: 'In-browser-decode hydration', level: 1 }),
    fuaran.card({
      id: 'how',
      heading: 'One tree, two pipelines',
      children: [
        fuaran.markdown(
          'how-body',
          'This page was **server-rendered** to static HTML by `ssr.mjs` (Node + `react-dom/server`), ' +
            'and the canonical **wire-format tree** was embedded as JSON. In the browser, ' +
            '`@fuaran-ui/renderer` reads that embed, **decodes it via `@fuaran-ui/ops`**, and attaches ' +
            'React with `hydrateRoot` — no re-render, no flash, no hand-written markup.',
        ),
        fuaran.link({
          id: 'spec',
          href: 'https://github.com/fuaran-ui',
          label: 'Fuaran wire format',
        }),
      ],
    }),
    fuaran.summaryList({
      id: 'facts',
      heading: 'At a glance',
      children: [
        fuaran.labelValueRow({ id: 'pipelines', label: 'Render pipelines', value: 2 }),
        fuaran.labelValueRow({ id: 'rerenders', label: 'Client re-renders on load', value: 0 }),
        fuaran.labelValueRow({ id: 'mismatches', label: 'Hydration mismatches', value: 0 }),
      ],
    }),
    // Phase 159 — interactivity over the *decoded* tree. These buttons carry
    // wire-survivable actions (Notify / Navigate survive encode→decode as data,
    // unlike a closure-carrying Dispatch). After the browser decodes + hydrates,
    // the Notify fires through the wired runtime; the Navigate is blocked by the
    // runtime's canDispatch gate — a decoded tree can't fire an unapproved
    // navigation. No server round-trip: the action runs entirely client-side.
    fuaran.card({
      id: 'interactive',
      heading: 'Interactive — decoded actions, gated, client-side',
      children: [
        fuaran.markdown(
          'int-body',
          'These buttons carry **wire-survivable actions** the browser decoded from the embed. ' +
            '`Notify` fires through the wired `runtime`; `Navigate` is **blocked by the `canDispatch` gate** ' +
            '— proving a server-emitted, decoded tree cannot fire an unapproved navigation.',
        ),
        fuaran.button({
          id: 'notify-btn',
          label: 'Fire a Notify action',
          onClick: action.notify('demo', 'Hello from a decoded Notify action!'),
        }),
        fuaran.button({
          id: 'nav-btn',
          label: 'Try to Navigate (gate denies)',
          onClick: action.navigate('/elsewhere'),
        }),
      ],
    }),
  ],
});

// 2. Server-render with the shared renderer.
const bodyHtml = renderToStaticMarkup(createElement(FuaranRenderer, { tree }));

// 3. Encode to wire JSON, escaping the </script>-breaking + injection chars the
//    F# Fuaran.UI.Renderer.Server `embeddedTreeElement` escapes (<, >, &).
const wireJson = encodeNode(tree)
  .replace(/&/g, '\\u0026')
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e');

// 4. Assemble index.html from the template.
const embed =
  `<div id="host">${bodyHtml}</div>\n    ` +
  `<script id="${hydrationScriptId(rootId)}" type="application/json">${wireJson}</script>`;
const template = readFileSync(join(here, 'index.template.html'), 'utf8');
writeFileSync(join(here, 'index.html'), template.replace('<!--SSR_OUTLET-->', embed));

console.log(`ssr.mjs: wrote index.html (root #${rootId}, ${wireJson.length}B wire JSON)`);
