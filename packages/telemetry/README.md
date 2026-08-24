# @fuaran-ui/telemetry

The telemetry record contract for Fuaran hosts: the structured records a sink
receives, and the sink interface itself. The TypeScript mirror of the F#
`Fuaran.UI.Telemetry.Abstractions` package — field names are camelCase and map
1:1 onto the F# record's PascalCase fields.

```bash
npm i @fuaran-ui/telemetry
```

## The contract

```ts
interface DenyTelemetry {
  readonly toolName: string; // what was denied — a stable id, not free text
  readonly reason: string; // the same diagnostic the deny envelope carries
  readonly activeModule?: string;
  readonly activePage?: string;
  readonly promptId?: string;
  readonly userId: string; // the audit subject
  readonly timestamp: string; // ISO-8601
}

interface FuaranTelemetrySink {
  readonly recordDeny: (telemetry: DenyTelemetry) => void;
}
```

A deny record is **audit evidence that policy was enforced** — emitted after the
decision, never as part of making it. The optional fields are omitted rather than
fabricated: an operator-initiated call (a DevTools console mutation, say)
legitimately belongs to no module, page, or prompt.

## The sink contract

Implementations **must not throw and must not block**. A slow or failing sink
must never change what the caller observes — every emitter wraps the call so a
sink failure is swallowed. Telemetry is evidence, not enforcement.

## Provided sinks

```ts
import { InMemoryTelemetrySink, noOpTelemetrySink } from '@fuaran-ui/telemetry';

const sink = new InMemoryTelemetrySink();
// … drive your host …
sink.denyRecords; // readonly DenyTelemetry[]
sink.clear();
```

`noOpTelemetrySink` drops everything — the backward-compatible default for a host
that has not wired telemetry.

## Narrating the stream in the DevTools console

`ConsoleDevToolsSink` is the passive half of a live-debug console: it renders
every beacon as a collapsible, severity-tagged console group as it fires, so you
watch a running log of what the AI (or an in-page `apply`) just did and whether
it was allowed. The pull counterpart is the renderer's `window.__fuaran` debug
global; this is the push side.

```ts
import { createConsoleDevToolsSink } from '@fuaran-ui/telemetry';

const sink = createConsoleDevToolsSink(); // dev defaults: everything, every severity
```

It introduces no new record type — it is a read-projection of the contract
above. Denials narrate at `warn`; `info` and `error` are in the severity model
for the legs that land alongside their records.

**Filter knobs.** Toggle a record type off, or raise the severity floor, so the
sink runs noisily in dev and quietly in a near-prod diagnostic build:

```ts
import {
  createConsoleDevToolsSink,
  consoleDevToolsDenialsAndFailuresOnly,
} from '@fuaran-ui/telemetry';

const quiet = createConsoleDevToolsSink(consoleDevToolsDenialsAndFailuresOnly);
const custom = createConsoleDevToolsSink({ showDeny: true, minSeverity: 'warn' });
```

**The writer seam.** All output goes through an injectable `DevToolsConsoleWriter`
— never a raw `console.*` call from the sink — so a host swaps the rendering
without touching the record-to-format logic:

```ts
const sink = createConsoleDevToolsSink(consoleDevToolsDefaults, {
  group: (record) => myPanel.append(record), // { level, header, rows }
});

// Or keep the default rendering, pointed at a console other than the global:
createConsoleDevToolsWriter(myConsole);
```

The default writer opens a `console.groupCollapsed`, tables the detail rows, and
closes the group; where a console offers neither grouping nor tables it prints
the same content as an indented `[fuaran.devtools]`-prefixed line block. Both
paths are best-effort — a console that throws never reaches the caller, and a
group is always closed.

**Parity.** `formatDeny` is exported because it _is_ the cross-host contract: the
severity, the header text and the detail-row order are parity-locked with the F#
`ConsoleDevToolsSink`, so the same denial reads identically whichever tier
narrated it and a drift detector can correlate console output across hosts.
Rewording a header is a cross-host break, not a cosmetic edit.

## Who emits

`@fuaran-ui/renderer`'s debug global records a deny when a console-driven
`window.__fuaran.apply` is refused by the policy gate, under the stable tool name
`__fuaran.apply`:

```ts
buildDebugGlobal(tree, sources, {
  runtime,
  applyHandler,
  sinks: { telemetrySink: sink, userId: 'operator' },
});
```

Both the tool name and the record shape are parity-locked with the F# mirror, so
a drift detector can correlate denials across hosts.
