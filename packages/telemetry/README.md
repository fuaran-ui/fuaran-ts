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
