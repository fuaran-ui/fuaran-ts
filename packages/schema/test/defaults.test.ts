import { describe, expect, it } from 'vitest';

import { defaults } from '../src/index.js';

describe('defaults', () => {
  it('exposes the canonical cross-cutting defaults', () => {
    expect(defaults.style).toEqual({
      tone: 'Default',
      weight: 'Standard',
      emphasis: 'Normal',
      role: 'None',
      voice: 'Default',
      // Phase 1472 — `auto` is the declared direction's identity, and it joins
      // the other omitted-when-default members here on exactly their terms.
      direction: 'auto',
    });
    expect(defaults.stateBehaviour()).toEqual({});
  });

  it('layout defaults seed empty children and sensible orientations', () => {
    expect(defaults.dashboard().children).toEqual([]);
    expect(defaults.stack()).toMatchObject({ orientation: 'Vertical', wrap: false });
    expect(defaults.gridLayout().cols).toBe(12);
    expect(defaults.splitPanel().weight).toBe(0.5);
    expect(defaults.tabs().orientation).toBe('Horizontal');
  });

  it('omits optional fields (None = absent key, never null)', () => {
    expect('trend' in defaults.metric).toBe(false);
    expect('heading' in defaults.callout).toBe(false);
    expect(defaults.numberFieldConstraints).toEqual({});
  });

  it('per-component accessibility defaults match the F# roles', () => {
    expect(defaults.accessibility.button).toEqual({ role: 'button' });
    expect(defaults.accessibility.dashboard).toEqual({ role: 'main' });
    expect(defaults.accessibility.callout).toEqual({ role: 'alert', liveRegion: 'assertive' });
    expect(defaults.accessibility.metric).toEqual({ liveRegion: 'polite' });
    expect(defaults.accessibility.table).toBeUndefined();
  });
});
