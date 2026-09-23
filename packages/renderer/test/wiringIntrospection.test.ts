// ============================================================================
//  The wiring section of the in-page introspection surface — TypeScript mirror
//  (Phase 1844).
//
//  The graph has one derivation (the reference host's binding walk); this host
//  READS its DTO. So what is under test is that reading is FAITHFUL:
//
//   1. THE CROSS-HOST BYTE CONTRACT. Every vector under
//      `fixtures/wiring-introspection/` was emitted by the reference host from a
//      corpus document (plus one synthetic vector for string escaping). This
//      host decodes each, re-encodes it, and describes it — and both renderings
//      must be the reference host's bytes, exactly.
//   2. CANONICAL ORDER, with its falsifier: the same DTO with every section
//      reversed encodes to the same bytes, and the reversal is checked to have
//      actually moved something.
//   3. STRICTNESS: a DTO this module cannot represent faithfully is refused
//      with a location, never approximated.
//   4. THE REPL: `getWiring()` / `describeWiring()` serve the host's DTO, and
//      say so — rather than reporting an empty graph — when there is none.
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fuaran } from '@fuaran-ui/ui';
import { describe, expect, it } from 'vitest';

import {
  DEBUG_GLOBAL_VERSION,
  buildDebugGlobal,
  decodeWiringIntrospection,
  describeWiringIntrospection,
  encodeWiringIntrospection,
  isWiringDecodeError,
  type WiringIntrospection,
} from '../src/index.js';

const vectorsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'wiring-introspection',
);

/** The documents the reference host pins, by name. */
const EXPECTED_VECTORS = [
  'call-into',
  'expr-params-state-selection',
  'filters-dependson-declared',
  'filters-dependson-undeclared',
  'filters-param-source-declared',
  'filters-param-source-undeclared',
  'grid-transform-param',
  'multiselect-chip-list-param',
  'query-dependson',
  'synthetic-escaping',
];

const vectorNames = readdirSync(vectorsDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -'.json'.length))
  .sort();

const bytesOf = (file: string): Buffer => readFileSync(join(vectorsDir, file));

const decodeVector = (name: string): WiringIntrospection => {
  const decoded = decodeWiringIntrospection(bytesOf(`${name}.json`).toString('utf8'));
  if (isWiringDecodeError(decoded)) {
    throw new Error(`${name}.json did not decode: ${decoded.error} at ${decoded.path}`);
  }
  return decoded;
};

describe('wiring introspection — the cross-host byte contract', () => {
  it('carries exactly the vectors the reference host pins', () => {
    expect(vectorNames).toEqual(EXPECTED_VECTORS);
  });

  it.each(EXPECTED_VECTORS)('%s: re-encodes to the reference bytes', (name) => {
    const encoded = Buffer.from(encodeWiringIntrospection(decodeVector(name)), 'utf8');
    expect(encoded.equals(bytesOf(`${name}.json`))).toBe(true);
  });

  it.each(EXPECTED_VECTORS)('%s: describes to the reference REPL text', (name) => {
    const text = Buffer.from(describeWiringIntrospection(decodeVector(name)), 'utf8');
    expect(text.equals(bytesOf(`${name}.txt`))).toBe(true);
  });

  it('the vectors carry filter and transform edges, write-back driver included', () => {
    const edges = EXPECTED_VECTORS.flatMap((n) => decodeVector(n).edges);
    expect(edges.some((e) => e.channel === 'filter' && e.consumption === 'declared-edge')).toBe(
      true,
    );
    expect(edges.some((e) => e.controlKinds.includes('filter-write-back'))).toBe(true);
    // The undeclared half of the dependsOn pair is a finding, not an edge.
    const undeclared = decodeVector('filters-dependson-undeclared');
    expect(undeclared.edges.some((e) => e.name === 'genre')).toBe(false);
    expect(
      undeclared.unresolved.some(
        (u) => u.reason === 'ungrounded' && u.name === 'genre' && u.kind === 'declared-edge',
      ),
    ).toBe(true);
  });
});

describe('wiring introspection — canonical order', () => {
  it('a DTO with every section reversed encodes to the same bytes', () => {
    const w = decodeVector('filters-dependson-declared');
    const reversed: WiringIntrospection = {
      ...w,
      controls: [...w.controls].reverse(),
      consumers: [...w.consumers].reverse(),
      edges: [...w.edges].reverse(),
      unresolved: [...w.unresolved].reverse(),
    };
    // The falsifier: the reversal must actually have moved something, or the
    // equality below proves nothing about the sort.
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(w));
    expect(encodeWiringIntrospection(reversed)).toBe(encodeWiringIntrospection(w));
    expect(describeWiringIntrospection(reversed)).toBe(describeWiringIntrospection(w));
  });

  it('duplicate entries collapse, as the reference host deduplicates', () => {
    const w = decodeVector('multiselect-chip-list-param');
    const doubled: WiringIntrospection = {
      ...w,
      controls: [...w.controls, ...w.controls],
      edges: [...w.edges, ...w.edges],
    };
    expect(encodeWiringIntrospection(doubled)).toBe(encodeWiringIntrospection(w));
  });
});

describe('wiring introspection — strict decoding', () => {
  const base = (): Record<string, unknown> =>
    JSON.parse(bytesOf('multiselect-chip-list-param.json').toString('utf8')) as Record<
      string,
      unknown
    >;

  it('refuses an unknown member, naming where', () => {
    const r = decodeWiringIntrospection({ ...base(), extra: 1 });
    expect(isWiringDecodeError(r) && r.error).toContain("unknown member 'extra'");
  });

  it('refuses another format token', () => {
    const r = decodeWiringIntrospection({ ...base(), format: 'fuaran-wiring-introspection/2' });
    expect(isWiringDecodeError(r) && r.path).toBe('/format');
  });

  it('refuses a token outside its closed set', () => {
    const b = base();
    const edges = b['edges'] as Record<string, unknown>[];
    edges[0] = { ...edges[0], controlKinds: ['chip'] };
    const r = decodeWiringIntrospection(b);
    expect(isWiringDecodeError(r) && r.path).toBe('/edges/0/controlKinds/0');
  });

  it('refuses an undriven entry carrying a consumer kind', () => {
    const r = decodeWiringIntrospection({
      ...base(),
      unresolved: [
        { channel: 'filter', kind: 'value-read', name: 'x', nodeId: 'n', reason: 'undriven' },
      ],
    });
    expect(isWiringDecodeError(r) && r.path).toBe('/unresolved/0/kind');
  });

  it('refuses text that is not JSON, rather than throwing', () => {
    const r = decodeWiringIntrospection('{not json');
    expect(isWiringDecodeError(r)).toBe(true);
  });
});

describe('wiring introspection — the REPL', () => {
  const tree = fuaran.stack<unknown>({ id: 'root', children: [] });

  it('says there is no DTO rather than reporting an empty graph', () => {
    const dbg = buildDebugGlobal(tree, {});
    expect(dbg.getWiring?.()).toHaveProperty('error');
    expect(dbg.describeWiring?.()).toHaveProperty('error');
  });

  it('serves the host DTO, as an object or as JSON text', () => {
    const text = bytesOf('multiselect-chip-list-param.json').toString('utf8');
    const expected = decodeVector('multiselect-chip-list-param');
    for (const supplied of [text, JSON.parse(text) as unknown]) {
      const dbg = buildDebugGlobal(tree, {}, { wiring: () => supplied });
      expect(dbg.getWiring?.()).toEqual(expected);
      expect(dbg.describeWiring?.()).toBe(
        bytesOf('multiselect-chip-list-param.txt').toString('utf8'),
      );
    }
  });

  it('reports a DTO that does not decode, and a source that throws', () => {
    const bad = buildDebugGlobal(tree, {}, { wiring: () => ({ format: 'nope' }) });
    expect(bad.getWiring?.()).toHaveProperty('error');
    const throwing = buildDebugGlobal(
      tree,
      {},
      {
        wiring: () => {
          throw new Error('boom');
        },
      },
    );
    const r = throwing.getWiring?.();
    expect(r && 'error' in r && r.error).toContain('boom');
  });

  it('is listed in help, at surface version 0.4.0', () => {
    const dbg = buildDebugGlobal(tree, {});
    expect(dbg.help()).toContain('.getWiring()');
    expect(dbg.help()).toContain('.describeWiring()');
    expect(DEBUG_GLOBAL_VERSION).toBe('0.4.0');
  });
});
