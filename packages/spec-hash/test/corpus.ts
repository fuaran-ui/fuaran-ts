// ============================================================================
//  Locating the specification's conformance corpus.
//
//  The corpus is the SPECIFICATION's, not this repository's. It is located the
//  way every other corpus leg here locates its corpus (Phase 2329): a variable
//  naming it FIRST, so a checkout that is not beside the specification — a
//  worktree, a CI layout of its own — runs against the corpus it was told to;
//  then the relative path from the repository root, where the DIRECTORY name is
//  the interface and a specification that moves home is checked out to the same
//  path.
//
//  The variable is `FUARAN_MODEL_EXECUTION_FIXTURES`, NOT `FUARAN_WIRE_FIXTURES`:
//  that one names the UI wire-format corpus, a different specification with a
//  different manifest, and a shell that sets it for the other legs would point
//  this suite at the wrong corpus. The manifest's own `specification` field is
//  checked, so a variable naming the wrong corpus fails loudly rather than
//  certifying against fixtures that are not this specification's.
//
//  ABSENCE IS A FAILURE, LOUDLY. There is no skip here and there must never be
//  one. A gate that quietly does nothing when it cannot find what it is checking
//  against leaves the build green, and everybody reads that as agreement.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The variable that names the corpus directory, read before the sibling path. */
export const CORPUS_ROOT_ENV = 'FUARAN_MODEL_EXECUTION_FIXTURES';

/** The `specification` this corpus's manifest declares. */
export const SPECIFICATION = 'model-execution-wire';

/** packages/spec-hash/test → the repository's parent → the specification checkout. */
export const CORPUS_RELATIVE_PATH = '../fuaran-model-execution-spec/wire-fixtures';

const fromEnv = process.env[CORPUS_ROOT_ENV];

export const corpusRoot =
  fromEnv !== undefined && fromEnv !== ''
    ? fromEnv
    : join(here, '..', '..', '..', '..', 'fuaran-model-execution-spec', 'wire-fixtures');

/** Where the corpus was looked for, for the absence message. */
const lookedFor =
  fromEnv !== undefined && fromEnv !== ''
    ? `${CORPUS_ROOT_ENV}=${fromEnv}`
    : `the sibling path '${CORPUS_RELATIVE_PATH}' (${CORPUS_ROOT_ENV} unset)`;

const missing = (what: string, path: string): never => {
  throw new Error(
    `the conformance corpus is not present: ${what} was expected at '${path}'. ` +
      "This suite certifies this tier against the specification's own fixtures, so it CANNOT pass " +
      `without them. Check the specification repository (Fuaran-Data/fuaran-model-execution-spec) out ` +
      `beside this repository at '${CORPUS_RELATIVE_PATH}', or name it with ${CORPUS_ROOT_ENV} ` +
      `(looked for: ${lookedFor}) — do not disable this suite, which would ` +
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
  const m = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  if (m.specification !== SPECIFICATION)
    throw new Error(
      `the corpus at '${corpusRoot}' is not the ${SPECIFICATION} corpus: its manifest declares ` +
        `specification ${JSON.stringify(m.specification)} (looked for: ${lookedFor}).`,
    );
  return m;
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
