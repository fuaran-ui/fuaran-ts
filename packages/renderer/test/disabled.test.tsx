// ============================================================================
//  Phase 129 / 130 — bindable disabled-state render assertion.
//
//  The corpus snapshot covers each interactive fixture in its *default* state
//  (the disabled binding resolves to its `defaultValue`, false). This focused
//  test pins *both* ends of the contract per spec: the resolved boolean
//  projects onto the native HTML `disabled` attribute — present when the bound
//  state is true, absent when false — mirroring the F# renderer's
//  `prop.disabled` emission so both hosts render the same DOM.
//
//  Each fixture binds `disabled` to a distinct state key (see
//  wire-format-fixtures/nodes/*.json):
//    btn-1    → "loading"      (ButtonSpec.disabled, Phase 129)
//    select-1 → "selectBusy"   (SelectSpec.disabled, Phase 130)
//    upload-1 → "uploadBusy"   (FileUploadSpec.disabled, Phase 130)
//    form-1   → "formBusy"     (FormSpec.disabled, Phase 130 — <fieldset disabled>)
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';

import { FuaranRenderer } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const nodesDir = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'nodes');

const renderFixtureWithState = (fixture: string, stateKey: string, value: boolean): string => {
  const decoded = decodeNode(readFileSync(join(nodesDir, fixture), 'utf8'));
  if (!decoded.ok) throw new Error(`decode failed for ${fixture}`);
  return renderToStaticMarkup(
    <FuaranRenderer tree={decoded.value} sources={{ state: { [stateKey]: value } }} />,
  );
};

// Match the rendered boolean attribute (`disabled=""`), not the bare substring
// — some fixture ids could contain the word "disabled".
const DISABLED_ATTR = 'disabled=""';

// fixture id → the state key its `disabled` binding reads.
const cases: ReadonlyArray<readonly [string, string, string]> = [
  ['btn-1.json', 'loading', 'ButtonSpec.disabled (Phase 129)'],
  ['select-1.json', 'selectBusy', 'SelectSpec.disabled (Phase 130)'],
  ['upload-1.json', 'uploadBusy', 'FileUploadSpec.disabled (Phase 130)'],
  ['form-1.json', 'formBusy', 'FormSpec.disabled (Phase 130, <fieldset disabled>)'],
];

describe('bindable disabled-state — both ends pinned per interactive spec', () => {
  for (const [fixture, stateKey, label] of cases) {
    it(`emits the disabled attribute for ${label} when ${stateKey} resolves true`, () => {
      expect(renderFixtureWithState(fixture, stateKey, true)).toContain(DISABLED_ATTR);
    });

    it(`omits the disabled attribute for ${label} when ${stateKey} resolves false`, () => {
      expect(renderFixtureWithState(fixture, stateKey, false)).not.toContain(DISABLED_ATTR);
    });
  }
});
