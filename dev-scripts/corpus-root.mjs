// ============================================================================
//  The ONE corpus-root resolver for this repository (Phase 2204).
//
//  Every suite and script here that reads the shared wire-format corpus finds
//  it through this module, in one order:
//
//    1. an explicit argument, when the caller has one;
//    2. FUARAN_WIRE_FIXTURES, the variable every host in the estate reads;
//    3. the canonical sibling clone, ../wire-format-fixtures beside this repo.
//
//  A NAMED root (1 or 2) must hold a manifest.json or it is REFUSED with an
//  error naming the variable and the path — never ignored. Falling through to
//  the sibling would reach, from a git worktree, the SHARED primary clone: the
//  very corpus the override exists to leave alone, so a run would certify
//  against an oracle nobody named and report it as green. An empty or
//  whitespace-only value counts as unset, as it does in the other hosts.
//
//  The fallback is returned whether or not it exists: whether an absent sibling
//  is a skip or a failure stays each caller's decision, as it was before.
//
//  `packages/conformance/test/corpus-root-guard.test.ts` fails the build when any
//  other file spells the sibling path for itself.
// ============================================================================

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The variable that names the corpus root — the estate's own spelling. */
export const CORPUS_ROOT_ENV = 'FUARAN_WIRE_FIXTURES';

// dev-scripts → the repository root → the side-by-side root holding the corpus
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The canonical sibling clone, ../wire-format-fixtures beside this repository. */
export const siblingCorpusRoot = () => join(repoRoot, '..', 'wire-format-fixtures');

const holdsCorpus = (dir) => existsSync(join(dir, 'manifest.json'));

const named = (value) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * Resolve the corpus root: explicit argument, then FUARAN_WIRE_FIXTURES, then
 * the sibling clone. Throws when a named root holds no manifest.json.
 *
 * @param {{ explicit?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ root: string, source: 'explicit' | 'env' | 'sibling' }}
 */
export const resolveCorpusRoot = (options = {}) => {
  const env = options.env ?? process.env;
  const explicit = named(options.explicit);
  if (explicit !== undefined) {
    const root = resolve(explicit);
    if (!holdsCorpus(root))
      throw new Error(
        `the corpus root given explicitly (${JSON.stringify(explicit)}) does not name a ` +
          `conformance corpus (no manifest.json under ${root}). It is refused rather than ` +
          `ignored: point it at the corpus root itself.`,
      );
    return { root, source: 'explicit' };
  }
  const declared = named(env[CORPUS_ROOT_ENV]);
  if (declared !== undefined) {
    const root = resolve(declared);
    if (!holdsCorpus(root))
      throw new Error(
        `${CORPUS_ROOT_ENV}=${JSON.stringify(declared)} does not name a conformance corpus ` +
          `(no manifest.json under ${root}).\n` +
          `Point it at the corpus root, or unset it. It is refused rather than ignored: ` +
          `falling back would reach ../wire-format-fixtures, which from a worktree is the ` +
          `shared primary clone the override exists to leave alone.`,
      );
    return { root, source: 'env' };
  }
  return { root: siblingCorpusRoot(), source: 'sibling' };
};

/**
 * The corpus root as a path — `resolveCorpusRoot(options).root`. The form every
 * suite uses: it keeps its own existence check for the sibling, and a named
 * root that is wrong throws before the suite reads anything.
 *
 * @param {{ explicit?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {string}
 */
export const wireCorpusRoot = (options) => resolveCorpusRoot(options).root;
