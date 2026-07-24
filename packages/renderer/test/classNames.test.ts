import { describe, it, expect } from 'vitest';
import { defaults, type StyleRole, type FontVoice } from '@fuaran-ui/schema';
import { styleClassName, styleRoleVar, fontVoiceVar } from '../src/index.js';

// Phase 147 — StyleRole / FontVoice class emission. Parity with the F#
// ToneClassEmissionTests (5): role/voice fragments append only when non-default,
// so a default style yields the exact pre-147 class string.

describe('Phase 147 — role/voice class fragments', () => {
  it('default style emits no fuaran-role-/fuaran-voice- fragment (byte-identical)', () => {
    expect(styleClassName(defaults.style)).toBe(
      'fuaran-node fuaran-tone-default fuaran-weight-standard fuaran-emphasis-normal',
    );
  });

  const roles: ReadonlyArray<[StyleRole, string]> = [
    ['Eyebrow', 'eyebrow'],
    ['Data', 'data'],
    ['Lede', 'lede'],
    ['Caption', 'caption'],
  ];
  for (const [role, suffix] of roles) {
    it(`StyleRole.${role} -> fuaran-role-${suffix}`, () => {
      expect(styleClassName({ ...defaults.style, role })).toContain(`fuaran-role-${suffix}`);
    });
  }

  const voices: ReadonlyArray<[FontVoice, string]> = [
    ['Display', 'display'],
    ['Structural', 'structural'],
  ];
  for (const [voice, suffix] of voices) {
    it(`FontVoice.${voice} -> fuaran-voice-${suffix}`, () => {
      expect(styleClassName({ ...defaults.style, voice })).toContain(`fuaran-voice-${suffix}`);
    });
  }

  it('StyleRole.None / FontVoice.Default resolve to no fragment', () => {
    expect(styleRoleVar('None')).toBeUndefined();
    expect(fontVoiceVar('Default')).toBeUndefined();
  });
});
