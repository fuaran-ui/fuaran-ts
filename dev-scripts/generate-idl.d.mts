// Types for generate-idl.mjs — see that file for what it generates and why.

/** The path of the generated module, `packages/schema/src/generated.ts`. */
export declare const OUTPUT_PATH: string;

/** The generated module's source from the IDL's bytes, unformatted. */
export declare const generateIdlModule: (idlBytes: Uint8Array) => string;

/** The generated module's source, Prettier-formatted with the repository's configuration. */
export declare const generateFormatted: (idlBytes: Uint8Array) => Promise<string>;

/** The corpus's `idl.json` bytes, resolved through `corpus-root.mjs`. */
export declare const readIdl: (explicitRoot?: string) => Promise<Buffer>;
