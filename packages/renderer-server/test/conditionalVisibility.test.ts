// ============================================================================
//  Phase 1535 — conditional visibility, predicate cases, the scalar selector.
//
//  Driven by the SHARED CORPUS rather than by hand-built trees: `node-visible`,
//  `switch-predicate`, `switch-predicate-only` and `switch-on-transform-scalar`
//  are the oracle every host answers to, and rendering the same bytes here is
//  what makes "this tier agrees with the others" a measurement rather than a
//  claim.
//
//  The codec round-trip is covered by the conformance package. What is asserted
//  here is the RENDERING — which no round-trip can see, and which is the whole
//  of what this phase changed on hosts that already decoded the bytes fine.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import type { BindingSources } from '../src/bindings.js';

import { renderToHtml } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// test → renderer-server → packages → fuaran-ts → Fuaran-UI/wire-format-fixtures
const nodesDir = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'nodes');

const load = (fixture: string) => {
  const raw = readFileSync(join(nodesDir, `${fixture}.json`), 'utf8');
  const decoded = decodeNode(raw);
  if (!decoded.ok) throw new Error(`${fixture} failed to decode: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

const render = (fixture: string, sources: Partial<BindingSources> = {}) =>
  renderToHtml(load(fixture), { sources: sources as BindingSources });

describe('node-visible — presence, not concealment', () => {
  it('removes a node whose predicate resolves false, leaving no trace at all', () => {
    const html = render('node-visible', { state: { 'banner.shown': false } });

    expect(html).not.toContain('visible-state-flag');
    expect(html).not.toContain('Shown while the flag is set');
    // Removal is not concealment: the node contributes no `aria-hidden` either.
    // The fixture's `aria-hidden-decoration` sibling DOES carry one, so this is
    // asserted on the removed node's own id rather than on the document.
    expect(html).not.toContain('id="visible-state-flag"');
  });

  it('renders the same node when the predicate resolves true', () => {
    const html = render('node-visible', { state: { 'banner.shown': true } });

    expect(html).toContain('Shown while the flag is set');
  });

  it('renders a node whose predicate does NOT resolve', () => {
    // `visible-unresolved` reads a query result no host has furnished. Rendering
    // it is the rule: a missing source silently hiding content is the one
    // failure a reader cannot see, cannot report and cannot work around.
    const html = render('node-visible');

    expect(html).toContain('Rendered, because nothing could say whether to hide it');
  });

  it('honours a computed predicate through the scalar path', () => {
    // `visible-computed` is an `Expr` over a State param: shown once the basket
    // holds more than three things. Both directions from one fixture, so a host
    // that ignored the predicate entirely fails one of them.
    expect(render('node-visible', { state: { 'cart.itemCount': 9 } })).toContain(
      'Shown once the basket has more than three things in it',
    );
    expect(render('node-visible', { state: { 'cart.itemCount': 1 } })).not.toContain(
      'Shown once the basket has more than three things in it',
    );
  });

  it('keeps `visible` and `accessibility.hidden` distinct', () => {
    // The contrast the fixture carries on sibling nodes, asserted as one
    // statement: the aria-hidden node is RENDERED and marked, where a
    // visible:false node is not there at all.
    const html = render('node-visible', { state: { 'banner.shown': false } });

    expect(html).toContain('aria-hidden-decoration');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('visible-state-flag');
  });

  it('renders the default-visible spelling with no host state at all', () => {
    // `visible-until-dismissed` declares `defaultValue: true`. This is the
    // spelling an author needs, because a DEFAULT-LESS State predicate follows
    // the shared `Binding.State` rule and resolves false — which is what
    // FUARAN148 reports.
    expect(render('node-visible')).toContain('Shown until the reader dismisses it');
    expect(render('node-visible', { state: { 'banner.dismissed': false } })).not.toContain(
      'Shown until the reader dismisses it',
    );
  });
});

describe('switch-predicate — first-match-wins over a mixed case list', () => {
  it('takes a predicate case on a resolved true', () => {
    const html = render('switch-predicate', { state: { 'cart.empty': true } });

    expect(html).toContain('Your basket is empty');
  });

  it('runs the AUTHORED order, so a later match does not pre-empt an earlier predicate', () => {
    // The fixture's two predicate cases precede its `match` case. With BOTH the
    // first predicate true and the selector equal to the match value, a host
    // that checked matches ahead of predicates would render 'Summary view'.
    const html = render('switch-predicate', {
      state: { 'cart.empty': true, view: 'summary' },
    });

    expect(html).toContain('Your basket is empty');
    expect(html).not.toContain('Summary view');
  });

  it('falls through to the match case once the predicates decline', () => {
    const html = render('switch-predicate', {
      state: { 'cart.empty': false, 'cart.itemCount': 1, view: 'summary' },
    });

    expect(html).toContain('Summary view');
  });

  it('falls through to the default when nothing selects', () => {
    const html = render('switch-predicate', {
      state: { 'cart.empty': false, 'cart.itemCount': 1, view: 'nothing-matches' },
    });

    expect(html).toContain('A few things in your basket');
  });

  it('selects by predicate alone on a switch with no selector', () => {
    expect(render('switch-predicate-only', { state: { 'form.valid': true } })).toContain(
      'Ready to send',
    );
    expect(render('switch-predicate-only', { state: { 'form.valid': false } })).toContain(
      'Fill in the form to continue',
    );
  });
});

describe('switch-on-transform-scalar — the wire-neutral fix', () => {
  it('selects the matched case from a computed selector', () => {
    // Before Phase 1535 this rendered `Default` on every host: the generic
    // resolver's `Transform` arm is row-shaped and cannot serve a string slot.
    // The default is asserted ABSENT as well, so a host rendering both would
    // fail rather than satisfy a contains-check on the case alone.
    const html = render('switch-on-transform-scalar');

    expect(html).toContain('Plenty of rows');
    expect(html).not.toContain('Could not tell');
  });
});
