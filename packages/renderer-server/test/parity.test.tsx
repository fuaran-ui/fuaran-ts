// ============================================================================
//  Render-parity corpus — the cross-host lock that makes this a fidelity twin.
//
//  Two locks over the whole node fixture corpus:
//
//   Lock A (TS authority): the SET of fuaran-* classes and the SET of
//     data-fuaran-node-id values the server renderer emits equal those the React
//     client renderer (@fuaran-ui/renderer via renderToStaticMarkup) emits for
//     the same decoded tree. This is what guarantees a hydration handoff finds
//     the markup it expects, and that the packaged reference CSS styles the
//     server output identically.
//
//   Lock B (F# authority): every fuaran-* class the server renderer emits is in
//     the vocabulary extracted from the F# reference renderer source — the same
//     cross-host parity lock the Python host carries. Skips when the F# sibling
//     is not checked out alongside.
// ============================================================================

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import { FuaranRenderer } from '@fuaran-ui/renderer';
import { permissiveEgress } from '@fuaran-ui/renderer/egress';

import { renderToHtml } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const estateRoot = join(here, '..', '..', '..', '..');
const nodesDir = join(estateRoot, 'wire-format-fixtures', 'nodes');

const fixtureFiles = readdirSync(nodesDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const decode = (file: string) => {
  const decoded = decodeNode(readFileSync(join(nodesDir, file), 'utf8'));
  if (!decoded.ok) throw new Error(`decode failed for ${file}: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

/** The sorted set of `fuaran-*` class tokens emitted anywhere in the HTML. */
const fuaranClasses = (html: string): string[] => {
  const out = new Set<string>();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const tok of m[1]!.split(/\s+/)) if (tok.startsWith('fuaran-')) out.add(tok);
  }
  return [...out].sort();
};

/** The sorted set of `data-fuaran-node-id` values emitted in the HTML. */
const nodeIds = (html: string): string[] => {
  const out = new Set<string>();
  for (const m of html.matchAll(/data-fuaran-node-id="([^"]+)"/g)) out.add(m[1]!);
  return [...out].sort();
};

// ─── The DECLARED tier divergences ───────────────────────────────────────────
//
// Lock A's premise is that the two tiers paint the same elements, and for almost
// every kind they do. FOUR CONTROLS ARE THE EXCEPTION, and the exception is the
// SPECIFICATION'S rather than a defect: for each of them §3.6 states that the
// static floor is a DIFFERENT CONTROL from the hydrated one, chosen because it
// is what a zero-JS medium can honour. A combobox floors on the user agent's own
// `<input list>` + `<datalist>` where the client draws the WAI-ARIA listbox; a
// token field floors on ONE TEXT INPUT because a chip row is built by a keystroke
// handler; a writable rating floors on native RADIOS because a `role="slider"`
// element can be neither adjusted nor submitted without script. The reference
// (F#) tier renders exactly this same pair on each of the three, so these tokens
// are what CONFORMANCE looks like, not what drift looks like.
//
// So the lock records them, one entry per family, naming the section that states
// the divergence. Two properties keep this a gate rather than a hole:
//
//   * The set is CLOSED and NAMED. Any other token appearing on one tier and not
//     the other still fails, with the token named — which is the whole of what
//     Lock A was ever catching.
//   * A STALE entry FAILS. Each declared token must actually be emitted by the
//     tier that claims it, on at least one fixture; an entry for a token neither
//     tier emits any more is reported by the sweep below, so the list cannot
//     quietly outlive the divergence it records.
//
// Adding an entry here is a DELIBERATE act with a spec citation, never a way to
// make a red test green: a divergence with no section behind it is a defect in
// one of the two renderers.
const DECLARED_TIER_DIVERGENCES: readonly {
  readonly token: string;
  readonly tier: 'server' | 'client';
  readonly why: string;
}[] = [
  // §3.6.9 — the combobox's static floor is `<input list>` + `<datalist>`; the
  // client draws the full listbox popup. No hand-written ARIA on the floor: a
  // static `aria-expanded="false"` that can never become `true` would replace
  // the user agent's own correct semantics with a claim inert markup cannot keep.
  { token: 'fuaran-combobox-list', tier: 'client', why: 'WIRE_FORMAT.md §3.6.9' },
  { token: 'fuaran-combobox-option', tier: 'client', why: 'WIRE_FORMAT.md §3.6.9' },
  // §3.6.19 — the token field's static floor is ONE TEXT INPUT carrying the
  // tokens comma-separated. A row of static chips with dead remove buttons would
  // be an affordance inert markup cannot honour.
  { token: 'fuaran-tokens-list', tier: 'client', why: 'WIRE_FORMAT.md §3.6.19' },
  { token: 'fuaran-tokens-chip', tier: 'client', why: 'WIRE_FORMAT.md §3.6.19' },
  { token: 'fuaran-tokens-chip-label', tier: 'client', why: 'WIRE_FORMAT.md §3.6.19' },
  { token: 'fuaran-tokens-chip-remove', tier: 'client', why: 'WIRE_FORMAT.md §3.6.19' },
  { token: 'fuaran-tokens-suggestions', tier: 'client', why: 'WIRE_FORMAT.md §3.6.19' },
  { token: 'fuaran-tokens-option', tier: 'client', why: 'WIRE_FORMAT.md §3.6.19' },
  { token: 'fuaran-tokens-status', tier: 'client', why: 'WIRE_FORMAT.md §3.6.19' },
  // §3.6.17 — a writable rating floors on native radios and hydrates to a
  // slider. The two markups are named separately BOTH WAYS, which is why this is
  // the one family with a `server` entry: the floor emits something the client
  // does not, and the client emits something the floor does not.
  { token: 'fuaran-rating-choice', tier: 'server', why: 'WIRE_FORMAT.md §3.6.17' },
  { token: 'fuaran-rating-choice-label', tier: 'server', why: 'WIRE_FORMAT.md §3.6.17' },
  { token: 'fuaran-rating-hits', tier: 'client', why: 'WIRE_FORMAT.md §3.6.17' },
  { token: 'fuaran-rating-hit', tier: 'client', why: 'WIRE_FORMAT.md §3.6.17' },
];

const declaredFor = (tier: 'server' | 'client'): Set<string> =>
  new Set(DECLARED_TIER_DIVERGENCES.filter((d) => d.tier === tier).map((d) => d.token));

const withoutDeclared = (classes: readonly string[], tier: 'server' | 'client'): string[] => {
  const declared = declaredFor(tier);
  return classes.filter((c) => !declared.has(c));
};

describe('Lock A — server output matches the React client renderer (class + node-id sets)', () => {
  it.each(fixtureFiles)('%s emits the same fuaran-* class set as <FuaranRenderer>', (file) => {
    const tree = decode(file);
    const server = renderToHtml(tree);
    const react = renderToStaticMarkup(<FuaranRenderer tree={tree} />);
    expect(
      withoutDeclared(fuaranClasses(server), 'server'),
      `${file}: a class appears on one tier and not the other with no declared divergence — ` +
        'either a renderer dropped it, or the divergence is real and belongs in ' +
        'DECLARED_TIER_DIVERGENCES with the section that states it.',
    ).toEqual(withoutDeclared(fuaranClasses(react), 'client'));
  });

  // The other half of the declaration, and the half that keeps it honest: an
  // entry whose token no longer appears on the tier it claims is recording a
  // divergence that has since closed, and would silently permit a real drift on
  // that token from then on.
  it('every declared tier divergence is still observed on the tier that claims it', () => {
    const serverSeen = new Set<string>();
    const clientSeen = new Set<string>();
    for (const file of fixtureFiles) {
      const tree = decode(file);
      for (const c of fuaranClasses(renderToHtml(tree))) serverSeen.add(c);
      for (const c of fuaranClasses(renderToStaticMarkup(<FuaranRenderer tree={tree} />)))
        clientSeen.add(c);
    }
    const stale = DECLARED_TIER_DIVERGENCES.filter(
      (d) => !(d.tier === 'server' ? serverSeen : clientSeen).has(d.token),
    ).map((d) => `${d.token} (declared ${d.tier}, ${d.why})`);
    expect(
      stale,
      'a declared divergence names a token its tier no longer emits — remove the entry, ' +
        'or the lock is permitting drift on a token nothing produces',
    ).toEqual([]);
  });

  it.each(fixtureFiles)('%s emits the same data-fuaran-node-id set as <FuaranRenderer>', (file) => {
    const tree = decode(file);
    const server = renderToHtml(tree);
    const react = renderToStaticMarkup(<FuaranRenderer tree={tree} />);
    expect(nodeIds(server)).toEqual(nodeIds(react));
  });
});

// ─── Lock B — F# reference-renderer vocabulary ───────────────────────────────

// The spellings the F# reference host has shipped under. It was renamed once
// (`fuaran` → `fuaran-dotnet`) and this file's paths were not updated, so Lock B
// silently skipped its entire fixture sweep for as long as the rename was old —
// a gate reporting success while checking nothing. Accepting both spellings
// means a rename in either direction cannot disable it again.
const REFERENCE_HOST_NAMES = ['fuaran-dotnet', 'fuaran'];

// Sibling hosts whose presence proves this is a cross-host checkout (the shape
// the conformance gate builds) rather than a standalone clone. Deliberately
// excludes this host and the reference host.
const OTHER_HOST_NAMES = ['fuaran-py', 'fuaran-rs', 'fuaran-go', 'fuaran-kt', 'fuaran-swift'];

// The renderer sources the class vocabulary is extracted from, relative to the
// reference host root.
const REFERENCE_RENDERER_SOURCES = [
  join('src', 'Fuaran.UI.Renderer.Server', 'Render.fs'),
  join('src', 'Fuaran.UI.Renderer', 'Render.fs'),
  join('src', 'Fuaran.UI.Renderer.Core', 'Theme.fs'),
  // Phase 525 — the Drawing SVG class vocabulary (fuaran-drawing*) lives here.
  join('src', 'Fuaran.UI.Renderer.Core', 'DrawingSvg.fs'),
  // Phase 207 — the per-kind class/id builder vocabulary (`Css`) was extracted
  // here from the two Render.fs files; the prefix tokens that used to sit inline
  // (fuaran-custom-, fuaran-badge-, …) are now spelled only in this module.
  join('src', 'Fuaran.UI.Renderer.Core', 'Css.fs'),
];

/**
 * Locate the F# reference host beside the corpus.
 *
 * The skip is correct for someone who genuinely cloned this repo (plus the
 * corpus) alone — that is why it exists, and why nobody noticed it firing
 * everywhere else. What is NOT correct is skipping in a cross-host checkout,
 * where a missing reference host means Lock B has been silently disabled. So the
 * two cases are separated: any other host present ⇒ hard failure naming what was
 * tried; nothing else present ⇒ the honest standalone skip.
 */
const referenceHostRoot = (): string | null => {
  for (const name of REFERENCE_HOST_NAMES) {
    if (existsSync(join(estateRoot, name, 'src'))) return join(estateRoot, name);
  }
  for (const sibling of OTHER_HOST_NAMES) {
    if (existsSync(join(estateRoot, sibling))) {
      throw new Error(
        `cross-host checkout detected (${sibling}/ is present under ${estateRoot}) but the F# ` +
          `reference host is at none of ${JSON.stringify(REFERENCE_HOST_NAMES)} — Lock B cannot ` +
          `run. This is the failure mode this check exists for: if the sibling was renamed again, ` +
          `add the new spelling to REFERENCE_HOST_NAMES rather than letting the lock skip.`,
      );
    }
  }
  return null;
};

const referenceRoot = referenceHostRoot();

const referenceRendererFiles = referenceRoot
  ? REFERENCE_RENDERER_SOURCES.map((rel) => join(referenceRoot, rel))
  : [];

// A located reference host whose sources have MOVED would silently empty the
// vocabulary, which makes every Lock B assertion below vacuously true. That is a
// failure naming the file, not a skip — the same posture the sibling hosts' own
// parity oracles take.
const missingReferenceSources = referenceRendererFiles.filter((p) => !existsSync(p));
if (referenceRoot !== null && missingReferenceSources.length > 0) {
  throw new Error(
    `reference renderer source(s) missing inside the located reference host ` +
      `(${referenceRoot}): ${missingReferenceSources.join(', ')} — Lock B would extract an empty ` +
      `vocabulary and pass vacuously.`,
  );
}

const referenceAvailable = referenceRoot !== null;

const referenceVocabulary = (): { exact: Set<string>; prefixes: string[] } => {
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  for (const path of referenceRendererFiles) {
    const src = readFileSync(path, 'utf8');
    for (const m of src.matchAll(/fuaran-[a-zA-Z0-9-]*/g)) {
      const token = m[0];
      if (token.endsWith('-')) prefixes.add(token);
      else exact.add(token);
    }
  }
  return { exact, prefixes: [...prefixes] };
};

// ─── Protected email link (Phase 812) — the plaintext-absence lock ──────────

describe('protected email link — no plaintext address in server output', () => {
  it('link-protected-1 emits the entity-encoded anchor and no scrapeable address', () => {
    // Phase 1037 — `permissiveEgress` by name: the DEFAULT policy refuses
    // `mailto:` (`allowNonNetwork: false`), so the protected arm is
    // unreachable under it. This lock is about the entity-encoded emission,
    // not the policy; the policy has its own corpus in `egressAmbient.test.ts`.
    const html = renderToHtml(decode('link-protected-1.json'), {
      egressPolicy: permissiveEgress,
    });
    // The wrapper + protected classes, with every href/label character a
    // decimal entity (&#109;… = 'mailto:'). Byte-locked to the F# server
    // renderer's emission.
    expect(html).toContain('<span class="fuaran-link-protected-wrap">');
    expect(html).toContain(
      '<a class="fuaran-link fuaran-link-protected" href="&#109;&#97;&#105;&#108;&#116;&#111;&#58;',
    );
    // The raw source carries no plaintext address, local part, or scheme.
    expect(html).not.toContain('mailto:');
    expect(html).not.toContain('contact@example.com');
    expect(html).not.toContain('@example');
  });
});

// ─── Drawing Label rotation (Phase 877) — the cross-host emission lock ──────

describe('rotated Drawing labels emit transform=rotate anchored at the label', () => {
  it('drawing-rotated-labels matches the F# reference emission byte-for-byte', () => {
    const html = renderToHtml(decode('drawing-rotated-labels.json'));

    // The pivot is each label's own (x, y) — not the viewBox origin — so the
    // rotation composes with `textAnchor` rather than fighting it. These are
    // the exact strings the F# `DrawingSvg` emitter produces for the same
    // fixture; the corpus is the oracle, and this is the emission half of the
    // conformance the codec round-trip does not cover.
    expect(html).toContain('transform="rotate(-30 30 100)"'); // tilted category label
    expect(html).toContain('transform="rotate(-90 70 100)"'); // vertical escalation
    expect(html).toContain('transform="rotate(90 8 60)"'); // rotated y-axis title
    expect(html).toContain('transform="rotate(12.34 110 100)"'); // 2-dp fraction
    expect(html).toContain('transform="rotate(-0.5 180 100)"'); // negative fraction

    // An explicit 0 is a PRESENT value and must still emit: absent and zero are
    // different wire shapes, and a renderer that conflates them re-introduces
    // downstream the very distinction the codec is careful to preserve.
    expect(html).toContain('transform="rotate(0 150 100)"');

    // The unrotated label in the same fixture emits no transform at all — the
    // byte-unchanged guarantee for every pre-877 drawing.
    expect(html).toContain('<text class="fuaran-drawing-label" x="100" y="20"');
    expect(html.match(/transform="rotate\(/g)).toHaveLength(6);
  });
});

describe.skipIf(!referenceAvailable)(
  'Lock B — server classes are in the F# reference vocabulary',
  () => {
    it('the extracted reference vocabulary is non-trivial', () => {
      const { exact, prefixes } = referenceVocabulary();
      expect(exact.size).toBeGreaterThan(50);
      expect(exact.has('fuaran-node')).toBe(true);
      expect(prefixes).toContain('fuaran-custom-');
    });

    it.each(fixtureFiles)('%s emits only classes in the F# reference vocabulary', (file) => {
      const { exact, prefixes } = referenceVocabulary();
      const html = renderToHtml(decode(file));
      for (const cls of fuaranClasses(html)) {
        const inVocab = exact.has(cls) || prefixes.some((p) => cls.startsWith(p));
        expect(inVocab, `class ${cls} is not in the F# reference renderer vocabulary`).toBe(true);
      }
    });
  },
);
