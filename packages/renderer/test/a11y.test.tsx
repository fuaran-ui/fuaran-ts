// ============================================================================
//  Accessibility audit (Phase 12.I discipline).
//
//  Renders a representative fixture sample, mounts the HTML into the jsdom
//  document, and runs axe-core. Asserts no violation at/above the contract's
//  severity threshold.
//
//  The disabled-rule set + severity threshold are NOT hard-coded here — they
//  are read from the canonical a11y contract in the shared wire-format-fixtures
//  corpus (`wire-format-fixtures/a11y-contract.json`), the single source of
//  truth shared with the F# accessibility release gate. One a11y contract, not
//  two: the F# gate and this suite read the same file and cannot drift (Phase
//  103 TIDY-UP — hardened from operator discipline to a literal shared read).
//  The contract disables `color-contrast` (it needs real layout/canvas metrics
//  jsdom cannot provide — a Playwright concern).
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import axe from 'axe-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';

import { FuaranRenderer } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// Both the fixture corpus and the a11y contract live under the workspace root,
// four levels up from this test file (test → renderer → packages → fuaran-ts).
const workspaceRoot = join(here, '..', '..', '..', '..');
const nodesDir = join(workspaceRoot, 'wire-format-fixtures', 'nodes');

// Canonical a11y contract — the single source of truth shared with the F#
// accessibility release gate, read from the shared wire-format-fixtures corpus
// (disabledRules → axe rule overrides; severityThreshold → the impact set the
// suite fails on).
const contract = JSON.parse(
  readFileSync(join(workspaceRoot, 'wire-format-fixtures', 'a11y-contract.json'), 'utf8'),
);

const axeRules: Record<string, { enabled: false }> = {};
for (const ruleId of Object.keys(contract.disabledRules ?? {})) {
  axeRules[ruleId] = { enabled: false };
}
const severityThreshold = new Set<string>(contract.severityThreshold ?? ['critical', 'serious']);

const renderFixture = (file: string): string => {
  const decoded = decodeNode(readFileSync(join(nodesDir, file), 'utf8'));
  if (!decoded.ok) throw new Error(`decode failed for ${file}`);
  return renderToStaticMarkup(<FuaranRenderer tree={decoded.value} />);
};

const sample = [
  'composite-root.json',
  'form-1.json',
  'tabs-1.json',
  'tabs-explicit-1.json',
  'btn-1.json',
  'callout-1.json',
  'discl-1.json',
];

/** The rule ids violated at/above the contract's severity threshold. */
const violationIdsOf = async (markup: string): Promise<string[]> => {
  document.body.innerHTML = `<main>${markup}</main>`;
  const results = await axe.run(document.body, { rules: axeRules });
  return results.violations
    .filter((v) => v.impact != null && severityThreshold.has(v.impact))
    .map((v) => v.id)
    .sort();
};

describe('accessibility — axe-core on a representative fixture sample', () => {
  it.each(sample)('%s has no critical/serious accessibility violations', async (file) => {
    const serious = await violationIdsOf(renderFixture(file));
    if (serious.length > 0) {
      // Surface the rule ids so a failure is actionable.
      throw new Error(`axe violations in ${file}: ${serious.join(', ')}`);
    }
    expect(serious).toHaveLength(0);
  });
});

// ============================================================================
//  Phase 958 — the axe leg reads the ACCESSIBILITY-TRAIT fixture family.
//
//  The sample above predates the trait family entirely: every `role` it renders
//  is a `BoxSpec` role, so the six `Accessibility` slots were audited nowhere.
//  That is not a small hole — it is precisely why the gate stayed silent while
//  the projection landed on the wrong element for months (Phase 951): the gate
//  was working, its input was blind. The Phase 955 family is the input.
//
//  The expectation is a per-fixture verdict rather than a blanket "no
//  violations", and the assertion is EQUALITY rather than emptiness, so the pin
//  bites in both directions: a new violation reds the leg, and so does an
//  EXPECTED one disappearing.
//
//  One fixture expects a violation, deliberately. `a11y-wrapper-state-bound`
//  carries the custom role `doc-pageFooter` — mixed case on purpose, because
//  ARIA role tokens are case-SENSITIVE and a host that folds them is the exact
//  defect that fixture exists to catch. axe is right that no such role exists
//  (the DPUB token is `doc-pagefooter`), and the renderer is right to carry the
//  author's spelling through untouched. Pinning `aria-roles` here is therefore
//  a second, independent witness for the fold bug: a host that lower-cased the
//  role would emit a VALID one, the violation would vanish, and this assertion
//  would fail.
// ============================================================================

/** The Phase 955 trait-bearing family, with each fixture's expected verdict. */
const traitFamily: ReadonlyArray<readonly [file: string, expected: readonly string[]]> = [
  ['a11y-wrapper-all-slots.json', []],
  // The deliberately mixed-case custom role — see the block comment above.
  ['a11y-wrapper-state-bound.json', ['aria-roles']],
  ['a11y-alert-assertive.json', []],
  ['a11y-link-labelled.json', []],
  ['a11y-button-named.json', []],
  ['a11y-image-decorative.json', []],
];

describe('Phase 958 — axe-core over the Phase 955 accessibility-trait family', () => {
  it.each(traitFamily.map(([file, expected]) => [file, expected] as const))(
    '%s matches its pinned axe verdict',
    async (file, expected) => {
      expect(await violationIdsOf(renderFixture(file))).toEqual([...expected]);
    },
  );

  // A table-driven leg that silently enumerated nothing would be a gate that
  // checked nothing.
  it('covers the full Phase 955 node family', () => {
    expect(traitFamily).toHaveLength(6);
  });

  // ── The two Phase 951 verdicts, pinned FROM THE CORPUS ────────────────────
  //
  // `a11yPlacement.test.tsx` already pins both against hand-built nodes and a
  // hand-written pre-fix literal — this tier measured against this tier. These
  // two derive the same verdicts from the shared fixture the whole estate
  // answers to, so the witness moves when the corpus moves.
  //
  // The pre-fix shape is RECONSTRUCTED from the rendered fixture rather than
  // written out: the projection is lifted off the semantic element and put back
  // on the wrapper, which is exactly the emission the renderers used to
  // produce. A literal would keep passing after the fixture changed underneath
  // it.
  const preFixPlacement = (markup: string, tag: string): string => {
    const at = markup.indexOf(`<${tag}`);
    if (at < 0) throw new Error(`no <${tag}> in the rendered fixture`);
    const end = markup.indexOf('>', at) + 1;
    const semanticTag = markup.slice(at, end);

    const projected = [...semanticTag.matchAll(/\s(?:role|aria-[a-z-]+)="[^"]*"/g)].map(
      (m) => m[0],
    );
    if (projected.length === 0) {
      throw new Error(`nothing to move: the projection is not on the <${tag}> — ${semanticTag}`);
    }

    const stripped = projected.reduce((t, p) => t.replace(p, ''), semanticTag);
    const wrapperEnd = markup.indexOf('>') + 1;
    const wrapper = `${markup.slice(0, wrapperEnd - 1)}${projected.join('')}>`;
    return wrapper + markup.slice(wrapperEnd, at) + stripped + markup.slice(end);
  };

  it('the fixed Button placement is clean; the reconstructed pre-fix one is nested-interactive', async () => {
    const markup = renderFixture('a11y-button-named.json');

    // Verdict 1 — the shipped placement, from the corpus fixture.
    expect(await violationIdsOf(markup)).toEqual([]);

    // Verdict 2 — the go-red witness. `role="button"` on a <div> wrapping a
    // <button> announces two interactive elements where the author declared
    // one, and axe calls that serious.
    expect(await violationIdsOf(preFixPlacement(markup, 'button'))).toContain('nested-interactive');
  });

  // The other half of Phase 951's measured verdict, and the reason the
  // placement tests exist at all: moving the projection off the <a> is NOT an
  // axe violation at any severity, because the resulting shape is still legal
  // HTML. So an all-green axe run is evidence about severity, never about
  // placement — and this leg says so out loud rather than leaving a reader to
  // infer that green means correct.
  it('the reconstructed pre-fix Link placement is invisible to axe — the gate has a floor', async () => {
    const markup = renderFixture('a11y-link-labelled.json');
    expect(await violationIdsOf(preFixPlacement(markup, 'a'))).toEqual([]);
  });
});
