// ============================================================================
//  Destination policy (WIRE_FORMAT §14.1) — the rules a corpus fixture cannot
//  reach on its own.
//
//  The markdown corpus pins the RENDERED BYTES under three named policies; these
//  tests pin the policy's own edges, where a plausible-looking implementation
//  goes wrong quietly: substring-instead-of-suffix matching, first-`@` userinfo
//  splitting, class scoping, and the trailing-root-dot spelling of a host.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  allowOrigin,
  checkDestination,
  classifyDestination,
  denyNonLocalEgress,
  egressRefusalMarker,
  permissiveEgress,
} from '../src/egress.js';

const declared = allowOrigin(
  { match: 'suffix', host: 'docs.example' },
  ['hyperlink'],
  allowOrigin({ match: 'exact', host: 'cdn.example' }, ['media'], denyNonLocalEgress),
);

describe('classifyDestination', () => {
  it('reads a relative path, a fragment and an empty URL as local', () => {
    expect(classifyDestination('/guide').kind).toBe('local');
    expect(classifyDestination('#top').kind).toBe('local');
    expect(classifyDestination('').kind).toBe('local');
  });

  it('reads a network scheme as remote, carrying the normalised host', () => {
    expect(classifyDestination('https://Example.COM/x')).toEqual({
      kind: 'remote',
      host: 'example.com',
    });
  });

  it('drops the port and a single trailing root dot from the host', () => {
    expect(classifyDestination('https://example.com.:8443/x')).toEqual({
      kind: 'remote',
      host: 'example.com',
    });
  });

  it('takes the host after the LAST @, not the first — the credential-confusion spelling', () => {
    expect(classifyDestination('https://good.example@evil.example/x')).toEqual({
      kind: 'remote',
      host: 'evil.example',
    });
    expect(classifyDestination('https://a@b@evil.example/x')).toEqual({
      kind: 'remote',
      host: 'evil.example',
    });
  });

  it('keeps an IPv6 literal bracketed', () => {
    expect(classifyDestination('https://[2001:db8::1]:8443/x')).toEqual({
      kind: 'remote',
      host: '[2001:db8::1]',
    });
  });

  it('reads a hostless scheme as non-network', () => {
    expect(classifyDestination('mailto:a@example.com')).toEqual({
      kind: 'nonNetwork',
      scheme: 'mailto',
    });
    expect(classifyDestination('tel:+441234567890')).toEqual({ kind: 'nonNetwork', scheme: 'tel' });
  });

  it('defers to the scheme floor, which rejects before any policy is consulted', () => {
    expect(classifyDestination('javascript:alert(1)').kind).toBe('rejected');
    expect(classifyDestination('//evil.example/x').kind).toBe('rejected');
    expect(classifyDestination('\\\\evil.example/x').kind).toBe('rejected');
  });
});

describe('checkDestination', () => {
  it('permits same-origin under the deny-non-local default: it denies leaving, not linking', () => {
    expect(checkDestination(denyNonLocalEgress, 'hyperlink', '/guide')).toEqual({
      kind: 'allowed',
      url: '/guide',
    });
  });

  it('refuses an undeclared origin and names the host, never the query', () => {
    const v = checkDestination(denyNonLocalEgress, 'media', 'https://collector.example/p?who=me');
    expect(v).toEqual({ kind: 'undeclaredOrigin', host: 'collector.example', cls: 'media' });
    expect(JSON.stringify(v)).not.toContain('who=me');
  });

  it('refuses mailto: by default — an egress channel with no host a rule could name', () => {
    expect(checkDestination(denyNonLocalEgress, 'hyperlink', 'mailto:a@example.com')).toEqual({
      kind: 'nonNetworkDenied',
      scheme: 'mailto',
      cls: 'hyperlink',
    });
  });

  it('permits everything under the permissive policy', () => {
    expect(checkDestination(permissiveEgress, 'media', 'https://anything.example/p').kind).toBe(
      'allowed',
    );
    expect(checkDestination(permissiveEgress, 'hyperlink', 'mailto:a@example.com').kind).toBe(
      'allowed',
    );
  });

  it('still refuses an unsafe URL under the permissive policy — the floor runs first', () => {
    expect(checkDestination(permissiveEgress, 'hyperlink', 'javascript:alert(1)').kind).toBe(
      'unsafeUrl',
    );
  });

  it('matches a host suffix at a LABEL BOUNDARY — a suffix, not a substring', () => {
    expect(checkDestination(declared, 'hyperlink', 'https://docs.example/g').kind).toBe('allowed');
    expect(checkDestination(declared, 'hyperlink', 'https://eu.docs.example/g').kind).toBe(
      'allowed',
    );
    expect(checkDestination(declared, 'hyperlink', 'https://notdocs.example/g').kind).toBe(
      'undeclaredOrigin',
    );
  });

  it('scopes a rule to its classes in both directions', () => {
    // docs.example is declared for hyperlink only…
    expect(checkDestination(declared, 'media', 'https://docs.example/p.png').kind).toBe(
      'undeclaredOrigin',
    );
    // …and cdn.example for media only.
    expect(checkDestination(declared, 'media', 'https://cdn.example/p.png').kind).toBe('allowed');
    expect(checkDestination(declared, 'hyperlink', 'https://cdn.example/p.png').kind).toBe(
      'undeclaredOrigin',
    );
  });

  it('treats an exact rule as exact — no subdomain, no sibling', () => {
    expect(checkDestination(declared, 'media', 'https://a.cdn.example/p.png').kind).toBe(
      'undeclaredOrigin',
    );
    expect(checkDestination(declared, 'media', 'https://notcdn.example/p.png').kind).toBe(
      'undeclaredOrigin',
    );
  });

  it('matches the dotted root spelling of a declared host', () => {
    expect(checkDestination(declared, 'media', 'https://cdn.example./p.png').kind).toBe('allowed');
  });

  it('reads a rule with an EMPTY class list as permitting nothing', () => {
    const empty = {
      ...denyNonLocalEgress,
      rules: [{ origin: { match: 'exact' as const, host: 'cdn.example' }, classes: [] }],
    };
    expect(checkDestination(empty, 'media', 'https://cdn.example/p.png').kind).toBe(
      'undeclaredOrigin',
    );
  });
});

describe('egressRefusalMarker', () => {
  it('names the class and the host, and nothing else', () => {
    expect(
      egressRefusalMarker(
        checkDestination(denyNonLocalEgress, 'media', 'https://collector.example/p?s=secret'),
      ),
    ).toEqual(['data-fuaran-egress-refused', 'media:collector.example']);
  });

  it('names the scheme where there is no host', () => {
    expect(
      egressRefusalMarker(checkDestination(denyNonLocalEgress, 'hyperlink', 'mailto:a@b.example')),
    ).toEqual(['data-fuaran-egress-refused', 'hyperlink:mailto']);
  });

  it('is absent for an allowed destination', () => {
    expect(
      egressRefusalMarker(checkDestination(permissiveEgress, 'hyperlink', '/x')),
    ).toBeUndefined();
  });
});
