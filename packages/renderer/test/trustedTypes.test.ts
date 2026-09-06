// ============================================================================
//  Phase 1546 - the `fuaran-renderer` Trusted Types policy.
//
//  The TypeScript twin of the F# tier's `TrustedTypesTests`, pinning the same
//  three claims for the same reasons.
//
//   1. EVERY raw-HTML sink in `@fuaran-ui/renderer` and `@fuaran-ui/react` mints
//      through the policy. The oracle is the source itself rather than a list
//      kept beside it, so a sink added tomorrow is red on the commit that adds
//      it. The react package holds no sink of its own today, and that is
//      asserted rather than assumed: one appearing there is exactly the case a
//      list would miss.
//
//   2. The policy's floor is INVARIANT over the renderer's own payloads. The
//      floor is `sanitizeMarkdownHtml`, written for markdown and now running over
//      drawing SVG and MathML too, on every host whether or not the browser
//      enforces Trusted Types. That uniformity is what keeps a server-rendered
//      document and the client hydration over it byte-identical, and it only
//      holds while the floor finds nothing to remove in those payloads.
//
//   3. The floor still refuses what it always refused, including at the
//      tag-name boundary the same change narrowed: `<metadata>` is not `<meta>`.
// ============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { DrawingSpec, TextSource } from '@fuaran-ui/schema';

import { emptySources } from '../src/bindings.js';
import { drawingSvg } from '../src/drawingSvg.js';
import { mathMl } from '../src/mathMl.js';
import { toHtml } from '../src/markdown.js';
import {
  TRUSTED_TYPES_POLICY_NAME,
  createHtml,
  resetTrustedTypesPolicyForTests,
  trustedHtml,
} from '../src/trustedTypes.js';

const here = dirname(fileURLToPath(import.meta.url));
const rendererSrc = join(here, '..', 'src');
const reactSrc = join(here, '..', '..', 'react', 'src');

// ─── The seam scan ───────────────────────────────────────────────────────────

interface Sink {
  readonly file: string;
  readonly line: number;
  readonly value: string;
}

const sourceFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
    }
  };
  walk(root);
  return out.sort();
};

/** Is this occurrence inside a `//` or ` * ` comment? Both are common here. */
const inComment = (text: string, index: number): boolean => {
  const lineStart = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const before = text.slice(lineStart, index);
  return before.includes('//') || before.trimStart().startsWith('*');
};

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** The text after `from`, with separating whitespace removed. */
const valueAfter = (text: string, from: number): string =>
  text.slice(from).replace(/^\s+/, '').slice(0, 60);

/**
 * Every raw-HTML sink in a source tree. Two shapes reach a DOM sink from this
 * renderer: React's prop, whose value sits behind `__html:`, and a direct
 * `innerHTML` assignment.
 */
const scan = (root: string): Sink[] => {
  const sinks: Sink[] = [];
  for (const path of sourceFiles(root)) {
    const text = readFileSync(path, 'utf8');
    const file = relative(root, path).replace(/\\/g, '/');

    for (const match of text.matchAll(/dangerouslySetInnerHTML/g)) {
      const at = match.index;
      if (inComment(text, at)) continue;
      const html = text.indexOf('__html:', at);
      sinks.push({
        file,
        line: lineOf(text, at),
        value: html < 0 ? '<no __html found>' : valueAfter(text, html + '__html:'.length),
      });
    }

    for (const match of text.matchAll(/\.innerHTML\s*=(?!=)/g)) {
      const at = match.index;
      if (inComment(text, at)) continue;
      sinks.push({
        file,
        line: lineOf(text, at),
        value: valueAfter(text, at + match[0].length),
      });
    }
  }
  return sinks;
};

const rendererSinks = scan(rendererSrc);
const reactSinks = scan(reactSrc);

const describeSink = (s: Sink): string => `${s.file}:${s.line} -> ${s.value}`;

// ─── Payload fixtures, built from the real emitters ──────────────────────────

const literal = (value: string): TextSource => ({ kind: 'Literal', value });

/** Hostile strings in every author-supplied slot, so the escaping is exercised. */
const hostileDrawing: DrawingSpec = {
  viewBox: { minX: 0.0, minY: 0.0, width: 200.0, height: 100.0 },
  shapes: [],
  style: {},
  title: literal('Revenue & "growth" <script>alert(1)</script>'),
  description: literal("<meta http-equiv=refresh> and <link rel=stylesheet> '"),
};

const drawingPayload = drawingSvg(emptySources, hostileDrawing);

const mathPayload = mathMl('x^2 + y_1', 'Block');

const markdownPayload = toHtml(
  '# Heading <script>alert(1)</script>\n\nA [link](https://example.com) and `code` and one & another.\n\n- one\n- two\n',
);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Phase 1546 - every raw-HTML sink mints through the policy', () => {
  it('finds the sinks it is meant to govern', () => {
    // Non-vacuity. A scan that matched nothing would satisfy every assertion
    // below while proving nothing at all.
    expect(rendererSinks.length).toBeGreaterThanOrEqual(6);
    const files = [...new Set(rendererSinks.map((s) => s.file))];
    expect(files).toContain('render/Display.tsx');
    expect(files).toContain('render/Visualisation.tsx');
    expect(files).toContain('enhanceMath.ts');
  });

  it('routes every renderer sink through trustedHtml', () => {
    const unrouted = rendererSinks.filter((s) => !s.value.startsWith('trustedHtml('));
    expect(unrouted.map(describeSink)).toEqual([]);
  });

  it('leaves the react adapter with no raw-HTML sink of its own', () => {
    // The react package renders through @fuaran-ui/renderer and holds no sink.
    // Asserted rather than assumed: a sink appearing here would otherwise be the
    // one place the seam discipline had no reader.
    expect(reactSinks.map(describeSink)).toEqual([]);
  });
});

describe('Phase 1546 - the floor is invariant over the renderer own payloads', () => {
  it('leaves rendered markdown unchanged', () => {
    expect(createHtml(markdownPayload)).toBe(markdownPayload);
  });

  it('leaves drawing SVG unchanged', () => {
    expect(createHtml(drawingPayload)).toBe(drawingPayload);
  });

  it('leaves MathML unchanged', () => {
    expect(mathPayload).not.toBeNull();
    expect(createHtml(mathPayload as string)).toBe(mathPayload);
  });

  it('the markdown fixture really does exercise the escaping upstream', () => {
    // Non-vacuity for the markdown case: the floor rests on the GFM renderer
    // escaping raw HTML by construction, so the fixture must prove it did.
    expect(markdownPayload).not.toContain('<script');
    expect(markdownPayload).toContain('&lt;script');
  });
});

describe('Phase 1546 - the floor still refuses what it always refused', () => {
  it('strips a script element', () => {
    const clean = createHtml('<p>ok</p><script>alert(1)</script>');
    expect(clean).not.toContain('<script');
    expect(clean).toContain('<p>ok</p>');
  });

  it('strips a meta refresh', () => {
    const clean = createHtml('<meta http-equiv="refresh" content="0;url=//evil"><p>ok</p>');
    expect(clean).not.toContain('<meta ');
    expect(clean).toContain('<p>ok</p>');
  });

  it('strips an inline event handler', () => {
    expect(createHtml('<a href="#" onclick="alert(1)">x</a>')).not.toContain('onclick');
  });

  it('neutralises a javascript: URL', () => {
    const clean = createHtml('<a href="JaVaScRiPt:alert(1)">x</a>');
    expect(clean.toLowerCase()).not.toContain('javascript:');
    expect(clean).toContain('about:blank');
  });
});

describe('Phase 1546 - a dangerous element name matches only at a tag-name boundary', () => {
  it('leaves an SVG metadata element intact', () => {
    // `<metadata>` is not `<meta>`. Before Phase 1546 the sweep stripped its
    // opening tag, which mattered the moment this floor started running over SVG.
    const svg = '<svg><metadata data-fuaran-provenance="v1">{"a":1}</metadata><rect /></svg>';
    expect(createHtml(svg)).toBe(svg);
  });

  it('leaves an SVG linearGradient element intact', () => {
    const svg = '<svg><defs><linearGradient id="g"><stop /></linearGradient></defs></svg>';
    expect(createHtml(svg)).toBe(svg);
  });

  it('admits no real dangerous element', () => {
    // The go-red half: each spelling below IS the element, so each must still be
    // refused. A boundary rule that let any through would be a weakening.
    for (const payload of [
      '<meta http-equiv=refresh>',
      '<meta/>',
      '<link rel=stylesheet href=evil>',
      '<script>x</script>',
      '<script\n>x</script>',
      '<iframe src=evil></iframe>',
    ]) {
      const clean = createHtml(payload);
      expect(clean).not.toContain('<meta');
      expect(clean).not.toContain('<link');
      expect(clean).not.toContain('<script');
      expect(clean).not.toContain('<iframe');
    }
  });

  it('still strips a truncated open tag at end of input', () => {
    expect(createHtml('<p>ok</p><script')).not.toContain('<script');
  });
});

describe('Phase 1546 - the policy handle', () => {
  const factoryHolder = globalThis as { trustedTypes?: unknown };

  it('names the policy a host pins in its trusted-types directive', () => {
    expect(TRUSTED_TYPES_POLICY_NAME).toBe('fuaran-renderer');
  });

  it('falls back to the floor alone where the API is absent', () => {
    resetTrustedTypesPolicyForTests();
    delete factoryHolder.trustedTypes;
    expect(trustedHtml(drawingPayload)).toBe(createHtml(drawingPayload));
  });

  it('mints through the policy where the API is present', () => {
    const minted: string[] = [];
    const names: string[] = [];
    factoryHolder.trustedTypes = {
      createPolicy: (name: string, rules: { createHTML(input: string): string }) => {
        names.push(name);
        return {
          createHTML: (input: string) => {
            minted.push(input);
            return rules.createHTML(input);
          },
        };
      },
    };
    try {
      resetTrustedTypesPolicyForTests();
      const out = trustedHtml('<p>ok</p><script>alert(1)</script>');

      expect(names).toEqual([TRUSTED_TYPES_POLICY_NAME]);
      expect(minted).toEqual(['<p>ok</p><script>alert(1)</script>']);
      // The policy's own rule is what sanitised it, not a second call beside it.
      expect(out).not.toContain('<script');

      // The handle is memoised: a repeat createPolicy under the same name throws
      // unless the host allows duplicates, so calling twice must not create twice.
      trustedHtml('<p>again</p>');
      expect(names).toEqual([TRUSTED_TYPES_POLICY_NAME]);
    } finally {
      delete factoryHolder.trustedTypes;
      resetTrustedTypesPolicyForTests();
    }
  });

  it('falls back to the floor when the host directive does not name the policy', () => {
    factoryHolder.trustedTypes = {
      createPolicy: () => {
        throw new TypeError('refused by the trusted-types directive');
      },
    };
    try {
      resetTrustedTypesPolicyForTests();
      const out = trustedHtml('<p>ok</p><script>alert(1)</script>');
      expect(out).not.toContain('<script');
      expect(out).toContain('<p>ok</p>');
    } finally {
      delete factoryHolder.trustedTypes;
      resetTrustedTypesPolicyForTests();
    }
  });
});
