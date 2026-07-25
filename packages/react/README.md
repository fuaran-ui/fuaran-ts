# @fuaran-ui/react

The React adapter for the Fuaran generation endpoint. `useFuaranGenerate` **owns
the current tree as React state**, so the turn-loop is automatic: the first
prompt is a fresh generation and every prompt after it is a cheap **repair diff**
against the tree the last turn produced. You never thread `currentTreeJson` by
hand.

```bash
npm i @fuaran-ui/react @fuaran-ui/client @fuaran-ui/renderer
```

## Quickstart

```tsx
import { useMemo, useState } from 'react';
import { FuaranClient } from '@fuaran-ui/client';
import { FuaranGenerated, useFuaranGenerate } from '@fuaran-ui/react';
import '@fuaran-ui/renderer/css';

export function Panel() {
  // Point at YOUR same-origin proxy route; the proxy injects the token + BYOK
  // key server-side, so no secret reaches the browser bundle.
  const client = useMemo(() => new FuaranClient({ endpoint: '/api/fuaran' }), []);
  const state = useFuaranGenerate({ client });
  const [prompt, setPrompt] = useState('');

  return (
    <section>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void state.generate(prompt);
        }}
      >
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Prompt" />
        <button type="submit" disabled={state.busy}>
          Generate
        </button>
      </form>
      <FuaranGenerated state={state} />
    </section>
  );
}
```

That is the whole integration. The second prompt (`"make the chart a bar chart"`)
is automatically a repair against the tree the first produced.

## The hook

`useFuaranGenerate({ client, initialTreeJson?, maxRepairRetries? })` returns:

| Field                     | What                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `tree`                    | the decoded `Node`, ready for `<FuaranRenderer tree={tree} />`    |
| `treeJson`                | canonical wire JSON of the held tree (what the next turn repairs) |
| `status`                  | `'idle' \| 'generating' \| 'ready' \| 'error'`                    |
| `error`                   | typed failure: `accessDenied` / `turnFailed` / `decodeFailed`     |
| `busy`                    | true while a turn is in flight                                    |
| `generate(prompt, opts?)` | run a turn — automatically a repair once a tree is held           |
| `repair(prompt, opts?)`   | run a turn with the **closed repair loop** (below)                |
| `reset()`                 | forget the held tree; the next turn is fresh again                |

A non-produced outcome **never advances the held tree**, so the previous tree
keeps rendering and the caller can retry the same repair.

## `repair` — the closed loop

When the endpoint rejects an emission at the `apply` or `parse` stage it returns
a hint. `repair` threads that hint back into the next turn automatically
(bounded by `maxRepairRetries`, default 2), so a rejected emission self-corrects
without you plumbing anything:

```tsx
await state.repair('add a date-range filter');
```

Terminal failures (`accessDenied`, a provider/transport error) are surfaced
immediately rather than retried.

## `<FuaranGenerated>`

Renders the held tree through `@fuaran-ui/renderer` and gives the non-ready
states a sensible default. Every `FuaranRenderer` prop passes through, and each
default is overridable:

```tsx
<FuaranGenerated
  state={state}
  dispatch={handleMsg}
  loading={<Spinner />}
  empty={<p>Describe the UI you want.</p>}
  renderError={(e) => <MyError error={e} />}
/>
```

A held tree keeps rendering while the next turn is in flight, so the UI does not
blank out mid-edit.

## Developing offline

Point the client at the local mock — no endpoint, no token, no BYOK spend:

```bash
npx @fuaran-ui/mock          # http://127.0.0.1:8123
```

```tsx
const client = useMemo(() => new FuaranClient({ endpoint: 'http://127.0.0.1:8123' }), []);
```

Swapping to the real endpoint is a one-line change.

## Secrets

Never put a BYOK key or access token in browser code. Use the **server-proxied**
pattern above: your proxy route injects them server-side. The endpoint URL and
paid access token are the commercial gate; this adapter is a thin, OSS-safe layer
over the public surfaces.
