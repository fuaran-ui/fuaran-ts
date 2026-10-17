// Types for host-capability.mjs, so the test that imports it typechecks.

export type FamilyAnswer =
  | 'covered'
  | { readonly pending: string }
  | { readonly notApplicable: string };

export declare const manifestPath: string;
export declare const HOST_CORPUS_FAMILIES: Readonly<Record<string, FamilyAnswer>>;
export declare const corpusFamilies: (root: string) => Set<string>;
export declare const render: () => string;
