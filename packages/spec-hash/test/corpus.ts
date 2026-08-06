// ============================================================================
//  Locating the specification's conformance corpus.
//
//  The corpus is the SPECIFICATION's, not this repository's. It is reached by
//  relative path from the repository root, which is how every host in this
//  estate consumes a shared corpus: the DIRECTORY name is the interface, and a
//  specification that moves to a different home is checked out to the same path.
//
//  ABSENCE IS A FAILURE, LOUDLY. There is no skip here and there must never be
//  one. A gate that quietly does nothing when it cannot find what it is checking
//  against leaves the build green, and everybody reads that as agreement.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** packages/spec-hash/test → the repository's parent → the specification checkout. */
export const CORPUS_RELATIVE_PATH = '../fuaran-model-execution-spec/wire-fixtures';

export const corpusRoot = join(
  here,
  '..',
  '..',
  '..',
  '..',
  'fuaran-model-execution-spec',
  'wire-fixtures',
);

const missing = (what: string, path: string): never => {
  throw new Error(
    `the conformance corpus is not present: ${what} was expected at '${path}'. ` +
      "This suite certifies this tier against the specification's own fixtures, so it CANNOT pass " +
      `without them. Check the specification repository (fuaran-ui/fuaran-model-execution-spec) out ` +
      `beside this repository at '${CORPUS_RELATIVE_PATH}' — do not disable this suite, which would ` +
      'leave the implementation unpinned while the build stayed green.',
  );
};

export const readCorpusFile = (relPath: string): string => {
  const path = join(corpusRoot, relPath);
  if (!existsSync(path)) missing(`the fixture '${relPath}'`, path);
  return readFileSync(path, 'utf8');
};

export interface Vector {
  readonly id: string;
  readonly family: string;
  readonly profile: string;
  readonly kind: 'round-trip' | 'hash' | 'reject' | 'accept';
  readonly file: string;
  readonly sha256: string;
  readonly digest?: string;
  readonly canonicalPayload?: string;
  readonly reject?: string;
  readonly description: string;
}

export interface Manifest {
  readonly specification: unknown;
  readonly families: readonly string[];
  readonly reservedFamilies: readonly string[];
  readonly vectors: readonly Vector[];
}

export const manifest = (): Manifest => {
  const path = join(corpusRoot, 'manifest.json');
  if (!existsSync(path)) missing('manifest.json', path);
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
};

/** The document a vector names, exactly as committed. */
export const loadVector = (v: Vector): string => readCorpusFile(v.file);

/**
 * The opaque payload a submission carries. Read with `JSON.parse` deliberately: the
 * ENVELOPE is an ordinary document to this suite, and only the payload inside it is
 * subject to the rule under test.
 */
export const specPayloadOf = (
  documentText: string,
): {
  readonly specPayload: string;
  readonly specHash: string;
  readonly specHashAlgorithm: string;
} => {
  const parsed = JSON.parse(documentText) as {
    body?: { specPayload?: unknown; specHash?: unknown; specHashAlgorithm?: unknown };
  };
  const body = parsed.body;
  if (
    !body ||
    typeof body.specPayload !== 'string' ||
    typeof body.specHash !== 'string' ||
    typeof body.specHashAlgorithm !== 'string'
  ) {
    throw new Error(
      'the vector is not a submission carrying a payload, a hash and an algorithm identifier',
    );
  }
  return {
    specPayload: body.specPayload,
    specHash: body.specHash,
    specHashAlgorithm: body.specHashAlgorithm,
  };
};
