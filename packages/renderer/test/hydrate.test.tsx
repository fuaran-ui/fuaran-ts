// ============================================================================
//  @fuaran-ui/renderer/hydrate — in-browser decode + hydrateRoot (Phase 143).
//
//  The TS isomorphic-hydration path: a server embeds the canonical wire tree as
//  a <script type="application/json">; the client reads it, DECODES it via
//  @fuaran-ui/ops, and attaches React with hydrateRoot. This test stands up that
//  exact flow in jsdom — server-render a corpus fixture, embed its wire JSON,
//  then hydrateEmbedded — and asserts the decode+mount succeeds with no React
//  hydration-mismatch warning (server + client markup are parity-locked, so the
//  same @fuaran-ui/renderer renders identical DOM on both sides).
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';

import { FuaranRenderer, hydrateEmbedded, hydrationScriptId } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const nodesDir = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'nodes');

/** Server-render a tree to static HTML (the markup the host would ship). */
const serverHtml = (json: string): string => {
  const decoded = decodeNode(json);
  if (!decoded.ok) throw new Error(`fixture decode failed: ${decoded.error.message}`);
  return renderToStaticMarkup(<FuaranRenderer tree={decoded.value} />);
};

/** Set up the page the way the server emits it: a container holding the
 *  server-rendered HTML + the embedded wire-tree <script> keyed by root id. */
const stagePage = (rootId: string, json: string): void => {
  document.body.innerHTML =
    `<div id="host">${serverHtml(json)}</div>` +
    `<script id="${hydrationScriptId(rootId)}" type="application/json">${json}</script>`;
};

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('hydrateEmbedded — in-browser decode + hydrateRoot', () => {
  it('decodes the embedded wire tree and hydrates the server DOM (no mismatch)', async () => {
    const json = readFileSync(join(nodesDir, 'link-1.json'), 'utf8');
    stagePage('link-1', json);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let result!: ReturnType<typeof hydrateEmbedded>;
    await act(async () => {
      result = hydrateEmbedded({ containerId: 'host', rootId: 'link-1' });
    });

    expect(result.ok).toBe(true);
    // The crawlable anchor survived hydration (it was server-rendered, now live).
    expect(document.querySelector('a.fuaran-link')).not.toBeNull();
    // No React hydration-mismatch warning was logged.
    const mismatch = errSpy.mock.calls
      .flat()
      .map(String)
      .some((m) => /hydrat|did not match|did not expect/i.test(m));
    expect(mismatch).toBe(false);
  });

  it('reports a missing embedded-tree script rather than throwing', () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const result = hydrateEmbedded({ containerId: 'host', rootId: 'absent' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('fuaran-hydrate-absent');
  });

  it('surfaces a decode failure on a malformed embedded payload', () => {
    document.body.innerHTML =
      `<div id="host"></div>` +
      `<script id="${hydrationScriptId('bad')}" type="application/json">{ not valid </script>`;
    const result = hydrateEmbedded({ containerId: 'host', rootId: 'bad' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('decode failed');
  });
});
