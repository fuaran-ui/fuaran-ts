// main.tsx — the browser half of the in-browser-decode hydration demo.
//
// The server (ssr.mjs) shipped #host with server-rendered HTML plus the embedded
// wire-format tree. Here we hand both ids to `hydrateEmbedded`, which reads the
// <script>, DECODES it via @fuaran-ui/ops, and attaches React with hydrateRoot.
// If the server + client markup agree (the shared class+ARIA parity contract),
// React logs no hydration-mismatch warning.
//
// Phase 159: we also wire a `runtime` so the decoded tree is INTERACTIVE. The
// decoded buttons carry wire-survivable actions — `Notify` fires through the
// runtime; `Navigate` is denied by `canDispatch` (the default-deny gate). The
// action runs entirely client-side: no server round-trip.

import '@fuaran-ui/renderer/css';

import { hydrateEmbedded, type FuaranRuntime } from '@fuaran-ui/renderer';

// Surface a visible verdict + an action log so the result is checkable in the
// browser without digging through the console.
const note = (text: string, tone: 'ok' | 'error' | 'info'): void => {
  const el = document.createElement('p');
  el.textContent = text;
  el.setAttribute('data-status', tone);
  const bg = tone === 'ok' ? '#1a7f37' : tone === 'error' ? '#b42318' : '#1f5fbf';
  el.style.cssText = `margin:0;padding:.5rem .75rem;font:13px/1.4 system-ui,sans-serif;color:#fff;background:${bg}`;
  document.body.insertBefore(el, document.body.firstChild);
};

// The runtime the decoded actions dispatch through. `canDispatch` is the
// default-deny gate (Phase 159): it allows everything EXCEPT Navigate, so the
// decoded `Navigate` action is blocked and surfaced via `warn` — a server-
// emitted tree cannot redirect the page without the host's approval.
const runtime: FuaranRuntime = {
  notify: (channel, payload) =>
    note(
      `✓ decoded Notify("${channel}") fired through the runtime — ${JSON.stringify(payload)}`,
      'info',
    ),
  navigate: (route) => note(`(navigated to ${route})`, 'info'), // unreached — the gate denies Navigate
  canDispatch: (descriptor) => descriptor.kind !== 'Navigate',
  warn: (message) => note(`⛔ ${message}`, 'error'),
};

const result = hydrateEmbedded({ containerId: 'host', rootId: 'hydration-root', runtime });

if (result.ok) {
  note(
    '✓ Decoded the embedded wire tree and hydrated #host via hydrateRoot — no mismatch. Click the buttons below.',
    'ok',
  );
  console.log('[fuaran:hydration] decoded embed + hydrated #host (interactive runtime wired)');
} else {
  note(`✗ Hydration failed: ${result.error}`, 'error');
  console.error(`[fuaran:hydration] ${result.error}`);
}
