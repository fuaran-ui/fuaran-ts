// ============================================================================
//  The host capability manifest (WIRE_FORMAT.md §27) — this host's generator.
//
//    node scripts/host-capability.mjs            # write host-capability-manifest.json
//    node scripts/host-capability.mjs --check    # exit 1 when the committed file is stale
//
//  test/host-capability.test.ts runs --check, so the gate and the CLI share one
//  implementation.
//
//  What it publishes (Phase 1938):
//
//    - `corpusFamilies` (§27.7) — every family the corpus enumerates and this
//      host's answer for it: "covered", or { pending | notApplicable: reason }.
//      It is a host STATEMENT, not a projection: no introspection can see which
//      families a test suite runs. The family gate in the same test derives the
//      family set from the corpus tree with `corpusFamilies(root)` below and
//      fails on a family this table does not name, or one the corpus no longer
//      has.
//    - the token families of §27.3 and their `tokens` (Phase 2332), PROJECTED
//      from this host's generated type model — the field tables
//      `@fuaran-ui/schema` generates from idl.json (`NODE_KINDS`, `KIND_FIELDS`,
//      `UNION_CASES`, `RECORD_FIELDS`). No token is written here: a construct
//      the generated layer gains is claimed on the next run, and one it loses is
//      dropped (§27.1). A row the IDL classes `hostOnly` never reaches the wire,
//      so it is no token. `hostedCases` stays not covered: the generated layer
//      types every hosted slot opaquely, so it holds no enumeration of the
//      discriminators inside one (§27.5) for a projection to read.
//
//  The generation reads no corpus (§27.3). The corpus enters only in the test,
//  which reads the claim back against the fixtures' vocabulary.
// ============================================================================

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KIND_FIELDS, NODE_KINDS, RECORD_FIELDS, UNION_CASES } from '@fuaran-ui/schema';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const repoRoot = join(packageRoot, '..', '..');
export const manifestPath = join(packageRoot, 'host-capability-manifest.json');

const pending = (why) => ({ pending: why });
const notApplicable = (why) => ({ notApplicable: why });

const NO_DESIGN_SEAM =
  'this host ships no design-provider seam: its records are read by a design-tool integration, and this host carries none';
const LAW_UNRUN = "this host's suite does not yet run this law family's vectors";
const HOSTED_OPAQUE =
  "this host's generated type model carries each hosted slot opaquely, so it holds no enumeration of the discriminators inside one (§27.5) and this host makes no claim in this family";

/** Every corpus family and this host's answer (§27.7), with the suite that runs each covered one. */
export const HOST_CORPUS_FAMILIES = {
  'node-round-trip': 'covered', // packages/ops/test/corpus.test.ts
  'op-round-trip': 'covered', // packages/ops/test/corpus.test.ts
  reject: 'covered', // packages/ops/test/corpus.test.ts
  'lenient-accept': 'covered', // packages/ops/test/corpus.test.ts
  'envelope-round-trip': 'covered', // packages/ops/test/corpus.test.ts
  formatting: pending(
    "this host's cell formatter (renderer-server formatNumber) is not yet driven from the formatting vectors",
  ),
  'envelope-reject': 'covered', // packages/ops/test/corpus.test.ts
  'elicitation-round-trip': 'covered', // packages/ops/test/corpus.test.ts
  'elicitation-reject': 'covered', // packages/ops/test/corpus.test.ts
  'elicitation-answer-accept': 'covered', // packages/ops/test/corpus.test.ts
  'elicitation-answer-reject': 'covered', // packages/ops/test/corpus.test.ts
  'contract-card-round-trip': 'covered', // packages/schema/test/customCard.test.ts
  'contract-card-reject': 'covered', // packages/schema/test/customCard.test.ts
  'teleport-decode': 'covered', // packages/op-stream/test/teleport.test.ts
  'teleport-reject': 'covered', // packages/op-stream/test/teleport.test.ts
  'style-observer': 'covered', // packages/style-observer/test/corpusConformance.test.ts
  'apply/duplicateIdsApply': 'covered', // packages/ops/test/duplicate-ids-apply-corpus.test.ts
  'apply/limitsApply': 'covered', // packages/ops/test/limits-apply-corpus.test.ts
  'apply/styleNormaliseApply': 'covered', // packages/ops/test/style-normalise-apply-corpus.test.ts
  'apply/skeletonApply': pending("this host's suite does not yet run the skeleton-apply vectors"),
  chain: 'covered', // packages/op-stream/test/parity.test.ts
  dag: 'covered', // packages/ops/test/dag.test.ts
  'decode-policy': 'covered', // packages/ops/test/decodePolicy.test.ts
  'design-seam-reject': notApplicable(NO_DESIGN_SEAM),
  'design-seam-round-trip': notApplicable(NO_DESIGN_SEAM),
  'devtools-relay': 'covered', // packages/renderer/test/relayCorpus.test.tsx
  'diff/treeDiff': notApplicable(
    'this host ships no structural tree diff: its op streams carry authored ops, and it never derives an op-script from a (before, after) pair',
  ),
  'laws/capabilityLaws': 'covered', // packages/ops/test/capabilityLaws.test.ts
  'laws/dataframeParity': pending(
    "this host's evaluator runs the drawn transformLaws sample; the authored dataframeParity cases are not run yet",
  ),
  'laws/decimal': 'covered', // packages/ops/test/decimalLaws.test.ts
  'laws/fieldLaws': 'covered', // packages/ops/test/fieldLaws.test.ts
  'laws/propagationLaws': pending(LAW_UNRUN),
  'laws/transformLaws': 'covered', // packages/ops/test/transformLaws.test.ts
  'lowers-to': pending("this host's suite does not yet run the lowers-to vectors"),
  'merge-conformance': 'covered', // packages/ops/test/merge.test.ts
  repair: 'covered', // packages/ops/test/repair.test.ts
  'row-encode': 'covered', // packages/ops/test/rowEncode.test.ts
  sanitization: 'covered', // packages/renderer/test/sanitizationCorpus.test.ts
  'stored-emissions': 'covered', // packages/ops/test/stored-emissions.test.ts
};

/**
 * The corpus family set, derived from the corpus tree (§27.7): each root manifest
 * fixture kind, and each top-level directory carrying its own manifest.json — one
 * family named by the directory, or one family `<directory>/<id>` per entry of that
 * manifest's `families` array of objects.
 */
export const corpusFamilies = (root) => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const found = new Set(manifest.fixtures.map((f) => f.kind));
  for (const name of readdirSync(root).sort()) {
    const own = join(root, name, 'manifest.json');
    if (!statSync(join(root, name)).isDirectory() || !existsSync(own)) continue;
    const members = JSON.parse(readFileSync(own, 'utf8')).families;
    if (
      Array.isArray(members) &&
      members.length > 0 &&
      members.every((m) => m !== null && typeof m === 'object' && !Array.isArray(m))
    ) {
      for (const m of members) {
        if (typeof m.id !== 'string' || m.id === '') {
          throw new Error(`${name}/manifest.json: a families entry carries no id`);
        }
        found.add(`${name}/${m.id}`);
      }
    } else {
      found.add(name);
    }
  }
  return found;
};

/** This host's generated type model: the tables `@fuaran-ui/schema` generates from idl.json. */
export const TYPE_MODEL = {
  kinds: NODE_KINDS,
  kindFields: KIND_FIELDS,
  unionCases: UNION_CASES,
  recordFields: RECORD_FIELDS,
};

const onWire = (rows) => rows.filter((r) => r.opt !== 'hostOnly').map((r) => r.name);

/**
 * The construct tokens (§27.2) a type model can author, sorted and deduplicated:
 * every kind, every union case, and every wire member of a kind, a union case or
 * a record. A pure function of the model, so the falsification test can hand it
 * a model with one construct removed.
 */
export const constructTokens = (model) => {
  const found = new Set();
  for (const tag of model.kinds) {
    found.add(`Kind.${tag}`);
    for (const f of onWire(model.kindFields[tag] ?? [])) found.add(`Kind.${tag}.${f}`);
  }
  for (const [union, cases] of Object.entries(model.unionCases)) {
    for (const [tag, rows] of Object.entries(cases)) {
      found.add(`${union}.${tag}`);
      for (const f of onWire(rows)) found.add(`${union}.${tag}.${f}`);
    }
  }
  for (const [record, rows] of Object.entries(model.recordFields)) {
    for (const f of onWire(rows)) found.add(`${record}.${f}`);
  }
  return [...found].sort();
};

/** The token families `constructTokens` projects; the sixth, `hostedCases`, is declared not covered. */
export const DERIVED_FAMILIES = ['kinds', 'kindFields', 'unionCases', 'caseFields', 'recordFields'];

/** The §27.3 token family a token belongs to, read from the §27.2 grammar alone. */
export const tokenFamily = (token) => {
  const segments = token.split('.');
  if (segments[0] === 'Kind') return segments.length === 2 ? 'kinds' : 'kindFields';
  if (segments.length === 3) return 'caseFields';
  return /^[A-Z]/.test(segments[1]) ? 'unionCases' : 'recordFields';
};

const sorted = (obj) =>
  Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((k) => [k, obj[k]]),
  );

/** The published artefact's exact bytes: §27.3 member order, sorted maps, two-space indent. */
export const render = () => {
  const hostVersion = JSON.parse(
    readFileSync(join(repoRoot, 'packages', 'ops', 'package.json'), 'utf8'),
  ).version;
  const family = (name) =>
    DERIVED_FAMILIES.includes(name) ? { covered: true } : { covered: false, reason: HOSTED_OPAQUE };
  const doc = {
    $manifest: 'fuaran.host-capability/1',
    host: 'fuaran-ts',
    hostVersion,
    corpusAuthority: null,
    generator: 'packages/conformance/scripts/host-capability.mjs',
    families: sorted({
      kinds: family('kinds'),
      kindFields: family('kindFields'),
      unionCases: family('unionCases'),
      caseFields: family('caseFields'),
      recordFields: family('recordFields'),
      hostedCases: family('hostedCases'),
    }),
    corpusFamilies: sorted(HOST_CORPUS_FAMILIES),
    tokens: constructTokens(TYPE_MODEL),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
};

const main = () => {
  const want = render();
  if (process.argv.includes('--check')) {
    const got = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
    if (got !== want) {
      process.stderr.write(
        'host-capability-manifest.json is not what this host declares — run: node scripts/host-capability.mjs\n',
      );
      process.exit(1);
    }
    return;
  }
  writeFileSync(manifestPath, want);
  process.stdout.write(`wrote ${manifestPath}\n`);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
