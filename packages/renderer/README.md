# @fuaran-ui/renderer

The React renderer for the Fuaran UI typed `Node` tree — the user-visible
surface of the TypeScript reference implementation. A conformant host of the
language-neutral wire-format contract (`fuaran-dotnet/docs/WIRE_FORMAT.md`): it renders
any tree `@fuaran-ui/ui` authors or `@fuaran-ui/ops` decodes, with **class-name
and ARIA parity** to the F# reference renderer (the packaged reference CSS keys
off those exact class names).

```bash
npm install @fuaran-ui/ui @fuaran-ui/ops @fuaran-ui/renderer react react-dom
```

```tsx
import { FuaranRenderer } from '@fuaran-ui/renderer';
import '@fuaran-ui/renderer/css';
import { fuaran, node } from '@fuaran-ui/ui';

const tree = node('root', fuaran.heading({ level: 1, text: { kind: 'Literal', value: 'Hello' } }));

export const App = () => <FuaranRenderer tree={tree} />;
```

## Custom-renderer registry

`NodeKind.Custom` is the bounded escape hatch. Registries are **per-instance**
(never module-global) — the host threads one in via the `runtime` prop:

```tsx
import {
  createCustomRendererRegistry,
  registerCustomRenderer,
  FuaranRenderer,
} from '@fuaran-ui/renderer';

const registry = createCustomRendererRegistry();
registerCustomRenderer(registry, 'charts', 'sparkline', ({ props }) => (
  <MySparkline data={props.points} />
));

<FuaranRenderer tree={tree} runtime={{ registry }} />;
```

## Theme bridge

```tsx
import { FuaranRenderer, defaultTheme } from '@fuaran-ui/renderer';

<FuaranRenderer tree={tree} theme={defaultTheme} />; // injects --fuaran-* vars at the root
```

## In-page introspection (`window.__fuaran`)

Pass `debug` to register a DEBUG-only console global that exposes the running
UI's **typed layer** — so the browser DevTools console answers _"which node is
this, what did this binding resolve to, where is it on screen?"_ instead of
handing back an untyped post-projection DOM node.

```tsx
// Gate on the bundler's dev flag so it never registers in a production build.
<FuaranRenderer tree={tree} sources={sources} debug={import.meta.env.DEV} />
```

Then, in the DevTools console of the running app:

```js
__fuaran.help(); // method reference
__fuaran.inspectTree(); // recursive structural snapshot (every node id)
__fuaran.getNodeState('submit-btn'); // kind + bound binding slots + child ids
__fuaran.getBindingValue('counter-kpi', 'Source'); // resolved value vs the live sources
__fuaran.getRenderedDom('counter-kpi'); // live geometry (x/y/size + overflow/hidden)
__fuaran.findNodes('Button'); // ids of every node of a kind
__fuaran.apply(opJson); // policy-gated TreeOp mutation (default-deny)
```

The global tracks the live tree + sources (it re-registers on each render), so
a value read after a state change reflects the new state. Its shape is
**DEBUG-only and unstable** (excluded from semver), and it is `undefined` unless
`debug` is set — leave it on `import.meta.env.DEV` and a production build never
registers it. `buildDebugGlobal(tree, sources, options?)` /
`registerDebugGlobal(global)` are exported for hosts that want to wire the
global on their own terms.

### Policy-gated `apply(opJson)`

`apply` decodes a canonical-JSON `TreeOp` and applies it to the live tree — but
only when the host's policy gate permits, so an in-page mutation obeys the same
default-deny contract as every other dispatch path. Wire it by passing
`onApply` (the host's "re-render with this tree" callback, typically a
`setState`) alongside `debug`; the apply consults `runtime.canDispatch` first:

```tsx
<FuaranRenderer tree={tree} runtime={runtime} debug={import.meta.env.DEV} onApply={setTree} />
```

`apply` returns a structured envelope, never a silent no-op: `{ ok: true,
status: 'applied' }` on success; `{ ok: false, status: 'denied', denied: true,
error }` when the gate refuses (the tree is unchanged); `'decodeFailed'` /
`'rejected'` for a malformed or inapplicable op; and `'unwired'` when no
`onApply` was supplied (a read-only surface). A host that omits `runtime` (or
its `canDispatch`) allows by default, matching every other dispatch path.

## Sanitisation

Every string→DOM seam (`href`, `dangerouslySetInnerHTML`, custom attributes)
routes through `@fuaran-ui/renderer/sanitize`. Custom-registered React
components are a host trust boundary — they are expected to do their own
escaping.

Apache-2.0. Part of the `@fuaran-ui/*` package set.
