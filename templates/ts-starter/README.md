# Fuaran starter — TypeScript (Vite + React 19)

The 30-second on-ramp: mount the Fuaran renderer, author a typed UI tree, run the
dispatch loop. Everything an AI orchestrator can emit, you can render here.

## Open it in a browser — no install, no account

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/fuaran-ui/fuaran-ts/tree/main/templates/ts-starter?file=src%2Ftree.ts)

- **StackBlitz** — <https://stackblitz.com/github/fuaran-ui/fuaran-ts/tree/main/templates/ts-starter>
- **CodeSandbox** — <https://codesandbox.io/s/github/fuaran-ui/fuaran-ts/tree/main/templates/ts-starter>

Both import this directory on its own and run `npm install` against the public
registry, so what opens is a real host wired to the published `@fuaran-ui/*`
packages — not a snippet. Edit [`src/tree.ts`](src/tree.ts) and the render
updates.

## Or run it locally

```bash
npx degit fuaran-ui/fuaran-ts/templates/ts-starter my-fuaran-app
cd my-fuaran-app
npm install
npm run dev       # http://localhost:24031
```

`pnpm` and `yarn` work the same way. Nothing here depends on the surrounding
repository: the `@fuaran-ui/*` dependencies are ordinary published versions, so
a copy of this directory installs anywhere.

You should see a "Hello, Fuaran" heading, a Counter metric, and two buttons that
move it. That whole UI is the typed `Node` tree in [`src/tree.ts`](src/tree.ts) —
no hand-written JSX for the components.

## What's wired

| File                                                   | Role                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [`src/main.tsx`](src/main.tsx)                         | Browser entry — mounts `<App>`, imports `@fuaran-ui/renderer/css`                   |
| [`src/app.tsx`](src/app.tsx)                           | Host component — `useReducer` dispatch loop + `<FuaranRenderer>` + the host runtime |
| [`src/tree.ts`](src/tree.ts)                           | The authored tree (`@fuaran-ui/ui` smart-ctors) + its `BindingSources`              |
| [`src/model.ts`](src/model.ts)                         | `Model` + `AppMsg` + the `update` reducer (the MVU core)                            |
| [`src/custom-renderers.tsx`](src/custom-renderers.tsx) | Custom-node registry stub — the one audited escape hatch                            |

## The loop

`Model` → `buildTree` projects a typed `Node` tree → `<FuaranRenderer>` renders it
→ a click emits an `AppMsg` via `dispatch` → `update` folds it into the next
`Model` → React re-renders. The same MVU shape the F# tier drives with Elmish.

## Next steps

1. **Add a node** — author another `fuaran.*` node in `src/tree.ts` (a `fuaran.button`,
   `fuaran.grid`, `fuaran.form`, …). If it reads state, add the key to `buildSources`.
2. **Register a query** — back a `binding.state(key, …)` with live data by extending
   `buildSources` (and a `query` source for non-controlled data).
3. **Register a custom renderer** — uncomment the example in `src/custom-renderers.tsx`,
   then author a `fuaran.custom({ moduleId, componentId, props })` node.

## A note on the pinned versions

[`package.json`](package.json) names published `@fuaran-ui/*` versions rather
than workspace links, which is what lets this directory be imported straight
from GitHub by a browser sandbox and copied out by `degit`. Those pins track the
versions this repository currently ships; `node dev-scripts/check-starter-pins.mjs`
(run by the repository's `test` script) fails if they fall behind, so the starter
cannot quietly drift onto an older line.
