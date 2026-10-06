# @fuaran-ui/observer-core

**Workspace-internal. Not published.**

The observer scaffolding `@fuaran-ui/layout-observer` and `@fuaran-ui/style-observer` share: the node
registry, subscribers that cannot poison each other, change detection on the derived flags,
`[data-fuaran-node-id]` self-discovery, the `MutationObserver` rescan, the animation-frame flush with
its wall-clock debounce, and the React hook body.

| Export                                            | Role                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `createInMemoryObserver({derive, …})`             | The fixture-driven observer behind both `InMemory*Observer` classes         |
| `createObserver({snapshot, derive, discover, …})` | The browser observer behind both `Browser*Observer` classes                 |
| `useObserver(args, canObserve, create)`           | The hook body behind `useFuaranLayoutObserver` and `useFuaranStyleObserver` |

What differs between the two observers stays in each package: the snapshot of an element, the
derivation of an observation from it, and how a change is discovered (geometry through a
`ResizeObserver`; resolved style through attribute mutations).

Both observer packages bundle this code into their own `dist` (`noExternal` + `dts.resolve` in their
`tsup.config.ts`) and keep their public classes and hooks as thin wrappers, so their public exports
are unchanged and no public import path depends on this package. `test/private.test.ts` fails if
this package stops being private or if a published package's built `dist` names it.
