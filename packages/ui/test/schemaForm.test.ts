// ============================================================================
//  Phase 1914 — the schema-to-form derivation, held to the reference host.
//
//  `fixtures/schema-form-parity.json` is a PAIRED test table: each schema (as
//  text) with the outcome the reference host's `Fuaran.UI.SchemaForm`
//  (Phase 1816) derives from it — the Form's canonical wire, or the refusal
//  envelope — certified by `schemaForm.parity.certify.fsx`. This suite holds
//  `deriveFormFromText` + the canonical encoder + `renderSchemaFormRefusals`
//  to those exact bytes, and then pins that the table actually covers every
//  row of the mapping table and every refusal code, so a row cannot quietly
//  drop out of the parity claim.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeNode } from '@fuaran-ui/ops';
import type { FormField, Node } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import { preEmitValidate } from '../src/preEmitValidate.js';
import {
  type SchemaFormOptions,
  type SchemaFormRefusalCode,
  deriveForm,
  deriveFormFromText,
  parseSchemaJson,
  renderSchemaFormRefusals,
  schemaFormDefaults,
  schemaFormRefusalCodeName,
  schemaJsonOf,
} from '../src/schemaForm.js';

type Msg = unknown;

interface ParityCase {
  readonly name: string;
  readonly schema: string;
  readonly outcome: 'form' | 'refused';
  readonly wire: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(
  readFileSync(join(here, 'fixtures', 'schema-form-parity.json'), 'utf8'),
) as { readonly cases: readonly ParityCase[] };

const defaults = schemaFormDefaults<Msg>();

/** The wire this host derives for a schema text: the Form's canonical bytes, or the refusals. */
const wireOf = (text: string, options: SchemaFormOptions<Msg> = defaults) => {
  const r = deriveFormFromText(options, text);
  return r.ok
    ? { outcome: 'form' as const, wire: encodeNode(r.value) }
    : { outcome: 'refused' as const, wire: renderSchemaFormRefusals(r.error) };
};

const caseNamed = (name: string): ParityCase => {
  const c = table.cases.find((x) => x.name === name);
  if (c === undefined) throw new Error(`parity table has no case '${name}'`);
  return c;
};

const formOf = (text: string, options: SchemaFormOptions<Msg> = defaults): Node<Msg> => {
  const r = deriveFormFromText(options, text);
  if (!r.ok) throw new Error(renderSchemaFormRefusals(r.error));
  return r.value;
};

const fieldsOf = (n: Node<Msg>): readonly FormField<Msg>[] => {
  if (n.kind.kind !== 'Input' || n.kind.input.kind !== 'Form') throw new Error('not a Form');
  return n.kind.input.spec.fields;
};

describe('schema-to-form parity with the reference host', () => {
  it('the table is non-trivial and every case is certified', () => {
    expect(table.cases.length).toBeGreaterThan(50);
    for (const c of table.cases) {
      expect(['form', 'refused']).toContain(c.outcome);
      expect(c.wire.length).toBeGreaterThan(0);
    }
    expect(new Set(table.cases.map((c) => c.name)).size).toBe(table.cases.length);
  });

  it.each(table.cases.map((c) => [c.name, c] as const))(
    '%s derives the reference host bytes',
    (_name, c) => {
      const got = wireOf(c.schema);
      expect(got.outcome).toBe(c.outcome);
      expect(got.wire).toBe(c.wire);
    },
  );
});

describe('every row of the mapping table is in the parity table', () => {
  // Each mapping-table row, the case that exercises it, and what the derived
  // field must look like — so a row is covered by NAME, not by accident.
  const rows: readonly (readonly [string, string, (f: readonly FormField<Msg>[]) => void])[] = [
    ['string -> Text', 'string-text', (f) => expect(f[0]?.kind.kind).toBe('Text')],
    [
      'string past the threshold -> TextArea',
      'string-textarea-past-threshold',
      (f) => expect(f[0]?.kind).toMatchObject({ kind: 'TextArea', rows: 4 }),
    ],
    [
      'string at the threshold stays Text',
      'string-text-at-threshold',
      (f) => expect(f[0]?.kind.kind).toBe('Text'),
    ],
    [
      'format date -> DateTime/Date',
      'string-format-date',
      (f) => expect(f[0]?.kind).toMatchObject({ kind: 'DateTime', variant: 'Date' }),
    ],
    [
      'format time -> DateTime/Time',
      'string-format-time',
      (f) => expect(f[0]?.kind).toMatchObject({ kind: 'DateTime', variant: 'Time' }),
    ],
    [
      'format date-time -> DateTime/DateTime',
      'string-format-date-time',
      (f) => expect(f[0]?.kind).toMatchObject({ kind: 'DateTime', variant: 'DateTime' }),
    ],
    ['format color -> Color', 'string-format-color', (f) => expect(f[0]?.kind.kind).toBe('Color')],
    [
      'format email -> Text + rule email',
      'string-format-email',
      (f) => expect(f[0]?.rule).toEqual({ format: 'email' }),
    ],
    [
      'format uri -> Text + rule url (never a TextArea)',
      'string-format-uri-long-stays-text',
      (f) => {
        expect(f[0]?.kind.kind).toBe('Text');
        expect(f[0]?.rule).toEqual({ format: 'url', maxLength: 500 });
      },
    ],
    [
      'minLength / maxLength / pattern -> the rule slots',
      'string-rule-slots',
      (f) => expect(f[0]?.rule).toEqual({ minLength: 2, maxLength: 8, pattern: '^[A-Z]+$' }),
    ],
    [
      'unbounded number -> Number',
      'number-unbounded',
      (f) => expect(f[0]?.kind.kind).toBe('Number'),
    ],
    [
      'a bound -> RangedNumber',
      'number-min-only',
      (f) => expect(f[0]?.kind).toMatchObject({ kind: 'RangedNumber', constraints: { min: 0.5 } }),
    ],
    [
      'multipleOf -> the step',
      'number-max-and-multipleOf',
      (f) => expect(f[0]?.kind).toMatchObject({ constraints: { max: 10, step: 0.25 } }),
    ],
    [
      'integer steps by 1',
      'integer-unbounded-steps-by-one',
      (f) => expect(f[0]?.kind).toMatchObject({ kind: 'RangedNumber', constraints: { step: 1 } }),
    ],
    [
      'integer exclusive bounds -> the next whole number inside',
      'integer-exclusive-bounds',
      (f) => expect(f[0]?.kind).toMatchObject({ constraints: { min: 1, max: 10, step: 1 } }),
    ],
    ['boolean -> Checkbox', 'boolean-checkbox', (f) => expect(f[0]?.kind.kind).toBe('Checkbox')],
    [
      'enum within segmentedMax -> SegmentedChoice',
      'enum-segmented-at-max',
      (f) =>
        expect(f[0]?.kind).toMatchObject({ kind: 'SegmentedChoice', orientation: 'Horizontal' }),
    ],
    [
      'enum within choiceMax -> Choice',
      'enum-choice-at-max',
      (f) => expect(f[0]?.kind.kind).toBe('Choice'),
    ],
    [
      'enum past choiceMax -> Combobox, no free text',
      'enum-combobox',
      (f) => expect(f[0]?.kind).toMatchObject({ kind: 'Combobox', allowFreeText: false }),
    ],
    [
      'array of a string enum -> Tokens',
      'array-of-enum-tokens',
      (f) => expect(f[0]?.kind).toMatchObject({ kind: 'Tokens', allowFreeText: false }),
    ],
    [
      'one nested object -> its fields in place',
      'nested-object-group',
      (f) => {
        expect(f.map((x) => x.id)).toEqual(['addr.city', 'addr.zip']);
        expect(f[0]?.label).toEqual({ kind: 'Literal', value: 'Address: City' });
        expect(f.map((x) => x.required)).toEqual([true, false]);
      },
    ],
    [
      'required / title / description -> required / label / help',
      'required-title-description',
      (f) => {
        expect(f[0]).toMatchObject({
          required: true,
          label: { kind: 'Literal', value: 'Full name' },
          help: { kind: 'Literal', value: 'As on your passport' },
        });
        expect(f[1]?.label).toEqual({ kind: 'Literal', value: 'nick' });
      },
    ],
    [
      'default -> State(<field id>, default)',
      'string-format-date-time',
      (f) =>
        expect(f[0]?.kind).toMatchObject({
          value: { kind: 'State', key: 'dt', defaultValue: '2026-01-02T03:04' },
        }),
    ],
    [
      'local $ref resolved, sibling title wins',
      'ref-local-sibling-title-wins',
      (f) =>
        expect(f.map((x) => x.label)).toEqual([
          { kind: 'Literal', value: 'How many' },
          { kind: 'Literal', value: 'Quantity' },
        ]),
    ],
    [
      'type [T, "null"] -> T',
      'nullable-type-union',
      (f) => expect(f.map((x) => x.kind.kind)).toEqual(['Text', 'RangedNumber']),
    ],
    [
      'additionalProperties true / false accepted',
      'additional-properties-accepted',
      (f) => expect(f.map((x) => x.id)).toEqual(['o.x']),
    ],
    [
      'annotations read, not rendered',
      'annotations-read-not-rendered',
      (f) => expect(f.map((x) => x.id)).toEqual(['x']),
    ],
  ];

  it.each(rows.map(([row, name, check]) => [row, name, check] as const))(
    '%s (%s)',
    (_row, name, check) => {
      const c = caseNamed(name);
      expect(c.outcome).toBe('form');
      check(fieldsOf(formOf(c.schema)));
    },
  );

  it('every derived form passes the pre-emit validator', () => {
    for (const c of table.cases.filter((x) => x.outcome === 'form')) {
      const r = preEmitValidate(formOf(c.schema));
      expect(r.ok ? [] : r.error.map((d) => `${c.name}: ${d.code}`)).toEqual([]);
    }
  });
});

describe('every refusal code is in the parity table', () => {
  const codes: readonly SchemaFormRefusalCode['kind'][] = [
    'SchemaNotJson',
    'RootNotObject',
    'NoFields',
    'Combinator',
    'RefCycle',
    'RefUnresolved',
    'NestingTooDeep',
    'UnsupportedType',
    'UnsupportedFormat',
    'UnsupportedKeyword',
    'KeywordNotCarried',
    'InvalidKeywordValue',
    'EnumNotStrings',
    'InvalidPropertyName',
    'DuplicateFieldId',
    'RequiredUnderOptionalObject',
  ];

  const refusedCodes = new Set(
    table.cases
      .filter((c) => c.outcome === 'refused')
      .flatMap((c) =>
        (JSON.parse(c.wire) as { refusals: { code: string }[] }).refusals.map((r) => r.code),
      ),
  );

  it.each(codes)('%s is produced by at least one certified case', (kind) => {
    const name = schemaFormRefusalCodeName({ kind } as SchemaFormRefusalCode);
    expect(refusedCodes).toContain(name);
  });

  it('a refusal names its schema path as an RFC 6901 pointer', () => {
    const r = deriveFormFromText(defaults, caseNamed('refuse-pointer-escapes-in-paths').schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.map((x) => x.path)).toEqual(['/properties/a~1b~0c/format']);
  });

  it('reports EVERY refusal, not only the first', () => {
    const r = deriveFormFromText(defaults, caseNamed('refuse-unsupported-types').schema);
    expect(r.ok ? 0 : r.error.length).toBe(7);
  });
});

describe('the options', () => {
  const schema = (props: string) => `{"type":"object","properties":${props}}`;

  it('booleanControl Toggle derives a Toggle', () => {
    const f = fieldsOf(
      formOf(schema('{"b":{"type":"boolean"}}'), { ...defaults, booleanControl: 'Toggle' }),
    );
    expect(f[0]?.kind.kind).toBe('Toggle');
  });

  it('the thresholds are inclusive on the smaller control and configurable', () => {
    const options: SchemaFormOptions<Msg> = {
      ...defaults,
      segmentedMax: 2,
      choiceMax: 3,
      textAreaThreshold: 10,
      textAreaRows: 7,
    };
    const kinds = fieldsOf(
      formOf(
        schema(
          '{"s":{"enum":["a","b"]},"c":{"enum":["a","b","c"]},"x":{"enum":["a","b","c","d"]},' +
            '"t":{"type":"string","maxLength":10},"ta":{"type":"string","maxLength":11}}',
        ),
        options,
      ),
    ).map((x) => x.kind);
    expect(kinds.map((k) => k.kind)).toEqual([
      'SegmentedChoice',
      'Choice',
      'Combobox',
      'Text',
      'TextArea',
    ]);
    expect(kinds[4]).toMatchObject({ rows: 7 });
  });

  it('formId, submitLabel and onSubmit reach the Form node', () => {
    const n = formOf(schema('{"a":{"type":"string"}}'), {
      ...defaults,
      formId: 'signup',
      submitLabel: { kind: 'Literal', value: 'Join' },
    });
    expect(n.id).toBe('signup');
    const wire = encodeNode(n);
    expect(wire).toContain('"id":"signup"');
    expect(wire).toContain('"submitLabel":"Join"');
    expect(wire).toContain('"onSubmit":{"$type":"Chain","ops":[]}');
  });

  it('is deterministic: the same schema and options yield the same bytes', () => {
    for (const c of table.cases.slice(0, 10)) expect(wireOf(c.schema)).toEqual(wireOf(c.schema));
  });
});

describe('reading the schema', () => {
  it('parseSchemaJson keeps document order, duplicates and the int/float distinction', () => {
    const r = parseSchemaJson('{"b":1,"10":2.0,"b":3}');
    expect(r).toEqual({
      ok: true,
      value: {
        kind: 'obj',
        members: [
          ['b', { kind: 'int', value: 1 }],
          ['10', { kind: 'float', value: 2 }],
          ['b', { kind: 'int', value: 3 }],
        ],
      },
    });
  });

  it('an object-member null is absence; any other null is refused', () => {
    expect(parseSchemaJson('{"a":null,"b":true}')).toEqual({
      ok: true,
      value: { kind: 'obj', members: [['b', { kind: 'bool', value: true }]] },
    });
    expect(parseSchemaJson('[null]').ok).toBe(false);
  });

  it('schemaJsonOf lifts a parsed value, erasing null / undefined members', () => {
    expect(schemaJsonOf({ a: null, b: undefined, c: [1, 1.5, -0, 'x', false] })).toEqual({
      kind: 'obj',
      members: [
        [
          'c',
          {
            kind: 'arr',
            items: [
              { kind: 'int', value: 1 },
              { kind: 'float', value: 1.5 },
              { kind: 'int', value: 0 },
              { kind: 'str', value: 'x' },
              { kind: 'bool', value: false },
            ],
          },
        ],
      ],
    });
    expect(schemaJsonOf([null])).toBeUndefined();
    expect(schemaJsonOf({ a: Number.NaN })).toBeUndefined();
    expect(schemaJsonOf(() => 1)).toBeUndefined();
  });

  it('deriveForm over a lifted value derives what the text derives', () => {
    const c = caseNamed('nested-object-group');
    const lifted = schemaJsonOf(JSON.parse(c.schema));
    expect(lifted).toBeDefined();
    if (lifted === undefined) return;
    const r = deriveForm(defaults, lifted);
    expect(r.ok).toBe(true);
    if (r.ok) expect(encodeNode(r.value)).toBe(c.wire);
  });
});
