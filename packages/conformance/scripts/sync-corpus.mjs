// ============================================================================
//  Sync — or CHECK — the bundled corpus snapshot against the authoritative
//  wire-format corpus.
//
//  The authoritative corpus lives beside this repo at ../wire-format-fixtures
//  (its own repo, cloned into the canonical side-by-side layout). This script
//  clean-copies the certification payload set into this package's corpus/
//  directory; the authority's conformance/ tooling subdirectory and its other
//  non-certification material are intentionally NOT copied (they are the
//  in-house cross-host gate, not part of the published kit).
//
//    node scripts/sync-corpus.mjs           # write the snapshot (after a regen)
//    node scripts/sync-corpus.mjs --check   # report drift, write nothing
//
//  --check is the guard: it exits 1 and NAMES every drifted, missing and extra
//  file. test/corpus-sync.test.ts runs exactly this mode, so the gate and the
//  CLI share one implementation and cannot disagree.
//
//  WHICH FILES ARE THE PAYLOAD is derived from the authority's manifest.json,
//  never from a hardcoded directory list. manifest.json is the authoritative
//  enumeration of the corpus, so a NEW fixture family — a new `kind` writing
//  into a new directory — is picked up here automatically. A hardcoded list
//  would silently neither copy nor check it: the same forward-coupling gap
//  (WIRE_FORMAT.md §11) that this guard exists to close, one level further
//  down.
// ============================================================================

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
// packages/conformance → packages → fuaran-ts → the workspace side-by-side root
const authority = join(packageRoot, '..', '..', '..', 'wire-format-fixtures');
const snapshot = join(packageRoot, 'corpus');

const checkOnly = process.argv.includes('--check');

if (!existsSync(join(authority, 'manifest.json'))) {
  console.error(
    `Authoritative corpus not found at ${authority}\n` +
      `This script requires the canonical workspace layout (the wire-format ` +
      `fixtures corpus as a sibling of this fuaran-ts checkout).`,
  );
  process.exit(1);
}

/** The top-level fixture directories the manifest actually references. */
const payloadDirs = (root) => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const dirs = new Set();
  for (const fixture of manifest.fixtures ?? [])
    for (const value of Object.values(fixture))
      if (typeof value === 'string' && value.endsWith('.json') && value.includes('/'))
        dirs.add(value.split('/')[0]);
  return [...dirs].sort();
};

/** Every certification file under `root`, relative and sorted. Directories are
 *  copied wholesale, so the comparison covers companion files a fixture entry
 *  does not name directly. A directory absent from `root` contributes nothing —
 *  the caller's set difference reports it, rather than an ENOENT crash. */
const certificationFiles = (root, dirs) => {
  const files = ['manifest.json', 'schema.json'].filter((f) => existsSync(join(root, f)));
  for (const dir of dirs) {
    if (!existsSync(join(root, dir))) continue;
    for (const entry of readdirSync(join(root, dir))) files.push(`${dir}/${entry}`);
  }
  return files.sort();
};

const dirs = payloadDirs(authority);

if (!checkOnly) {
  rmSync(snapshot, { recursive: true, force: true });
  mkdirSync(snapshot, { recursive: true });

  for (const rel of certificationFiles(authority, dirs)) {
    mkdirSync(dirname(join(snapshot, rel)), { recursive: true });
    copyFileSync(join(authority, rel), join(snapshot, rel));
  }

  console.log(
    `Corpus snapshot synced: ${authority} → ${snapshot}\n` + `  families: ${dirs.join(', ')}`,
  );
  process.exit(0);
}

// ---- check mode -----------------------------------------------------------

const expected = certificationFiles(authority, dirs);
const actual = new Set(certificationFiles(snapshot, dirs));

const missing = expected.filter((f) => !actual.has(f));
const extra = [...actual].filter((f) => !expected.includes(f)).sort();
const drifted = expected
  .filter((f) => actual.has(f))
  .filter((f) => !readFileSync(join(authority, f)).equals(readFileSync(join(snapshot, f))));

if (missing.length === 0 && extra.length === 0 && drifted.length === 0) {
  console.log(
    `Corpus snapshot is in sync with the authority (${expected.length} files; ` +
      `families: ${dirs.join(', ')}).`,
  );
  process.exit(0);
}

const report = (label, files) =>
  files.length ? `\n  ${label} (${files.length}):\n${files.map((f) => `    ${f}`).join('\n')}` : '';

console.error(
  `Bundled corpus snapshot has DRIFTED from the authoritative corpus.\n` +
    `  authority: ${authority}\n` +
    `  snapshot:  ${snapshot}` +
    report('missing from the snapshot', missing) +
    report('present in the snapshot but not the authority', extra) +
    report('present in both but not byte-identical', drifted) +
    `\n\nFix: re-run the sync from this package —\n` +
    `  pnpm --filter @fuaran-ui/conformance sync-corpus\n` +
    `then commit the snapshot alongside the corpus regeneration that caused it.`,
);
process.exit(1);
