// ============================================================================
//  Teleport decoder — cross-host byte-parity proof.
//
//  The golden bundle below was produced by the F# host
//  (`Fuaran.UI.OpStream.Abstractions.Teleport.encode`): a running app — its
//  tree plus its `Binding.State` values — serialised to one deflate+base64url,
//  digest-signed string. These tests prove the TypeScript decoder decompresses
//  it, recomputes the SHA-256 integrity digest with the SAME canonical renderer
//  the wire codec is corpus-verified against, and structurally decodes the tree
//  — i.e. a bundle minted by one conformant host resumes bit-for-bit on
//  another. The tamper case proves the integrity gate refuses a single flipped
//  byte rather than resuming something subtly wrong.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeTeleport, TELEPORT_FORMAT_PREFIX } from '../src/index.js';

// A genuine F#-produced bundle: a 3-step signup wizard on step 1, name + email
// filled, the other fields not yet entered. Its carried integrity digest:
const GOLDEN_DIGEST = '29c3a5bbc187ff3188cb76635d921675dd72fa70040321cbe066da1f9cef79cb';
const GOLDEN_BUNDLE =
  'FT1.q1ZKKs1LyUlVslIqSc1JLcgvKnEwVNJRSslMTy0uAYoaWSYbJ5omJSUbWpinpRkbWlgkJ5mbmRmbplgaGZqZm6akmBulJZobGJgYGBsZJielGpiZpSQaplkmp6aZWyYnAc0qLkksAVpQrZSam5iZAzQzMSXRITEvMaeyJDM5MUcvNS89My8VqDAvMRfkEMeURAWf_LLUnMRkkGhBTmIeUBTIKkpNSy0qSgQZATY2tUDJykAH6PDE3ODMKpBWpVogtygVbFticnJqcXFmUmZOZkklSKAoH-zPotT0zPw8kMrMFJC3C3QTCwqA5mVn5gH51UoqJZUFIHVO-RVA0eSMzJyUolSgC6Kr4RpAVhdj0RIMFC9ILQLKJCaXZJalgvio8olALwOlyxJzSoECBkBHYLfAAIvpvolF2Sn55XlAqZLUCmDkIKR8MktSQQEDk1GKzC8tUkhJLQEGeLFSbW2tDpLZoPilxOyAzORshUQFcLygGW1EodE-icUlyM6O1VHKzwsGJsxkkKxNck5-cWlRqh1QCsnWgqL89CJgVFNodzwothQMFfLTFIwVHjVMUUAOw3g0n6ZlpuakYLMRT6pJ0wUncMpcqaXlBzTESktLASWboLlOF5LVKLXKFWQKyC7sORbdUnCKoNTOAKAhICvjNfLySxQqU0sUUvOAilJTNDHiQBdeIFBqqUdqYlGKQllmIrE2g8ocim0NARqiUAwsufDYCswBOYmV-aUoZrnlpIJSWUpmETBjgAozK6Ww1CJw3ACFy4sSgaVOWmJOcSqwfIGWeu5F-aUFQAOB5mWkJqZk5qXjdZxfarkCsADNL80rAZWUVHGCMzCMQV4CAA';

describe('decodeTeleport — cross-host parity', () => {
  it('decodes an F#-produced bundle and verifies its integrity digest', async () => {
    const result = await decodeTeleport(GOLDEN_BUNDLE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Digest recomputed independently in TS === the one the F# host signed.
    expect(result.value.digest).toBe(GOLDEN_DIGEST);
  });

  it('resumes the exact mid-interaction state', async () => {
    const result = await decodeTeleport(GOLDEN_BUNDLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.state).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@analytical.engine',
      plan: '',
      step: 0,
    });
  });

  it('structurally decodes the carried tree', async () => {
    const result = await decodeTeleport(GOLDEN_BUNDLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The decoded tree is a real typed Node (a Card, per the wire), not raw JSON.
    expect(result.value.tree).toHaveProperty('kind');
    expect(result.value.history).toEqual([]);
    expect(result.value.chainHead).toBeUndefined();
  });

  it('refuses a tampered bundle with a typed DigestMismatch', async () => {
    // Flip one byte in the middle of the compressed payload — corruption or
    // tampering between devices produces exactly this.
    const mid = Math.floor(GOLDEN_BUNDLE.length / 2);
    const flipped = GOLDEN_BUNDLE[mid] === 'A' ? 'B' : 'A';
    const tampered = GOLDEN_BUNDLE.slice(0, mid) + flipped + GOLDEN_BUNDLE.slice(mid + 1);

    const result = await decodeTeleport(tampered);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Either the deflate stream no longer decodes, or it decodes to an envelope
    // whose recomputed digest no longer matches — both are typed refusals, not
    // a silent wrong resume.
    expect(['DigestMismatch', 'InvalidFormat', 'InvalidJson', 'InvalidEnvelope']).toContain(
      result.error.code,
    );
  });

  it('rejects a non-bundle string', async () => {
    const result = await decodeTeleport('not a teleport bundle');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('InvalidFormat');
  });

  it('rejects an oversize input before doing any work', async () => {
    const huge = TELEPORT_FORMAT_PREFIX + 'A'.repeat(70000);
    const result = await decodeTeleport(huge);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('Oversize');
  });
});
