// ============================================================================
//  The debug global's `apply` decodes under the host's §23 DecodePolicy
//  (Phase 1931).
//
//  `window.__fuaran.apply` — and the DevTools relay that carries it — is a THIRD
//  way an op reaches the tree. It used to decode with no policy at all, so a kind
//  a host's closed profile refuses on every other path could be pasted in from
//  the console. `DebugGlobalOptions.decodePolicy` closes that, and
//  `<FuaranRenderer debug decodePolicy>` supplies it from the renderer's own.
// ============================================================================

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { CLOSED_PROFILE, type Node } from '@fuaran-ui/schema';
import { fuaran } from '@fuaran-ui/ui';

import { FuaranRenderer } from '../src/index.js';
import { buildDebugGlobal, readRegisteredDebugGlobal } from '../src/debug.js';

const tree = fuaran.stack<unknown>({
  id: 'root',
  children: [fuaran.heading<unknown>({ id: 'title', text: 'Hello', level: 2 })],
});

/** An op inserting a `Custom` node — an escape hatch `CLOSED_PROFILE` refuses. */
const insertCustom = JSON.stringify({
  $type: 'InsertChild',
  child: { id: 'guest', kind: { $type: 'Custom', componentId: 'card', moduleId: 'm', props: {} } },
  parentId: 'root',
});

describe('Phase 1931 — DebugGlobalOptions.decodePolicy', () => {
  it('omitted, every recognised kind is admitted (the behaviour before)', () => {
    const applied: Node<unknown>[] = [];
    const r = buildDebugGlobal(tree, {}, { applyHandler: (t) => applied.push(t) }).apply(
      insertCustom,
    );
    expect(r.ok).toBe(true);
    expect(applied).toHaveLength(1);
  });

  it('given, an op naming a refused kind is a decode failure and the tree is untouched', () => {
    const applied: Node<unknown>[] = [];
    const r = buildDebugGlobal(
      tree,
      {},
      { applyHandler: (t) => applied.push(t), decodePolicy: CLOSED_PROFILE },
    ).apply(insertCustom);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe('decodeFailed');
    expect(applied).toHaveLength(0);
  });
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root !== undefined) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const mount = async (element: React.ReactElement): Promise<void> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
  });
};

describe('Phase 1931 — <FuaranRenderer debug decodePolicy> hands its policy to the surface', () => {
  it('the console apply refuses what the renderer was told to refuse', async () => {
    const applied: Node<unknown>[] = [];
    await mount(
      <FuaranRenderer
        tree={tree}
        debug
        decodePolicy={CLOSED_PROFILE}
        onApply={(t) => applied.push(t)}
      />,
    );
    const surface = readRegisteredDebugGlobal();
    expect(surface).toBeDefined();
    const r = surface!.apply(insertCustom);
    expect(r.ok).toBe(false);
    expect(applied).toHaveLength(0);
  });
});
