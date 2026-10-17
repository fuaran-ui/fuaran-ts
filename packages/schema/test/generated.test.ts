// ============================================================================
//  Phase 2073 — the generated module is what idl.json projects, and nothing else.
//
//  `src/generated.ts` is this host's projection of the specification corpus's
//  `idl.json` (see dev-scripts/generate-idl.mjs). Two drift checks, on the
//  pattern the sibling hosts use:
//
//    1. the recorded IDL_SHA256 equals the corpus's idl.json bytes — red the
//       moment the corpus moves and this host has not been regenerated;
//    2. a regeneration equals the committed module byte-for-byte — red on a
//       hand edit of the generated file, or a generator change not re-run.
//
//  Plus the go-red proof (a moved IDL changes both), and the one thing the
//  hand-kept tables this module replaces had drifted on: the binding slots.
// ============================================================================

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BINDING_SLOTS,
  ENUM_CASES,
  IDL_SHA256,
  KIND_CATEGORY,
  KIND_FIELDS,
  NODE_KINDS,
  NODE_KIND_NAMES,
  type BadgeVariant,
  type IdlSpec,
  type NodeKindName,
  type TextSource,
} from '../src/index.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';
import {
  OUTPUT_PATH,
  generateFormatted,
  generateIdlModule,
} from '../../../dev-scripts/generate-idl.mjs';

const IDL = join(wireCorpusRoot(), 'idl.json');
const present = existsSync(IDL);
if (!present)
  console.warn(
    `[generated] SKIPPED: idl.json is not at ${IDL}. The generated module is NOT being checked ` +
      `against the corpus this run. Check the wire-format corpus out beside this repo to run it.`,
  );

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(!present)('generated.ts is what idl.json projects', () => {
  const idl = readFileSync(IDL);

  it('records the hash of the idl.json it was generated from', () => {
    expect(IDL_SHA256).toBe(sha256(idl));
  });

  it('equals a regeneration byte-for-byte', async () => {
    const committed = readFileSync(OUTPUT_PATH, 'utf8');
    expect(committed).toBe(await generateFormatted(idl));
  });

  it('goes red on a moved idl.json (the falsifier is not vacuous)', () => {
    const moved = Buffer.from(
      idl.toString('utf8').replace('"Neutral",', '"Neutral", "ProbeCase",'),
      'utf8',
    );
    expect(moved.equals(idl)).toBe(false);
    expect(sha256(moved)).not.toBe(IDL_SHA256);
    expect(generateIdlModule(moved)).not.toBe(generateIdlModule(idl));
    expect(generateIdlModule(moved)).toContain("'ProbeCase'");
  });
});

describe('the tables are consistent with each other', () => {
  it('every kind has a category and a field table', () => {
    for (const k of NODE_KINDS) {
      expect(KIND_CATEGORY[k]).toBeTypeOf('string');
      expect(Array.isArray(KIND_FIELDS[k])).toBe(true);
    }
    expect(new Set(NODE_KIND_NAMES)).toEqual(new Set(NODE_KINDS));
  });

  it('an enum table is a non-empty list of distinct wire tokens', () => {
    for (const [name, cases] of Object.entries(ENUM_CASES)) {
      expect(cases.length, name).toBeGreaterThan(0);
      expect(new Set(cases).size, name).toBe(cases.length);
    }
  });

  // The three hand-kept slot tables this host carried (renderer `declaredSlots`,
  // ai-tools `extractBindingSlots` / `bindingForSlot`) all omitted these: every
  // one is a `Binding<…>` member the IDL declares, and the table is now derived.
  it('BINDING_SLOTS names the slots the hand-kept tables omitted', () => {
    const slots = (k: NodeKindName): readonly string[] => BINDING_SLOTS[k].map((s) => s.slot);
    expect(slots('Modal')).toContain('Open');
    expect(slots('Toast')).toContain('Open');
    expect(slots('Embed')).toContain('Src');
    expect(slots('Switch')).toContain('On');
    expect(slots('Link')).toContain('Href');
    expect(slots('Image')).toContain('Src');
    expect(slots('Media')).toContain('Src');
    expect(slots('DataGrid')).toContain('RowTotal');
    expect(slots('Select')).toContain('Values');
    // And still every slot the hand tables did name.
    expect(slots('Metric')).toEqual(['Value', 'Trend']);
    expect(slots('Select')).toEqual(['Source', 'Value', 'Disabled', 'Values']);
    expect(slots('Tabs')).toEqual(['ActiveIndex', 'ActiveTag']);
  });
});

// ─── The field table as a type: a compile-time pin ───────────────────────────
//
// `IdlSpec<'Badge'>` is read off the generated table; a member the IDL gains
// reaches the spec interface that extends it with no hand edit, and a member
// the hand interface spells differently fails to compile at that interface.

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Flat<T> = { [K in keyof T]: T[K] };

const badgeIsItsTable: Equal<
  Flat<IdlSpec<'Badge'>>,
  { readonly label: TextSource; readonly variant: BadgeVariant }
> = true;
void badgeIsItsTable;
