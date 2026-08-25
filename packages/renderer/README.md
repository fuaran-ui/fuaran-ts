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

## Custom / Mount hardening posture — the named contract

`NodeKind.Custom` and `NodeKind.Mount` are the two surfaces that sit **outside**
the dispatch gate structurally, so `runtime.canDispatch` does not reach them.
Their posture is specified once, language-neutrally, in the
[sanitization contract](../../../fuaran-dotnet/SANITIZATION.md) — sections
_"What the registry scoping and `ContentHash` do and do NOT protect"_ and
_"The `Mount` boundary"_. **A new host ports from that contract, not by reading
another host's source**; what follows is only how this host binds it.

**`ContentHash` is drift detection, never authentication.** The tree supplies its
own hash record, so a match proves only that whoever wrote the tree knew the
registered renderer's hash. Strictness is therefore a **host floor a tree may
only tighten**, and under an enforcing floor a hash that cannot be verified —
because the tree declared none, or the registry recorded none — is a refusal
rather than a silent render:

```tsx
<FuaranRenderer tree={tree} runtime={{ registry }} customHashFloor="StrictReplay" />
```

Omitting `customHashFloor` means `'AdvisoryWarning'`: a `Custom` node with no
hash is the common legitimate case, so the default is the lenient one and
enforcement is an act a host takes by name. `classifyCustomHashUnder` is exported
as the pure join, so the rule is testable without a render.

**`Mount` is unprivileged by default.** `runtime.loadGuest` is the guest loader
seam; the renderer's `Mount` arm owns the only call to it and derives the guest's
privilege in the same expression, so a loader cannot construct a privileged guest
context. With no `runtime.guestSeam` wired the guest receives a **deny-all
runtime** — every capability refused through the host's `warn`, `canDispatch`
false, no custom-renderer registry, no nested guest loading. And because
`channel.direction` is a required wire field a decoded tree fills in itself, the
channel is **clamped to `OutOnly` before anything reads it**; `TwoWay` is a host
grant (`GuestSeam.grantTwoWay`) and a refused upgrade is warned, never dropped
silently. The clamp is at the renderer rather than the decoder, deliberately: the
decoder preserves what the wire said, so canonical round-trip and the shared
conformance corpus are untouched.

A `Mount` in a host that wires no loader renders an inert placeholder, exactly as
before.

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
__fuaran.apply(op); // policy-gated TreeOp mutation (default-deny)
__fuaran.getBindingState('counter-kpi', 'Source'); // as getBindingValue, tagged with the binding's identity
__fuaran.treeRevision(); // opaque token identifying the current tree state
__fuaran.subscribe((c) => console.log(c)); // committed-tree-change signal → unsubscribe fn
```

The global tracks the live tree + sources (it re-registers on each render), so
a value read after a state change reflects the new state. Its shape is
**DEBUG-only and unstable** (excluded from semver), and it is `undefined` unless
`debug` is set — leave it on `import.meta.env.DEV` and a production build never
registers it. `buildDebugGlobal(tree, sources, options?)` /
`registerDebugGlobal(global)` are exported for hosts that want to wire the
global on their own terms.

### Policy-gated `apply(op)`

`apply` decodes a canonical `TreeOp` and applies it to the live tree — but only
when the host's policy gate permits, so an in-page mutation obeys the same
default-deny contract as every other dispatch path. Wire it by passing
`onApply` (the host's "re-render with this tree" callback, typically a
`setState`) alongside `debug`; the apply consults `runtime.canDispatch` first:

```tsx
<FuaranRenderer
  tree={tree}
  runtime={runtime}
  debug={import.meta.env.DEV}
  onApply={setTree}
  validate={(candidate) => {
    const r = preEmitValidate(candidate); // @fuaran-ui/ui — optional
    return r.ok ? [] : r.error;
  }}
/>
```

The op may be a **JSON string** (paste it into the console) or a **structured
object** — the same edit, and the host serialises the object canonically rather
than asking the caller to.

`apply` returns a structured envelope, never a silent no-op: `{ ok: true,
status: 'applied', treeRevision }` on success; `{ ok: false, status: 'denied',
denied: true, error }` when the gate refuses (the tree is unchanged);
`'decodeFailed'` (carrying the codec's `DecodeError`) / `'rejected'` (carrying
the diagnostic `code`) for a malformed or inapplicable op; and `'unwired'` when
no `onApply` was supplied (a read-only surface). A host that omits `runtime` (or
its `canDispatch`) allows by default, matching every other dispatch path.

The optional `validate` prop runs the host's tree validator on the **candidate**
tree and folds the edit only when it introduces no defect the tree did not
already carry — a pre-existing defect is not the edit's fault and does not block
it.

### Change subscription

`__fuaran.subscribe(cb)` reports **committed tree changes** and returns an
unsubscribe handle. It pushes — there is nothing to poll — and rapid changes
coalesce into one notification carrying the latest `treeRevision`, because a
change is a staleness signal rather than a change log: re-read what you need.
The subscription lives on a page-wide hub, so it survives the surface rebuild
that every tree change causes.

```js
const off = __fuaran.subscribe(({ treeRevision, cause }) => refresh(treeRevision, cause));
off(); // stop
```

`treeRevision` is **opaque**: compare it for equality to notice a cached read
has gone stale; never parse or order it.

### DevTools relay (`relay`) — off by default

`relay` installs a same-origin `postMessage` endpoint that carries the surface
above across the page/extension boundary, so a browser extension (or any other
same-page script) can inspect — and, where `onApply` is wired, edit — the live
tree. It implements the `relay@1.0` contract (`DEVTOOLS_RELAY.md` in the
specification repository) and is pinned against that contract's fixture family.

```tsx
<FuaranRenderer
  tree={tree}
  debug={import.meta.env.DEV}
  relay={import.meta.env.DEV}
  onApply={setTree}
/>
```

Three properties are deliberate and worth knowing before you enable it:

- **Off by default, and absent rather than inert.** Without `relay`, no listener
  is installed at all, so a probe gets no answer whatsoever. Gate it on the same
  dev flag as `debug`; it is a debugging affordance, not a feature flag.
- **No side door.** Every relayed mutation crosses this host's own decode →
  validate → policy path, in the page. The relay contributes no apply engine, no
  validator, and no policy — a relay client's reach is exactly the set of legal,
  permitted ops, and no message can widen it.
- **Origin discipline.** Messages are accepted only from this same window at this
  same origin, replies are posted at `window.origin` (never `"*"`), and anything
  failing those checks is ignored in silence — a refusal would itself disclose
  that a Fuaran host is present.

`createRelayPeer` / `installRelayPeer` are exported for hosts wiring the peer on
their own terms; both are **not opted in unless told to be**.

## Sanitisation

Every string→DOM seam (`href`, `dangerouslySetInnerHTML`, custom attributes)
routes through `@fuaran-ui/renderer/sanitize`. Custom-registered React
components are a host trust boundary — they are expected to do their own
escaping.

Apache-2.0. Part of the `@fuaran-ui/*` package set.
