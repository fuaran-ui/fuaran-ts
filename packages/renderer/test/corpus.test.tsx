// ============================================================================
//  Fixture-corpus visual round-trip.
//
//  For every node fixture in the workspace wire-format-fixtures corpus: decode
//  via @fuaran-ui/ops, render via <FuaranRenderer>, and assert the rendered
//  HTML is non-empty, carries the addressable-element marker, and matches the
//  committed snapshot (the rendered-output expectation — the floor; Playwright
//  visual-diff is a future TIDY-UP per Phase 77). A representative subset also
//  pins specific F#-parity class names.
// ============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';

import { FuaranRenderer, permissiveEgress } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/renderer/test → workspace-root/wire-format-fixtures
const nodesDir = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'nodes');

const fixtureFiles = readdirSync(nodesDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

/**
 * Render for THIS corpus (Phase 1037).
 *
 * The corpus asks a question about the class + ARIA vocabulary, so it renders
 * under a policy that admits every destination. That is not a weakening: the
 * ambient default-deny has its own dedicated corpus in `egressAmbient.test.tsx`,
 * and leaving it switched on here would mean a class-name regression and an
 * egress-policy change produced the same failure output — a corpus that cannot
 * say which of two things broke is worth much less than two that can.
 *
 * `link-protected-1.json` is a `mailto:` link, which the DEFAULT policy refuses
 * (`allowNonNetwork: false`); rendering under `permissiveEgress` is what keeps
 * it testing the anchor shape rather than the policy. Mirrors the F# SSR parity
 * corpus's `renderHtml`, which made the identical call for the identical reason.
 */
const renderFixture = (file: string): string => {
  const json = readFileSync(join(nodesDir, file), 'utf8');
  const decoded = decodeNode(json);
  if (!decoded.ok) throw new Error(`decode failed for ${file}: ${JSON.stringify(decoded.error)}`);
  return renderToStaticMarkup(
    <FuaranRenderer tree={decoded.value} egressPolicy={permissiveEgress} />,
  );
};

describe('fixture-corpus — decode + render every node fixture', () => {
  it('has fixtures to render', () => {
    expect(fixtureFiles.length).toBeGreaterThan(20);
  });

  it.each(fixtureFiles)('%s renders to a non-empty DOM tree', (file) => {
    const html = renderFixture(file);
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('data-fuaran-node-id');
    expect(html).toMatch(/class="fuaran-/);
  });

  it.each(fixtureFiles)('%s matches its rendered-output snapshot', (file) => {
    expect(renderFixture(file)).toMatchSnapshot();
  });
});

describe('class-name parity — representative subset pins F# class names', () => {
  const expectations: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['badge-1.json', ['fuaran-kind-badge', 'fuaran-badge fuaran-badge-']],
    ['btn-1.json', ['fuaran-kind-button', 'fuaran-button fuaran-button-']],
    ['metric-1.json', ['fuaran-kind-metric', 'fuaran-metric-label', 'fuaran-metric-value']],
    ['heading-1.json', ['fuaran-kind-heading', 'fuaran-heading']],
    ['stack-1.json', ['fuaran-kind-stack', 'fuaran-layout-stack']],
    ['tabs-1.json', ['fuaran-layout-tabs', 'role="tablist"', 'role="tab"', 'role="tabpanel"']],
    ['discl-1.json', ['fuaran-layout-disclosure', 'fuaran-disclosure-summary']],
    ['progress-1.json', ['fuaran-progress', 'fuaran-progress-bar', 'fuaran-progress-fill']],
    ['form-1.json', ['fuaran-form', 'fuaran-form-field', 'fuaran-form-submit']],
    ['callout-1.json', ['fuaran-callout', 'fuaran-callout-body']],
    // grid-1's source is a Query binding; under empty test sources it resolves
    // to no rows, so only the header row renders (data cells need rows).
    ['grid-1.json', ['fuaran-grid', 'fuaran-grid-header']],
    ['table-1.json', ['fuaran-table', 'fuaran-table-header']],
  ];

  it.each(expectations)('%s emits the expected class names', (file, fragments) => {
    const html = renderFixture(file);
    for (const fragment of fragments) expect(html).toContain(fragment);
  });
});

describe('node-level wrapper contract', () => {
  it('emits id, data-fuaran-node-id, and the fuaran-node style class on the wrapper', () => {
    const html = renderFixture('badge-1.json');
    expect(html).toMatch(/<div[^>]*data-fuaran-node-id="[^"]+"/);
    expect(html).toContain('fuaran-node');
    expect(html).toContain('fuaran-tone-');
    expect(html).toContain('fuaran-weight-');
    expect(html).toContain('fuaran-emphasis-');
  });
});
