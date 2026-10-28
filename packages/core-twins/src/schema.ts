// ============================================================================
//  Core twin — the schema operations over field metadata (Phase 2207).
//
//  A port of `Fuaran.Core.Schema` (fuaran-core#33, #317, #427): the structural
//  `diffSchema`, its replay `patchSchema`, the depended-on-column verdict
//  `classifySchemaDelta`, and the cross-host `schemaFingerprint`. A schema entry
//  is the reference's `Field`: a name and a type, then an optional unit (held as
//  its canonical text, so two units are equal exactly when their texts are), an
//  optional label, an optional description, and the extension map.
//
//  The delta's canonical wire is written by @fuaran-ui/ops (`encodeSchemaDelta`)
//  beside the schema entry's own encoding, as the reference's
//  `SchemaDeltaCodec` sits beside its columnar codec.
// ============================================================================

import type { ColumnType, Result, SchemaEntry } from '@fuaran-ui/schema';

import { canonicalFields, fnv1a } from './capability.js';
import { columnTypeWidens } from './columnType.js';
import { err, ok } from './result.js';

const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The extension members of an entry, in ordinal key order (none when it states none). */
const extEntries = (f: SchemaEntry): [string, string][] =>
  [...(f.ext ?? new Map<string, string>())].sort((a, b) => ordinal(a[0], b[0]));

/** Whether an entry states any metadata — a unit, a label, a description or an extension member. */
export const fieldHasMetadata = (f: SchemaEntry): boolean =>
  f.unit !== undefined ||
  f.label !== undefined ||
  f.description !== undefined ||
  (f.ext !== undefined && f.ext.size > 0);

/**
 * One moved metadata member of a column common to both schemas — the reference's `FieldChange`.
 * `from` / `to` are absent where that side stated none; a unit is its canonical text.
 */
export type FieldChange =
  | {
      readonly member: 'unit' | 'label' | 'description';
      readonly from?: string;
      readonly to?: string;
    }
  | { readonly member: 'ext'; readonly key: string; readonly from?: string; readonly to?: string };

/** A structured schema delta — the reference's `SchemaDelta`. */
export interface SchemaDelta {
  /** Columns only the target holds, in target order, each with its metadata. */
  readonly added: readonly SchemaEntry[];
  /** Columns only the old schema holds, in old order, as the old schema spelled them. */
  readonly removed: readonly SchemaEntry[];
  /** Columns in both whose type changed, in old order. */
  readonly retyped: readonly {
    readonly name: string;
    readonly from: ColumnType;
    readonly to: ColumnType;
  }[];
  /** One entry per moved member of a column in both, in old column order, then member order. */
  readonly amended: readonly { readonly name: string; readonly change: FieldChange }[];
  /** Whether the columns common to both appear in a different relative order. A report only. */
  readonly reordered: boolean;
  /** The target's column order, or empty when it is the order `patchSchema` derives without it. */
  readonly order: readonly string[];
}

/** Why `patchSchema` refused a delta — the reference's `SchemaError`. */
export type SchemaError =
  | { readonly kind: 'DuplicateColumn'; readonly column: string }
  | { readonly kind: 'AbsentColumn'; readonly column: string }
  | {
      readonly kind: 'TypeDisagrees';
      readonly column: string;
      readonly expected: ColumnType;
      readonly got: ColumnType;
    }
  | { readonly kind: 'MetadataDisagrees'; readonly column: string; readonly change: FieldChange }
  | { readonly kind: 'AlreadyPresent'; readonly column: string }
  | {
      readonly kind: 'OrderMismatch';
      readonly expected: readonly string[];
      readonly got: readonly string[];
    };

/** The compatibility verdict for a consumer's depended-on columns — the reference's `SchemaCompat`. */
export type SchemaCompat =
  | { readonly kind: 'compatible' }
  | { readonly kind: 'breaking'; readonly reasons: readonly string[] }
  | { readonly kind: 'unknown'; readonly reasons: readonly string[] };

/** A change with its absent sides omitted, so an entry never carries an `undefined` member. */
const moved = (
  member: 'unit' | 'label' | 'description',
  from: string | undefined,
  to: string | undefined,
): FieldChange[] =>
  from === to
    ? []
    : [
        {
          member,
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        },
      ];

/**
 * The metadata changes from `before` to `after`, in member order: the unit, the label, the
 * description, then each extension key the two carry between them, in ordinal order.
 */
const changes = (before: SchemaEntry, after: SchemaEntry): FieldChange[] => {
  const b = before.ext ?? new Map<string, string>();
  const a = after.ext ?? new Map<string, string>();
  const keys = [...new Set([...b.keys(), ...a.keys()])].sort(ordinal);
  return [
    ...moved('unit', before.unit, after.unit),
    ...moved('label', before.label, after.label),
    ...moved('description', before.description, after.description),
    ...keys.flatMap((key): FieldChange[] => {
      const from = b.get(key);
      const to = a.get(key);
      return from === to
        ? []
        : [
            {
              member: 'ext',
              key,
              ...(from === undefined ? {} : { from }),
              ...(to === undefined ? {} : { to }),
            },
          ];
    }),
  ];
};

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The structured delta from `old` to `target` (total). */
export const diffSchema = (
  old: readonly SchemaEntry[],
  target: readonly SchemaEntry[],
): SchemaDelta => {
  const oldMap = new Map(old.map((f) => [f.name, f]));
  const newMap = new Map(target.map((f) => [f.name, f]));
  const added = target.filter((f) => !oldMap.has(f.name));
  const removed = old.filter((f) => !newMap.has(f.name));
  const retyped = old.flatMap((f) => {
    const nf = newMap.get(f.name);
    return nf !== undefined && nf.type !== f.type
      ? [{ name: f.name, from: f.type, to: nf.type }]
      : [];
  });
  const amended = old.flatMap((f) => {
    const nf = newMap.get(f.name);
    return nf === undefined ? [] : changes(f, nf).map((change) => ({ name: f.name, change }));
  });
  const commonOld = old.map((f) => f.name).filter((n) => newMap.has(n));
  const commonNew = target.map((f) => f.name).filter((n) => oldMap.has(n));
  // The order `patchSchema` derives untold: the survivors in old order, then the added ones.
  const derived = [...commonOld, ...added.map((f) => f.name)];
  const targetOrder = target.map((f) => f.name);
  return {
    added,
    removed,
    retyped,
    amended,
    reordered: !sameOrder(commonOld, commonNew),
    order: sameOrder(targetOrder, derived) ? [] : targetOrder,
  };
};

/** `f` with the optional member `member` set to `v`, or removed where `v` is absent. */
const withMember = (
  f: SchemaEntry,
  member: 'unit' | 'label' | 'description',
  v: string | undefined,
): SchemaEntry => {
  const { [member]: _dropped, ...rest } = f;
  return v === undefined ? rest : { ...rest, [member]: v };
};

/** The entry `change` leaves when applied to `f`, or `undefined` when `f` lacks its `from`. */
const applyChange = (change: FieldChange, f: SchemaEntry): SchemaEntry | undefined => {
  if (change.member !== 'ext')
    return f[change.member] === change.from ? withMember(f, change.member, change.to) : undefined;
  const ext = new Map(f.ext ?? []);
  if (ext.get(change.key) !== change.from) return undefined;
  if (change.to === undefined) ext.delete(change.key);
  else ext.set(change.key, change.to);
  const { ext: _dropped, ...rest } = f;
  return ext.size === 0 ? rest : { ...rest, ext };
};

const firstDuplicate = (names: readonly string[]): string | undefined => {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) return n;
    seen.add(n);
  }
  return undefined;
};

/**
 * Apply a delta to a schema — removed, then retyped (metadata kept), then amended, then added, then
 * the order. The law: `patchSchema(old, diffSchema(old, target))` is `target` for every pair of
 * schemas that each name no column twice. Anything else is a named `SchemaError`, never a repair.
 */
export const patchSchema = (
  old: readonly SchemaEntry[],
  delta: SchemaDelta,
): Result<SchemaEntry[], SchemaError> => {
  const dup = firstDuplicate(old.map((f) => f.name));
  if (dup !== undefined) return err({ kind: 'DuplicateColumn', column: dup });
  let s: SchemaEntry[] = [...old];
  const find = (name: string): SchemaEntry | undefined => s.find((f) => f.name === name);
  const replace = (name: string, f: SchemaEntry): void => {
    s = s.map((g) => (g.name === name ? f : g));
  };
  for (const r of delta.removed) {
    const f = find(r.name);
    if (f === undefined) return err({ kind: 'AbsentColumn', column: r.name });
    if (f.type !== r.type)
      return err({ kind: 'TypeDisagrees', column: r.name, expected: r.type, got: f.type });
    s = s.filter((g) => g.name !== r.name);
  }
  for (const { name, from, to } of delta.retyped) {
    const f = find(name);
    if (f === undefined) return err({ kind: 'AbsentColumn', column: name });
    if (f.type !== from)
      return err({ kind: 'TypeDisagrees', column: name, expected: from, got: f.type });
    replace(name, { ...f, type: to });
  }
  for (const { name, change } of delta.amended) {
    const f = find(name);
    if (f === undefined) return err({ kind: 'AbsentColumn', column: name });
    const g = applyChange(change, f);
    if (g === undefined) return err({ kind: 'MetadataDisagrees', column: name, change });
    replace(name, g);
  }
  for (const a of delta.added) {
    if (find(a.name) !== undefined) return err({ kind: 'AlreadyPresent', column: a.name });
    s.push(a);
  }
  if (delta.order.length === 0) return ok(s);
  const names = s.map((f) => f.name);
  const key = (xs: readonly string[]): string[] => [...xs].sort(ordinal);
  if (delta.order.length !== names.length || !sameOrder(key(delta.order), key(names)))
    return err({ kind: 'OrderMismatch', expected: names, got: delta.order });
  return ok(delta.order.map((n) => find(n)!));
};

/**
 * Classify a delta against the columns a consumer depends on. Breaking: a depended-on column
 * removed, retyped other than by a widening, or whose STATED unit was replaced or withdrawn.
 * Unknown: a depended-on column's extension member moved. Breaking outranks unknown; everything
 * else — added columns, reorders, labels, descriptions, a unit stated for the first time, any
 * change to a column the consumer does not read — is compatible.
 */
export const classifySchemaDelta = (
  dependsOn: readonly string[],
  delta: SchemaDelta,
): SchemaCompat => {
  const deps = new Set(dependsOn);
  const breaking = [
    ...delta.removed
      .filter((f) => deps.has(f.name))
      .map((f) => `depended-on column removed: ${f.name} (${f.type})`),
    ...delta.retyped
      .filter((r) => deps.has(r.name) && !columnTypeWidens(r.from, r.to))
      .map((r) => `depended-on column ${r.name} retyped ${r.from} → ${r.to} (not a safe widening)`),
    ...delta.amended.flatMap(({ name, change }) =>
      change.member === 'unit' && change.from !== undefined && deps.has(name)
        ? [
            `depended-on column ${name} unit changed ${change.from} → ${change.to ?? 'none'} ` +
              '(its values no longer mean what was read)',
          ]
        : [],
    ),
  ];
  const unknown = delta.amended.flatMap(({ name, change }) =>
    change.member === 'ext' && deps.has(name)
      ? [
          `depended-on column ${name} extension member ${change.key} changed (not interpreted by the kit)`,
        ]
      : [],
  );
  if (breaking.length > 0) return { kind: 'breaking', reasons: breaking };
  return unknown.length > 0 ? { kind: 'unknown', reasons: unknown } : { kind: 'compatible' };
};

/**
 * The pre-image element a field's metadata contributes: the unit prefixed `u`, the label `l`, the
 * description `d` (each the empty field where unstated, so an absent member and an empty one
 * differ), then each extension key and value in ordinal key order — through `canonicalFields`.
 */
const metadataPreimage = (f: SchemaEntry): string => {
  const stated = (tag: string, v: string | undefined): string => (v === undefined ? '' : tag + v);
  return canonicalFields([
    stated('u', f.unit),
    stated('l', f.label),
    stated('d', f.description),
    ...extEntries(f).flatMap(([k, v]) => [k, v]),
  ]);
};

/**
 * The schema's cross-host fingerprint: FNV-1a over the UTF-16 code units of the canonical field
 * pre-image of each `name:type`, a field that states metadata contributing one more element after
 * its own. A schema with no metadata keeps the fingerprint it had before Phase 2207.
 */
export const schemaFingerprint = (s: readonly SchemaEntry[]): string =>
  fnv1a(
    canonicalFields(
      s.flatMap((f) => [
        `${f.name}:${f.type}`,
        ...(fieldHasMetadata(f) ? [metadataPreimage(f)] : []),
      ]),
    ),
  );
