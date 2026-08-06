// ============================================================================
//  Loading the cross-host vector file.
//
//  Read from disk rather than `import`ed, for the same reason the corpus is:
//  absence must be a LOUD failure that names what is missing and how to restore
//  it, and a bundler-resolved import fails with a module-not-found error that
//  reads like a broken build rather than a missing gate.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const VECTORS_PATH = join(here, 'vectors', 'cross-host-vectors.json');

export interface CrossHostVector {
  readonly id: string;
  readonly rendered: string;
  /** The same document authored the other way round; `null` on the hand-picked edges. */
  readonly renderedPermuted: string | null;
  readonly canonical: string;
  readonly digest: string;
}

export interface CrossHostRefusal {
  readonly id: string;
  readonly rendered: string;
  readonly refusal:
    | 'not-json'
    | 'duplicate-members'
    | 'number-not-representable'
    | 'ill-formed-unicode';
}

export interface CrossHostVectorFile {
  readonly algorithm: string;
  readonly note: string;
  readonly seed: number;
  readonly generatedCount: number;
  readonly vectorCount: number;
  readonly refusalCount: number;
  readonly vectors: readonly CrossHostVector[];
  readonly refusals: readonly CrossHostRefusal[];
}

export const crossHostVectors = (): CrossHostVectorFile => {
  if (!existsSync(VECTORS_PATH)) {
    throw new Error(
      `the cross-host vector file is missing at '${VECTORS_PATH}'. It is a COMMITTED artefact, not a ` +
        "build output: it carries an independent implementation's canonical bytes and digests for the " +
        'same registered algorithm, and without it this tier is only checked against itself. ' +
        'Restore it from version control, or regenerate it per scripts/README.md — but never by ' +
        "copying this implementation's own output, which would make the gate agree with itself.",
    );
  }
  return JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as CrossHostVectorFile;
};
