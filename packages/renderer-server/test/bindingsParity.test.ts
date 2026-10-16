// ============================================================================
//  The server and client bindings modules resolve alike (Phase 1931).
//
//  `src/bindings.ts` is a hand twin of @fuaran-ui/renderer's bindings module,
//  kept local so this package carries no React dependency. Its header called it
//  "verbatim", and it had drifted twice: list-valued Transform params (Phase 610)
//  never reached it, and a decoded `Computed`'s remedy text was wrapped here and
//  verbatim there. Each drift is SSR and hydration disagreeing about one tree.
//
//  This lock resolves EVERY binding and every text source of EVERY corpus node
//  fixture through both modules, under several source configurations, and
//  requires the two answers to be identical. It is not a substitute for the
//  structural fix (one React-free module both renderers import); it is what
//  makes the drift loud until that lands.
// ============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Binding, Node, TextSource } from '@fuaran-ui/schema';
import { decodeNode } from '@fuaran-ui/ops';
import {
  renderText as renderTextClient,
  resolve as resolveClient,
  tryResolve as tryResolveClient,
} from '@fuaran-ui/renderer';

import {
  renderText as renderTextServer,
  resolve as resolveServer,
  tryResolve as tryResolveServer,
  type BindingSources,
} from '../src/bindings.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const nodesDir = join(wireCorpusRoot(), 'nodes');
const fixtureFiles = readdirSync(nodesDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

/** The cases `resolve` dispatches on — a walked object carrying one is a binding. */
const BINDING_KINDS = new Set([
  'Static',
  'Query',
  'Filter',
  'Selection',
  'State',
  'Now',
  'Computed',
  'Local',
  'Format',
  'Transform',
  'Expr',
  'Invoke',
]);

/** The cases `renderText` dispatches on (`I18n` is also a binding case; both are tried). */
const TEXT_KINDS = new Set(['Literal', 'Bound', 'I18n']);

interface Found {
  readonly bindings: Binding<unknown>[];
  readonly texts: TextSource[];
  readonly stateKeys: Set<string>;
  readonly filterNames: Set<string>;
  readonly selectionIds: Set<string>;
}

/** Every binding- and text-shaped object reachable from the decoded tree. */
const walk = (tree: Node<unknown>): Found => {
  const found: Found = {
    bindings: [],
    texts: [],
    stateKeys: new Set(),
    filterNames: new Set(),
    selectionIds: new Set(),
  };
  const seen = new Set<unknown>();
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const o = v as Record<string, unknown>;
    const kind = o['kind'];
    if (typeof kind === 'string') {
      if (BINDING_KINDS.has(kind)) found.bindings.push(o as unknown as Binding<unknown>);
      if (TEXT_KINDS.has(kind)) found.texts.push(o as unknown as TextSource);
      if (kind === 'State' && typeof o['key'] === 'string') found.stateKeys.add(o['key']);
      if (kind === 'Filter' && typeof o['name'] === 'string') found.filterNames.add(o['name']);
      if (kind === 'Selection' && typeof o['nodeId'] === 'string')
        found.selectionIds.add(o['nodeId']);
    }
    for (const value of Object.values(o)) visit(value);
  };
  visit(tree);
  return found;
};

/** The source configurations each fixture is resolved under. */
const configurations = (found: Found): readonly [string, BindingSources][] => {
  const fill = (keys: Set<string>, value: unknown): Record<string, unknown> =>
    Object.fromEntries([...keys].map((k) => [k, value]));
  return [
    ['empty sources', {}],
    [
      'scalar-written sources',
      {
        state: fill(found.stateKeys, 'eng'),
        filters: fill(found.filterNames, 'eng'),
        selections: fill(found.selectionIds, { id: 'r1', dept: 'eng' }),
        now: '2026-01-02T03:04:05Z',
        i18n: { greeting: 'Hello {name}' },
      },
    ],
    [
      'list-written sources (a multi-select selection)',
      {
        state: fill(found.stateKeys, ['eng', 'sales']),
        filters: fill(found.filterNames, ['eng', 'sales']),
        now: '2026-01-02T03:04:05Z',
      },
    ],
    ['empty-selection sources', { filters: fill(found.filterNames, []) }],
  ];
};

/** One answer as comparable text: functions and `undefined` named, never dropped. */
const show = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'function' ? '<fn>' : v === undefined ? '<undefined>' : v,
  ) ?? '<undefined>';

const attempt = (f: () => unknown): string => {
  try {
    return show(f());
  } catch (ex) {
    return `threw ${ex instanceof Error ? `${ex.name}: ${ex.message}` : String(ex)}`;
  }
};

const decode = (file: string): Node<unknown> => {
  const decoded = decodeNode(readFileSync(join(nodesDir, file), 'utf8'));
  if (!decoded.ok) throw new Error(`decode failed for ${file}: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

describe('Phase 1931 — the SSR and client bindings modules resolve alike', () => {
  it('reads a non-trivial corpus, list-param fixture included (the lock is not vacuous)', () => {
    expect(fixtureFiles.length).toBeGreaterThan(100);
    expect(fixtureFiles).toContain('multiselect-chip-list-param.json');
    const total = fixtureFiles.reduce((n, f) => n + walk(decode(f)).bindings.length, 0);
    expect(total).toBeGreaterThan(400);
  });

  it.each(fixtureFiles)('%s', (file) => {
    const tree = decode(file);
    const found = walk(tree);
    const diffs: string[] = [];
    for (const [label, sources] of configurations(found)) {
      found.bindings.forEach((b, i) => {
        const server = attempt(() => resolveServer(sources, b));
        const client = attempt(() => resolveClient(sources, b));
        if (server !== client)
          diffs.push(`${label} · binding #${i} (${b.kind}): server ${server} · client ${client}`);
        const tServer = attempt(() => tryResolveServer(sources, b));
        const tClient = attempt(() => tryResolveClient(sources, b));
        if (tServer !== tClient)
          diffs.push(
            `${label} · tryResolve #${i} (${b.kind}): server ${tServer} · client ${tClient}`,
          );
      });
      found.texts.forEach((t, i) => {
        const server = attempt(() => renderTextServer(sources, t));
        const client = attempt(() => renderTextClient(sources, t));
        if (server !== client)
          diffs.push(`${label} · text #${i} (${t.kind}): server ${server} · client ${client}`);
      });
    }
    expect(diffs).toEqual([]);
  });

  it('a decoded Computed shows ONE error text on both tiers, the remedy verbatim', () => {
    const decoded = decodeNode(
      JSON.stringify({
        id: 'm',
        kind: { $type: 'Metric', label: 'Revenue', value: { $type: 'Computed', fn: '<closure>' } },
      }),
    );
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.error));
    const computed = walk(decoded.value).bindings.find((b) => b.kind === 'Computed');
    if (computed === undefined) throw new Error('no Computed binding decoded');
    const server = resolveServer({}, computed);
    const client = resolveClient({}, computed);
    expect(server).toEqual(client);
    expect(server.kind).toBe('Errored');
    if (server.kind === 'Errored') expect(server.message).not.toMatch(/^Computed binding threw/);
  });
});
