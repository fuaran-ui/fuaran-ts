// ============================================================================
//  WIRE_FORMAT §20 decode determinism + §7.1 integer slots + §21.6/§21.7 —
//  this host's leg (Phase 1521).
//
//  §1's byte-stable round-trip is silent about a narrower question: given the
//  SAME input bytes, do two conformant hosts produce the same tree, or the same
//  rejection? For a small set of inputs they did not, and because every host is
//  individually self-consistent the corpus could not see it — every divergence
//  §20 ratifies was found by reading source rather than by a failing gate.
//
//  The corpus pins one vector per §20 row and every host runs it. This file
//  covers what a stored vector cannot: the rows as CLASSES rather than as one
//  example each, the accept side of each rule (the half a family of refusals
//  never asserts), and the two linear §21 limits, whose vectors are host-local
//  by §21.5's own reasoning — a megabyte of padding committed to a shared
//  repository to assert one integer comparison is a poor trade.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeNode, decodeOp, decodeOps } from '../src/decode.js';
import { MAX_DOCUMENT_BYTES, MAX_NODES, MAX_STRING_LENGTH } from '@fuaran-ui/schema';

const metric = (value: string): string =>
  `{"id":"m","kind":{"$type":"Metric","label":"R","value":{"$type":"Static","value":${value}}}}`;

const skeleton = (rows: string): string => `{"id":"s","kind":{"$type":"Skeleton","rows":${rows}}}`;

const markdown = (text: string): string =>
  `{"id":"a","kind":{"$type":"Markdown","text":"${text}"}}`;

const expectRefused = (json: string, code: string): void => {
  const r = decodeNode(json);
  expect(r.ok, `the payload decoded; §20 requires a refusal:\n  ${json.slice(0, 160)}`).toBe(false);
  if (!r.ok) expect(r.error.code, r.error.message).toBe(code);
};

const expectDecodes = (json: string): void => {
  const r = decodeNode(json);
  expect(r.ok, r.ok ? '' : `${r.error.code} at ${r.error.path}: ${r.error.message}`).toBe(true);
};

describe('§20.2 row 1 — a repeated object member is INVALID_JSON', () => {
  // The one §20 row that changes what a document MEANS rather than whether it
  // is accepted. This host kept the LAST occurrence and the reference host the
  // first, so a vetting host and a rendering host saw different trees from
  // identical bytes with no error anywhere.
  it('refuses a repeat at the root', () => {
    expectRefused('{"id":"a","id":"b","kind":{"$type":"Markdown","text":"x"}}', 'INVALID_JSON');
  });

  it('refuses a repeat in a nested object', () => {
    expectRefused('{"id":"a","kind":{"$type":"Markdown","text":"x","text":"y"}}', 'INVALID_JSON');
  });

  it('refuses a repeat inside a rule-12 payload', () => {
    expectRefused(
      '{"id":"a","kind":{"$type":"Custom","componentId":"c","moduleId":"m","props":{"k":1,"k":2}}}',
      'INVALID_JSON',
    );
  });

  it('accepts the same keys on DIFFERENT objects', () => {
    // The check is per object, not per document; a `text` on two siblings is
    // ordinary and must not be caught by a document-wide key set.
    expectDecodes(
      '{"id":"a","kind":{"$type":"Box","children":[' +
        '{"id":"b","kind":{"$type":"Markdown","text":"x"}},' +
        '{"id":"c","kind":{"$type":"Markdown","text":"y"}}],' +
        '"layout":{"$type":"Auto"},"role":"Group"}}',
    );
  });
});

describe('§20.2 row 2 — content after the root value', () => {
  it('refuses a second document', () => {
    expectRefused('{"id":"a","kind":{"$type":"Markdown","text":"x"}} {"id":"b"}', 'INVALID_JSON');
  });

  it('refuses trailing garbage', () => {
    expectRefused('{"id":"a","kind":{"$type":"Markdown","text":"x"}}garbage', 'INVALID_JSON');
  });

  it('accepts trailing whitespace', () => {
    // The check must not refuse a document a conformant encoder could have
    // produced with a newline on the end.
    expectDecodes('{"id":"a","kind":{"$type":"Markdown","text":"x"}}  \n\t ');
  });
});

describe('§20.2 row 3 — the RFC 8259 number grammar', () => {
  // `Number(...)` accepts every one of these, which is why the grammar is
  // checked BEFORE it: asking JavaScript "is this a number" was asking about
  // JavaScript rather than about this format.
  it.each(['+1', '01', '.5', '1.', '1e', '1e+', '-', '0x1f', '1..2', 'Infinity', ''])(
    'refuses %j',
    (token) => {
      expectRefused(metric(token), 'INVALID_JSON');
    },
  );

  it.each(['0', '-0', '1', '-1', '1.5', '1e3', '1E3', '1e+3', '1e-3', '0.5', '1.5e10'])(
    'accepts %j',
    (token) => {
      expectDecodes(metric(token));
    },
  );

  it('row 7 — an overflowing exponent is an infinity, not a refusal', () => {
    // Ratified as-is: all five hosts already agreed, so the row was unspecified
    // rather than divergent. It sits deliberately beside row 4, which refuses
    // the same value written as a bare `Infinity` literal.
    const r = decodeNode(metric('1e999'));
    expect(r.ok).toBe(true);
  });
});

describe('§20.2 row 5 — a raw C0 control character in a string', () => {
  it.each([0x00, 0x09, 0x0a, 0x1f])('refuses U+%s raw', (code) => {
    expectRefused(markdown(`x${String.fromCharCode(code)}y`), 'INVALID_JSON');
  });

  it('accepts the escaped spelling, which is the specified one', () => {
    expectDecodes(markdown('x\\ty'));
  });
});

describe('§20.2 row 6 — unpaired surrogates', () => {
  // Three hosts did three different things with a lone `\uD800` and one of them
  // deferred an uncatchable encoding error to the first canonical-bytes
  // boundary rather than raising it at decode. Refusing is the only answer that
  // keeps §6's promise that every wire-shape violation is a structured error.
  it.each([
    ['lone high', '\\ud83d'],
    ['lone low', '\\ude00'],
    ['high then a non-surrogate', '\\ud83dx'],
    ['high at the end', 'x\\ud83d'],
    ['two highs', '\\ud83d\\ud83d'],
    ['both halves, separated', '\\ud83d x \\ude00'],
  ])('refuses %s', (_label, text) => {
    expectRefused(markdown(text), 'INVALID_JSON');
  });

  it('accepts a well-formed pair, escaped and literal', () => {
    expectDecodes(markdown('\\ud83d\\ude00'));
    expectDecodes(markdown('\u{1f600}'));
  });
});

describe('§7.1 — integer slots', () => {
  it.each(['3', '3.0', '3e0', '0.3e1'])('accepts the integer-valued %j', (token) => {
    expectDecodes(skeleton(token));
  });

  it.each(['2.5', '-2.5'])('refuses the fractional %j rather than truncating it', (token) => {
    expectRefused(skeleton(token), 'WRONG_TYPE');
  });

  it.each(['1e10', '-1e10', '9007199254740992'])(
    'refuses %j — outside the 32-bit range the slot can hold',
    (token) => {
      expectRefused(skeleton(token), 'WRONG_TYPE');
    },
  );

  it.each(['2147483647', '-2147483648'])('accepts the 32-bit boundary %j', (token) => {
    expectDecodes(skeleton(token));
  });

  it.each(['"NaN"', '"Infinity"', '"-Infinity"'])(
    'refuses the §7 float sentinel %s at an integer slot',
    (sentinel) => {
      // §20.2 row 8 widens a FLOAT slot by exactly three strings. An integer
      // slot does not widen, and a host where one function serves both would
      // not notice.
      expectRefused(skeleton(sentinel), 'WRONG_TYPE');
    },
  );
});

describe('§21.6 — the string bound counts CODE POINTS', () => {
  // The four cases below are the only ones that distinguish code points from
  // the two units hosts were actually using. The BMP pair passes under every
  // reading; the ASTRAL pair is the discriminator, and this host — which
  // counted `out.length`, i.e. UTF-16 units — failed its accept half.
  const withText = (text: string): string =>
    `{"id":"a","kind":{"$type":"Heading","level":1,"text":"${text}","variant":"Standard"}}`;

  it('accepts a BMP string of exactly MAX_STRING_LENGTH code points', () => {
    expectDecodes(withText('x'.repeat(MAX_STRING_LENGTH)));
  });

  it('refuses a BMP string of MAX + 1 — the off-by-one the old check had', () => {
    // The bound was tested at the TOP of the accumulation loop against the
    // length so far, so the final character was appended after the last check
    // and a string of exactly MAX+1 passed.
    const r = decodeNode(withText('x'.repeat(MAX_STRING_LENGTH + 1)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('accepts an ASTRAL string of exactly MAX_STRING_LENGTH code points', () => {
    // U+1D11E is one code point and TWO UTF-16 units, so a unit-counting host
    // sees twice the limit here and refuses a conformant document.
    expectDecodes(withText('\\ud834\\udd1e'.repeat(MAX_STRING_LENGTH)));
  });

  it('refuses an ASTRAL string of MAX + 1 code points', () => {
    const r = decodeNode(withText('\\ud834\\udd1e'.repeat(MAX_STRING_LENGTH + 1)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('LIMIT_EXCEEDED');
  });
});

describe('§21.7 — the total-payload ceiling', () => {
  it('refuses a document past MAX_DOCUMENT_BYTES', () => {
    const doc = `{"id":"${'a'.repeat(MAX_DOCUMENT_BYTES)}","kind":{"$type":"Box"}}`;
    const r = decodeNode(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('admits a document at exactly MAX_NODES', () => {
    // The constraint that SET the figure: an 8 MiB ceiling would have refused
    // this document, which §21.2 rule 1 requires every host to accept —
    // silently lowering MAX_NODES while leaving its stated value in the table.
    const children: string[] = [];
    for (let i = 1; i < MAX_NODES; i += 1) {
      children.push(
        `{"id":"c${i}","kind":{"$type":"Heading","level":1,"text":"x","variant":"Standard"}}`,
      );
    }
    const doc = `{"id":"root","kind":{"$type":"Box","children":[${children.join(',')}],"layout":{"$type":"Auto"},"role":"Group"}}`;
    expect(doc.length).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
    expectDecodes(doc);
  });
});

describe('decodeOps — the batch decodes on the way down', () => {
  const op = (id: string): string =>
    `{"$type":"UpdateProp","path":"Label","target":"${id}","value":"Updated revenue"}`;

  it('accepts a single op and an array, and reports the batch position', () => {
    const one = decodeOps(op('a'));
    expect(one.ok).toBe(true);
    if (one.ok) expect(one.value).toHaveLength(1);

    const many = decodeOps(`[${op('a')},${op('b')}]`);
    expect(many.ok).toBe(true);
    if (many.ok) expect(many.value).toHaveLength(2);
  });

  it('names the failing element by its batch index', () => {
    const r = decodeOps(`[${op('a')},{"$type":"NotAnOp"}]`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.path.startsWith('$[1]')).toBe(true);
  });

  it('applies §20 to the WHOLE batch, not to each element after a native parse', () => {
    // The shape this entry point exists to replace ran `JSON.parse` over the
    // payload and re-stringified each element, which laundered every §20
    // difference between that parser and this one into bytes this decoder then
    // accepted. A duplicate member inside an element is the cheapest witness.
    const r = decodeOps(
      '[{"$type":"UpdateProp","path":"Label","target":"a","target":"b","value":"x"}]',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_JSON');
  });

  it('agrees with decodeOp on a single op', () => {
    const viaBatch = decodeOps(op('a'));
    const viaSingle = decodeOp(op('a'));
    expect(viaBatch.ok && viaSingle.ok).toBe(true);
    if (viaBatch.ok && viaSingle.ok) expect(viaBatch.value[0]).toEqual(viaSingle.value);
  });
});
