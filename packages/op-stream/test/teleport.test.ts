// ============================================================================
//  Teleport decoder — certified against the shared corpus family.
//
//  This suite used to carry the golden bundle as a string constant pasted into
//  the file. That proved something real — the TypeScript decoder decompresses
//  an F#-produced bundle, recomputes its SHA-256 integrity digest with the same
//  canonical renderer, and structurally decodes the tree — but it proved it in
//  a form no other host could reach. A third host had nothing to certify
//  against, and a change to the bundle's shape was invisible to every host that
//  did not hold the constant. That is a one-host self-check, not conformance.
//
//  The bundle now lives in the shared wire-format corpus as its own fixture
//  family (`teleport-decode` / `teleport-reject`, WIRE_FORMAT.md §17.6), and
//  this suite is driven entirely by the manifest: every accept vector must
//  decode to the canonical envelope the corpus holds, and every reject vector
//  must be refused with the case and at the position §17.6 fixes. Nothing here
//  is private to this host — a fourth host certifies its own teleport decoder
//  by reading the same files.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeNode, jsonField, parse, renderAstCanonical } from '@fuaran-ui/ops';
import { describe, expect, it } from 'vitest';

import {
  decodeTeleport,
  defaultTeleportLimits,
  TELEPORT_FORMAT_PREFIX,
  type TeleportError,
  type TeleportLimits,
} from '../src/index.js';
import type { JsonAst } from '@fuaran-ui/ops';
import type { Node } from '@fuaran-ui/schema';

const here = dirname(fileURLToPath(import.meta.url));
// packages/op-stream/test → workspace-root/wire-format-fixtures
const corpusRoot = join(here, '..', '..', '..', '..', 'wire-format-fixtures');
const manifestPath = join(corpusRoot, 'manifest.json');
const readFixture = (relPath: string): string => readFileSync(join(corpusRoot, relPath), 'utf8');

/** The manifest rows this family uses (WIRE_FORMAT.md §12). */
interface ManifestFixture {
  readonly id: string;
  readonly kind: string;
  readonly decoder: string;
  readonly inputFile: string;
  readonly expectedFile?: string;
  readonly expectedErrorCode?: string;
  readonly expectedPath?: string;
  readonly description: string;
}

/** A `teleport-*` fixture's input document: the bundle string, plus the size
 *  ceilings this vector is to be run under when it names any (§17.6). */
interface TeleportInput {
  readonly encoded: string;
  readonly limits?: Partial<TeleportLimits>;
}

const corpusPresent = existsSync(manifestPath);

const fixturesOfKind = (kind: string): readonly ManifestFixture[] => {
  if (!corpusPresent) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    readonly fixtures: readonly ManifestFixture[];
  };
  return manifest.fixtures.filter((f) => f.kind === kind);
};

const decodeFixtures = fixturesOfKind('teleport-decode');
const rejectFixtures = fixturesOfKind('teleport-reject');

const inputOf = (f: ManifestFixture): TeleportInput =>
  JSON.parse(readFixture(f.inputFile)) as TeleportInput;

const limitsOf = (input: TeleportInput): TeleportLimits => ({
  ...defaultTeleportLimits,
  ...input.limits,
});

/** The envelope member `name`, as its parsed AST — `undefined` when the
 *  envelope omits it (§17.2 omits `state` / `history` / `chainHead` when
 *  empty). */
const member = (envelope: JsonAst, name: string): JsonAst | undefined =>
  envelope.kind === 'JObject' ? jsonField(envelope.fields, name) : undefined;

/** The canonical bytes of envelope member `name` — what a conformant host must
 *  produce for it. */
const memberBytes = (envelope: JsonAst, name: string): string | undefined => {
  const ast = member(envelope, name);
  return ast === undefined ? undefined : renderAstCanonical(ast);
};

/** The `$`-rooted position a §17.4 error case concerns. The mapping is
 *  NORMATIVE and lives in WIRE_FORMAT.md §17.6, not here: a §17.4 error is a
 *  typed case rather than a `(code, path)` pair, so fixing the position in the
 *  specification is what stops two conformant hosts disagreeing about a fixture
 *  while both pass. This implements that table and nothing else. */
const pathOf = (error: TeleportError): string => {
  switch (error.code) {
    case 'InvalidEnvelope':
      return error.path;
    case 'UnsupportedVersion':
      return '$.bundle';
    case 'DigestMismatch':
      return '$.digest';
    case 'TreeDecode':
      return error.error.path;
    default:
      // Oversize / InvalidFormat / InvalidJson — the failure precedes any envelope.
      return '$';
  }
};

/** Plain JSON → the AST the canonical renderer consumes. `decodeTeleport`
 *  hands `state` back as ordinary JavaScript values (that is its contract — a
 *  host seats them into its own state store), so re-rendering them canonically
 *  is how this suite compares them to corpus bytes rather than to a
 *  `JSON.stringify` spelling. */
const toAst = (value: unknown): JsonAst => {
  if (value === null) return { kind: 'JNull' };
  if (typeof value === 'boolean') return { kind: 'JBool', value };
  if (typeof value === 'number') return { kind: 'JNumber', value };
  if (typeof value === 'string') return { kind: 'JString', value };
  if (Array.isArray(value)) return { kind: 'JArray', items: value.map(toAst) };
  const fields = new Map<string, JsonAst>();
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) fields.set(k, toAst(v));
  return { kind: 'JObject', fields };
};

// ─── The family must EXIST ───────────────────────────────────────────────────
//
// `--emit-corpus` rewrites the root manifest wholesale from the reference
// emitter's own fixture list, and that emitter builds no teleport fixtures yet
// (WIRE_FORMAT.md §12). A regeneration can therefore drop this family in
// passing, leaving `teleport/` orphaned on disk and every host quietly
// un-certified. Failing here — rather than reporting an empty suite green — is
// what turns that into a named gate failure in the repo that noticed.

describe.skipIf(!corpusPresent)('teleport corpus family', () => {
  it('is registered in the manifest', () => {
    expect(
      decodeFixtures.length,
      'the corpus carries no `teleport-decode` fixtures. If the corpus was just regenerated, ' +
        '`--emit-corpus` rewrote manifest.json without this family — restore the ' +
        '`teleport-decode` / `teleport-reject` entries (WIRE_FORMAT.md §12).',
    ).toBeGreaterThan(0);
    expect(rejectFixtures.length).toBeGreaterThan(0);
  });

  it('names the teleport entry point for every entry', () => {
    for (const f of [...decodeFixtures, ...rejectFixtures]) expect(f.decoder).toBe('teleport');
  });
});

// ─── Accept ──────────────────────────────────────────────────────────────────

describe.skipIf(!corpusPresent)('decodeTeleport — corpus accept vectors', () => {
  for (const f of decodeFixtures) {
    it(`${f.id} decodes to the envelope the corpus holds`, async () => {
      const input = inputOf(f);
      const result = await decodeTeleport(input.encoded, limitsOf(input));

      expect(result.ok, `${f.id}: ${f.description}`).toBe(true);
      if (!result.ok) return;

      const expectedRaw = readFixture(f.expectedFile as string);
      const parsed = parse(expectedRaw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const envelope = parsed.value;

      // The corpus payload is itself canonical bytes. A hand edit that
      // reordered a member or respaced the document would make every
      // comparison below a comparison against something §2 does not permit.
      expect(renderAstCanonical(envelope)).toBe(expectedRaw);

      // The carried integrity digest, recomputed independently in TypeScript.
      expect(`"${result.value.digest}"`).toBe(memberBytes(envelope, 'digest'));

      // The decoded tree re-encodes to the SAME canonical bytes the corpus
      // holds for the envelope's `tree` member. This is the cross-host claim:
      // bytes in, bytes out, no shared type model between the two hosts.
      expect(encodeNode(result.value.tree as Node<unknown>)).toBe(memberBytes(envelope, 'tree'));

      // State, history and chain head resume exactly as carried — each
      // compared through the canonical renderer, never through JSON.stringify,
      // whose number and escape rules are not §2's.
      const stateBytes = memberBytes(envelope, 'state');
      expect(renderAstCanonical(toAst(result.value.state))).toBe(stateBytes ?? '{}');

      const historyAst = member(envelope, 'history');
      const expectedHistory =
        historyAst !== undefined && historyAst.kind === 'JArray'
          ? historyAst.items.map(renderAstCanonical)
          : [];
      expect(result.value.history.map(renderAstCanonical)).toEqual(expectedHistory);

      const chainHeadBytes = memberBytes(envelope, 'chainHead');
      expect(result.value.chainHead === undefined ? undefined : `"${result.value.chainHead}"`).toBe(
        chainHeadBytes,
      );
    });
  }
});

// ─── Reject ──────────────────────────────────────────────────────────────────

describe.skipIf(!corpusPresent)('decodeTeleport — corpus reject vectors', () => {
  for (const f of rejectFixtures) {
    it(`${f.id} is refused`, async () => {
      const input = inputOf(f);
      const result = await decodeTeleport(input.encoded, limitsOf(input));

      expect(result.ok, `${f.id} decoded, but ${f.description}`).toBe(false);
      if (result.ok) return;

      expect(result.error.code, f.description).toBe(f.expectedErrorCode);
      // Prefix matching, per §12 — a host may name a position deeper than the
      // corpus's stated slot and is then more precise, not divergent.
      expect(pathOf(result.error).startsWith(f.expectedPath as string)).toBe(true);
    });
  }
});

// ─── Decoder contract, corpus-independent ────────────────────────────────────
//
// These two carry no bundle and no golden constant: they hold in a standalone
// clone with no corpus beside it, where every suite above skips. They assert
// the shape of a refusal, never the content of any artefact.

describe('decodeTeleport — refusals that need no fixture', () => {
  it('rejects a string with no format tag', async () => {
    const result = await decodeTeleport('not a teleport bundle');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('InvalidFormat');
  });

  it('rejects an oversize input before doing any work', async () => {
    const huge = TELEPORT_FORMAT_PREFIX + 'A'.repeat(defaultTeleportLimits.maxEncodedChars + 1);
    const result = await decodeTeleport(huge);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('Oversize');
  });
});
