// ============================================================================
//  @fuaran-ui/validator — rule corpus.
//
//  Mirrors the F# tier's `ValidatorTests.fs` acceptance suite: one (or more)
//  fixture(s) per rule — a violating example asserting the exact FUARAN### code
//  + severity, paired with a clean example asserting the code does NOT fire.
//  The fixtures are authored against the `@fuaran-ui/ui` object-options
//  surface (the host the validator walks).
// ============================================================================

import { describe, expect, it } from 'vitest';

import { validateSources, type Finding, type Severity } from '../src/index.js';
import { emptyManifest, type Manifest } from '../src/manifest.js';

function check(source: string, manifest?: Manifest): readonly Finding[] {
  return validateSources([{ fileName: 'fixture.ts', source }], manifest ? { manifest } : {})
    .findings;
}

function codes(findings: readonly Finding[]): string[] {
  return findings.map((f) => f.code);
}

function severityOf(findings: readonly Finding[], code: string): Severity | undefined {
  return findings.find((f) => f.code === code)?.severity;
}

const manifest = (over: Partial<{ queries: string[]; msgCases: string[] }>): Manifest => ({
  ...emptyManifest,
  queries: new Set(over.queries ?? []),
  msgCases: new Set(over.msgCases ?? []),
});

describe('FUARAN001 / FUARAN002 — NodeId uniqueness', () => {
  it('duplicate NodeId within one dashboard tree is an Error (FUARAN001)', () => {
    const f = check(`
      fuaran.dashboard({ id: 'root', children: [
        fuaran.metric({ id: 'dup', label: 'A' }),
        fuaran.metric({ id: 'dup', label: 'B' }),
      ]});
    `);
    expect(codes(f)).toContain('FUARAN001');
    expect(severityOf(f, 'FUARAN001')).toBe('error');
  });

  it('cross-tree duplicate NodeId is a Warning (FUARAN002), not an Error', () => {
    const f = check(`
      fuaran.dashboard({ id: 'treeA', children: [ fuaran.metric({ id: 'shared', label: 'A' }) ]});
      fuaran.dashboard({ id: 'treeB', children: [ fuaran.metric({ id: 'shared', label: 'B' }) ]});
    `);
    expect(codes(f)).toContain('FUARAN002');
    expect(codes(f)).not.toContain('FUARAN001');
  });

  it('a unique tree raises no NodeId findings', () => {
    const f = check(`
      fuaran.dashboard({ id: 'root', children: [
        fuaran.metric({ id: 'a', label: 'A' }),
        fuaran.metric({ id: 'b', label: 'B' }),
      ]});
    `);
    expect(codes(f)).not.toContain('FUARAN001');
    expect(codes(f)).not.toContain('FUARAN002');
  });
});

describe('FUARAN010 — binding.query name resolution (manifest-gated)', () => {
  it('unresolved query name is an Error with a suggestion', () => {
    const f = check(
      `const b = binding.query('totalRevneu', (r: any) => r.total);`,
      manifest({ queries: ['totalRevenue', 'salesRows'] }),
    );
    expect(codes(f)).toContain('FUARAN010');
    const finding = f.find((x) => x.code === 'FUARAN010')!;
    expect(finding.severity).toBe('error');
    expect(finding.suggestion).toBe('totalRevenue');
    expect(finding.availableFields).toEqual(['totalRevenue', 'salesRows']);
  });

  it('a resolved query name raises no FUARAN010', () => {
    const f = check(
      `const b = binding.query('totalRevenue', (r: any) => r.total);`,
      manifest({ queries: ['totalRevenue'] }),
    );
    expect(codes(f)).not.toContain('FUARAN010');
  });

  it('without a manifest, FUARAN010 is silenced and FUARAN900 surfaces', () => {
    const f = check(`const b = binding.query('anything', (r: any) => r.total);`);
    expect(codes(f)).not.toContain('FUARAN010');
    expect(codes(f)).toContain('FUARAN900');
  });
});

describe('FUARAN020 — action.dispatch case resolution (manifest-gated)', () => {
  it('mistyped Msg case (object discriminant) is an Error (FUARAN020)', () => {
    const f = check(
      `const a = action.dispatch({ type: 'LoadDate' });`,
      manifest({ msgCases: ['LoadData', 'Reset'] }),
    );
    expect(codes(f)).toContain('FUARAN020');
    expect(f.find((x) => x.code === 'FUARAN020')!.suggestion).toBe('LoadData');
  });

  it('a known Msg case raises no FUARAN020', () => {
    const f = check(
      `const a = action.dispatch({ type: 'LoadData' });`,
      manifest({ msgCases: ['LoadData'] }),
    );
    expect(codes(f)).not.toContain('FUARAN020');
  });
});

describe('FUARAN046 — gridLayoutTemplated equivalent to typed cols', () => {
  it('repeat(N, 1fr) template is a Warning (FUARAN046)', () => {
    const f = check(`fuaran.gridLayoutTemplated({ id: 'g', templateColumns: 'repeat(3, 1fr)' });`);
    expect(codes(f)).toContain('FUARAN046');
    expect(severityOf(f, 'FUARAN046')).toBe('warning');
  });

  it('an irregular template raises no FUARAN046', () => {
    const f = check(`fuaran.gridLayoutTemplated({ id: 'g', templateColumns: '1fr 2fr 100px' });`);
    expect(codes(f)).not.toContain('FUARAN046');
  });
});

describe('FUARAN047 / 048 / 049 — Tabs shape', () => {
  it('tabHeaders length ≠ children length is an Error (FUARAN047)', () => {
    const f = check(`
      fuaran.tabs({ id: 't', children: [a, b, c], tabHeaders: [h1, h2] });
    `);
    expect(codes(f)).toContain('FUARAN047');
    expect(severityOf(f, 'FUARAN047')).toBe('error');
  });

  it('tabTags length ≠ children length is an Error (FUARAN048)', () => {
    const f = check(`
      fuaran.tabs({ id: 't', children: [a, b], tabTags: ['x', 'y', 'z'] });
    `);
    expect(codes(f)).toContain('FUARAN048');
    expect(severityOf(f, 'FUARAN048')).toBe('error');
  });

  it('activeTag without tabTags is a Warning (FUARAN049)', () => {
    const f = check(`
      fuaran.tabs({ id: 't', children: [a], activeTag: binding.static('x') });
    `);
    expect(codes(f)).toContain('FUARAN049');
    expect(severityOf(f, 'FUARAN049')).toBe('warning');
  });

  it('an aligned Tabs spec raises no Tabs findings', () => {
    const f = check(`
      fuaran.tabs({ id: 't', children: [a, b], tabHeaders: [h1, h2], tabTags: ['x', 'y'], activeTag: binding.static('x') });
    `);
    expect(codes(f)).not.toContain('FUARAN047');
    expect(codes(f)).not.toContain('FUARAN048');
    expect(codes(f)).not.toContain('FUARAN049');
  });
});

describe('FUARAN050 — progress fraction range', () => {
  it('out-of-[0,1] fraction literal is a Warning (FUARAN050)', () => {
    const f = check(`fuaran.progress({ id: 'p', fraction: 42 });`);
    expect(codes(f)).toContain('FUARAN050');
    expect(severityOf(f, 'FUARAN050')).toBe('warning');
  });

  it('an in-range fraction literal raises no FUARAN050', () => {
    const f = check(`fuaran.progress({ id: 'p', fraction: 0.42 });`);
    expect(codes(f)).not.toContain('FUARAN050');
  });
});

describe('FUARAN060 — withExtraAttribute key allowlist', () => {
  it('an on* event-handler key is a Warning (FUARAN060)', () => {
    const f = check(`const n = node.withExtraAttribute('onclick', 'doEvil()', base);`);
    expect(codes(f)).toContain('FUARAN060');
    expect(severityOf(f, 'FUARAN060')).toBe('warning');
  });

  it('a data-* key raises no FUARAN060', () => {
    const f = check(`const n = node.withExtraAttribute('data-test', 'hook', base);`);
    expect(codes(f)).not.toContain('FUARAN060');
  });
});

describe('FUARAN061 — localeFormat.currency blank ISO code', () => {
  it('a blank ISO code is an Error (FUARAN061)', () => {
    const f = check(`const fmt = localeFormat.currency('');`);
    expect(codes(f)).toContain('FUARAN061');
    expect(severityOf(f, 'FUARAN061')).toBe('error');
  });

  it('a valid ISO code raises no FUARAN061', () => {
    const f = check(`const fmt = localeFormat.currency('GBP');`);
    expect(codes(f)).not.toContain('FUARAN061');
  });
});

describe('FUARAN063 — blank link href', () => {
  it('a blank href is a Warning (FUARAN063)', () => {
    const f = check(`fuaran.link({ id: 'l', href: '', label: 'Home' });`);
    expect(codes(f)).toContain('FUARAN063');
    expect(severityOf(f, 'FUARAN063')).toBe('warning');
  });

  it('a non-blank href raises no FUARAN063', () => {
    const f = check(`fuaran.link({ id: 'l', href: 'https://example.com', label: 'Home' });`);
    expect(codes(f)).not.toContain('FUARAN063');
  });
});

describe('FUARAN064 — no-op disabled binding', () => {
  it('disabled: binding.static(false) is a Warning (FUARAN064)', () => {
    const f = check(`fuaran.button({ id: 'b', label: 'Go', disabled: binding.static(false) });`);
    expect(codes(f)).toContain('FUARAN064');
    expect(severityOf(f, 'FUARAN064')).toBe('warning');
  });

  it('disabled: binding.static(true) is a legitimate placeholder (no FUARAN064)', () => {
    const f = check(`fuaran.button({ id: 'b', label: 'Go', disabled: binding.static(true) });`);
    expect(codes(f)).not.toContain('FUARAN064');
  });

  it('disabled bound to state is the intended shape (no FUARAN064)', () => {
    const f = check(
      `fuaran.button({ id: 'b', label: 'Go', disabled: binding.state('loading', false) });`,
    );
    expect(codes(f)).not.toContain('FUARAN064');
  });
});

describe('clean tree', () => {
  it('a valid tree against a full manifest produces no findings', () => {
    const f = check(
      `
      fuaran.dashboard({ id: 'root', children: [
        fuaran.metric({ id: 'rev', label: 'Revenue', value: binding.query('totalRevenue', (r: any) => r.total) }),
        fuaran.button({ id: 'load', label: 'Load', onClick: action.dispatch({ type: 'LoadData' }) }),
      ]});
    `,
      manifest({ queries: ['totalRevenue'], msgCases: ['LoadData'] }),
    );
    expect(f).toEqual([]);
  });

  it('an empty source (zero smart-ctor calls) yields no findings (with manifest)', () => {
    expect(check(`const x = 1;`, manifest({}))).toEqual([]);
  });
});
