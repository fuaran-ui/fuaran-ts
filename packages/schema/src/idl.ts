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
