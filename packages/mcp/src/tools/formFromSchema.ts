// fuaran_formFromSchema — a JSON Schema → the Form it derives to (Phase 1914).
//
// The one tool here that AUTHORS rather than observes: an agent holding a JSON
// Schema (a tool's input schema, a request body) asks for the form instead of
// transcribing it. It is the TypeScript mirror of the reference host's
// `fuaran.formFromSchema` (Phase 1816) — the same three arguments, the same
// argument refusals, and the same result: the Form's canonical wire JSON, or
// the refusal envelope `{"refusals":[{"code","message","path"}]}` naming every
// unsupported construct by its schema path. The derivation is
// `@fuaran-ui/ui`'s `deriveForm` and nothing else, and the wire is the
// canonical encoder's, so the bytes are the reference host's for the same
// schema.
//
// The registered name follows this server's `fuaran_<verb>` convention with
// the reference tool's verb kept verbatim: a dotted name is outside the tool-
// name grammar several MCP clients enforce.
//
// The `schema` argument arrives as a parsed object, so it carries the
// JavaScript object model's key order (integer-like property names enumerate
// first). `deriveFormFromText` in `@fuaran-ui/ui` reads schema TEXT in document
// order for callers that need it.

import { encodeNode } from '@fuaran-ui/ops';
import {
  deriveForm,
  renderSchemaFormRefusals,
  schemaFormDefaults,
  schemaJsonOf,
} from '@fuaran-ui/ui';

/** The tool's registered name. */
export const FORM_FROM_SCHEMA_TOOL = 'fuaran_formFromSchema';

export interface FormFromSchemaArgs {
  /** The JSON Schema object to derive the form from. */
  readonly schema: unknown;
  /** The Form node's id (default `"schema-form"`). */
  readonly formId?: unknown;
  /** The submit button's label (default `"Submit"`). */
  readonly submitLabel?: unknown;
}

/**
 * `ok` carries the Form's canonical wire JSON; otherwise `refusals` is the
 * refusal envelope — the derivation's refusals, or one `invalid-arguments`
 * entry when the call's own arguments are wrong.
 */
export type FormFromSchemaResult =
  | { readonly ok: true; readonly wire: string }
  | { readonly ok: false; readonly refusals: string };

/** The canonical wire string escape (WIRE_FORMAT §2 rule 6) — `"`, `\` and C0 only. */
const canonString = (s: string): string => {
  let out = '"';
  for (let k = 0; k < s.length; k += 1) {
    const c = s.charCodeAt(k);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += s.charAt(k);
  }
  return out + '"';
};

const argumentsRefusal = (path: string, message: string): FormFromSchemaResult => ({
  ok: false,
  refusals: `{"refusals":[{"code":"invalid-arguments","message":${canonString(message)},"path":${canonString(path)}}]}`,
});

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

/**
 * `fuaran_formFromSchema(schema, formId?, submitLabel?)`. Pure and
 * deterministic: the same arguments always yield the same bytes.
 */
export function runFormFromSchema(args: unknown): FormFromSchemaResult {
  if (typeof args !== 'object' || args === null || Array.isArray(args))
    return argumentsRefusal('', 'the arguments are not an object');
  const members = args as Record<string, unknown>;
  const unknownKey = Object.keys(members).find(
    (k) => k !== 'schema' && k !== 'formId' && k !== 'submitLabel',
  );
  if (unknownKey !== undefined) return argumentsRefusal('/' + unknownKey, 'unknown argument');
  const { schema, formId, submitLabel } = members;
  if (schema === undefined) return argumentsRefusal('/schema', 'the schema argument is required');
  if (formId !== undefined && !isNonEmptyString(formId))
    return argumentsRefusal('/formId', 'formId must be a non-empty string');
  if (submitLabel !== undefined && !isNonEmptyString(submitLabel))
    return argumentsRefusal('/submitLabel', 'submitLabel must be a non-empty string');

  const json = schemaJsonOf(schema);
  if (json === undefined) return argumentsRefusal('/schema', 'the schema argument is not JSON');

  const defaults = schemaFormDefaults<unknown>();
  const derived = deriveForm(
    {
      ...defaults,
      formId: formId ?? defaults.formId,
      submitLabel:
        submitLabel !== undefined ? { kind: 'Literal', value: submitLabel } : defaults.submitLabel,
    },
    json,
  );
  return derived.ok
    ? { ok: true, wire: encodeNode(derived.value) }
    : { ok: false, refusals: renderSchemaFormRefusals(derived.error) };
}
