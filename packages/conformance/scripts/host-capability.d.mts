// Types for host-capability.mjs, so the test that imports it typechecks.

export type FamilyAnswer =
  | 'covered'
  | { readonly pending: string }
  | { readonly notApplicable: string };

export declare const manifestPath: string;
export declare const HOST_CORPUS_FAMILIES: Readonly<Record<string, FamilyAnswer>>;
export declare const corpusFamilies: (root: string) => Set<string>;
export declare const render: () => string;

/** One generated field-table row, as far as the token projection reads it. */
export interface ModelRow {
  readonly name: string;
  readonly opt: string;
}
export interface TypeModel {
  readonly kinds: readonly string[];
  readonly kindFields: Readonly<Record<string, readonly ModelRow[]>>;
  readonly unionCases: Readonly<Record<string, Readonly<Record<string, readonly ModelRow[]>>>>;
  readonly recordFields: Readonly<Record<string, readonly ModelRow[]>>;
}
export declare const TYPE_MODEL: TypeModel;
export declare const constructTokens: (model: TypeModel) => string[];
export declare const DERIVED_FAMILIES: readonly string[];
export declare const tokenFamily: (token: string) => string;
