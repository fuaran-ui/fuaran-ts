// ============================================================================
//  ThemeManifest contract + decode + project tests. Mirrors the F#
//  Fuaran.UI.ThemeManifest tests: DTCG + wrapper decode, role resolution,
//  palette membership, and the token-surface projectors.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  decodeManifest,
  emptyManifest,
  invariant,
  merge,
  paletteColours,
  projectFromCssCustomProperties,
  projectFromFuaranToneVars,
  resolveNamedRole,
  resolveRole,
  tryGetToken,
  type ThemeManifest,
} from '../src/index.js';

const manifest: ThemeManifest = {
  meta: { name: 'test', version: '1.0' },
  tokens: [
    { name: 'color.brand.base', type: 'color', value: '#3b5bdb' },
    { name: 'color.surface', type: 'color', value: '#ffffff' },
    { name: 'space.md', type: 'dimension', value: '16px' },
  ],
  roles: [
    { role: { kind: 'Tone', tone: 'Brand' }, tokenName: 'color.brand.base' },
    { role: { kind: 'Named', name: 'body-text' }, tokenName: 'color.surface' },
  ],
  invariants: [invariant({ kind: 'ContrastFloor', role: 'Brand', minRatio: 7 })],
};

describe('manifest helpers', () => {
  it('looks up a token by dotted name', () => {
    expect(tryGetToken('color.surface', manifest)?.value).toBe('#ffffff');
    expect(tryGetToken('missing', manifest)).toBeUndefined();
  });
  it('resolves a Tone role to its token', () => {
    expect(resolveRole('Brand', manifest)?.name).toBe('color.brand.base');
    expect(resolveRole('Critical', manifest)).toBeUndefined();
  });
  it('resolves a named role to its token', () => {
    expect(resolveNamedRole('body-text', manifest)?.value).toBe('#ffffff');
    expect(resolveNamedRole('divider', manifest)).toBeUndefined();
  });
  it('collects the palette colour set (colour tokens only)', () => {
    expect(paletteColours(manifest)).toEqual(new Set(['#3b5bdb', '#ffffff']));
  });
});

describe('decode', () => {
  it('decodes a Fuaran manifest wrapper (meta + DTCG tokens + roles + invariants)', () => {
    const json = JSON.stringify({
      meta: { name: 'acme', version: '2.1', description: 'x' },
      tokens: {
        color: {
          brand: { base: { $type: 'color', $value: '#3b5bdb', $description: 'brand' } },
          surface: { $type: 'color', $value: '#ffffff' },
        },
      },
      roles: [{ role: { tone: 'Brand' }, token: 'color.brand.base' }],
      invariants: [{ kind: 'ContrastFloor', role: 'Brand', minRatio: 7, weight: 2 }],
    });
    const r = decodeManifest(json);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.meta).toEqual({ name: 'acme', version: '2.1', description: 'x' });
    expect(tryGetToken('color.brand.base', r.value)).toEqual({
      name: 'color.brand.base',
      type: 'color',
      value: '#3b5bdb',
      description: 'brand',
    });
    expect(resolveRole('Brand', r.value)?.name).toBe('color.brand.base');
    expect(r.value.invariants).toEqual([
      { kind: { kind: 'ContrastFloor', role: 'Brand', minRatio: 7 }, weight: 2 },
    ]);
  });

  it('decodes a vanilla DTCG file (no wrapper) to tokens-only', () => {
    const json = JSON.stringify({
      color: { accent: { $type: 'color', $value: '#ff8800' } },
    });
    const r = decodeManifest(json);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tokens).toEqual([{ name: 'color.accent', type: 'color', value: '#ff8800' }]);
    expect(r.value.roles).toEqual([]);
  });

  it('reads a fuaran role extension on a DTCG token', () => {
    const json = JSON.stringify({
      color: {
        brand: { $type: 'color', $value: '#3b5bdb', $extensions: { fuaran: { role: 'accent' } } },
      },
    });
    const r = decodeManifest(json);
    expect(r.ok && r.value.tokens[0]?.role).toBe('accent');
  });

  it('returns ok:false on malformed JSON', () => {
    expect(decodeManifest('{ not json').ok).toBe(false);
  });
});

describe('projectors', () => {
  it('projects --fuaran-tone-*-bg vars into tokens + Tone role bindings', () => {
    const css = ':root { --fuaran-tone-brand-bg: #3b5bdb; --fuaran-tone-brand-fg: #fff; }';
    const m = projectFromFuaranToneVars(css);
    expect(tryGetToken('tone.brand.bg', m)?.value).toBe('#3b5bdb');
    expect(resolveRole('Brand', m)?.name).toBe('tone.brand.bg');
  });

  it('projects generic :root custom properties (light + dark) with roles unbound', () => {
    const css = ':root { --color-x: #111; } [data-theme="dark"] { --color-x: #eee; }';
    const m = projectFromCssCustomProperties(css);
    expect(tryGetToken('color-x', m)?.value).toBe('#111');
    expect(tryGetToken('color-x@dark', m)?.value).toBe('#eee');
    expect(m.roles).toEqual([]);
  });

  it('merges override tokens over a base with last-write-wins', () => {
    const base = projectFromCssCustomProperties(':root { --a: 1px; --b: 2px; }');
    const over = projectFromCssCustomProperties(':root { --b: 9px; }');
    const m = merge(base, over);
    expect(tryGetToken('b', m)?.value).toBe('9px');
    expect(tryGetToken('a', m)?.value).toBe('1px');
  });

  it('the empty manifest has no tokens', () => {
    expect(emptyManifest.tokens).toEqual([]);
  });
});
