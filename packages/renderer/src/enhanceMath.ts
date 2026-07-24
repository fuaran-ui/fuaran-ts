// Client-only post-hydration KaTeX math enhancement (Phase 293).
//
// The renderers emit DETERMINISTIC output that is byte-identical across all hosts
// + SSR (Phase 658): a `Math` node → a `.fuaran-math-block` / `.fuaran-math-inline`
// container holding native MathML for the closed LaTeX subset (real superscripts,
// no JS) or a `<span class="fuaran-math-source">` (raw escaped source) for
// out-of-subset input, with the original LaTeX in `data-fuaran-math-src`; rendered
// markdown leaves inline `$…$` / `$$…$$` as literal text. That deterministic output
// is the ONLY thing the cross-host + SSR↔CSR parity gate compares.
//
// `enhanceMath` is the **separate, opt-in, client-only** layer that upgrades that
// output IN PLACE after hydration — it KaTeX-renders the `.fuaran-math` containers
// (reading the LaTeX from `data-fuaran-math-src`) and the inline `$…$` spans in
// rendered markdown. Because it runs after
// hydration and is never part of any renderer's output, it can never cause a
// hydration mismatch or a cross-host divergence; KaTeX is a client dependency,
// not a parity-path one. It is idempotent (a processed node is marked with
// `data-fuaran-math-done`) so it is safe to call after every render.
//
// Hosts must also load KaTeX's stylesheet once (`import 'katex/dist/katex.min.css'`).
import katex from 'katex';

const DONE_ATTR = 'data-fuaran-math-done';

// Phase 658 — the deterministic Math container carries the original LaTeX in
// `data-fuaran-math-src` (its content is native MathML for in-subset input,
// whose text is NOT valid LaTeX, or the raw-source span otherwise).
const SRC_ATTR = 'data-fuaran-math-src';

/** Tags whose text content is verbatim and must never be scanned for `$…$`. */
const SKIP_TAGS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']);

interface RenderOpts {
  readonly displayMode: boolean;
}

function renderTo(el: Element, tex: string, opts: RenderOpts): void {
  try {
    el.innerHTML = katex.renderToString(tex, {
      displayMode: opts.displayMode,
      throwOnError: false,
      output: 'htmlAndMathml',
    });
  } catch {
    // Leave the deterministic source fallback untouched on any failure — the
    // reader still sees the raw LaTeX, never a blank.
  }
}

/**
 * Upgrade the explicit `Math` nodes (Phase 658: the `.fuaran-math` CONTAINER,
 * MathML or source variant alike). Reads the LaTeX from `data-fuaran-math-src`
 * (falling back to `textContent`) and replaces the container content wholesale
 * with KaTeX output.
 *
 * Idempotence is CONTENT-AWARE, not marker-alone: React can restore the
 * deterministic children while the imperatively-set `DONE_ATTR` survives on the
 * same element, leaving a marked container with no KaTeX inside. A container
 * counts as done only when the KaTeX output is actually present; the marker
 * remains as a tie-breaker for the failure path (render caught – deterministic
 * content kept). Mirrors the F# `MathEnhance` twin exactly.
 */
function enhanceMathNodes(root: ParentNode): void {
  const nodes = root.querySelectorAll<HTMLElement>('.fuaran-math');
  nodes.forEach((el) => {
    if (el.querySelector('.katex') !== null) return;
    const tex = el.getAttribute(SRC_ATTR) ?? el.textContent ?? '';
    const displayMode = el.classList.contains('fuaran-math-block');
    renderTo(el, tex, { displayMode });
    el.setAttribute(DONE_ATTR, '');
  });
}

type Segment = { readonly kind: 'text' | 'inline' | 'display'; readonly value: string };

/**
 * Split a text run into literal-text / inline-`$…$` / display-`$$…$$` segments.
 * `\$` is a literal dollar. A `$`/`$$` with no non-empty closing delimiter stays
 * literal text (the conservative CommonMark-ish reading).
 */
export function parseMathSegments(input: string): Segment[] {
  const segments: Segment[] = [];
  let buffer = '';
  let i = 0;

  const flushText = (): void => {
    if (buffer.length > 0) {
      segments.push({ kind: 'text', value: buffer });
      buffer = '';
    }
  };

  while (i < input.length) {
    // `charAt` returns '' past the end — avoids `noUncheckedIndexedAccess`
    // `string | undefined` noise while reading single chars.
    const ch = input.charAt(i);

    if (ch === '\\' && input.charAt(i + 1) === '$') {
      buffer += '$';
      i += 2;
      continue;
    }

    if (ch === '$') {
      const display = input.charAt(i + 1) === '$';
      const delimLen = display ? 2 : 1;
      const start = i + delimLen;
      let j = start;
      let close = -1;
      while (j < input.length) {
        if (input.charAt(j) === '\\') {
          j += 2;
          continue;
        }
        if (
          display ? input.charAt(j) === '$' && input.charAt(j + 1) === '$' : input.charAt(j) === '$'
        ) {
          close = j;
          break;
        }
        j += 1;
      }
      if (close > start) {
        flushText();
        segments.push({ kind: display ? 'display' : 'inline', value: input.slice(start, close) });
        i = close + delimLen;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }

  flushText();
  return segments;
}

function enhanceTextNode(node: Text): void {
  const raw = node.nodeValue ?? '';
  if (!raw.includes('$')) return;

  const segments = parseMathSegments(raw);
  if (segments.length === 1 && segments[0]?.kind === 'text') return;

  const doc = node.ownerDocument ?? document;
  const fragment = doc.createDocumentFragment();

  for (const seg of segments) {
    if (seg.kind === 'text') {
      fragment.appendChild(doc.createTextNode(seg.value));
      continue;
    }
    const display = seg.kind === 'display';
    const span = doc.createElement('span');
    span.className = display ? 'fuaran-math fuaran-math-block' : 'fuaran-math fuaran-math-inline';
    span.setAttribute('data-math-display', display ? 'block' : 'inline');
    span.setAttribute(DONE_ATTR, '');
    renderTo(span, seg.value, { displayMode: display });
    fragment.appendChild(span);
  }

  node.parentNode?.replaceChild(fragment, node);
}

/**
 * Upgrade inline `$…$` / `$$…$$` spans inside rendered-markdown blocks. Same
 * content-aware idempotence as the Math containers: a done-marked block whose
 * KaTeX spans were wiped by a React restore (no `.katex` inside, but `$` text
 * back in the DOM) is re-scanned; a done-marked block whose enhancement
 * survived – or that never had math – is skipped.
 */
function enhanceMarkdownInline(root: ParentNode): void {
  const blocks = root.querySelectorAll<HTMLElement>('.fuaran-markdown');
  blocks.forEach((block) => {
    if (block.getAttribute(DONE_ATTR) !== null) {
      const restored =
        block.querySelector('.katex') === null && (block.textContent ?? '').includes('$');
      if (!restored) return;
    }
    const doc = block.ownerDocument ?? document;
    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node): number {
        let parent = node.parentElement;
        while (parent !== null && parent !== block) {
          if (SKIP_TAGS.has(parent.tagName) || parent.classList.contains('katex')) {
            return NodeFilter.FILTER_REJECT;
          }
          parent = parent.parentElement;
        }
        return (node.nodeValue ?? '').includes('$')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    const targets: Text[] = [];
    let current = walker.nextNode();
    while (current !== null) {
      targets.push(current as Text);
      current = walker.nextNode();
    }
    targets.forEach(enhanceTextNode);
    block.setAttribute(DONE_ATTR, '');
  });
}

/**
 * KaTeX-render the deterministic math fallback in `root` (default: `document`).
 * Idempotent + client-only — call once after each (re)render/hydration. Hosts
 * must also load `katex/dist/katex.min.css`.
 */
export function enhanceMath(root: ParentNode = document): void {
  enhanceMathNodes(root);
  enhanceMarkdownInline(root);
}
