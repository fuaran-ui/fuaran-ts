// ============================================================================
//  ConsoleDevToolsSink — the narration contract, executable.
//
//  Two things are pinned here, and they are pinned separately on purpose.
//
//  The RECORD-TO-FORMAT mapping (`formatDeny`) is the host-agnostic half: the
//  severity, the header text, and the detail rows in order are parity-locked
//  with the F# sink of the same name, so the same denial reads identically
//  whichever tier narrated it. A reworded header is a cross-host break, not a
//  cosmetic edit, and these assertions are what make that visible.
//
//  The WRITER is the host-specific half: grouped and tabular where the console
//  offers it, an indented `[fuaran.devtools]` line block where it does not. The
//  fallback shape is itself parity-locked — a log filter written against either
//  tier must match the other — so it is asserted literally rather than loosely.
//
//  Threaded through both: a sink must not throw and must not gate what it
//  observes. A writer that throws, a console missing half its methods, a
//  `table` that blows up mid-group — none of them may reach the caller, and
//  none may leave a console group open to indent everything that follows.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  ConsoleDevToolsSink,
  consoleDevToolsDefaults,
  consoleDevToolsDenialsAndFailuresOnly,
  createConsoleDevToolsSink,
  createConsoleDevToolsWriter,
  devToolsHeaderLine,
  devToolsLevelRank,
  formatDeny,
  type ConsoleDevToolsOptions,
  type DenyTelemetry,
  type DevToolsConsoleTarget,
  type DevToolsRecord,
  type FuaranTelemetrySink,
} from '../src/index.js';

const deny = (toolName: string, overrides: Partial<DenyTelemetry> = {}): DenyTelemetry => ({
  toolName,
  reason: `denied: ${toolName}`,
  userId: 'user-1',
  timestamp: '2026-07-29T12:00:00.000Z',
  ...overrides,
});

/** A capturing writer — the seam a host injects, standing in for a console. */
const capturingWriter = (): { records: DevToolsRecord[]; group: (r: DevToolsRecord) => void } => {
  const records: DevToolsRecord[] = [];
  return { records, group: (r) => void records.push(r) };
};

/** A capturing console: every call recorded as `[method, ...args]`, with the
 *  optional methods present only when asked for, so the writer's probing path
 *  is exercised rather than assumed. */
const capturingConsole = (
  present: ReadonlyArray<keyof DevToolsConsoleTarget> = [
    'log',
    'info',
    'warn',
    'error',
    'group',
    'groupCollapsed',
    'groupEnd',
    'table',
  ],
): { calls: unknown[][]; target: DevToolsConsoleTarget } => {
  const calls: unknown[][] = [];
  const method =
    (name: string) =>
    (...args: unknown[]): void =>
      void calls.push([name, ...args]);

  const target: Record<string, unknown> = { log: method('log') };
  for (const name of present) {
    target[name] = method(name);
  }
  return { calls, target: target as unknown as DevToolsConsoleTarget };
};

describe('devToolsLevelRank', () => {
  it('orders info < warn < error', () => {
    expect(devToolsLevelRank('info')).toBeLessThan(devToolsLevelRank('warn'));
    expect(devToolsLevelRank('warn')).toBeLessThan(devToolsLevelRank('error'));
  });
});

describe('formatDeny — the host-agnostic mapping', () => {
  it('classifies a denial as warn and renders the parity header', () => {
    const record = formatDeny(deny('addNode'));

    expect(record.level).toBe('warn');
    expect(record.header).toBe('deny tool=addNode — denied: addNode');
  });

  it('renders the detail rows in the parity order', () => {
    const record = formatDeny(
      deny('addNode', { activeModule: 'reports', activePage: 'summary', promptId: 'p-7' }),
    );

    expect(record.rows).toEqual([
      { key: 'module', value: 'reports' },
      { key: 'page', value: 'summary' },
      { key: 'prompt', value: 'p-7' },
      { key: 'user', value: 'user-1' },
      { key: 'ts', value: '2026-07-29T12:00:00.000Z' },
    ]);
  });

  it('renders an omitted optional as `-` rather than fabricating one', () => {
    const record = formatDeny(deny('addNode'));

    expect(record.rows.map((r) => r.value)).toEqual([
      '-',
      '-',
      '-',
      'user-1',
      '2026-07-29T12:00:00.000Z',
    ]);
  });

  it('passes the timestamp through verbatim — no re-parse, nothing to throw on', () => {
    const record = formatDeny(deny('addNode', { timestamp: 'not-a-date' }));

    expect(record.rows.at(-1)).toEqual({ key: 'ts', value: 'not-a-date' });
  });
});

describe('ConsoleDevToolsSink — filtering', () => {
  it('narrates each record through the injected writer, in arrival order', () => {
    const writer = capturingWriter();
    const sink = new ConsoleDevToolsSink(consoleDevToolsDefaults, writer);

    sink.recordDeny(deny('addNode'));
    sink.recordDeny(deny('removeNode'));

    expect(writer.records.map((r) => r.header)).toEqual([
      'deny tool=addNode — denied: addNode',
      'deny tool=removeNode — denied: removeNode',
    ]);
  });

  it('suppresses the record type when its toggle is off', () => {
    const writer = capturingWriter();
    const options: ConsoleDevToolsOptions = { showDeny: false, minSeverity: 'info' };

    new ConsoleDevToolsSink(options, writer).recordDeny(deny('addNode'));

    expect(writer.records).toEqual([]);
  });

  it('suppresses a record below the minimum severity', () => {
    const writer = capturingWriter();
    const options: ConsoleDevToolsOptions = { showDeny: true, minSeverity: 'error' };

    new ConsoleDevToolsSink(options, writer).recordDeny(deny('addNode'));

    expect(writer.records).toEqual([]);
  });

  it('still narrates a denial in the quiet diagnostic preset', () => {
    const writer = capturingWriter();

    new ConsoleDevToolsSink(consoleDevToolsDenialsAndFailuresOnly, writer).recordDeny(
      deny('addNode'),
    );

    expect(writer.records).toHaveLength(1);
  });

  it('isolates a throwing writer — telemetry never reaches the caller', () => {
    const sink = new ConsoleDevToolsSink(consoleDevToolsDefaults, {
      group: () => {
        throw new Error('writer exploded');
      },
    });

    expect(() => sink.recordDeny(deny('addNode'))).not.toThrow();
  });

  it('exposes recordDeny as a bound reference a host can detach', () => {
    const writer = capturingWriter();
    const sink = new ConsoleDevToolsSink(consoleDevToolsDefaults, writer);
    const record: FuaranTelemetrySink['recordDeny'] = sink.recordDeny;

    record(deny('addNode'));

    expect(writer.records).toHaveLength(1);
  });

  it('is usable wherever the sink interface is required', () => {
    const writer = capturingWriter();
    const sink = createConsoleDevToolsSink(consoleDevToolsDefaults, writer);
    const useSink = (s: FuaranTelemetrySink): void => s.recordDeny(deny('addNode'));

    expect(() => useSink(sink)).not.toThrow();
    expect(writer.records).toHaveLength(1);
  });
});

describe('createConsoleDevToolsWriter — the grouped path', () => {
  it('opens a collapsed group, tables the rows, and closes it', () => {
    const { calls, target } = capturingConsole();

    createConsoleDevToolsWriter(target).group(formatDeny(deny('addNode')));

    expect(calls.map((c) => c[0])).toEqual(['groupCollapsed', 'table', 'groupEnd']);
    expect(calls[0]?.[1]).toBe('[fuaran.devtools] ⚠ deny tool=addNode — denied: addNode');
    expect(calls[1]?.[1]).toEqual({
      module: '-',
      page: '-',
      prompt: '-',
      user: 'user-1',
      ts: '2026-07-29T12:00:00.000Z',
    });
  });

  it('falls back to the level method for rows when the console has no table', () => {
    const { calls, target } = capturingConsole(['log', 'warn', 'group', 'groupEnd']);

    createConsoleDevToolsWriter(target).group(formatDeny(deny('addNode')));

    expect(calls.map((c) => c[0])).toEqual([
      'group',
      'warn',
      'warn',
      'warn',
      'warn',
      'warn',
      'groupEnd',
    ]);
    expect(calls[1]?.[1]).toBe('    module: -');
  });

  it('closes the group even when the table call throws', () => {
    const calls: string[] = [];
    const target = {
      log: () => void calls.push('log'),
      warn: () => void calls.push('warn'),
      groupCollapsed: () => void calls.push('groupCollapsed'),
      groupEnd: () => void calls.push('groupEnd'),
      table: () => {
        throw new Error('table exploded');
      },
    } as unknown as DevToolsConsoleTarget;

    expect(() =>
      createConsoleDevToolsWriter(target).group(formatDeny(deny('addNode'))),
    ).not.toThrow();
    expect(calls).toEqual(['groupCollapsed', 'groupEnd']);
  });
});

describe('createConsoleDevToolsWriter — the flat fallback', () => {
  it('prints the tagged header and indented rows when grouping is unavailable', () => {
    const { calls, target } = capturingConsole(['log']);

    createConsoleDevToolsWriter(target).group(
      formatDeny(deny('addNode', { activeModule: 'reports' })),
    );

    expect(calls).toEqual([
      ['log', '[fuaran.devtools] ⚠ deny tool=addNode — denied: addNode'],
      ['log', '    module: reports'],
      ['log', '    page: -'],
      ['log', '    prompt: -'],
      ['log', '    user: user-1'],
      ['log', '    ts: 2026-07-29T12:00:00.000Z'],
    ]);
  });

  it('tags each severity distinctly, so denials and failures are scannable apart', () => {
    const at = (level: DevToolsRecord['level']): string =>
      devToolsHeaderLine({ level, header: 'h', rows: [] });

    expect(at('info')).toBe('[fuaran.devtools] ▸ h');
    expect(at('warn')).toBe('[fuaran.devtools] ⚠ h');
    expect(at('error')).toBe('[fuaran.devtools] ✖ h');
  });

  it('never throws on a console whose methods throw', () => {
    const target = {
      log: () => {
        throw new Error('console exploded');
      },
    } as unknown as DevToolsConsoleTarget;

    expect(() =>
      createConsoleDevToolsWriter(target).group(formatDeny(deny('addNode'))),
    ).not.toThrow();
  });
});
