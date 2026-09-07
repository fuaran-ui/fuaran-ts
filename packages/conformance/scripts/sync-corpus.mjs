// ============================================================================
//  Sync — or CHECK, or DECLARE — the bundled corpus snapshot against the
//  authoritative wire-format corpus.
//
//  The authoritative corpus lives beside this repo at ../wire-format-fixtures
//  (its own repo, cloned into the canonical side-by-side layout). This script
//  clean-copies the certification payload set into this package's corpus/
//  directory; the authority's conformance/ tooling subdirectory and its other
//  non-certification material are intentionally NOT copied (they are the
//  in-house cross-host gate, not part of the published kit).
//
//    node scripts/sync-corpus.mjs                   # write the snapshot (after a regen)
//    node scripts/sync-corpus.mjs --check           # report byte drift, write nothing
//    node scripts/sync-corpus.mjs --check-distance  # report how far behind the authority
//    node scripts/sync-corpus.mjs --declare         # (re)write this snapshot's records
//                                                   #   into the authority's copies.json
//
//  --check is the guard: it NAMES every drifted, missing and extra file.
//  test/corpus-sync.test.ts runs exactly this mode, so the gate and the CLI
//  share one implementation and cannot disagree.
//
//  WHICH FILES ARE THE PAYLOAD is derived from the authority's manifest.json,
//  never from a hardcoded directory list. manifest.json is the authoritative
//  enumeration of the corpus, so a NEW fixture family — a new `kind` writing
//  into a new directory — is picked up here automatically. A hardcoded list
//  would silently neither copy nor check it: the same forward-coupling gap
//  (WIRE_FORMAT.md §11) that this guard exists to close, one level further
//  down.
//
//  ---- the provenance sentinel -------------------------------------------
//
//  Every sync writes corpus/snapshot.json recording the authority commit the
//  snapshot was taken from:
//
//    {"authorityCommit": "<40 lowercase hex>", "kind": "corpusSnapshot"}
//
//  The shape is the Python host's, byte for byte — two-space indent, sorted
//  keys, a trailing newline, no platform newline translation — so the two
//  bundled snapshots answer "behind by N" the same way and a reader comparing
//  them is comparing the same thing. It lives at the snapshot ROOT, outside
//  every family directory, so the file-set comparison below never sees it and
//  needs no exclusion.
//
//  A distance is not a byte comparison and neither substitutes for the other.
//  The byte check says WHICH files differ; the sentinel says HOW FAR the
//  snapshot is behind, which a checkout holding only the snapshot can still
//  read — and which stays answerable on a machine that has no authority clone
//  to compare bytes against at all.
//
//  --check-distance answers the second question, on the Python host's exit
//  contract exactly:
//
//    0 — the snapshot records the authority's current HEAD
//    2 — the snapshot is BEHIND (or otherwise differs from) the authority
//    1 — the check could not be MADE (no authority beside this checkout, the
//        authority is not a git clone, or the snapshot carries no sentinel)
//
//  The 1 and 2 cases are kept apart deliberately. A check that reported drift
//  it had not measured would be the same vacuous green this guard exists to
//  prevent, read backwards. Both are non-zero, so a gate that refuses on any
//  non-zero refuses both; only the wording distinguishes them.
//
//  IT IS A SEPARATE FLAG, and that is a decision rather than an oversight.
//  --check is what test/corpus-sync.test.ts runs, so whatever --check refuses
//  is what reddens this repo's build. The authority is a REPOSITORY, not just a
//  payload: a commit to it that touches no bundled fixture — the copies.json
//  this very phase added, a spec-document edit, a sibling family this host does
//  not bundle — moves HEAD and changes nothing anyone here needs to re-sync.
//  Folding the distance into --check turned exactly that into a red build, on
//  the first run of this gate after the copies.json commit landed. So the
//  distance is a release-path and sweep question (where a conservative "the
//  authority moved, re-sync to be sure" is the right answer, and is what the
//  Python host's release gate does with it), never a per-PR one. --check still
//  PRINTS the distance as an advisory line, because a reader of a byte report
//  wants it; it just does not decide the exit.
//
//  ---- the estate declaration --------------------------------------------
//
//  --declare (re)writes this snapshot's per-file records into the authority's
//  own copies.json, the estate's generated-cross-repo-copy registry that
//  `roadmapctl copies <workspace-root>` projects on every sweep. The record
//  set is derived from the same payload list the sync copies, so the
//  declaration cannot drift from what is actually bundled — a hand-kept list
//  would be exactly the hand-kept copy the registry exists to remove.
//
//  The Python host declares into the SAME file, so this step MERGES: it
//  replaces only the records whose copy lives under this snapshot, and leaves
//  every other producer-declared record untouched. Both writers emit the same
//  byte formatting, so whichever runs second does not re-churn the other's
//  rows.
// ============================================================================

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
// packages/conformance → packages → fuaran-ts → the workspace side-by-side root
const authority = join(packageRoot, '..', '..', '..', 'wire-format-fixtures');
const snapshot = join(packageRoot, 'corpus');
const sentinel = join(snapshot, 'snapshot.json');

const SENTINEL_KIND = 'corpusSnapshot';
const SHA_RE = /^[0-9a-f]{40}$/;
const RESYNC_COMMAND = 'pnpm --filter @fuaran-ui/conformance sync-corpus';
/** Workspace-root-relative, matching the `regen` clause the sweep quotes verbatim. */
const REGEN_COMMAND = `cd Fuaran/Fuaran-UI/fuaran-ts; ${RESYNC_COMMAND}`;

const checkOnly = process.argv.includes('--check');
const distanceOnly = process.argv.includes('--check-distance');
const declareOnly = process.argv.includes('--declare');

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

// ---- the provenance sentinel ----------------------------------------------

/** Run a read-only git command in `repo`; `null` when it cannot answer.
 *
 *  Every failure mode folds into `null` on purpose — no git on PATH, the
 *  directory not being a clone, a shallow checkout that cannot resolve a
 *  commit. The callers turn `null` into "I could not measure this" rather than
 *  into a number, because a fabricated distance is worse than an absent one. */
const git = (repo, ...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000 });
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout.trim();
};

/** The authority clone's HEAD commit, or `null` when it cannot be read. */
const authorityHead = () => {
  const sha = git(authority, 'rev-parse', 'HEAD');
  return sha && SHA_RE.test(sha) ? sha : null;
};

/** The authority commit the committed snapshot records, if it records one. */
const recordedCommit = () => {
  let payload;
  try {
    payload = JSON.parse(readFileSync(sentinel, 'utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const sha = payload.authorityCommit;
  return typeof sha === 'string' && SHA_RE.test(sha) ? sha : null;
};

/** How many authority commits land after `sha`; `null` when the clone cannot
 *  answer — most commonly a shallow checkout, which holds HEAD but not the
 *  commit the snapshot names. The check then says the distance is unknown
 *  rather than guessing at it. */
const commitsBehind = (sha) => {
  const count = git(authority, 'rev-list', '--count', `${sha}..HEAD`);
  return count !== null && /^\d+$/.test(count) ? Number(count) : null;
};

/** Record the authority commit this snapshot was taken from.
 *
 *  A clone whose HEAD cannot be read records `null` rather than nothing: the
 *  snapshot is still a valid corpus, and --check then reports honestly that it
 *  cannot tell how old it is. Silently omitting the field would make an
 *  unmeasurable snapshot indistinguishable from a fresh one. */
const writeSentinel = () => {
  const head = authorityHead();
  // Keys in sorted order (authorityCommit, kind) and an explicit "\n": the
  // Python host writes json.dumps(..., indent=2, sort_keys=True) + "\n" with
  // newline="" — no platform translation — and these bytes must match.
  writeFileSync(
    sentinel,
    `${JSON.stringify({ authorityCommit: head, kind: SENTINEL_KIND }, null, 2)}\n`,
    'utf8',
  );
  return head;
};

// ---- the estate declaration ------------------------------------------------

/** The workspace root: the directory the estates sit under, three levels above
 *  the authority in the canonical layout. `roadmapctl copies` resolves every
 *  consumer path against it, and there is no other root that can address a file
 *  in a different repo. */
const workspaceRoot = resolve(authority, '..', '..', '..');
const posix = (p) => p.split('\\').join('/');
const copiesManifest = join(authority, 'copies.json');

/** JSON carries no comment syntax, so the header note the registry's readers
 *  need is a field. `roadmapctl copies` reads `kind`, `producer` and `records`
 *  and ignores anything else, so this rides along unmolested. It is seeded once
 *  and then preserved verbatim by both writers, so editing it by hand survives
 *  the next declare. */
const DEFAULT_NOTE =
  'GENERATED — do not hand-edit the records. Each bundled-corpus record is (re)written by ' +
  'the host that bundles the snapshot: fuaran-ts via `pnpm --filter @fuaran-ui/conformance ' +
  'declare-corpus`, fuaran-py via `python conformance/sync_corpus.py --declare`. Each writer ' +
  'replaces only the records whose copy lives under its own snapshot, so the two co-own this ' +
  'file without clobbering each other. fuaran-go and fuaran-rs are DELIBERATELY UNDECLARED: ' +
  'they bundle no snapshot and read this corpus directly from the workspace (their CI checks ' +
  'it out to ../wire-format-fixtures), so there is no copy of it that can go stale.';

const declare = () => {
  const dirs = payloadDirs(authority);
  const files = certificationFiles(authority, dirs);

  const prefix = posix(relative(workspaceRoot, snapshot));
  if (prefix === '' || prefix.startsWith('..')) {
    console.error(
      `Cannot declare: the bundled snapshot at ${snapshot} does not sit under the\n` +
        `workspace root inferred from the authority (${workspaceRoot}). The estate copy\n` +
        `registry addresses consumers by workspace-relative path, so a checkout outside\n` +
        `the canonical side-by-side layout cannot declare — re-run from one that is.`,
    );
    process.exit(1);
  }

  // One record per COPY, not per source. A source bundled by two hosts is two
  // records, because a record carries exactly one `regen` clause and the two
  // hosts are re-synced by different commands — the sweep must be able to quote
  // the right one at whoever is reading it.
  const mine = files.map((rel) => ({
    source: rel,
    consumers: [`${prefix}/${rel}`],
    check: 'fingerprint',
    regen: REGEN_COMMAND,
  }));

  // Merge: keep every record that is not about a copy under THIS snapshot.
  let existing = [];
  let note = '';
  if (existsSync(copiesManifest)) {
    const parsed = JSON.parse(readFileSync(copiesManifest, 'utf8'));
    if (parsed.kind !== 'copies')
      throw new Error(`${copiesManifest} exists but is not a "kind": "copies" manifest`);
    note = typeof parsed.note === 'string' ? parsed.note : '';
    existing = (parsed.records ?? []).filter(
      (r) => !(r.consumers ?? []).some((c) => c.startsWith(`${prefix}/`)),
    );
  }

  const records = [...existing, ...mine].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      (a.consumers[0] ?? '').localeCompare(b.consumers[0] ?? ''),
  );

  writeFileSync(
    copiesManifest,
    `${JSON.stringify(
      {
        kind: 'copies',
        producer: 'wire-format-fixtures',
        note: note || DEFAULT_NOTE,
        records,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(
    `Declared ${mine.length} bundled snapshot file(s) as estate copies in ${copiesManifest}\n` +
      `  consumer prefix: ${prefix}\n` +
      `  total records now: ${records.length}`,
  );
  process.exit(0);
};

// ---- the distance measurement ----------------------------------------------
//
// How far behind the authority the committed snapshot is, per its sentinel.
// Returns the state alongside the line, so the caller decides what a distance
// COSTS — --check-distance exits on it, --check merely reports it.

const measureDistance = () => {
  const snapshotSha = recordedCommit();
  const head = authorityHead();

  if (snapshotSha === null)
    return {
      state: 'unmeasured',
      line:
        `corpus distance UNMEASURED: the snapshot at ${snapshot} records no authority commit ` +
        `(expected snapshot.json to carry a 40-character authorityCommit) — ` +
        `re-sync to record one: ${RESYNC_COMMAND}`,
    };

  if (head === null)
    return {
      state: 'unmeasured',
      line:
        `corpus distance UNMEASURED: cannot read HEAD of the authority at ${authority} ` +
        `(not a git clone, or git is unavailable)`,
    };

  if (snapshotSha === head)
    return {
      state: 'sync',
      line: `corpus snapshot records the authority's current HEAD (${head})`,
    };

  const behind = commitsBehind(snapshotSha);
  const headline =
    behind === null
      ? 'snapshot behind authority by an unknown number of commits'
      : behind === 0
        ? // HEAD is not a descendant of the recorded commit: the authority's
          // history was rewritten, or the snapshot came off another branch. Not
          // "behind", and calling it that would be a guess.
          'snapshot does not match the authority and is not behind it (rewritten history, or another branch)'
        : `snapshot behind authority by ${behind} commit${behind === 1 ? '' : 's'}`;

  return {
    state: 'behind',
    line:
      `${headline} (authority ${head}, snapshot ${snapshotSha})\n` +
      `re-sync and commit the snapshot: ${RESYNC_COMMAND}`,
  };
};

// ---- dispatch --------------------------------------------------------------

const dirs = payloadDirs(authority);

if (declareOnly) declare();

if (distanceOnly) {
  const { state, line } = measureDistance();
  if (state === 'sync') {
    console.log(line);
    process.exit(0);
  }
  console.error(line);
  process.exit(state === 'behind' ? 2 : 1);
}

if (!checkOnly) {
  rmSync(snapshot, { recursive: true, force: true });
  mkdirSync(snapshot, { recursive: true });

  for (const rel of certificationFiles(authority, dirs)) {
    mkdirSync(dirname(join(snapshot, rel)), { recursive: true });
    copyFileSync(join(authority, rel), join(snapshot, rel));
  }

  const head = writeSentinel();

  console.log(
    `Corpus snapshot synced: ${authority} → ${snapshot}\n` +
      `  families: ${dirs.join(', ')}\n` +
      `  authority commit: ${head ?? 'unknown'}`,
  );
  process.exit(0);
}

// ---- check mode -----------------------------------------------------------

const expected = certificationFiles(authority, dirs);
const actual = new Set(certificationFiles(snapshot, dirs));

const missing = expected.filter((f) => !actual.has(f));
const extra = [...actual].filter((f) => !expected.includes(f)).sort();

// Content drift and line-ending drift are reported separately. Both repos pin
// `* text=auto eol=lf`, so a COMMITTED file is LF on both sides and this split
// never fires from a clean checkout — but the corpus generator writes the
// platform newline, so a freshly regenerated authority working tree can be CRLF
// while the snapshot is still the LF a checkout produced. Lumping that in with
// content drift would report all ~300 files as changed when nothing was, which
// is how a guard gets ignored. The fix is the same sync either way.
const stripCr = (buf) => Buffer.from(buf.toString('binary').replace(/\r\n/g, '\n'), 'binary');
const differing = expected
  .filter((f) => actual.has(f))
  .map((f) => ({
    f,
    a: readFileSync(join(authority, f)),
    s: readFileSync(join(snapshot, f)),
  }))
  .filter(({ a, s }) => !a.equals(s));

const eolOnly = differing.filter(({ a, s }) => stripCr(a).equals(stripCr(s))).map(({ f }) => f);
const drifted = differing.filter(({ a, s }) => !stripCr(a).equals(stripCr(s))).map(({ f }) => f);

const bytesDrifted =
  missing.length > 0 || extra.length > 0 || drifted.length > 0 || eolOnly.length > 0;

// The distance rides along as an ADVISORY line — reported, never fatal here.
// See the header: a corpus-repo commit touching no bundled fixture moves HEAD
// and needs no re-sync, so it must not redden this repo's build. Ask
// --check-distance when you want it to decide something.
const { line: distanceLine } = measureDistance();

if (!bytesDrifted) {
  console.log(
    `Corpus snapshot is in sync with the authority (${expected.length} files; ` +
      `families: ${dirs.join(', ')}).\n${distanceLine}`,
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
    report('identical content, different line endings', eolOnly) +
    `\n\nFix: re-run the sync from this package —\n` +
    `  ${RESYNC_COMMAND}\n` +
    `then commit the snapshot alongside the corpus regeneration that caused it.\n` +
    distanceLine,
);

process.exit(1);
