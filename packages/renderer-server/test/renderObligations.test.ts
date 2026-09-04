// ============================================================================
//  Executable render-obligation conformance (WIRE_FORMAT.md §13) — this host's
//  adoption. The twin of the F# server-renderer suite.
//
//  Codec conformance is byte-parity and strong. Render obligations were prose:
//  §3.6.5 and §3.6.6 state, in sentences, that an accessible name is always
//  emitted, that `autoplay` never appears without `muted`, that an audio
//  transport has no autoplay pathway at all, that a refused source emits no
//  affordance. A host can pass every fixture in the corpus and silently fail
//  every one of those — none is a missing discriminator arm, so no codec test
//  and no type checker reaches them.
//
//  So the manifest carries them now, and this suite asserts FROM the manifest
//  rather than from a hand list beside it. Three consequences, which are the
//  whole point:
//
//    * The ENUMERATION is the corpus artefact's. A newly declared obligation on
//      a kind this host renders arrives here as a claim with no checker and
//      turns the suite RED — not as a paragraph a future reader may re-read.
//
//    * NOT CHECKED IS NOT PASSED. Every claim this host does not assert is
//      printed by name with the section that states it, and fails the gate
//      unless it carries a declared exemption. Silence is never an answer.
//
//    * The go-red property is PROVEN. `statusOf` is exercised against a claim no
//      checker covers and must report it unchecked — the shape a new obligation
//      takes on the day it lands.
//
//  Every checker asserts in EMITTED HTML through `renderToHtml`. A checker that
//  inspected the typed tree would be re-stating the type system; the obligations
//  are claims about output.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  describeObligationReport,
  parseRenderFidelityManifest,
  reportObligations,
  unassertedObligations,
  type ObligationOutcome,
  type RenderFidelityManifest,
  CardStore,
  type ContentHash,
  type ContractCard,
  type Node,
} from '@fuaran-ui/schema';
import { fuaran } from '@fuaran-ui/ui';

import { renderToHtml } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// test → renderer-server → packages → fuaran-ts → workspace/wire-format-fixtures
const ARTIFACT = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'render-fidelity.json');

const present = existsSync(ARTIFACT);
const load = (): RenderFidelityManifest =>
  parseRenderFidelityManifest(JSON.parse(readFileSync(ARTIFACT, 'utf8')));

/**
 * A destination that is safe by the scheme floor and entirely undeclared, so the
 * ambient egress policy refuses it. This is the input the two "refused"
 * obligations are about.
 */
const REFUSED = 'https://collector.example/asset.jpg';
/** The marked refusal a refused destination renders as. */
const REFUSAL_URL = 'about:blank#fuaran-egress-refused';

// ─── The checkers ────────────────────────────────────────────────────────────
//
// One per (kind, claim). Each pins BOTH directions where the obligation has two:
// an emission test alone cannot tell a renderer that honours a conditional from
// one that emits unconditionally.

const checkAccessibleNameAlways = (): void => {
  // Both variants, because the label is mandatory for the KIND and not for one
  // arm of it. A renderer emitting it only on `<video>` passes a video-only test.
  const video = renderToHtml(
    fuaran.video({ id: 'mv', src: '/walkthrough.mp4', label: 'Studio walkthrough' }),
  );
  const audio = renderToHtml(
    fuaran.audio({ id: 'ma', src: '/commentary.mp3', label: 'Curator commentary' }),
  );

  expect(video, 'a video emits the resolved label as aria-label').toContain(
    'aria-label="Studio walkthrough"',
  );
  expect(audio, 'an audio emits the resolved label as aria-label').toContain(
    'aria-label="Curator commentary"',
  );
};

const checkAutoplayMutedPairing = (): void => {
  const autoplaying = renderToHtml(
    fuaran.video({ id: 'mva', src: '/ambient.mp4', label: 'Ambient loop', autoplay: true }),
  );

  expect(autoplaying, 'a declared autoplay is emitted').toContain('autoplay');
  expect(
    autoplaying,
    'and never without muted — an unmuted autoplay is blocked and means nothing',
  ).toContain('muted');

  // The pairing runs one way, and this is the half a one-sided assertion misses:
  // `muted` unasked silences a video the reader started themselves.
  const plain = renderToHtml(
    fuaran.video({ id: 'mv', src: '/walkthrough.mp4', label: 'Studio walkthrough' }),
  );

  expect(plain, 'autoplay is not declared, so it must not be emitted').not.toContain('autoplay');
  expect(plain, 'muted rides autoplay; unasked it is a behaviour change').not.toContain('muted');
};

const checkNoAutoplayPathway = (): void => {
  const audio = renderToHtml(
    fuaran.audio({ id: 'ma', src: '/commentary.mp3', label: 'Curator commentary' }),
  );

  expect(audio, 'an <audio> must never carry an autoplay attribute').not.toContain('autoplay');
  expect(audio, 'an <audio> has no autoplay, so it has nothing to mute').not.toContain('muted');
};

const checkRefusedSourceDropped = (): void => {
  const refused = renderToHtml(
    fuaran.video({
      id: 'mvp',
      src: '/walkthrough.mp4',
      label: 'Studio walkthrough',
      poster: REFUSED,
    }),
  );

  expect(refused, "a refused poster's destination is never emitted").not.toContain(
    'collector.example',
  );
  expect(
    refused,
    'a refused poster is DROPPED, not emitted at the refusal URL — a poster at the refusal URL is a broken image over the player, where no poster shows the first frame',
  ).not.toContain('poster=');

  // The allow twin. Without it a renderer that dropped EVERY poster would pass
  // the refusal assertion and this obligation would guard nothing.
  const allowed = renderToHtml(
    fuaran.video({
      id: 'mvp2',
      src: '/walkthrough.mp4',
      label: 'Studio walkthrough',
      poster: '/walkthrough-poster.jpg',
    }),
  );

  expect(allowed, 'a local poster still renders').toContain('poster="/walkthrough-poster.jpg"');
};

const checkAltAlwaysEmitted = (): void => {
  const named = renderToHtml(
    fuaran.image({ id: 'img', src: '/harbour.jpg', alt: 'Fishing boats moored at first light' }),
  );
  expect(named, 'the alt text is emitted').toContain('alt="Fishing boats moored at first light"');

  // The decorative case is the one that matters. An omitted `alt` and an empty
  // one are different claims to assistive technology: omitted means "nobody
  // said", empty means "this is decorative, skip it".
  const decorative = renderToHtml(fuaran.image({ id: 'imgd', src: '/rule.png', alt: '' }));
  expect(decorative, 'a decorative image emits an EMPTY alt, never no alt at all').toContain(
    'alt=""',
  );
};

const checkAnchorAffordanceOnExpandable = (): void => {
  const html = renderToHtml(
    fuaran.image({ id: 'imge', src: '/harbour.jpg', alt: 'Harbour', expandable: true }),
  );

  // The ELEMENT is pinned, not only the class: the whole no-JS claim is that
  // this is an `<a href>`, and a `<span class="fuaran-image-expand">` carrying
  // the data attribute would pass a class-only assertion while giving a
  // scriptless reader nothing.
  expect(html, 'expandable emits a real anchor to the asset the image already names').toContain(
    '<a class="fuaran-image-expand" href="/harbour.jpg" data-fuaran-expandable="">',
  );

  const notExpandable = renderToHtml(
    fuaran.image({ id: 'imgp', src: '/harbour.jpg', alt: 'Harbour' }),
  );
  expect(notExpandable, 'an undeclared expansion emits no anchor').not.toContain(
    'fuaran-image-expand',
  );
};

const checkRefusedSrcNoAffordance = (): void => {
  const html = renderToHtml(
    fuaran.image({ id: 'imgr', src: REFUSED, alt: 'Harbour', expandable: true }),
  );

  expect(
    html,
    'a src the egress floor refused emits NO expand anchor — an affordance that cannot be honoured is worse than none',
  ).not.toContain('fuaran-image-expand');

  // The image itself still renders, at the refusal URL. Without this leg a
  // renderer that dropped the whole node would pass the assertion above, and
  // this obligation would be satisfied by a worse bug than the one it guards.
  expect(html, 'the img is still emitted, with the marked refusal URL as its src').toContain(
    REFUSAL_URL,
  );
  expect(html, 'and the refused destination never becomes a navigable href').not.toContain(
    'href="https://collector.example',
  );
};

const checkFigureCaptionOutsideLink = (): void => {
  const html = renderToHtml(
    fuaran.image({
      id: 'imgef',
      src: '/harbour.jpg',
      alt: 'Harbour',
      expandable: true,
      caption: 'The harbour at dawn',
    }),
  );

  // Asserting the two opening tags IN ORDER is what catches the inversion
  // (anchor outside figure), which would carry every one of the same classes.
  expect(html, 'the figure wraps the anchor, not the other way round').toContain(
    '<figure class="fuaran-image-figure"><a class="fuaran-image-expand" href="/harbour.jpg" data-fuaran-expandable="">',
  );
  expect(
    html,
    "the figcaption is the anchor's SIBLING — the caption is prose a reader quotes, not a second click surface",
  ).toContain(
    '</a><figcaption class="fuaran-image-figure-caption">The harbour at dawn</figcaption></figure>',
  );
};

const checkSrcSetAscendingByWidth = (): void => {
  // Authored DESCENDING, so the assertion pins the renderer's SORT and not
  // merely its spelling: a renderer emitting authored order would produce a
  // srcset containing all the same URLs and fail here.
  const html = renderToHtml(
    fuaran.image({
      id: 'imgs',
      src: '/harbour.jpg',
      alt: 'Harbour',
      srcSet: [
        { src: '/harbour-1600.jpg', width: 1600 },
        { src: '/harbour-800.jpg', width: 800 },
        { src: '/harbour-400.jpg', width: 400 },
      ],
    }),
  );

  expect(html, 'candidates are emitted ascending by width').toContain(
    'srcset="/harbour-400.jpg 400w, /harbour-800.jpg 800w, /harbour-1600.jpg 1600w"',
  );

  // The second half of the same obligation: a refused candidate is DROPPED, so
  // the primary src remains the fallback rather than the list carrying a
  // destination the floor refused.
  const withRefused = renderToHtml(
    fuaran.image({
      id: 'imgs2',
      src: '/harbour.jpg',
      alt: 'Harbour',
      srcSet: [
        { src: '/harbour-400.jpg', width: 400 },
        { src: REFUSED, width: 1600 },
      ],
    }),
  );

  expect(withRefused, "a refused candidate's destination is never emitted").not.toContain(
    'collector.example',
  );
  expect(withRefused, '…while the candidates that pass the floor still are').toContain(
    '/harbour-400.jpg 400w',
  );
};

// ─── The unregistered-degradation obligation (§25.4) ─────────────────────────

/**
 * A contract card for a component this host has no renderer for. That is the
 * whole premise: this tier ships no custom-renderer registry seam at all, so
 * every `Custom` node takes the unregistered path and the card is the only thing
 * standing between a reader and two opaque strings.
 */
const SPARKLINE_CARD: ContractCard = {
  moduleId: 'analytics',
  componentId: 'sparkline',
  props: [
    {
      name: 'series',
      type: 'string',
      required: true,
      payloadLanguage: 'chartspec',
      payloadGate: 'chartspec-gate:1.2',
    },
    { name: 'title', type: 'string', required: false },
  ],
  contentHash: { algorithm: 'SHA256', hash: 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3' },
  summary: 'A compact trend line with a period-over-period delta.',
};

const customNode = (contentHash?: ContentHash): Node<never> =>
  fuaran.custom({
    id: 'cust',
    moduleId: 'analytics',
    componentId: 'sparkline',
    props: { series: '{"points":[1,2,3]}' },
    ...(contentHash !== undefined ? { contentHash } : {}),
  });

const checkUnregisteredCustomLabelled = (): void => {
  const cards = CardStore.of([SPARKLINE_CARD]);

  // (1) NO CARD — the pre-§25 path, byte-for-byte. First, because it is the leg
  // the obligation must NOT have changed: an obligation that quietly rewrote
  // every existing host's output would be a breaking change wearing a
  // conformance claim.
  const bare = renderToHtml(customNode());

  expect(bare, 'the identity-only placeholder still names the component').toContain(
    'Custom analytics.sparkline',
  );
  expect(bare, 'a host with no card claims nothing about a card').not.toContain(
    'data-fuaran-custom-card',
  );
  expect(bare, 'and invents no description it does not have').not.toContain('trend line');

  // (2) CARD, NO DECLARED HASH — the common case. Shown, and marked unverified.
  const unverified = renderToHtml(customNode(), { cards });

  expect(unverified, 'the verdict marker is machine-readable').toContain(
    'data-fuaran-custom-card="unverified"',
  );
  expect(unverified, 'the identity is still emitted').toContain(
    '[fuaran:custom analytics.sparkline]',
  );
  expect(unverified, "the card's summary is emitted — the whole legibility gain").toContain(
    'A compact trend line with a period-over-period delta.',
  );
  expect(unverified, 'the declared prop rows are emitted, payload language included').toContain(
    'series: string (required) [chartspec (gate chartspec-gate:1.2)]',
  );
  // Never a prop VALUE: this host was not asked to interpret the node's props.
  expect(unverified, 'no prop value reaches the placeholder').not.toContain('points');

  // (3) CARD, MATCHING HASH — the strongest claim available.
  const matching = renderToHtml(
    customNode({
      algorithm: 'SHA256',
      hash: 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
      strictness: 'AdvisoryWarning',
    }),
    { cards },
  );

  expect(matching, 'a verified card says so').toContain('data-fuaran-custom-card="described"');
  expect(matching, 'and shows the description').toContain('A compact trend line');

  // (4) CARD, CONTRADICTED HASH — the description is WITHHELD. Without this leg
  // the obligation would be satisfied by a renderer showing any card matching by
  // name, which is the guess it exists to forbid.
  const mismatched = renderToHtml(
    customNode({
      algorithm: 'SHA256',
      hash: '0000000000000000000000000000000000000000',
      strictness: 'AdvisoryWarning',
    }),
    { cards },
  );

  expect(mismatched, 'the contradiction is stated, not hidden').toContain(
    'data-fuaran-custom-card="hash-mismatch"',
  );
  expect(
    mismatched,
    'a description of a different shape is withheld — a confident wrong description is worse than none',
  ).not.toContain('trend line');
  expect(mismatched, 'the identity survives; only the description is withheld').toContain(
    '[fuaran:custom analytics.sparkline]',
  );

  // (5) A MALFORMED prop bag is CALLED malformed. The half a labelling pass
  // alone would miss.
  const malformed = renderToHtml(
    fuaran.custom({
      id: 'cust',
      moduleId: 'analytics',
      componentId: 'sparkline',
      props: { title: 'Revenue' },
    }),
    { cards },
  );

  expect(malformed, 'a card lets this host say the node violates its declared schema').toContain(
    "required prop 'series' (string) is missing",
  );
};

// ─── Phase 1110 — the Media text tracks ─────────────────────────────────────

const captionsTrack = (label: string, srcLang: string, isDefault: boolean) => ({
  kind: 'Captions' as const,
  src: `/walkthrough.${srcLang}.vtt`,
  srcLang,
  label,
  default: isDefault,
});

const checkAuthoredChildOrder = (): void => {
  // Authored in an order NO SORT PRODUCES, which is what makes this an
  // assertion about order rather than about presence: a renderer emitting the
  // tracks sorted by language, by kind, or by label would carry all three and
  // still fail here.
  const html = renderToHtml(
    fuaran.video({
      id: 'mv',
      src: '/walkthrough.mp4',
      label: 'Studio walkthrough',
      tracks: [
        { kind: 'Subtitles', src: '/w.gd.vtt', srcLang: 'gd', label: 'Gàidhlig' },
        captionsTrack('English captions', 'en', true),
        { kind: 'Descriptions', src: '/w.ad.vtt', srcLang: 'ar', label: 'Audio description' },
      ],
    }),
  );
  const order = ['gd', 'en', 'ar'].map((l) => html.indexOf(`srclang="${l}"`));
  expect(
    order.every((i) => i >= 0),
    'every authored track is emitted',
  ).toBe(true);
  expect(
    order,
    'the tracks are emitted in the AUTHORED order — a reader picks from a menu the user agent builds in document order, so re-sorting rewrites someone else\u2019s menu',
  ).toEqual([...order].sort((a, b) => a - b));
};

const checkSingleDefaultPerKind = (): void => {
  // Two captions tracks BOTH electing default, and a subtitles track electing
  // it as well. The election is per KIND, so the subtitles default must survive
  // alongside the FIRST captions one — a host that kept only one default in the
  // whole element would pass a naive count and be wrong.
  const html = renderToHtml(
    fuaran.video({
      id: 'mvd',
      src: '/walkthrough.mp4',
      label: 'Studio walkthrough',
      tracks: [
        captionsTrack('English captions', 'en', true),
        captionsTrack('English captions (verbose)', 'ev', true),
        { kind: 'Subtitles', src: '/w.gd.vtt', srcLang: 'gd', label: 'Gàidhlig', default: true },
      ],
    }),
  );
  const tracks = html.match(/<track[^>]*>/g) ?? [];
  expect(tracks.length, 'every track is still emitted — only the CLAIM is dropped').toBe(3);
  const defaults = tracks.filter((t) => t.includes(' default'));
  expect(
    defaults.length,
    'exactly two defaults survive: the FIRST captions election and the subtitles one',
  ).toBe(2);
  expect(defaults[0], 'the first captions election is the one honoured').toContain('srclang="en"');
  expect(
    tracks.find((t) => t.includes('srclang="ev"')),
    'the LATER election of the same kind is emitted without the attribute',
  ).not.toContain(' default');
};

const checkTranscriptDisclosureNamed = (): void => {
  const html = renderToHtml(
    fuaran.audio({
      id: 'ma',
      src: '/commentary.mp3',
      label: "Curator's commentary",
      transcript: 'The harbour was rebuilt twice.',
    }),
  );
  // BESIDE the transport, never inside it: `<audio>` admits only source-ish
  // children, so a transcript placed there would be fallback content a browser
  // never shows. Asserting the two opening tags in order is what catches that
  // inversion, which would carry every one of the same classes.
  expect(html, 'the disclosure is a SIBLING of the transport inside the group wrapper').toContain(
    '</audio><details class="fuaran-media-transcript"',
  );
  expect(
    html,
    "the disclosure carries the MEDIA's own resolved label, so a reader meeting it out of context is told which recording it transcribes",
  ).toContain('aria-label="Curator&#x27;s commentary"');

  const without = renderToHtml(
    fuaran.audio({ id: 'ma2', src: '/commentary.mp3', label: 'Commentary' }),
  );
  expect(without, 'absent, the emission is the bare element it would otherwise be').not.toContain(
    'fuaran-media-transcript',
  );
};

// ─── Phase 1111 — the sandboxed embed ───────────────────────────────────────

const checkEmbedAccessibleNameAlways = (): void => {
  const html = renderToHtml(
    fuaran.embed({ id: 'em', src: 'https://example.com/x', title: 'Quarterly figures' }),
  );
  expect(html, 'the frame carries its accessible name').toContain('title="Quarterly figures"');

  // A frame is a focus container a reader tabs INTO, so it is never decorative:
  // the attribute is emitted whatever it resolves to, and an empty title is a
  // stated empty rather than an absent one.
  const empty = renderToHtml(fuaran.embed({ id: 'em2', src: 'https://example.com/x', title: '' }));
  expect(empty, 'an empty title is still EMITTED, never dropped').toContain('title=""');
};

const checkSandboxAlwaysExactlyDeclared = (): void => {
  const none = renderToHtml(
    fuaran.embed({ id: 'es', src: 'https://example.com/x', title: 'Figures' }),
  );
  // EMPTY and PRESENT. Omitting it on a permissionless embed would be the same
  // markup as an unsandboxed frame — the one mistake here that grants
  // everything while looking like it grants nothing.
  expect(none, 'the sandbox attribute is emitted even when nothing is granted').toContain(
    'sandbox=""',
  );

  // Authored out of declaration order and with a duplicate, so this pins the
  // ORDER and the DE-DUPLICATION rather than the token set: two documents naming
  // the same set must produce identical markup whatever order they authored.
  const some = renderToHtml(
    fuaran.embed({
      id: 'es2',
      src: 'https://example.com/x',
      title: 'Figures',
      permissions: ['AllowForms', 'AllowScripts', 'AllowScripts'],
    }),
  );
  expect(some, 'tokens ride in DECLARATION order, de-duplicated').toContain(
    'sandbox="allow-scripts allow-forms"',
  );
  expect(
    some,
    'and never a token the document did not name — AllowSameOrigin plus AllowScripts is how a frame removes its own sandbox',
  ).not.toContain('allow-same-origin');

  // Fullscreen rides `allow`, not `sandbox`: it is a permissions-policy
  // directive and not a sandbox token, and emitting it as one grants nothing.
  const fs = renderToHtml(
    fuaran.embed({
      id: 'es3',
      src: 'https://example.com/x',
      title: 'Figures',
      permissions: ['AllowFullscreen'],
    }),
  );
  expect(fs, 'fullscreen is a permissions-policy directive').toContain('allow="fullscreen"');
  expect(fs, 'and is NOT a sandbox token').toContain('sandbox=""');
};

const checkRefusedEmbedSourceOmitted = (): void => {
  // `http` — the embed egress class admits `https` and nothing else, because a
  // same-origin frame is exactly where AllowSameOrigin plus AllowScripts lets
  // the framed document remove its own sandbox.
  const html = renderToHtml(
    fuaran.embed({ id: 'er', src: 'http://example.com/x', title: 'Figures' }),
  );
  expect(
    html,
    'the source attribute is OMITTED ENTIRELY rather than pointed at the refusal URL — an iframe at that URL renders that page',
  ).not.toContain('src=');
  expect(html, 'while the refusal is still RECORDED').toContain('data-fuaran-egress');
  expect(html, 'and the frame itself is still emitted, named and sandboxed').toContain(
    'title="Figures"',
  );
};

// ─── Phase 1115 — the upload picker ─────────────────────────────────────────

const checkPickerAlwaysPresent = (): void => {
  const noop = () => ({ kind: 'Chain' as const, actions: [] });
  for (const [id, extra] of [
    ['up-plain', {}],
    ['up-drop', { dropTarget: true }],
    ['up-paste', { acceptPaste: true }],
    ['up-capture', { capture: 'Camera' as const }],
    ['up-dest', { destination: 'session-recordings' }],
  ] as const) {
    const html = renderToHtml(fuaran.fileUpload({ id, label: 'Upload', onSelect: noop, ...extra }));
    // The declared gestures are ADDITIONAL. Whatever the document declares, the
    // picker and its label are emitted — so the keyboard-accessible route
    // survives and a no-script host renders a working upload.
    expect(html, `${id}: the file input is emitted`).toContain('type="file"');
    expect(html, `${id}: and its label with it`).toContain('fuaran-file-upload-label');
  }
};

// ─── Phase 1119 — the modal's inertness claim ───────────────────────────────

const checkAriaModalOnlyWhenBlocking = (): void => {
  const blocking = renderToHtml(
    fuaran.modal({ id: 'md', openStateKey: 'open', children: [], heading: 'Confirm' }),
  );
  expect(blocking, 'the blocking modality claims the page behind it is inert').toContain(
    'aria-modal="true"',
  );

  const popover = renderToHtml(
    fuaran.modal({
      id: 'mp',
      openStateKey: 'open',
      children: [],
      heading: 'Details',
      modality: 'Popover',
    }),
  );
  // The claim is about INERTNESS, and a non-blocking anchored surface leaves the
  // page genuinely available — so it carries the dialog role WITHOUT the claim.
  // A host emitting `aria-modal` here tells assistive technology the rest of the
  // page is unreachable when it is not.
  expect(popover, 'the anchored surface still carries the dialog role').toContain('role="dialog"');
  expect(popover, 'but never the inertness claim').not.toContain('aria-modal');
};

// ─── Phase 1120 — the tree row's accessible name ────────────────────────────

const checkTreeAccessibleNameAlways = (): void => {
  const html = renderToHtml(
    fuaran.tree({
      id: 'tr',
      items: [
        { id: 'goods', label: 'Goods', children: [{ id: 'cocoa', label: 'Cocoa' }] },
        { id: 'ledger', label: 'Ledger' },
      ],
    }),
  );
  // STATED rather than computed. A treeitem OWNS its child group, so a name
  // computed from contents reads the whole branch out as the row's own name —
  // "Goods Cocoa" for the parent here. Asserting the parent's name is exactly
  // its own visible label is what catches that.
  expect(html, 'the parent row is named by its OWN label, not its subtree').toContain(
    'aria-label="Goods"',
  );
  expect(html, 'a leaf row is named too — every instance, never only some').toContain(
    'aria-label="Ledger"',
  );
  expect(html, 'and the stated name is byte-identical to the visible label').toContain(
    '<span class="fuaran-tree-label">Goods</span>',
  );
};

/**
 * The registry: which (kind, claim) pairs this host asserts, and how. Keyed by
 * the claim's WIRE token, because the enumeration it is matched against comes
 * from the artefact.
 */
const CHECKERS: ReadonlyMap<string, () => void> = new Map([
  ['Media/accessible-name-always', checkAccessibleNameAlways],
  ['Media/autoplay-muted-pairing', checkAutoplayMutedPairing],
  ['Media/no-autoplay-pathway', checkNoAutoplayPathway],
  ['Media/refused-source-dropped', checkRefusedSourceDropped],
  ['Image/alt-always-emitted', checkAltAlwaysEmitted],
  ['Image/anchor-affordance-on-expandable', checkAnchorAffordanceOnExpandable],
  ['Image/refused-src-no-affordance', checkRefusedSrcNoAffordance],
  ['Image/figure-caption-outside-link', checkFigureCaptionOutsideLink],
  ['Image/srcset-ascending-by-width', checkSrcSetAscendingByWidth],
  ['Custom/unregistered-custom-labelled', checkUnregisteredCustomLabelled],
  // Phase 1128 — the wave's own obligations, each arriving here as a failing
  // claim on the day the manifest declared it (the Phase 1109 mechanism working
  // as designed) and leaving as an assertion in emitted HTML.
  ['Media/authored-child-order', checkAuthoredChildOrder],
  ['Media/single-default-per-kind', checkSingleDefaultPerKind],
  ['Media/transcript-disclosure-named', checkTranscriptDisclosureNamed],
  ['Embed/accessible-name-always', checkEmbedAccessibleNameAlways],
  ['Embed/sandbox-always-exactly-declared', checkSandboxAlwaysExactlyDeclared],
  ['Embed/refused-embed-source-omitted', checkRefusedEmbedSourceOmitted],
  ['FileUpload/picker-always-present', checkPickerAlwaysPresent],
  ['Modal/aria-modal-only-when-blocking', checkAriaModalOnlyWhenBlocking],
  ['Tree/accessible-name-always', checkTreeAccessibleNameAlways],
]);

/**
 * Obligations this host declares it does NOT check, each with a reason.
 *
 * EMPTY is the correct state for this tier: it renders every canonical kind, so
 * every declared obligation is one it owes. The map exists because the
 * alternative — an unchecked obligation silently absent from the registry — is
 * precisely the failure the manifest replaces. A host that genuinely cannot
 * check a claim (no player, no network loader, a decode-only surface) records it
 * here and its report says so out loud.
 */
const DECLARED_EXEMPTIONS: ReadonlyMap<string, string> = new Map();

const statusOf = (kind: string, claimId: string): ObligationOutcome => {
  const key = `${kind}/${claimId}`;
  if (CHECKERS.has(key)) return { status: 'asserted' };
  const exemption = DECLARED_EXEMPTIONS.get(key);
  if (exemption !== undefined) return { status: 'unchecked', reason: exemption };
  return {
    status: 'unchecked',
    reason:
      'no checker registered in renderObligations.test.ts and no declared exemption — add one, or declare why this host cannot check it',
  };
};

describe.skipIf(!present)('render-obligation conformance (WIRE_FORMAT.md §13)', () => {
  // ── The gate ──────────────────────────────────────────────────────────────
  it('asserts every obligation the manifest declares', () => {
    const manifest = load();
    const report = reportObligations(manifest, statusOf);

    expect(
      report.length,
      'the manifest declares no obligations at all — either the artefact is stale or this suite is reading the wrong file, and either way it is asserting nothing',
    ).toBeGreaterThan(0);

    // NOT CHECKED IS NOT PASSED. Everything this host did not assert is printed
    // by name and section before the gate decides, so an exempted claim is
    // visible in the run rather than inferable from its absence.
    const unmet = unassertedObligations(report);
    for (const line of unmet)
      console.log(`  render obligation not asserted: ${describeObligationReport(line)}`);

    const undeclared = unmet
      .filter((l) => !DECLARED_EXEMPTIONS.has(`${l.kind}/${l.claimId}`))
      .map((l) => `${l.kind}/${l.claimId} [${l.section}]`);

    expect(
      undeclared,
      'a render obligation this host owes has no checker: assert it, or add a declared exemption saying why this host cannot',
    ).toEqual([]);
  });

  // ── The go-red proof ──────────────────────────────────────────────────────
  it('reports an obligation with no checker as UNCHECKED (negative probe)', () => {
    // The shape a NEWLY-DECLARED obligation takes on the day it lands: a
    // kind/claim pair the registry does not cover. Without this probe the gate
    // above could be green because the classification never reports anything,
    // which is the completeness check that cannot fail.
    const outcome = statusOf('Markdown', 'accessible-name-always');
    expect(outcome.status, 'an unregistered (kind, claim) must be reported UNCHECKED').toBe(
      'unchecked',
    );
    if (outcome.status === 'unchecked')
      expect(outcome.reason, 'in words a reader can act on').toContain('no checker registered');

    // …and the gate's own filter must classify it as unasserted, which is what
    // turns the suite red.
    const probe = {
      kind: 'Markdown',
      claimId: 'accessible-name-always',
      statement: '',
      section: 'probe',
      outcome,
    };
    expect(unassertedObligations([probe]).length).toBe(1);
  });

  // ── The vocabulary seam ───────────────────────────────────────────────────
  it('resolves every declared claim id against the closed vocabulary', () => {
    // A row naming a claim the vocabulary omits is unresolvable: a host keying
    // its registry off the vocabulary could never report it, and a host must
    // never accept a claim it cannot name.
    const manifest = load();
    const vocabulary = new Set(manifest.obligationVocabulary.map((v) => v.id));

    expect(vocabulary.size, 'the artefact carries no obligation vocabulary').toBeGreaterThan(0);

    const unresolvable = manifest.kinds
      .flatMap((row) => row.obligations.map((o) => ({ kind: row.kind, id: o.id })))
      .filter((o) => !vocabulary.has(o.id))
      .map((o) => `${o.kind}/${o.id}`);

    expect(
      unresolvable,
      'a kind declares an obligation the closed vocabulary does not carry',
    ).toEqual([]);

    // Every claim carries a section. An obligation with no section is an
    // assertion about a host's habits, not about the specification.
    for (const row of manifest.kinds)
      for (const o of row.obligations) {
        expect(o.section, `${row.kind}/${o.id}: no spec section`).toContain('WIRE_FORMAT.md');
        expect(o.statement.length, `${row.kind}/${o.id}: no normative statement`).toBeGreaterThan(
          0,
        );
      }
  });

  // ── The registry is not itself a second source of truth ───────────────────
  it('registers no checker for an obligation the manifest does not declare', () => {
    // A checker for a claim no row declares is a stale assertion: it passes
    // forever and guards a contract that has moved, which is exactly the drift
    // the generated artefact exists to remove.
    const manifest = load();
    const declared = new Set(
      manifest.kinds.flatMap((row) => row.obligations.map((o) => `${row.kind}/${o.id}`)),
    );
    const orphans = [...CHECKERS.keys()].filter((key) => !declared.has(key));

    expect(
      orphans,
      'a checker asserts an obligation no manifest row declares — either the row was removed or the checker was never declared',
    ).toEqual([]);
  });

  // ── The checkers themselves ───────────────────────────────────────────────
  //
  // Run by name, so a failing obligation names the claim it broke rather than
  // surfacing as one opaque red test.
  for (const [key, check] of CHECKERS) it(`owes ${key}`, () => check());
});
