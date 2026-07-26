// @fuaran-ui/telemetry — the telemetry record contract.
//
// The TypeScript mirror of the F# `Fuaran.UI.Telemetry.Abstractions` package:
// the structured records a host's sink receives, and the sink interface itself.
// Field names are camelCase per TS convention and map 1:1 onto the F# record's
// PascalCase fields — the same mirroring the client's `RecoverableError` uses.
//
// The sink is FIRE-AND-FORGET by contract: an implementation must not throw and
// must not gate the operation being recorded. Telemetry is evidence that policy
// was enforced, never part of enforcing it.

/** One structured record per denied dispatch.
 *
 *  `activeModule` / `activePage` / `promptId` are optional for the same reason
 *  the op record's prompt id is: an operator-initiated call (a DevTools console
 *  mutation, say) legitimately belongs to no module, page, or prompt. They are
 *  omitted rather than fabricated.
 *
 *  Mirrors F# `DenyTelemetry` — `ToolName`/`Reason`/`ActiveModule`/`ActivePage`/
 *  `PromptId`/`UserId`/`Timestamp`. */
export interface DenyTelemetry {
  /** What was denied. A stable identifier, not free text. */
  readonly toolName: string;
  /** The deny diagnostic — the same text the caller's deny envelope carries. */
  readonly reason: string;
  readonly activeModule?: string;
  readonly activePage?: string;
  readonly promptId?: string;
  /** The audit subject the denial is attributed to. */
  readonly userId: string;
  /** When the denial happened, as an ISO-8601 instant. */
  readonly timestamp: string;
}

/** The host's telemetry sink. Mirrors F# `IFuaranTelemetrySink`; only the deny
 *  leg is modelled so far — further records are added as their emitters land.
 *
 *  Implementations MUST NOT throw and MUST NOT block: a slow or failing sink
 *  must never change what the caller observes. */
export interface FuaranTelemetrySink {
  readonly recordDeny: (telemetry: DenyTelemetry) => void;
}

/** A sink that retains records in memory — for tests and dev tooling. */
export class InMemoryTelemetrySink implements FuaranTelemetrySink {
  readonly #denies: DenyTelemetry[] = [];

  /** Every deny record received, in arrival order. */
  get denyRecords(): readonly DenyTelemetry[] {
    return this.#denies;
  }

  readonly recordDeny = (telemetry: DenyTelemetry): void => {
    this.#denies.push(telemetry);
  };

  clear(): void {
    this.#denies.length = 0;
  }
}

/** A sink that drops everything — the backward-compatible default for a host
 *  that has not wired telemetry. Mirrors F# `NoOpTelemetrySink`. */
export const noOpTelemetrySink: FuaranTelemetrySink = {
  recordDeny: () => {
    /* intentionally empty */
  },
};
