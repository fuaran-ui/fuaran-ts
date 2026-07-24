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

describe('accessibility — axe-core on a representative fixture sample', () => {
  it.each(sample)('%s has no critical/serious accessibility violations', async (file) => {
    document.body.innerHTML = `<main>${renderFixture(file)}</main>`;
    const results = await axe.run(document.body, { rules: axeRules });
    const serious = results.violations.filter(
      (v) => v.impact != null && severityThreshold.has(v.impact),
    );
    if (serious.length > 0) {
      // Surface the rule ids so a failure is actionable.
      throw new Error(
        `axe violations in ${file}: ${serious.map((v) => `${v.id} (${v.impact})`).join(', ')}`,
      );
    }
    expect(serious).toHaveLength(0);
  });
});
