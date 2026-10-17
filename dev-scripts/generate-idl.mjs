// ============================================================================
//  This host's generator over the wire corpus's published `idl.json` (Phase 2073).
//
//  The vocabulary is declared once, in the specification corpus's `idl.json`;
//  everything STRUCTURAL in this host is a projection of it. This script is the
//  host's own — a small dependency-free Node script that reads the IDL as DATA
//  and writes `packages/schema/src/generated.ts`: the enum case tables, the kind
//  set with its categories, every kind's / record's / union case's / op's field
//  table (optionality, type, declared default), the node envelope's fields, the
//  hardening table, and — derived from those — the kinds-by-category, child-slot
//  and binding-slot tables. Behaviour (decode policy, leniency, refusal wording,
//  rendering) stays hand-written in the modules that read the tables.
//
//  Ruling (2026-10-16): host-owned generators over the published IDL. Hosts are
//  siblings — no codec code is shared with another host, and reading a
//  language-neutral data artefact with the host's own generator is not a
//  transpile.
//
//  The IDL is resolved the way every corpus reader here resolves the corpus
//  (`corpus-root.mjs`: FUARAN_WIRE_FIXTURES first, the sibling clone second).
//
//    node dev-scripts/generate-idl.mjs          # rewrite the generated module
//    node dev-scripts/generate-idl.mjs --check  # exit 1 when it has drifted
//
//  The same drift check runs in the schema package's test suite, with the
//  recorded IDL_SHA256 compared against the corpus's `idl.json` bytes, so a
//  moved IDL without a regeneration is red in CI.
//
//  Representation quirks of this host (a kind spec spelt differently, a closure
//  slot's TypeScript type, a hosted payload's type) are NOT in the IDL and not
//  in this script: they are declared once, in the hand-written dialect beside
//  the generated module (`packages/schema/src/types.ts`'s overlay maps and the
//  decoder's / encoder's override tables), which the type checker validates
//  against the generated tables.
// ============================================================================

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const OUTPUT_PATH = join(here, '..', 'packages', 'schema', 'src', 'generated.ts');

/** A canonical JSON rendering (sorted keys at every depth) — the interning key. */
const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v !== null && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(',')}}`
      : JSON.stringify(v);

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Interns every distinct IDL type as one named const; nested types by reference. */
class Types {
  constructor() {
    this.rows = new Map(); // name -> source
    this.byKey = new Map(); // canonical JSON -> name
  }
  static spell(t) {
    const tag = t.$type;
    let head = ['union', 'record', 'enum', 'var'].includes(tag) ? `${tag}_${t.name}` : tag;
    const inner = t.of ?? t.values;
    if (inner !== undefined) head += '_' + Types.spell(inner);
    for (const a of t.args ?? []) head += '_' + Types.spell(a);
    return head;
  }
  /** The literal for `t`, nested types named. */
  literal(t) {
    const tag = t.$type;
    switch (tag) {
      case 'list':
        return `{ $type: 'list', of: ${this.name(t.of)} }`;
      case 'map':
        return `{ $type: 'map', values: ${this.name(t.values)} }`;
      case 'enum':
      case 'record':
      case 'var':
        return `{ $type: ${q(tag)}, name: ${q(t.name)} }`;
      case 'union':
        return `{ $type: 'union', name: ${q(t.name)}, args: [${(t.args ?? []).map((a) => this.name(a)).join(', ')}] }`;
      case 'fn':
        return `{ $type: 'fn', wire: '<closure>' }`;
      case 'hosted':
        return `{ $type: 'hosted', wire: 'json' }`;
      default:
        return `{ $type: ${q(tag)} }`;
    }
  }
  name(t) {
    const key = canonical(t);
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    const literal = this.literal(t); // interns the nested types first
    const name = `T_${Types.spell(t)}`;
    this.byKey.set(key, name);
    this.rows.set(name, literal);
    return name;
  }
}

const defaultLiteral = (d) => {
  switch (d.$type) {
    case 'bool':
    case 'int':
    case 'float':
      return `{ $type: ${q(d.$type)}, value: ${d.value} }`;
    case 'str':
      return `{ $type: 'str', value: ${q(d.value)} }`;
    case 'enum':
      return `{ $type: 'enum', case: ${q(d.case)} }`;
    case 'list':
      return `{ $type: 'list', items: [${d.items.map(defaultLiteral).join(', ')}] }`;
    case 'union':
      return `{ $type: 'union', tag: ${q(d.tag)}, fields: [${d.fields.map((f) => `{ name: ${q(f.name)}, value: ${defaultLiteral(f.value)} }`).join(', ')}] }`;
    case 'record':
      return `{ $type: 'record', fields: [${d.fields.map((f) => `{ name: ${q(f.name)}, value: ${defaultLiteral(f.value)} }`).join(', ')}] }`;
    default:
      throw new Error(`idl.json: unknown default shape '${d.$type}'`);
  }
};

const rowLiteral = (types, f) => {
  const opt = f.optionality.$type;
  const parts = [`name: ${q(f.name)}`, `opt: ${q(opt)}`, `type: ${types.name(f.type)}`];
  if (opt === 'omitDefault') parts.push(`dflt: ${defaultLiteral(f.optionality.default)}`);
  return `{ ${parts.join(', ')} }`;
};

const rowsLiteral = (types, fields) => `[${fields.map((f) => rowLiteral(types, f)).join(', ')}]`;

const isBinding = (t) => t.$type === 'union' && t.name === 'Binding';
const isChild = (t) => t.$type === 'node' || (t.$type === 'list' && t.of.$type === 'node');
const slotName = (field) => field[0].toUpperCase() + field.slice(1);

/** Generate the module source (unformatted) from the IDL's bytes. */
export const generateIdlModule = (idlBytes) => {
  const idl = JSON.parse(idlBytes.toString('utf8'));
  const sha = createHash('sha256').update(idlBytes).digest('hex');
  const types = new Types();
  const out = [];
  const emit = (s) => out.push(s);

  // Intern every type first so the T_* consts are declared before the tables.
  const tables = [];
  const kindRows = idl.kinds.map((k) => [k.tag, rowsLiteral(types, k.fields)]);
  const recordRows = idl.records.map((r) => [r.name, rowsLiteral(types, r.fields)]);
  const unionRows = idl.unions.map((u) => [
    u.name,
    `{ ${u.cases.map((c) => `${c.tag}: ${rowsLiteral(types, c.fields)}`).join(', ')} }`,
  ]);
  const opRows = idl.ops.map((o) => [o.tag, rowsLiteral(types, o.fields)]);
  const nodeRows = rowsLiteral(types, idl.nodeFields);
  void tables;

  emit(`// GENERATED from idl.json by dev-scripts/generate-idl.mjs — DO NOT EDIT BY HAND.
//
// The structural vocabulary of the wire format, as data: what each kind, record,
// union case and op carries, how optional each member is, and the default an
// omitted member means. Regenerate with \`node dev-scripts/generate-idl.mjs\`;
// \`--check\` (and \`packages/schema/test/generated.test.ts\`) reports drift.
// Behaviour lives in the hand-written modules that read these tables.

import type { FieldRow, IdlType } from './idl.js';

/** SHA-256 of the exact \`idl.json\` bytes this module was generated from. */
export const IDL_SHA256 = ${q(sha)};
export const IDL_VERSION = ${idl.version};
`);

  emit(`// ─── Types (each distinct IDL type once; nested types by name) ───────────────\n`);
  for (const [name, literal] of types.rows)
    emit(`const ${name} = ${literal} as const satisfies IdlType;`);

  emit(`\n// ─── Enums ───────────────────────────────────────────────────────────────────\n`);
  emit(`/** Every bare-string enum's cases, as the wire spells them, in IDL order. */`);
  emit(`export const ENUM_CASES = {`);
  for (const e of idl.enums) emit(`  ${e.name}: [${e.cases.map(q).join(', ')}],`);
  emit(`} as const satisfies Record<string, readonly string[]>;`);
  emit(`export type EnumName = keyof typeof ENUM_CASES;`);
  emit(`/** The TypeScript union of an enum's cases. */`);
  emit(`export type EnumCase<N extends EnumName> = (typeof ENUM_CASES)[N][number];`);

  emit(`\n// ─── Kinds ───────────────────────────────────────────────────────────────────\n`);
  emit(`/** The emittable NodeKind vocabulary — every wire \`kind.$type\` name, in IDL order. */`);
  emit(`export const NODE_KINDS = [${idl.kinds.map((k) => q(k.tag)).join(', ')}] as const;`);
  emit(`export type NodeKindName = (typeof NODE_KINDS)[number];`);
  const categories = [];
  for (const k of idl.kinds) if (!categories.includes(k.category)) categories.push(k.category);
  emit(`export const KIND_CATEGORIES = [${categories.map(q).join(', ')}] as const;`);
  emit(`export type KindCategory = (typeof KIND_CATEGORIES)[number];`);
  emit(`export const KIND_CATEGORY = {`);
  for (const k of idl.kinds) emit(`  ${k.tag}: ${q(k.category)},`);
  emit(`} as const satisfies Record<NodeKindName, KindCategory>;`);
  emit(`/** The kinds of each category, in IDL order. */`);
  emit(`export const KINDS_BY_CATEGORY = {`);
  for (const c of categories)
    emit(
      `  ${c}: [${idl.kinds
        .filter((k) => k.category === c)
        .map((k) => q(k.tag))
        .join(', ')}],`,
    );
  emit(`} as const satisfies Record<KindCategory, readonly NodeKindName[]>;`);

  emit(`\n/** Each kind's field table, in IDL order. */`);
  emit(`export const KIND_FIELDS = {`);
  for (const [tag, rows] of kindRows) emit(`  ${tag}: ${rows},`);
  emit(`} as const satisfies Record<NodeKindName, readonly FieldRow[]>;`);

  emit(`\n// ─── The node envelope ───────────────────────────────────────────────────────\n`);
  emit(`export const NODE_FIELDS = ${nodeRows} as const satisfies readonly FieldRow[];`);

  emit(`\n// ─── Records ─────────────────────────────────────────────────────────────────\n`);
  emit(`export const RECORD_FIELDS = {`);
  for (const [name, rows] of recordRows) emit(`  ${name}: ${rows},`);
  emit(`} as const satisfies Record<string, readonly FieldRow[]>;`);
  emit(`export type RecordName = keyof typeof RECORD_FIELDS;`);

  emit(`\n// ─── Unions ──────────────────────────────────────────────────────────────────\n`);
  emit(`/** Each tagged union's cases, each case's field table, in IDL order. */`);
  emit(`export const UNION_CASES = {`);
  for (const [name, cases] of unionRows) emit(`  ${name}: ${cases},`);
  emit(`} as const satisfies Record<string, Record<string, readonly FieldRow[]>>;`);
  emit(`export type UnionName = keyof typeof UNION_CASES;`);
  const params = idl.unions.filter((u) => (u.params ?? []).length > 0);
  emit(`/** The type parameters of the generic unions. */`);
  emit(`export const UNION_PARAMS = {`);
  for (const u of params) emit(`  ${u.name}: [${u.params.map(q).join(', ')}],`);
  emit(`} as const satisfies Partial<Record<UnionName, readonly string[]>>;`);
  const transparent = idl.unions.filter((u) => u.transparentCase !== undefined);
  emit(`/** The case a bare wire value lifts into (the transparent unions). */`);
  emit(`export const UNION_TRANSPARENT_CASE = {`);
  for (const u of transparent) emit(`  ${u.name}: ${q(u.transparentCase)},`);
  emit(`} as const satisfies Partial<Record<UnionName, string>>;`);
  const annotated = idl.unions.flatMap((u) =>
    u.cases.filter((c) => c.annotations !== undefined).map((c) => [u.name, c.tag, c.annotations]),
  );
  emit(`/** Per-case annotations the IDL declares. */`);
  emit(`export const UNION_CASE_ANNOTATIONS = {`);
  for (const [u, tag, a] of annotated)
    emit(
      `  ${u}: { ${tag}: { ${Object.entries(a)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ')} } },`,
    );
  emit(`} as const;`);

  emit(`\n// ─── Ops ─────────────────────────────────────────────────────────────────────\n`);
  emit(`export const OP_FIELDS = {`);
  for (const [tag, rows] of opRows) emit(`  ${tag}: ${rows},`);
  emit(`} as const satisfies Record<string, readonly FieldRow[]>;`);
  emit(`export type OpName = keyof typeof OP_FIELDS;`);

  emit(`\n// ─── Hardening ───────────────────────────────────────────────────────────────\n`);
  emit(
    `export const HARDEN = ${JSON.stringify(idl.harden, null, 2)
      .replace(/"([A-Za-z_$][A-Za-z0-9_$]*)":/g, '$1:')
      .replace(/"/g, "'")} as const;`,
  );

  emit(`\n// ─── Derived from the tables above ───────────────────────────────────────────\n`);
  emit(`/** Each kind's node-bearing members (a \`node\` or a \`list<node>\`), in IDL order. */`);
  emit(`export const CHILD_SLOTS = {`);
  for (const k of idl.kinds)
    emit(
      `  ${k.tag}: [${k.fields
        .filter((f) => isChild(f.type))
        .map((f) => q(f.name))
        .join(', ')}],`,
    );
  emit(`} as const satisfies Record<NodeKindName, readonly string[]>;`);
  emit(
    `/** Each kind's binding slots — every \`Binding<…>\` member, with the slot name the introspection surface reports (the member name in PascalCase), in IDL order. */`,
  );
  emit(`export const BINDING_SLOTS = {`);
  for (const k of idl.kinds)
    emit(
      `  ${k.tag}: [${k.fields
        .filter((f) => isBinding(f.type))
        .map(
          (f) =>
            `{ field: ${q(f.name)}, slot: ${q(slotName(f.name))}, optional: ${f.optionality.$type !== 'required'} }`,
        )
        .join(', ')}],`,
    );
  emit(
    `} as const satisfies Record<NodeKindName, readonly { readonly field: string; readonly slot: string; readonly optional: boolean }[]>;`,
  );

  return out.join('\n') + '\n';
};

/** The module source, Prettier-formatted with the repository's configuration. */
export const generateFormatted = async (idlBytes) => {
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(OUTPUT_PATH)) ?? {};
  return prettier.format(generateIdlModule(idlBytes), { ...config, filepath: OUTPUT_PATH });
};

export const readIdl = async (explicitRoot) => {
  const { wireCorpusRoot } = await import('./corpus-root.mjs');
  const root = wireCorpusRoot(explicitRoot === undefined ? undefined : { explicit: explicitRoot });
  return readFileSync(join(root, 'idl.json'));
};

const main = async () => {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const rootArg = args.find((a) => !a.startsWith('--'));
  const generated = await generateFormatted(await readIdl(rootArg));
  if (check) {
    let committed = '';
    try {
      committed = readFileSync(OUTPUT_PATH, 'utf8');
    } catch {
      committed = '';
    }
    if (committed !== generated) {
      console.error(
        `${OUTPUT_PATH} is not what idl.json projects — run node dev-scripts/generate-idl.mjs`,
      );
      process.exit(1);
    }
    console.log('generated.ts is current');
    return;
  }
  writeFileSync(OUTPUT_PATH, generated);
  console.log(`wrote ${OUTPUT_PATH}`);
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
