// ============================================================================
//  The WIRE half of `Binding.Local`, and the decoded `Binding.Computed`
//  (WIRE_FORMAT.md Section 3.3.3).
//
//  The corpus fixture `nodes/form-local-debounce.json` carries three
//  `"<closure>"` sentinels, and they used to restore to nothing usable: a
//  `format` that was absent (so the renderer fell back to `String(v)`), a
//  `parse` that ALWAYS returned an error, and a no-op `onCommit`. A
//  wire-authored debounced input could not round-trip a single keystroke.
//
//  Every assertion here is written to fail on that restore. The identity tests
//  fail because `parse` used to answer `{ ok: false }` for every input; the
//  codec tests fail because there was no codec; the `Computed` test fails
//  because the old stand-in returned `undefined` and the resolver reported it
//  as RESOLVED — a wrong answer indistinguishable at the slot from a right one.
// ============================================================================

import type { Binding, LocalBinding } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '../src/index.js';
import {
  DECODED_COMPUTED_MESSAGE,
  fixedText,
  identityFormat,
  tryNumberText,
} from '../src/localCodec.js';

const debounceFixture =
  '{"id":"form-local-debounce","kind":{"$type":"Form","fields":[{"id":"email-input","kind":{"$type":"Text","onChange":"<closure>","value":{"$type":"Local","flushOn":{"$type":"OnDebounce","milliseconds":250},"format":"<closure>","initialFrom":{"$type":"Static","value":"draft@example.com"},"onCommit":"<closure>","parse":"<closure>"}},"label":"Email","required":true}],"onSubmit":{"$type":"Chain","ops":[]},"submitLabel":"Save"}}';

const declaredFixture =
  '{"id":"form-local-declared","kind":{"$type":"Form","fields":[{"id":"unit-price","kind":{"$type":"Number","value":{"$type":"Local","codec":{"$type":"Number","decimals":2},"commitTo":"order.unitPrice","flushOn":{"$type":"OnBlur"},"format":"<closure>","initialFrom":{"$type":"State","defaultValue":0,"key":"order.unitPrice"},"parse":"<closure>"}},"label":"Unit price","required":false}],"onSubmit":{"$type":"Chain","ops":[]},"submitLabel":"Save"}}';

const currencyCodecFixture =
  '{"id":"f","kind":{"$type":"Form","fields":[{"id":"amount","kind":{"$type":"Number","value":{"$type":"Local","codec":{"$type":"Currency","isoCode":"GBP"},"commitTo":"order.amount","flushOn":{"$type":"OnBlur"},"format":"<closure>","initialFrom":{"$type":"State","defaultValue":0,"key":"order.amount"},"parse":"<closure>"}},"label":"Amount","required":false}],"onSubmit":{"$type":"Chain","ops":[]},"submitLabel":"Save"}}';

const bothDestinationsFixture =
  '{"id":"f","kind":{"$type":"Form","fields":[{"id":"email","kind":{"$type":"Text","value":{"$type":"Local","commitTo":"form.email","flushOn":{"$type":"OnBlur"},"format":"<closure>","initialFrom":{"$type":"Static","value":"a@b.c"},"onCommit":"<closure>","parse":"<closure>"}},"label":"Email","required":false}],"onSubmit":{"$type":"Chain","ops":[]},"submitLabel":"Save"}}';

/**
 * The first binding of `tag` anywhere in a decoded tree.
 *
 * Written as a walk rather than as a path through the node envelope on purpose:
 * this suite is about what a BINDING decodes to, and threading it through the
 * form/field/kind envelope would make the test fail for envelope reasons and
 * read as a binding failure.
 */
const findBinding = (json: string, tag: string): Record<string, unknown> => {
  const r = decodeNode(json);
  if (!r.ok) throw new Error(`decode failed: ${r.error.code} at ${r.error.path}`);
  const seen: Record<string, unknown>[] = [];
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    const o = v as Record<string, unknown>;
    if (o['kind'] === tag) seen.push(o);
    for (const x of Object.values(o)) walk(x);
  };
  walk(r.value);
  const first = seen[0];
  if (first === undefined) throw new Error(`no ${tag} binding in the decoded tree`);
  return first;
};

const localOf = (json: string): LocalBinding<unknown> =>
  findBinding(json, 'Local')['local'] as LocalBinding<unknown>;

describe('Binding.Local on the wire', () => {
  it('round-trips its value through format and parse — the fixture own shape', () => {
    const local = localOf(debounceFixture);
    expect(local.format?.('draft@example.com')).toBe('draft@example.com');
    expect(local.parse('draft@example.com')).toEqual({ ok: true, value: 'draft@example.com' });
    // The fixture declares an onCommit closure and no declared destination.
    expect(local.onCommit).toBeTypeOf('function');
    expect(local.codec).toBeUndefined();
    expect(local.commitTo).toBeUndefined();
  });

  it('parses at the slot own type, not at a type this host guessed', () => {
    const local = localOf(declaredFixture);
    // The numeric slot reads a number; the codec's inverse is the JSON number
    // grammar, so the reader's full precision survives the way in.
    expect(local.parse('3.14159')).toEqual({ ok: true, value: 3.14159 });
    expect(local.parse('1,234').ok).toBe(false);
    expect(local.parse('not a number').ok).toBe(false);
  });

  it('renders through the declared codec, and the inverse is exact on its own text', () => {
    const local = localOf(declaredFixture);
    expect(local.codec).toEqual({ kind: 'Number', decimals: 2 });
    expect(local.commitTo).toBe('order.unitPrice');
    // Mutually exclusive on the wire: a declared destination excludes the closure.
    expect(local.onCommit).toBeUndefined();

    expect(local.format?.(3.14159)).toBe('3.14');
    expect(local.format?.(12)).toBe('12.00');
    expect(local.format?.(-0.001)).toBe('0.00');
    expect(local.parse(local.format?.(3.14159) ?? '')).toEqual({ ok: true, value: 3.14 });
  });

  it('refuses a codec case with no total inverse, at the codec own path', () => {
    const r = decodeNode(currencyCodecFixture);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('WRONG_TYPE');
      expect(r.error.path).toBe('$.kind.fields[0].kind.value.codec');
    }
    // The go-red half: a decoder refusing EVERY codec would pass the above.
    expect(decodeNode(declaredFixture).ok).toBe(true);
  });

  it('refuses two commit destinations, at the commitTo path', () => {
    const r = decodeNode(bothDestinationsFixture);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('WRONG_TYPE');
      expect(r.error.path).toBe('$.kind.fields[0].kind.value.commitTo');
    }
    // Either one ALONE decodes — the refusal is the pair.
    expect(decodeNode(debounceFixture).ok).toBe(true);
    expect(decodeNode(declaredFixture).ok).toBe(true);
  });
});

describe('the local edit-buffer codec', () => {
  it('spells booleans and numbers the way the wire does', () => {
    expect(identityFormat(true)).toBe('true');
    expect(identityFormat(false)).toBe('false');
    expect(identityFormat(3)).toBe('3');
    expect(identityFormat(3.5)).toBe('3.5');
    expect(identityFormat('x')).toBe('x');
  });

  it('accepts the JSON number grammar and nothing wider', () => {
    for (const s of ['0', '-0', '0.5', '-1.5e3', '12', '1E+2', ' 7 ']) {
      expect(tryNumberText(s)).not.toBeUndefined();
    }
    // `Number(...)` would accept every one of these; the grammar must not.
    for (const s of ['+1', '.5', '1.', '01', '1,234', '0x10', '', 'e5', '1 2', 'Infinity']) {
      expect(tryNumberText(s)).toBeUndefined();
    }
  });

  it('rounds half away from zero and pads to exactly the declared width', () => {
    expect(fixedText(2, 0.005)).toBe('0.01');
    expect(fixedText(2, -0.005)).toBe('-0.01');
    expect(fixedText(2, 0.5)).toBe('0.50');
    expect(fixedText(0, 2.5)).toBe('3');
    expect(fixedText(3, 1)).toBe('1.000');
  });
});

describe('a decoded Binding.Computed', () => {
  it('throws its remedy instead of answering the slot zero', () => {
    const json =
      '{"id":"m","kind":{"$type":"Metric","label":"L","value":{"$type":"Computed","fn":"<closure>"}}}';
    const r = decodeNode(json);
    // The document is well-formed and must DECODE; the failure belongs at the
    // point of use, where the reader can be told what to reach for instead.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = findBinding(json, 'Computed') as unknown as Extract<
      Binding<unknown>,
      { kind: 'Computed' }
    >;
    expect(() => b.compute({ state: {}, tryGetState: () => undefined })).toThrowError(
      DECODED_COMPUTED_MESSAGE,
    );
  });
});
