// ============================================================================
//  Context + hook test — a consumer component reads the introspection API for
//  the provided tree via useFuaranIntrospection(); using the hook outside a
//  provider throws. (Acceptance: a consumer React component can call
//  useFuaranIntrospection().getNodeState(id) and receive the typed state.)
// ============================================================================

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Node, NodeId } from '@fuaran-ui/schema';

import { FuaranIntrospectionProvider, useFuaranIntrospection } from '../src/index.js';

const nid = (s: string): NodeId => s as NodeId;

const tree: Node<unknown> = {
  id: nid('root'),
  kind: {
    kind: 'Layout',
    layout: {
      kind: 'Box',
      spec: {
        layout: { kind: 'Auto' },
        role: 'Dashboard',
        keepTogether: false,
        breakBefore: false,
        children: [
          {
            id: nid('rev'),
            kind: {
              kind: 'Display',
              display: {
                kind: 'Metric',
                spec: {
                  label: { kind: 'Literal', value: 'Revenue' },
                  value: { kind: 'State', key: 'revenue', defaultValue: 0 },
                  format: { kind: 'None' },
                  tone: 'Default',
                  weight: 'Standard',
                  emphasis: 'Normal',
                  trendPolarity: 'HigherIsBetter',
                },
              },
            },
            state: {},
            style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
          },
        ],
      },
    },
  },
  state: {},
  style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
};

function Probe() {
  const api = useFuaranIntrospection();
  const state = api.getNodeState('rev');
  const inputCount = api.findNodes((n) => n.kind.kind === 'Display').length;
  return (
    <span>
      {state?.kind}|{state?.bindings[0]?.expression}|{api.inspectTree().children.length}|
      {inputCount}
    </span>
  );
}

describe('FuaranIntrospectionProvider + useFuaranIntrospection', () => {
  it('exposes the introspection API to a descendant component', () => {
    const html = renderToStaticMarkup(
      <FuaranIntrospectionProvider tree={tree}>
        <Probe />
      </FuaranIntrospectionProvider>,
    );
    expect(html).toContain('Metric');
    expect(html).toContain('$state.revenue');
    // inspectTree().children.length === 1 (the metric), Display count === 1.
    expect(html).toContain('|1|1');
  });

  it('throws when the hook is used outside a provider', () => {
    expect(() => renderToStaticMarkup(<Probe />)).toThrow(/within a <FuaranIntrospectionProvider>/);
  });
});
