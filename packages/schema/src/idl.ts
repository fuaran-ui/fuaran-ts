// ============================================================================
//  @fuaran-ui/schema/idl — the shape of the IDL's field tables (Phase 2073).
//
//  `generated.ts` is this host's projection of the specification corpus's
//  `idl.json`: every kind, record, union case and op as a table of FieldRows.
//  This module is the hand-written vocabulary those tables are typed against —
//  the IDL's own type language (`$type` descriptors), its four optionalities
//  and its default shapes — so the generated module compiles only when it
//  spells what this host reads. Nothing here is behaviour.
// ============================================================================

import { KIND_FIELDS, type NodeKindName } from './generated.js';
import type { IdlSpec } from './types.js';

/** A leaf IDL type: a JSON scalar, a node, an untyped JSON value, a tree op, a node kind. */
export type IdlScalar = 'str' | 'int' | 'float' | 'bool' | 'node' | 'json' | 'op' | 'kind';

/**
 * One IDL type descriptor, the `$type` form `idl.json` itself uses. `fn` is a
 * closure slot (`"<closure>"` on the wire, host-typed off it); `hosted` is a
 * payload whose wire form is JSON and whose host representation the host
 * chooses; `var` is a generic union's type parameter.
 */
export type IdlType =
  | { readonly $type: IdlScalar }
  | { readonly $type: 'list'; readonly of: IdlType }
  | { readonly $type: 'map'; readonly values: IdlType }
  | { readonly $type: 'enum'; readonly name: string }
  | { readonly $type: 'record'; readonly name: string }
  | { readonly $type: 'union'; readonly name: string; readonly args: readonly IdlType[] }
  | { readonly $type: 'fn'; readonly wire: '<closure>' }
  | { readonly $type: 'hosted'; readonly wire: 'json' }
  | { readonly $type: 'var'; readonly name: string };

/**
 * How present a member is: `required`; `optional` (absent is None); `omitDefault`
 * (absent means the declared default, and the default is omitted on encode —
 * WIRE_FORMAT.md §3.6); `hostOnly` (a host-language member with no wire form).
 */
export type Optionality = 'required' | 'optional' | 'omitDefault' | 'hostOnly';

/** A declared default, in the IDL's own value language. */
export type IdlDefault =
  | { readonly $type: 'bool'; readonly value: boolean }
  | { readonly $type: 'int' | 'float'; readonly value: number }
  | { readonly $type: 'str'; readonly value: string }
  | { readonly $type: 'enum'; readonly case: string }
  | { readonly $type: 'list'; readonly items: readonly IdlDefault[] }
  | {
      readonly $type: 'union';
      readonly tag: string;
      readonly fields: readonly { readonly name: string; readonly value: IdlDefault }[];
    }
  | {
      readonly $type: 'record';
      readonly fields: readonly { readonly name: string; readonly value: IdlDefault }[];
    };

/** One member of a kind, record, union case, op or the node envelope. */
export interface FieldRow {
  readonly name: string;
  readonly opt: Optionality;
  readonly type: IdlType;
  /** Present exactly when `opt` is `omitDefault`. */
  readonly dflt?: IdlDefault;
}

/** The rows of a table that reach the wire (every row but a `hostOnly` one). */
export const wireRows = <R extends FieldRow>(rows: readonly R[]): readonly R[] =>
  rows.filter((r) => r.opt !== 'hostOnly');

/**
 * The value an `omitDefault` member's declared default denotes in this host's
 * representation: a union case is `{ kind: <tag>, ...fields }` and a record a
 * plain object, as the hand-written types spell them. Fresh on every call, so
 * no two decoded specs share one default's identity.
 */
export const defaultValue = (d: IdlDefault): unknown => {
  switch (d.$type) {
    case 'bool':
    case 'int':
    case 'float':
    case 'str':
      return d.value;
    case 'enum':
      return d.case;
    case 'list':
      return d.items.map(defaultValue);
    case 'union':
      return Object.fromEntries([
        ['kind', d.tag],
        ...d.fields.map((f) => [f.name, defaultValue(f.value)] as const),
      ]);
    case 'record':
      return Object.fromEntries(d.fields.map((f) => [f.name, defaultValue(f.value)] as const));
  }
};

/** The members of a kind's table that are `omitDefault`. */
export type OmitDefaultMember<K extends NodeKindName> = Extract<
  (typeof KIND_FIELDS)[K][number],
  { readonly opt: 'omitDefault' }
>['name'];

/** A spec with its `omitDefault` members left to the table: what an authoring surface hands `withDefaults`. */
export type SpecInput<K extends NodeKindName> = Omit<IdlSpec<K, unknown>, OmitDefaultMember<K>> & {
  readonly [N in OmitDefaultMember<K>]?:
    | (N extends keyof IdlSpec<K, unknown> ? IdlSpec<K, unknown>[N] : never)
    | undefined;
};

/** The `omitDefault` members of a kind's spec, as the table fills them. */
export type Defaulted<K extends NodeKindName> = Pick<
  IdlSpec<K, unknown>,
  Extract<OmitDefaultMember<K>, keyof IdlSpec<K, unknown>>
>;

/**
 * A kind's spec with every `omitDefault` member the caller left undefined
 * filled from its IDL default (Phase 2073). An authoring surface therefore
 * carries no wire default of its own: a constructed spec agrees with a decoded
 * one by construction, and a member the IDL gains with a default needs no edit
 * where specs are built. Members the table does not carry (a host closure)
 * pass through, so the result keeps the caller's own type.
 */
export const withDefaults = <K extends NodeKindName, const S extends SpecInput<K>>(
  kind: K,
  spec: S,
): S & Defaulted<K> => {
  const out: Record<string, unknown> = { ...spec };
  for (const row of KIND_FIELDS[kind] as readonly FieldRow[]) {
    if (row.dflt === undefined) continue;
    if (out[row.name] === undefined) out[row.name] = defaultValue(row.dflt);
  }
  return out as unknown as S & Defaulted<K>;
};
