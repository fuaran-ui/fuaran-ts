// ============================================================================
//  Phase 1071 — the authoring surface expresses the field-rule vocabulary.
//
//  Phase 864 added `FormField.rule`: the declarative per-field constraint that
//  replaces writing the rule into help text. The codec halves are pinned by the
//  `form-field-rules` corpus fixture in `@fuaran-ui/ops`. What THAT fixture
//  cannot show is whether an author using this package's fluent surface can
//  reach the vocabulary at all — and an unreachable vocabulary is the same
//  failure as an unimplemented one, because a projector or an author with
//  nothing to call emits the prose form instead.
//
//  So this asserts the surface, not the wire: `fuaran.form` carries every slot
//  of the vocabulary through to the node it builds. The encoding of those slots
//  is the corpus fixture's job and is deliberately not duplicated here.
//
//  Cross-checked against `../../wire-format-fixtures/nodes/form-field-rules.json`
//  — the five fields below are that fixture's, so a change to the fixture's rule
//  vocabulary that this surface cannot express shows up as a compile error here.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  action,
  binding,
  formFieldKind,
  fuaran,
  type FieldRule,
  type FormField,
  type FormSpec,
  type Node,
} from '../src/index.js';

const field = (id: string, label: string, rule?: FieldRule): FormField<never> => ({
  id,
  kind: formFieldKind.textDeclarative(binding.state(id, '')),
  label: { kind: 'Literal', value: label },
  required: true,
  ...(rule !== undefined ? { rule } : {}),
});

/** The `FormSpec` of a node built by `fuaran.form` — narrowed for assertions. */
const specOf = (n: Node<never>): FormSpec<never> => {
  const k = n.kind;
  if (k.kind !== 'Input' || k.input.kind !== 'Form') throw new Error('not a Form node');
  return k.input.spec;
};

describe('fuaran.form carries the Phase 864 field-rule vocabulary', () => {
  const built = fuaran.form<never>({
    id: 'form-field-rules',
    submitLabel: 'Save',
    onSubmit: action.chain([]),
    fields: [
      field('work-email', 'Work email', { format: 'email' }),
      field('postcode', 'Postcode', {
        message: { kind: 'Literal', value: 'Enter a UK postcode, e.g. EH1 1YZ' },
        pattern: '[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}',
      }),
      field('username', 'Username', { maxLength: 24, minLength: 3 }),
      field('hire-start-date', 'Start date'),
      field('hire-end-date', 'End date', {
        // `undefined` is the faithful spelling of "this read has no default":
        // the State case types `defaultValue` as required, and the encoder
        // omits an undefined one, which is the fixture's `{"$type":"State",
        // "key":…}` with no `defaultValue` member.
        compare: {
          against: binding.state<unknown>('hire-start-date', undefined),
          op: 'gte',
        },
        message: { kind: 'Literal', value: 'End date must be on or after the start date' },
      }),
    ],
  });

  const rules = specOf(built).fields.map((f) => f.rule);

  it('expresses a named input FORMAT', () => {
    expect(rules[0]).toEqual({ format: 'email' });
  });

  it('expresses a PATTERN with its own message', () => {
    expect(rules[1]?.pattern).toBe('[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}');
    expect(rules[1]?.message).toEqual({
      kind: 'Literal',
      value: 'Enter a UK postcode, e.g. EH1 1YZ',
    });
  });

  it('expresses a LENGTH pair', () => {
    expect(rules[2]).toEqual({ maxLength: 24, minLength: 3 });
  });

  it('leaves an unconstrained field with NO rule — absence is absence', () => {
    // Load-bearing: `rule` is optional rather than omit-default, which is what
    // keeps every pre-864 form byte-unchanged on the wire.
    const unconstrained = specOf(built).fields[3];
    expect(unconstrained).toBeDefined();
    expect(rules[3]).toBeUndefined();
    expect(unconstrained !== undefined && 'rule' in unconstrained).toBe(false);
  });

  it('expresses the CROSS-FIELD comparison as an ordinary Binding read', () => {
    // The cross-field mechanism is a Binding, not a coordination vocabulary:
    // every form field's value is in State under its own id, so a sibling is
    // read with `binding.state(<sibling id>)` and nothing else.
    expect(rules[4]?.compare).toEqual({
      against: { kind: 'State', key: 'hire-start-date' },
      op: 'gte',
    });
  });
});
