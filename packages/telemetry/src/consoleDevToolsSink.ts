// ============================================================================
//  ConsoleDevToolsSink — the "passive narration" half of the live-debug console.
//
//  Pretty-prints every already-emitted telemetry beacon as a grouped,
//  severity-tagged record as it fires, so a developer watching a live Fuaran app
//  sees a running, human-scannable log of what the AI (or an in-page `apply`)
//  just did and whether it was allowed. The pull counterpart is the renderer's
//  `window.__fuaran` debug global; this is the push side.
//
//  Zero new contracts: it is a pure read-projection of the canonical telemetry
//  stream — it renders only the records that already ship through
//  `FuaranTelemetrySink`, and never gates the operation it observes.
//
//  The record-to-format mapping (`formatDeny` and its future siblings) is the
//  parity surface with the F# `Fuaran.UI.Telemetry.Default` sink of the same
//  name: identical severity classification, identical header text, identical
//  detail rows in identical order, and the same `-` placeholder for an omitted
//  optional. Console output is therefore host-agnostic — the same denial reads
//  the same way whichever tier narrated it. It is exported rather than kept
//  private precisely because it IS that contract.
//
//  Output goes through an injectable `DevToolsConsoleWriter` seam, never a raw
//  `console.*` call from the sink itself. The default writer renders a
//  collapsible `console.group` with a `console.table` of the detail rows where
//  the host console offers them, and degrades to an indented, `[fuaran.devtools]`
//  -prefixed line block where it does not — the same flat shape the F# default
//  writer emits, so a log filter written against one tier matches the other.
//
//  Coverage note: the TS record contract models the deny leg only (see
//  `./index.ts`), so this sink narrates denials. The severity model, the writer
//  seam, the filter knobs and the option presets mirror the F# sink in full, so
//  each further record type is one `format*` function and one toggle when its
//  record and its emitter land here.
// ============================================================================

import type { DenyTelemetry, FuaranTelemetrySink } from './index.js';

/** Severity classifier for a rendered record. Authorizer denials are `warn`;
 *  successful operations narrate at `info` and render failures at `error` as
 *  those legs land. Drives the `minSeverity` filter and the writer's per-level
 *  console method. */
export type DevToolsLevel = 'info' | 'warn' | 'error';

const LEVEL_RANK: Readonly<Record<DevToolsLevel, number>> = { info: 0, warn: 1, error: 2 };

/** Ascending rank — `info` < `warn` < `error` — for the `minSeverity` gate. */
export const devToolsLevelRank = (level: DevToolsLevel): number => LEVEL_RANK[level];

/** One `key: value` detail row beneath a record's header. */
export interface DevToolsRow {
  readonly key: string;
  readonly value: string;
}

/** One telemetry record, rendered: a severity, a header line, and its detail
 *  rows. This is the whole of what a writer receives — the mapping from a
 *  telemetry record to this shape is the host-agnostic part. */
export interface DevToolsRecord {
  readonly level: DevToolsLevel;
  readonly header: string;
  readonly rows: readonly DevToolsRow[];
}

/** The injectable console-group writer seam. One `group` call renders one
 *  telemetry record, so a host swaps the rendering (browser `console.group`, a
 *  plain line log, a test-capture shim) without touching the sink's
 *  record-to-format logic. */
export interface DevToolsConsoleWriter {
  readonly group: (record: DevToolsRecord) => void;
}

type ConsoleMethod = (...args: unknown[]) => void;

/** The structural slice of a console the default writer uses. Everything past
 *  `log` is optional and probed for: a host console without grouping or tables
 *  gets the flat fallback rather than a crash. Declared structurally rather
 *  than as the ambient `Console` so this package stays free of a DOM or Node
 *  lib dependency. */
export interface DevToolsConsoleTarget {
  readonly log: ConsoleMethod;
  readonly info?: ConsoleMethod;
  readonly warn?: ConsoleMethod;
  readonly error?: ConsoleMethod;
  readonly group?: ConsoleMethod;
  readonly groupCollapsed?: ConsoleMethod;
  readonly groupEnd?: () => void;
  // Narrower than `ConsoleMethod` on purpose: this is exactly how the writer
  // calls it, and the ambient `Console.table` declares a second, string-array
  // parameter that a permissive rest signature is not assignable from.
  readonly table?: (tabularData: Record<string, string>) => void;
}

const TAGS: Readonly<Record<DevToolsLevel, string>> = { info: '▸', warn: '⚠', error: '✖' };

/** The header line as the flat fallback prints it — prefixed `[fuaran.devtools]`
 *  so a log filter can target the sink without colliding with unrelated console
 *  callers, and tagged per severity. Parity-locked with the F# default writer. */
export const devToolsHeaderLine = (record: DevToolsRecord): string =>
  `[fuaran.devtools] ${TAGS[record.level]} ${record.header}`;

/** Default writer. Renders a collapsible group with a table of detail rows when
 *  the console offers `group`/`groupCollapsed` and `table`, and an indented line
 *  block otherwise. Best-effort throughout: a transiently-unusable console never
 *  poisons the path the sink observes. */
export const createConsoleDevToolsWriter = (
  target: DevToolsConsoleTarget = console,
): DevToolsConsoleWriter => ({
  group: (record: DevToolsRecord): void => {
    try {
      const line = devToolsHeaderLine(record);
      const levelled = target[record.level] ?? target.log;
      const open = target.groupCollapsed ?? target.group;

      if (open === undefined || target.groupEnd === undefined) {
        levelled.call(target, line);
        for (const row of record.rows) {
          levelled.call(target, `    ${row.key}: ${row.value}`);
        }
        return;
      }

      open.call(target, line);
      try {
        if (target.table !== undefined && record.rows.length > 0) {
          const table: Record<string, string> = {};
          for (const row of record.rows) {
            table[row.key] = row.value;
          }
          target.table.call(target, table);
        } else {
          for (const row of record.rows) {
            levelled.call(target, `    ${row.key}: ${row.value}`);
          }
        }
      } finally {
        // Always close the group we opened — leaving it open would indent every
        // unrelated console line that follows.
        target.groupEnd.call(target);
      }
    } catch {
      /* best-effort: telemetry rendering must never throw at its caller */
    }
  },
});

/** Construction-time filter knobs. Toggle a record type off, and/or raise the
 *  `minSeverity` floor, so the sink runs noisily in dev (`consoleDevToolsDefaults`)
 *  and quietly in a near-prod diagnostic build
 *  (`consoleDevToolsDenialsAndFailuresOnly`). */
export interface ConsoleDevToolsOptions {
  readonly showDeny: boolean;
  readonly minSeverity: DevToolsLevel;
}

/** Show everything at every severity — the dev default. */
export const consoleDevToolsDefaults: ConsoleDevToolsOptions = {
  showDeny: true,
  minSeverity: 'info',
};

/** Quiet diagnostic mode — only denials and failures narrate. The preset name
 *  and the `warn` floor are parity-locked with the F# sink, so a host's wiring
 *  reads the same across tiers; with only the deny leg modelled here it admits
 *  the same records the dev default does, and starts suppressing the moment an
 *  `info`-severity leg lands. */
export const consoleDevToolsDenialsAndFailuresOnly: ConsoleDevToolsOptions = {
  showDeny: true,
  minSeverity: 'warn',
};

const optional = (value: string | undefined): string => value ?? '-';

/** The deny record's rendering. Warn severity; `-` for an omitted optional
 *  rather than a fabricated value, matching how the record itself omits them.
 *
 *  The timestamp is passed through verbatim: the record's contract already says
 *  ISO-8601, so re-parsing it through `Date` would only risk throwing on a
 *  malformed input inside a sink that must not throw. */
export const formatDeny = (telemetry: DenyTelemetry): DevToolsRecord => ({
  level: 'warn',
  header: `deny tool=${telemetry.toolName} — ${telemetry.reason}`,
  rows: [
    { key: 'module', value: optional(telemetry.activeModule) },
    { key: 'page', value: optional(telemetry.activePage) },
    { key: 'prompt', value: optional(telemetry.promptId) },
    { key: 'user', value: telemetry.userId },
    { key: 'ts', value: telemetry.timestamp },
  ],
});

/** A presentational `FuaranTelemetrySink` that narrates the telemetry stream as
 *  grouped, severity-tagged DevTools-console records. Never throws — telemetry
 *  is best-effort by contract, and that holds for a misbehaving writer too. */
export class ConsoleDevToolsSink implements FuaranTelemetrySink {
  readonly #options: ConsoleDevToolsOptions;
  readonly #writer: DevToolsConsoleWriter;

  constructor(
    options: ConsoleDevToolsOptions = consoleDevToolsDefaults,
    writer: DevToolsConsoleWriter = createConsoleDevToolsWriter(),
  ) {
    this.#options = options;
    this.#writer = writer;
  }

  // Bound property, not a method: a host hands `sink.recordDeny` to a caller
  // that knows nothing about the sink, and a plain method would lose `this`.
  readonly recordDeny = (telemetry: DenyTelemetry): void => {
    this.#emit(this.#options.showDeny, formatDeny(telemetry));
  };

  #emit(enabled: boolean, record: DevToolsRecord): void {
    if (!enabled) {
      return;
    }
    if (devToolsLevelRank(record.level) < devToolsLevelRank(this.#options.minSeverity)) {
      return;
    }
    try {
      this.#writer.group(record);
    } catch {
      // The writer is best-effort; a misbehaving writer must never poison the
      // dispatch path it observes.
    }
  }
}

/** Fresh sink with the dev defaults and the default console writer. Pass
 *  `options` to tune the filters, and `writer` to inject a different rendering
 *  (a test-capture shim, or a writer over a console other than the global). */
export const createConsoleDevToolsSink = (
  options: ConsoleDevToolsOptions = consoleDevToolsDefaults,
  writer: DevToolsConsoleWriter = createConsoleDevToolsWriter(),
): FuaranTelemetrySink => new ConsoleDevToolsSink(options, writer);
