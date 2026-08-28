// ============================================================================
//  @fuaran-ui/conformance — corpus loading + versioning.
//
//  The package bundles a snapshot of the canonical wire-format conformance
//  corpus under `corpus/` — manifest.json + schema.json + every fixture family
//  the manifest enumerates — so a third party needs nothing beyond
//  `npm install` to certify. The snapshot is synced from the authoritative
//  `wire-format-fixtures/` corpus by `scripts/sync-corpus.mjs`, and the same
//  script's `--check` mode guards it byte-for-byte from the package's own test
//  suite, so it cannot silently drift from the authority.
//
//  Every report names the corpus it certified against: the manifest `version`
//  plus a SHA-256 digest over the manifest, the schema, and every fixture
//  payload in manifest order. Certification is per corpus version — content
//  advances with the spec (WIRE_FORMAT.md §11), and a report against an older
//  digest does not certify conformance with a newer one.
// ============================================================================

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type FixtureKind =
  | 'node-round-trip'
  | 'op-round-trip'
  | 'reject'
  | 'lenient-accept'
  // WIRE_FORMAT.md §15 wire-versioning envelope + tolerance.
  | 'envelope-round-trip'
  | 'envelope-reject'
  // WIRE_FORMAT.md §18 elicitation envelope + answer conformance.
  | 'elicitation-round-trip'
  | 'elicitation-reject'
  | 'elicitation-answer-accept'
  | 'elicitation-answer-reject'
  // WIRE_FORMAT.md §25 contract cards. Its OWN family, never `nodes/` — a card is
  // not a node, so the node round-trip law says nothing about it.
  | 'contract-card-round-trip'
  | 'contract-card-reject';

export interface CorpusFixture {
  readonly id: string;
  readonly kind: FixtureKind;
  readonly decoder:
    | 'node'
    | 'op'
    | 'elicitation'
    | 'elicitation-outcome'
    | 'elicitation-answer'
    | 'contract-card'
    | 'contract-card-bundle';
  readonly inputFile: string;
  readonly expectedFile?: string;
  readonly expectedErrorCode?: string;
  readonly expectedPath?: string;
  readonly description: string;
}

interface Manifest {
  readonly version: number;
  readonly schema: string;
  readonly description: string;
  readonly fixtures: readonly CorpusFixture[];
}

export interface Corpus {
  /** Absolute directory the corpus was loaded from. */
  readonly root: string;
  /** `bundled` (the package snapshot) or `external` (a caller-supplied root). */
  readonly source: 'bundled' | 'external';
  /** The manifest `version` field — the corpus major version. */
  readonly manifestVersion: number;
  readonly fixtures: readonly CorpusFixture[];
  /** SHA-256 (hex) over manifest.json + schema.json + every fixture payload in manifest order. */
  readonly digest: string;
  /** The canonical Draft 2020-12 JSON Schema (wire-format-fixtures/schema.json). */
  readonly schema: object;
  /** Read a corpus-relative payload file as UTF-8 text. */
  readonly read: (relPath: string) => string;
}

/** The bundled snapshot directory, resolved relative to the built module. */
const bundledRoot = (): string =>
  // dist/index.js → ../corpus (tsup `shims: true` provides import.meta.url under CJS).
  fileURLToPath(new URL('../corpus/', import.meta.url));

/**
 * Load the conformance corpus. With no options, loads the snapshot bundled in
 * this package; pass `corpusRoot` to certify against an external corpus
 * checkout (e.g. the workspace `wire-format-fixtures/` directory).
 */
export const loadCorpus = (options?: { readonly corpusRoot?: string }): Corpus => {
  const external = options?.corpusRoot;
  const root = external ?? bundledRoot();
  const read = (relPath: string): string => readFileSync(join(root, relPath), 'utf8');

  const manifestText = read('manifest.json');
  const manifest = JSON.parse(manifestText) as Manifest;

  const hash = createHash('sha256');
  hash.update(manifestText);
  hash.update(read(manifest.schema));
  for (const f of manifest.fixtures) {
    hash.update(read(f.inputFile));
    if (f.expectedFile !== undefined && f.expectedFile !== f.inputFile)
      hash.update(read(f.expectedFile));
  }

  return {
    root,
    source: external === undefined ? 'bundled' : 'external',
    manifestVersion: manifest.version,
    fixtures: manifest.fixtures,
    digest: hash.digest('hex'),
    schema: JSON.parse(read(manifest.schema)) as object,
    read,
  };
};
