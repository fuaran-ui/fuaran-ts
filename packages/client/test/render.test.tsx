import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { encodeNode } from '@fuaran-ui/ops';
import { fuaran } from '@fuaran-ui/ui';

import { SURFACE_VERSION, type Produced } from '../src/index.js';
import { decodeProducedTree, mountProduced } from '../src/render.js';

// React 19 wants this flag set before act(...) drives a real root in jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Wrap a real canonical wire tree as a produced result, the way the endpoint
 *  would return it. */
function producedFrom(treeJson: string): Produced {
  return { kind: 'produced', treeJson, ops: [], version: SURFACE_VERSION };
}

describe('render glue — decode + mount', () => {
  it('decodes the wire tree a produced result carries into a typed Node', () => {
    const tree = fuaran.heading({ id: 'h', text: 'Revenue' });
    const produced = producedFrom(encodeNode(tree));

    const decoded = decodeProducedTree(produced);

    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.tree.id).toBe('h');
      expect(decoded.tree.kind.kind).toBe('Display');
    }
  });

  it('surfaces a decode error for malformed wire JSON rather than throwing', () => {
    const decoded = decodeProducedTree(producedFrom('{ not valid json'));

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error.code).toBeDefined();
    }
  });

  it('mounts a produced tree into a container (the one-liner render path)', async () => {
    const tree = fuaran.heading({ id: 'h', text: 'Revenue' });
    const produced = producedFrom(encodeNode(tree));
    const container = document.createElement('div');

    let result!: ReturnType<typeof mountProduced>;
    await act(async () => {
      result = mountProduced(container, produced);
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(container.textContent).toContain('Revenue');
      const { root } = result;
      act(() => root.unmount());
    }
  });
});
