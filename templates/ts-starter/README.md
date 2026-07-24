# Fuaran starter — TypeScript (Vite + React 19)

The 30-second on-ramp: mount the Fuaran renderer, author a typed UI tree, run the
dispatch loop. Everything an AI orchestrator can emit, you can render here.

```bash
pnpm install
pnpm dev          # http://localhost:24031
```

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

## Using this outside the Fuaran workspace

This template is a member of the Fuaran pnpm workspace, so it depends on the
`@fuaran-ui/*` packages via `workspace:*` (they resolve to the local checkout).
When you copy it out (degit / `create-fuaran-app`), replace the `workspace:*`
ranges in [`package.json`](package.json) with the published versions, e.g.
`"@fuaran-ui/renderer": "^0.1.0"`, once the packages are on npm.
