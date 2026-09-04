# Getting started — the six-lesson tour

Six short lessons that between them explain what this language is for. Each is a
few dozen lines you can read in one sitting, and the whole tour runs in about a
second.

```bash
pnpm --filter @fuaran-ui/getting-started-sample build
pnpm --filter @fuaran-ui/getting-started-sample start           # the whole tour
pnpm --filter @fuaran-ui/getting-started-sample start replay    # just one lesson
```

(Or from this directory: `pnpm build && pnpm start`. It needs the workspace
packages built first — `pnpm build` at the repo root.)

**Five of the six need no key, no network and no browser.** Only the last one calls
a model, and only when you supply your own key — so nothing here is unrunnable
because you have not signed up for anything.

## The lessons

|     | Lesson       | What it shows                                                                                                                                |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `authoring`  | A user interface is a **value**. Build a typed tree with ordinary functions, encode it to canonical JSON, render it to HTML with no browser. |
| 2   | `ops`        | **Edit the tree, don't regenerate it.** A `TreeOp` is a typed, addressed edit that applies deterministically and fails by name.              |
| 3   | `replay`     | A session is a **hash-chained list of ops**, so it replays exactly, time-travels for free, and detects tampering.                            |
| 4   | `safety`     | **Safety is a property of the shape.** Malformed emissions are refused because the vocabulary has no code case to strip.                     |
| 5   | `operations` | **Declared operations need no model.** A control publishes typed operations; a structural search dispatches one deterministically, offline.  |
| 6   | `ai`         | **Bring your own key**: prompt → wire JSON → strict decode → render. The whole loop, in one file.                                            |

## Try this: run lesson 3 in another host

The F# and Python hosts ship the same tour. Run `replay` in any two of them and
compare the chain hashes: they are character for character the same. The pre-image
is a shared, versioned envelope over the canonical op bytes, so a session recorded
by one host verifies in another — which is what having a specification buys you
over having a library.

## Running lesson 6 with your own key

```bash
# PowerShell
$env:ANTHROPIC_API_KEY = "sk-..."
pnpm start ai

# bash
export ANTHROPIC_API_KEY="sk-..."
pnpm start ai

# or, without setting an environment variable at all
pnpm start ai --key sk-...
```

The key is read from this process, sent to the provider you chose, and used for one
request. Nothing is stored and nothing is logged. There is no SDK involved — Node's
global `fetch` and one JSON body — so pointing the sample at a different provider is
a different URL and a different field name.

## What to read next

- **`samples/demo`** — the same vocabulary rendered by React in a browser.
- **`samples/hydration`** — server-render, embed the wire, hydrate in the browser.
- **`CONFORMANCE.md`** — what it takes for a new host to certify against the wire
  format.

## A note on what is not here

Lesson 5 declares its own patterns, in its own file. What no sample can show you is
a pattern bank **learned** from a corpus of real sessions — a resolver that gets
better the more it is used. That is not part of the open language tier, and its
absence is deliberate rather than an oversight.
