// ============================================================================
//  WIRE_FORMAT.md §15 — wire versioning + forward/backward-compatibility.
//
//  TS-side unit coverage mirroring the F# `Fuaran.Core.Tests.VersioningTests`:
//  a behind consumer decodes a newer artifact WITHOUT crashing (detect →
//  preserve → degrade); an unrecognised kind round-trips byte-for-byte
//  (must-ignore-but-preserve); a Foreign profile hard-refuses; the authoring
//  surface stays closed (no encoder path constructs an `Unknown`).
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  coreV1,
  decodeEnvelope,
  decodeNode,
  decodeNodeTolerant,
  encodeEnvelope,
  encodeNode,
  negotiate,
  negotiateEnvelope,
  renderProfile,
  tryParseProfile,
  type Profile,
} from '../src/index.js';

// A canonical known-node wire form, derived through the real codec so it is the
// exact bytes the encoder emits (independent of field ordering / defaults).
const knownNode: string = (() => {
  const j = '{"id":"m1","kind":{"$type":"Markdown","text":{"$type":"Literal","text":"hi"}}}';
  const d = decodeNode(j);
  if (!d.ok) throw new Error(`test setup: known node failed to decode (${d.error.code})`);
  return encodeNode(d.value);
})();

// A newer producer authored a `hologram` kind this host does not understand,
// hand-authored in canonical (Ordinal-sorted keys) form so a re-render
// reproduces the input bytes. `requiredProfile` names the gap.
const unknownNode = '{"id":"h1","kind":{"$type":"hologram"},"shimmer":true}';
const unknownNodeWithProfile =
  '{"id":"h1","kind":{"$type":"hologram"},"requiredProfile":"core@1.4","shimmer":true}';
const unknownNodeMalformedProfile =
  '{"id":"h1","kind":{"$type":"hologram"},"requiredProfile":"not-a-profile","shimmer":true}';

const enveloped = (payload: string, profile: string): string =>
  `{"$payload":${payload},"$profile":"${profile}"}`;

describe('Profile id (§15.1)', () => {
  it('renders and parses round-trip', () => {
    expect(renderProfile(coreV1)).toBe('core@1.0');
    const q = tryParseProfile('core@2.7');
    expect(q.ok && q.value).toEqual({ name: 'core', major: 2, minor: 7 });
  });

  it('rejects malformed ids', () => {
    expect(tryParseProfile('core').ok).toBe(false); // missing @
    expect(tryParseProfile('core@1').ok).toBe(false); // missing minor
    expect(tryParseProfile('core@1.x').ok).toBe(false); // non-numeric
    expect(tryParseProfile('@1.0').ok).toBe(false); // missing name
    expect(tryParseProfile('core@-1.0').ok).toBe(false); // negative
  });
});

describe('capability negotiation (§15.2)', () => {
  const consumer: Profile = { name: 'core', major: 1, minor: 3 };
  it('classifies current / behind / foreign', () => {
    expect(negotiate(consumer, { ...consumer, minor: 2 })).toEqual({ kind: 'Current' });
    expect(negotiate(consumer, consumer)).toEqual({ kind: 'Current' });
    expect(negotiate(consumer, { ...consumer, minor: 5 })).toEqual({
      kind: 'Behind',
      authored: { ...consumer, minor: 5 },
    });
    expect(negotiate(consumer, { ...consumer, major: 2 }).kind).toBe('Foreign');
    expect(negotiate(consumer, { ...consumer, name: 'music' }).kind).toBe('Foreign');
  });
});

describe('versioned envelope (§15.1)', () => {
  it('round-trips a known payload byte-for-byte carrying the profile', () => {
    const wire = enveloped(knownNode, 'core@1.0');
    const env = decodeEnvelope(wire);
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(renderProfile(env.value.profile)).toBe('core@1.0');
    expect(encodeEnvelope(env.value)).toBe(wire);
  });

  it('sorts $payload before $profile canonically', () => {
    // Even given "wrong" source order, the canonical re-encode is $payload first.
    const env = decodeEnvelope(`{"$profile":"core@1.0","$payload":${knownNode}}`);
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(encodeEnvelope(env.value)).toBe(enveloped(knownNode, 'core@1.0'));
  });

  it('rejects a missing / malformed profile', () => {
    expect(decodeEnvelope(`{"$payload":${knownNode}}`)).toMatchObject({
      ok: false,
      error: { code: 'MISSING_FIELD' },
    });
    expect(decodeEnvelope(enveloped(knownNode, 'garbage'))).toMatchObject({
      ok: false,
      error: { code: 'MALFORMED_PROFILE' },
    });
  });
});

describe('transport-only Unknown — detect (§15.3)', () => {
  it('a known kind decodes to Known', () => {
    const d = decodeNodeTolerant(knownNode);
    expect(d.ok && d.value.known).toBe(true);
  });

  it('an unknown kind is detected, not rejected', () => {
    const d = decodeNodeTolerant(unknownNodeWithProfile);
    expect(d.ok).toBe(true);
    if (!d.ok || d.value.known) throw new Error('hologram should be Unknown');
    expect(d.value.unknown.kind).toBe('hologram');
    expect(d.value.unknown.requiredProfile).toEqual({ name: 'core', major: 1, minor: 4 });
  });

  it('a bare unknown kind no longer throws WRONG_NODE_KIND under decodeNode', () => {
    // The un-tolerant decoder still hard-rejects (the closed authoring surface)…
    expect(decodeNode(unknownNode)).toMatchObject({
      ok: false,
      error: { code: 'WRONG_NODE_KIND' },
    });
    // …but the tolerant boundary preserves it.
    expect(decodeNodeTolerant(unknownNode).ok).toBe(true);
  });

  it('malformed requiredProfile degrades to no label but preserves bytes', () => {
    const d = decodeNodeTolerant(unknownNodeMalformedProfile);
    expect(d.ok).toBe(true);
    if (!d.ok || d.value.known) throw new Error('unknown expected');
    expect(d.value.unknown.requiredProfile).toBeUndefined();
  });
});

describe('must-ignore-but-preserve — byte-for-byte (§15.3)', () => {
  it('an unknown-kind artifact re-encodes verbatim (old client cannot destroy newer data)', () => {
    // Behind: consumer core@1.0 meets an artifact authored core@1.1.
    const wire = enveloped(unknownNode, 'core@1.1');
    const out = negotiateEnvelope(wire, coreV1);
    expect(out.ok && out.value).toBe(wire);
  });

  it('an enveloped known payload re-encodes byte-identically (Current)', () => {
    const wire = enveloped(knownNode, 'core@1.0');
    const out = negotiateEnvelope(wire, coreV1);
    expect(out.ok && out.value).toBe(wire);
  });
});

describe('Foreign hard-refuse (§15.2)', () => {
  it('a major-ahead profile is refused', () => {
    expect(negotiateEnvelope(enveloped(knownNode, 'core@2.0'), coreV1)).toMatchObject({
      ok: false,
      error: { code: 'FOREIGN_PROFILE' },
    });
  });
  it('a foreign namespace is refused', () => {
    expect(negotiateEnvelope(enveloped(knownNode, 'music@1.0'), coreV1)).toMatchObject({
      ok: false,
      error: { code: 'FOREIGN_PROFILE' },
    });
  });
});
