import { describe, it, expect, beforeEach } from 'vitest';
import { enhanceExpandable, closeExpanded } from '../src/enhanceExpandable.js';

// Phase 1079 — the client-only overlay over the renderers' `expandable` anchor.
//
// What these tests are FOR is the accessibility contract, not the pretty part.
// The overlay is a dialog, so it owes what the declarative `Modal` node owes
// (WIRE_FORMAT §3.6.5), and a lightbox that opens without a focus trap, without
// `Escape`, or without restoring focus is the ordinary defect this file exists
// to make impossible to reintroduce silently.
//
// `enhanceExpandable` binds ONE delegated listener and guards against
// re-binding, so it survives module reuse across cases; the DOM is rebuilt per
// test and any live overlay is closed.

const ANCHOR = `
  <a class="fuaran-image-expand" href="/harbour.jpg" data-fuaran-expandable="">
    <img class="fuaran-image" src="/harbour-400.jpg" alt="Fishing boats at first light" />
  </a>
`;

const FIGURE = `
  <figure class="fuaran-image-figure">
    ${ANCHOR}
    <figcaption class="fuaran-image-figure-caption">The harbour at dawn, 1908.</figcaption>
  </figure>
`;

function overlay(): HTMLElement | null {
  return document.querySelector('.fuaran-image-lightbox');
}

function anchorEl(): HTMLAnchorElement {
  return document.querySelector<HTMLAnchorElement>('a[data-fuaran-expandable]')!;
}

/** A left click with the button/modifier shape a real activation has. */
function click(el: Element): MouseEvent {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  el.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  closeExpanded();
  document.body.innerHTML = '';
  enhanceExpandable();
});

describe('enhanceExpandable — the overlay', () => {
  it('opens on activation and suppresses the navigation', () => {
    document.body.innerHTML = ANCHOR;
    expect(overlay()).toBeNull();

    const ev = click(anchorEl().querySelector('img')!);

    expect(overlay()).not.toBeNull();
    // Suppression is conditional on the overlay actually being up — see the
    // refusal case below, where the navigation is deliberately left alone.
    expect(ev.defaultPrevented).toBe(true);
  });

  it('meets the dialog contract: role, aria-modal, and an alt-derived label', () => {
    document.body.innerHTML = ANCHOR;
    click(anchorEl());

    const o = overlay()!;
    expect(o.getAttribute('role')).toBe('dialog');
    expect(o.getAttribute('aria-modal')).toBe('true');
    // The PICTURE is announced, not the word "dialog".
    expect(o.getAttribute('aria-label')).toBe('Fishing boats at first light');
  });

  it('shows the full asset — the href, never the thumbnail candidate', () => {
    document.body.innerHTML = ANCHOR;
    click(anchorEl());

    const img = overlay()!.querySelector<HTMLImageElement>('.fuaran-image-lightbox-image')!;
    expect(img.getAttribute('src')).toBe('/harbour.jpg');
    // A lightbox that showed the thumbnail would satisfy every structural
    // assertion above and defeat the entire feature.
    expect(img.getAttribute('src')).not.toBe('/harbour-400.jpg');
    expect(img.hasAttribute('srcset')).toBe(false);
    expect(img.getAttribute('alt')).toBe('Fishing boats at first light');
  });

  it('moves focus into the overlay and traps Tab within it', () => {
    document.body.innerHTML = ANCHOR;
    click(anchorEl());

    const o = overlay()!;
    const items = Array.from(o.querySelectorAll<HTMLElement>('button, a[href]'));
    expect(items.length).toBeGreaterThan(1);
    expect(document.activeElement).toBe(items[0]);

    // Tab from the LAST stop wraps to the first rather than escaping into the
    // (aria-hidden) document behind.
    items[items.length - 1]!.focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(items[0]);

    // Shift+Tab from the FIRST wraps to the last.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('dismisses on Escape and restores focus to the opening anchor', () => {
    document.body.innerHTML = ANCHOR;
    const opener = anchorEl();
    click(opener);
    expect(overlay()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(overlay()).toBeNull();
    // A reader tabbing through a gallery must not lose their place because they
    // looked at one picture.
    expect(document.activeElement).toBe(opener);
  });

  it('dismisses on a backdrop click but not on a click on the picture', () => {
    document.body.innerHTML = ANCHOR;
    click(anchorEl());
    const o = overlay()!;

    click(o.querySelector('.fuaran-image-lightbox-image')!);
    expect(overlay()).not.toBeNull();

    click(o);
    expect(overlay()).toBeNull();
  });

  it('hides the rest of the document while open and RESTORES prior aria-hidden', () => {
    document.body.innerHTML = `<div id="already" aria-hidden="true"></div><div id="live"></div>${ANCHOR}`;
    click(anchorEl());

    const already = document.getElementById('already')!;
    const live = document.getElementById('live')!;
    expect(already.getAttribute('aria-hidden')).toBe('true');
    expect(live.getAttribute('aria-hidden')).toBe('true');

    closeExpanded();

    // Restoring, not blanket-removing: an element that was already hidden from
    // assistive technology must stay that way.
    expect(already.getAttribute('aria-hidden')).toBe('true');
    expect(live.hasAttribute('aria-hidden')).toBe(false);
  });

  it('carries a sibling figcaption into the overlay', () => {
    document.body.innerHTML = FIGURE;
    click(anchorEl());

    const cap = overlay()!.querySelector('.fuaran-image-lightbox-caption');
    expect(cap?.textContent).toBe('The harbour at dawn, 1908.');
  });

  it('emits no caption element when the image has none', () => {
    document.body.innerHTML = ANCHOR;
    click(anchorEl());
    expect(overlay()!.querySelector('.fuaran-image-lightbox-caption')).toBeNull();
  });
});

describe('enhanceExpandable — what it deliberately leaves alone', () => {
  it('ignores a plain image with no expandable marker', () => {
    document.body.innerHTML = `<img class="fuaran-image" src="/a.png" alt="A" />`;
    const ev = click(document.querySelector('img')!);
    expect(overlay()).toBeNull();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('leaves a modified click to the browser', () => {
    document.body.innerHTML = ANCHOR;
    const ev = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
    });
    anchorEl().dispatchEvent(ev);

    // "Open in a new tab" is the reader asking the BROWSER to handle the link.
    expect(overlay()).toBeNull();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('does NOT suppress the navigation when it cannot build an overlay', () => {
    // A marked anchor with no `<img>` inside it: nothing to expand. Swallowing
    // the click here would turn a working link into a dead control, which is
    // the one failure this whole design exists to avoid.
    document.body.innerHTML = `<a class="fuaran-image-expand" href="/harbour.jpg" data-fuaran-expandable="">text</a>`;
    const ev = click(anchorEl());
    expect(overlay()).toBeNull();
    expect(ev.defaultPrevented).toBe(false);
  });
});
