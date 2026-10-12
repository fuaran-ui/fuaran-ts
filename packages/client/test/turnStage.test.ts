// Phase 2134 — the turn stage keeps an unknown label distinct from a terminal one.
//
// THE PARITY TABLE. `fuaran-dotnet/src/Fuaran.UI.Client.Tests/TurnStageTests.fs`
// carries the same rows, in the same order, against `TurnStage.ofLabel` /
// `TurnStage.label` / `Repair.isRepairable`. The two clients live in separate
// repositories, so the table is held twice; a row changed in one is changed in
// the other in the same change-set, or the hosts stop agreeing on what a refusal
// means.
//
// Each row: the label the endpoint sent, the stage label the client reads it as,
// whether that stage is one of the four the client knows, and whether the repair
// loop retries it.

import { describe, expect, it } from 'vitest';

import { isKnownTurnStage, isRepairable, parseTurnResponse, type TurnStage } from '../src/index.js';

const STAGE_TABLE: ReadonlyArray<readonly [string, string, boolean, boolean]> = [
  // The canonical labels.
  ['access-token', 'access-token', true, false],
  ['provider', 'provider', true, false],
  ['parse', 'parse', true, true],
  ['apply', 'apply', true, true],
  // The retired PascalCase spellings.
  ['AccessToken', 'access-token', true, false],
  ['Provider', 'provider', true, false],
  ['Parse', 'parse', true, true],
  ['Apply', 'apply', true, true],
  // Case, `-`, `_` and ASCII whitespace are ignored.
  ['ACCESS_TOKEN', 'access-token', true, false],
  [' apply\t', 'apply', true, true],
  // Unknown: kept exactly as sent, never read as a known stage, never retried.
  ['validate', 'validate', false, false],
  ['Telepathy', 'Telepathy', false, false],
  ['unknown', 'unknown', false, false],
  ['', '', false, false],
  ['   ', '   ', false, false],
  ['parse ', 'parse ', false, false],
];

const refusal = (stage: unknown): string =>
  JSON.stringify({ error: { stage, code: 'C', message: 'm' } });

function stageOf(status: number, body: string): TurnStage {
  const result = parseTurnResponse(status, body);
  if (result.kind !== 'turnFailed') {
    throw new Error(`expected turnFailed, got ${result.kind}`);
  }
  return result.error.stage;
}

describe('the turn-stage parity table', () => {
  it.each(STAGE_TABLE)(
    'reads %j as %j (known %s, repairable %s)',
    (sent, read, known, repairable) => {
      for (const status of [422, 500]) {
        const stage = stageOf(status, refusal(sent));
        expect(stage).toBe(read);
        expect(isKnownTurnStage(stage)).toBe(known);
        expect(isRepairable(stage)).toBe(repairable);
      }
    },
  );

  it('never reads an unknown label as provider', () => {
    for (const [sent, , known] of STAGE_TABLE) {
      if (!known) {
        expect(stageOf(422, refusal(sent))).not.toBe('provider');
      }
    }
  });
});

describe('an absent stage is not a label', () => {
  it('keeps the provider fallback when the envelope names no stage, or a non-string one', () => {
    for (const body of [JSON.stringify({ error: {} }), refusal(7), refusal(null), '']) {
      expect(stageOf(422, body)).toBe('provider');
    }
  });
});

describe('isKnownTurnStage', () => {
  it('admits the four canonical labels only — a retired spelling built by hand is not one', () => {
    expect(['access-token', 'provider', 'parse', 'apply'].every(isKnownTurnStage)).toBe(true);
    expect(isKnownTurnStage('Apply')).toBe(false);
    expect(isRepairable('Apply')).toBe(false);
  });
});
