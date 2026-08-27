// Client-only post-hydration expandable-image enhancement (Phase 1079).
//
// The renderers emit DETERMINISTIC output that is byte-identical across all
// hosts + SSR: an `Image` declaring `expandable` renders as a real anchor around
// the picture —
//
//   <a class="fuaran-image-expand" href="/harbour.jpg" data-fuaran-expandable>
//     <img class="fuaran-image" src="/harbour.jpg" alt="…">
//   </a>
//
// — and THAT is the only thing the cross-host + SSR↔CSR parity gate compares.
//
// The distinction from the other two enhancement passes in this package is
// worth stating, because it is what makes this one safe to ship at all: KaTeX
// and syntax highlighting upgrade output that is merely PLAINER without them,
// whereas the anchor below is fully FUNCTIONAL without this file. Click it with
// no JavaScript and the browser opens the full-size asset in its own viewer.
// `enhanceExpandable` changes where the picture opens, never whether it opens.
// A lightbox built the usual way — a dead `<div>`, or `href="#"` plus a click
// handler — gives a crawler, a text browser, a locked-down client or a failed
// hydration nothing at all, which is precisely why the wire slot is a bool
// declaring REACHABILITY and not an action declaring a lightbox.
//
// The overlay is a DIALOG and meets the same contract the declarative `Modal`
// node meets (WIRE_FORMAT §3.6.5; the F# `docs/SSR.md` overlay contract):
// `role="dialog"` + `aria-modal="true"`, an `alt`-derived `aria-label`, a focus
// trap, `Escape` and backdrop dismissal, focus restored to the opening anchor,
// and the rest of the document `aria-hidden` while it is open. An enhancement
// that met a weaker contract would be a second, worse dialog on the same page.
//
// It binds ONE delegated listener on the document rather than one per image, so
// it is idempotent with respect to re-renders: an anchor React mounts after this
// runs needs no rescan and no marker attribute. Calling it twice is a no-op —
// the second call sees its own listener already installed and returns.
//
// The F# twin is the packaged `content/fuaran-image-expand.js` in
// `Fuaran.UI.Renderer`, for hosts not carrying these npm packages. Both read the
// same attribute and emit the same `.fuaran-image-lightbox` markup; the
// reference stylesheet carries the rules for it, so neither writes inline
// styles.

const MARKER = 'data-fuaran-expandable';
const OVERLAY_CLASS = 'fuaran-image-lightbox';

interface OpenState {
  readonly overlay: HTMLElement;
  readonly opener: HTMLElement;
  readonly hidden: readonly Element[];
  readonly hiddenPrev: readonly (string | null)[];
  readonly onKey: (ev: KeyboardEvent) => void;
}

/**
 * The live overlay, or null. At most ONE is open: a second expansion over an
 * open one would need a stack, and a stack needs a story about what Escape
 * means at each level. One is the honest model.
 */
let open: OpenState | null = null;

/** Guards the delegated listener so repeat calls do not double-bind. */
let bound = false;

/** Walk up from an event target to the marked anchor, if any. */
function markedAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  let node = target as Node | null;
  while (node !== null && node !== document) {
    if (node.nodeType === 1) {
      const el = node as Element;
      if (el.tagName === 'A' && el.hasAttribute(MARKER)) return el as HTMLAnchorElement;
    }
    node = node.parentNode;
  }
  return null;
}

/**
 * The caption text for an expandable anchor, or ''. Read from the sibling
 * `<figcaption>` of the enclosing `<figure>`: the caption is OUTSIDE the link
 * by construction (it is prose a reader selects, not a second click surface),
 * so there is nothing to find inside the anchor.
 */
function captionOf(anchor: HTMLElement): string {
  const parent = anchor.parentElement;
  if (parent === null || parent.tagName !== 'FIGURE') return '';
  const cap = parent.querySelector('.fuaran-image-figure-caption');
  return cap === null ? '' : (cap.textContent ?? '').trim();
}

function focusables(overlay: HTMLElement): HTMLElement[] {
  return Array.from(overlay.querySelectorAll<HTMLElement>('button, a[href]'));
}

/** Close the live overlay, restoring what it changed. */
export function closeExpanded(): void {
  if (open === null) return;
  const state = open;
  open = null;

  state.overlay.parentNode?.removeChild(state.overlay);
  state.hidden.forEach((el, i) => {
    // RESTORE, not remove: an element already `aria-hidden` before the overlay
    // opened must stay that way.
    const prev = state.hiddenPrev[i];
    if (prev === null || prev === undefined) el.removeAttribute('aria-hidden');
    else el.setAttribute('aria-hidden', prev);
  });
  document.removeEventListener('keydown', state.onKey, true);
  state.opener.focus();
}

function onKeyFactory(overlay: HTMLElement): (ev: KeyboardEvent) => void {
  return (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      ev.preventDefault();
      closeExpanded();
      return;
    }
    if (ev.key !== 'Tab') return;

    // The trap. Capture-phase, so it runs before anything the host bound.
    const items = focusables(overlay);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;

    if (ev.shiftKey && (active === first || !overlay.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && (active === last || !overlay.contains(active))) {
      ev.preventDefault();
      first.focus();
    }
  };
}

/**
 * Open the overlay for one marked anchor. Returns false when there is nothing
 * to show, which lets the caller fall through to the browser's own navigation
 * rather than swallowing the activation — a suppressed click that then does
 * nothing is the dead control this design exists to avoid.
 */
function expand(anchor: HTMLAnchorElement): boolean {
  const img = anchor.querySelector('img');
  const href = anchor.getAttribute('href');
  if (img === null || href === null || href === '') return false;

  closeExpanded();

  const alt = img.getAttribute('alt') ?? '';
  const caption = captionOf(anchor);

  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  // The alt, not a generic label: the dialog should announce the PICTURE.
  overlay.setAttribute('aria-label', alt === '' ? 'Expanded image' : alt);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'fuaran-image-lightbox-close';
  closeBtn.setAttribute('type', 'button');
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.appendChild(document.createTextNode('×'));

  // The picture, wrapped in its own link to the asset. That link is the second
  // trap stop AND the escape hatch: a reader who wants the file itself, or a
  // new tab, still has an ordinary anchor to reach for.
  //
  // It carries NO `srcset`: the candidates on the thumbnail are sized for the
  // layout box, and offering them here would defeat the expansion.
  const link = document.createElement('a');
  link.setAttribute('href', href);
  const full = document.createElement('img');
  full.className = 'fuaran-image-lightbox-image';
  full.setAttribute('src', href);
  full.setAttribute('alt', alt);
  link.appendChild(full);

  overlay.appendChild(closeBtn);
  overlay.appendChild(link);

  if (caption !== '') {
    const cap = document.createElement('p');
    cap.className = 'fuaran-image-lightbox-caption';
    cap.appendChild(document.createTextNode(caption));
    overlay.appendChild(cap);
  }

  // Hide the rest of the document from assistive technology. Only the overlay's
  // own siblings need marking — everything below them is hidden with its
  // ancestor.
  const hidden = Array.from(document.body.children);
  const hiddenPrev = hidden.map((el) => el.getAttribute('aria-hidden'));
  hidden.forEach((el) => el.setAttribute('aria-hidden', 'true'));

  document.body.appendChild(overlay);

  const onKey = onKeyFactory(overlay);
  open = { overlay, opener: anchor, hidden, hiddenPrev, onKey };

  document.addEventListener('keydown', onKey, true);
  closeBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    closeExpanded();
  });
  // Backdrop dismissal: a click that landed on the overlay itself, not on the
  // picture or a control inside it.
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeExpanded();
  });

  closeBtn.focus();
  return true;
}

/**
 * Upgrade every `expandable` image on the page into an in-page overlay.
 * Idempotent + client-only — call once after the first render/hydration; a
 * delegated listener covers everything mounted later.
 *
 * Nothing here is required for the reader to reach the asset: the anchor the
 * renderers emit is an ordinary link, and this only changes where the picture
 * opens.
 */
export function enhanceExpandable(): void {
  if (bound) return;
  bound = true;

  document.addEventListener('click', (ev) => {
    // Leave every deliberate "open elsewhere" gesture alone: a modified click
    // and a middle click are the reader asking the BROWSER to handle the link,
    // and an enhancement has no business overriding that.
    if (ev.defaultPrevented || ev.button !== 0) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

    const anchor = markedAnchor(ev.target);
    if (anchor === null) return;
    // An anchor inside the overlay is the escape hatch, not an expansion.
    if (open !== null && open.overlay.contains(anchor)) return;

    // Suppress the navigation ONLY once the overlay is really up.
    if (expand(anchor)) ev.preventDefault();
  });
}
