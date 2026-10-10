// Types for corpus-root.mjs — see that file for the resolution order.

export interface CorpusRootOptions {
  explicit?: string;
  env?: Record<string, string | undefined>;
}

export declare const CORPUS_ROOT_ENV: 'FUARAN_WIRE_FIXTURES';

export declare const siblingCorpusRoot: () => string;

export declare const resolveCorpusRoot: (options?: CorpusRootOptions) => {
  root: string;
  source: 'explicit' | 'env' | 'sibling';
};

export declare const wireCorpusRoot: (options?: CorpusRootOptions) => string;
