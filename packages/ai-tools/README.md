# @fuaran-ui/ai-tools

Runtime tree-introspection surface for the [Fuaran UI](https://github.com/fuaran-ui/fuaran-ts) typed `Node` tree — the TypeScript port of the read-only introspection subset of the F# `Fuaran.UI.AiTools` tier.

Walk a typed Fuaran tree and report each node's kind, its bound binding slots (with the canonical wire-form expression — `$state.<key>`, `$queries.<name>`, …), and its structure. Useful for a TS host's own AI integrations (an orchestrator analogue that inspects the current tree to feed the model), dev tooling (a React-DevTools-style panel over the typed Fuaran shape), accessibility audits, and integration tests — without traversing the raw React tree and losing the typed-Fuaran semantics. The kind names + binding-slot expressions match the F# tier for the same tree.

## Install

```sh
npm install @fuaran-ui/ai-tools
```

`@fuaran-ui/schema` is a peer dependency; `react` is an **optional** peer (only the `FuaranIntrospectionProvider` / `useFuaranIntrospection` hook needs it — the introspection functions are React-free).

## Usage

### Functions

```ts
import { getNodeState, findNodes, inspectTree } from '@fuaran-ui/ai-tools';

getNodeState(tree, 'revenue-metric');
// → { id: 'revenue-metric', kind: 'Metric',
//     bindings: [{ slot: 'Source', expression: '$state.revenue', source: 'State' }],
//     childIds: [] }

findNodes(tree, (n) => n.kind.kind === 'Input'); // every interactive node
inspectTree(tree); // recursive structural snapshot
```

### React

```tsx
import { FuaranIntrospectionProvider, useFuaranIntrospection } from '@fuaran-ui/ai-tools';
import { FuaranRenderer } from '@fuaran-ui/renderer';

function DevPanel() {
  const { inspectTree } = useFuaranIntrospection();
  return <pre>{JSON.stringify(inspectTree(), null, 2)}</pre>;
}

function App({ tree }) {
  return (
    <FuaranIntrospectionProvider tree={tree}>
      <FuaranRenderer tree={tree} />
      <DevPanel />
    </FuaranIntrospectionProvider>
  );
}
```

## Scope

This package ships the **source-side, self-contained** introspection surface — kind, binding-slot expressions, and structure. The F# tier additionally resolves binding _values_ against live `BindingSources` and probes renderer geometry / current-state via host seams; those require the renderer's live resolution context and are a candidate follow-up. The shapes this package returns (`kindName`, the per-kind binding-slot table, the `$…` expression forms) match the F# tier's for the same tree.

## Stability

The introspection surface is **alpha** — see [`STABILITY.md`](../../STABILITY.md). The `kindName` output and the binding-slot expression forms are pinned to the F# tier; the envelope shape may grow as adopters surface needs.

Apache-2.0.
