// ============================================================================
//  @fuaran-ui/renderer/wiringIntrospection — the wiring section of the in-page
//  introspection surface, TypeScript mirror (Phase 1844).
//
//  The wiring graph says which controls drive which consumers: the chip that
//  declares a filter, the `Select` whose write-back commits to it, the
//  `SetState` or `Call into:` that fills a key, the grid whose selection a
//  `Selection` binding names — and every filter / transform edge a
//  `Query.dependsOn` name or a `Transform` / `Expr` param asserts. It is the
//  relation the validator's wiring rules decide on, so a developer asking "why
//  did this chip do nothing?" needs to SEE it.
//
//  The graph has ONE derivation: the reference host's binding walk, projected
//  by its `WiringGraph` and exposed as the `Introspection` DTO
//  (`fuaran-wiring-introspection/1`). This module derives nothing. It READS that
//  DTO — a strict decoder, a canonical re-encoder, and the REPL's printable
//  rendering — and for the same DTO it produces the same bytes the reference
//  host does, on both renderings. A second walk of the spec vocabulary here
//  would be a second answer to "what drives what", and the whole point of the
//  surface is that the graph a developer sees is the graph the validator
//  decides on.
//
//  So a host that renders with this package and wants the wiring in its console
//  hands the DTO in — typically the server that emitted the tree emits the DTO
//  beside it — through `DebugGlobalOptions.wiring` (or the `wiring` prop of
//  `<FuaranRenderer debug>`). Without it, `getWiring()` says so rather than
//  answering with an empty graph, which would read as "nothing is wired".
//
//  The cross-host byte vectors live in `test/fixtures/wiring-introspection/`,
//  emitted by the reference host; `wiringIntrospection.test.ts` holds this
//  module to them.
// ============================================================================

/** The DTO's format token. A DTO carrying any other is refused. */
export const WIRING_INTROSPECTION_FORMAT = 'fuaran-wiring-introspection/1';

/** The reactive channel an edge runs over. */
export type WiringChannel = 'filter' | 'state' | 'query' | 'selection';

/** How a control drives its channel. `filter-write-back` is a write-back position. */
export type WiringControlKind =
  | 'declared-filter'
  | 'state-write'
  | 'fetch-into-state'
  | 'fetch-into-query'
  | 'selection-producer'
  | 'filter-write-back';

/**
 * What a consumer's read is worth: `declared-edge` for a `Query.dependsOn` name
 * or a `Transform` / `Expr` param sourced from a filter, `value-read` for a
 * plain read.
 */
export type WiringConsumerKind = 'value-read' | 'declared-edge';

/** One control: a node that drives `name` on `channel`. */
export interface WiringControlEntry {
  readonly channel: WiringChannel;
  readonly name: string;
  readonly nodeId: string;
  readonly kind: WiringControlKind;
}

/** One consumer usage: a node that reads `name` on `channel`. */
export interface WiringConsumerEntry {
  readonly channel: WiringChannel;
  readonly name: string;
  readonly nodeId: string;
  readonly kind: WiringConsumerKind;
}

/** One resolved edge — control (the source) to consumer, on one name. */
export interface WiringEdgeEntry {
  readonly channel: WiringChannel;
  readonly name: string;
  /** The driving node's id. */
  readonly control: string;
  /** The reading node's id. */
  readonly consumer: string;
  readonly consumption: WiringConsumerKind;
  /** The kinds of the controls at the driving end, sorted and distinct. */
  readonly controlKinds: readonly WiringControlKind[];
}

/** An end that met nothing. */
export type WiringUnresolvedEntry =
  | {
      /** An express control that drives nothing in this tree. */
      readonly reason: 'undriven';
      readonly channel: WiringChannel;
      readonly name: string;
      readonly nodeId: string;
      readonly kind: WiringControlKind;
    }
  | {
      /** A consumer naming something no control in this tree produces. */
      readonly reason: 'ungrounded';
      readonly channel: WiringChannel;
      readonly name: string;
      readonly nodeId: string;
      readonly kind: WiringConsumerKind;
    };

/** The wiring section of the introspection surface. */
export interface WiringIntrospection {
  readonly format: typeof WIRING_INTROSPECTION_FORMAT;
  readonly controls: readonly WiringControlEntry[];
  readonly consumers: readonly WiringConsumerEntry[];
  readonly edges: readonly WiringEdgeEntry[];
  readonly unresolved: readonly WiringUnresolvedEntry[];
  /** State keys read through a surface the walk cannot tag with a reading node. */
  readonly untaggedStateReads: readonly string[];
  /** A reader whose state access cannot be seen — an `undriven` entry then proves nothing. */
  readonly opaqueReader: boolean;
  /** A writer whose destination cannot be seen — an `ungrounded` state entry then proves nothing. */
  readonly opaqueWriter: boolean;
}

/** Why a value is not a wiring DTO: the first defect, and where it sits. */
export interface WiringDecodeError {
  readonly error: string;
  /** A JSON-pointer-ish locator (`/edges/3/controlKinds/0`). */
  readonly path: string;
}

// ─── strict decoding ────────────────────────────────────────────────────────

const CHANNELS: ReadonlySet<string> = new Set(['filter', 'state', 'query', 'selection']);
const CONTROL_KINDS: ReadonlySet<string> = new Set([
  'declared-filter',
  'state-write',
  'fetch-into-state',
  'fetch-into-query',
  'selection-producer',
  'filter-write-back',
]);
const CONSUMER_KINDS: ReadonlySet<string> = new Set(['value-read', 'declared-edge']);

class Refusal extends Error {
  constructor(
    readonly reason: string,
    readonly at: string,
  ) {
    super(reason);
  }
}

const refuse = (reason: string, at: string): never => {
  throw new Refusal(reason, at);
};

const objectAt = (value: unknown, at: string, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return refuse('expected an object', at);
  }
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!keys.includes(key)) refuse(`unknown member '${key}'`, at);
  }
  for (const key of keys) {
    if (!(key in o)) refuse(`missing member '${key}'`, at);
  }
  return o;
};

const stringAt = (value: unknown, at: string): string =>
  typeof value === 'string' ? value : refuse('expected a string', at);

const tokenAt = <T extends string>(value: unknown, at: string, allowed: ReadonlySet<string>): T => {
  const s = stringAt(value, at);
  return allowed.has(s) ? (s as T) : refuse(`unknown token '${s}'`, at);
};

const arrayAt = <T>(value: unknown, at: string, item: (v: unknown, at: string) => T): T[] =>
  Array.isArray(value)
    ? value.map((v, i) => item(v, `${at}/${i}`))
    : refuse('expected an array', at);

const boolAt = (value: unknown, at: string): boolean =>
  typeof value === 'boolean' ? value : refuse('expected a boolean', at);

const decodeControl = (value: unknown, at: string): WiringControlEntry => {
  const o = objectAt(value, at, ['channel', 'kind', 'name', 'nodeId']);
  return {
    channel: tokenAt<WiringChannel>(o['channel'], `${at}/channel`, CHANNELS),
    name: stringAt(o['name'], `${at}/name`),
    nodeId: stringAt(o['nodeId'], `${at}/nodeId`),
    kind: tokenAt<WiringControlKind>(o['kind'], `${at}/kind`, CONTROL_KINDS),
  };
};

const decodeConsumer = (value: unknown, at: string): WiringConsumerEntry => {
  const o = objectAt(value, at, ['channel', 'kind', 'name', 'nodeId']);
  return {
    channel: tokenAt<WiringChannel>(o['channel'], `${at}/channel`, CHANNELS),
    name: stringAt(o['name'], `${at}/name`),
    nodeId: stringAt(o['nodeId'], `${at}/nodeId`),
    kind: tokenAt<WiringConsumerKind>(o['kind'], `${at}/kind`, CONSUMER_KINDS),
  };
};

const decodeEdge = (value: unknown, at: string): WiringEdgeEntry => {
  const o = objectAt(value, at, [
    'channel',
    'consumer',
    'consumption',
    'control',
    'controlKinds',
    'name',
  ]);
  return {
    channel: tokenAt<WiringChannel>(o['channel'], `${at}/channel`, CHANNELS),
    name: stringAt(o['name'], `${at}/name`),
    control: stringAt(o['control'], `${at}/control`),
    consumer: stringAt(o['consumer'], `${at}/consumer`),
    consumption: tokenAt<WiringConsumerKind>(o['consumption'], `${at}/consumption`, CONSUMER_KINDS),
    controlKinds: arrayAt(o['controlKinds'], `${at}/controlKinds`, (v, a) =>
      tokenAt<WiringControlKind>(v, a, CONTROL_KINDS),
    ),
  };
};

const decodeUnresolved = (value: unknown, at: string): WiringUnresolvedEntry => {
  const o = objectAt(value, at, ['channel', 'kind', 'name', 'nodeId', 'reason']);
  const reason = tokenAt<'undriven' | 'ungrounded'>(
    o['reason'],
    `${at}/reason`,
    new Set(['undriven', 'ungrounded']),
  );
  const channel = tokenAt<WiringChannel>(o['channel'], `${at}/channel`, CHANNELS);
  const name = stringAt(o['name'], `${at}/name`);
  const nodeId = stringAt(o['nodeId'], `${at}/nodeId`);
  // The kind's vocabulary follows the reason: an undriven end is a CONTROL,
  // an ungrounded one a CONSUMER. A DTO mixing them is not a DTO this format
  // can produce, so it is refused rather than carried.
  return reason === 'undriven'
    ? {
        reason,
        channel,
        name,
        nodeId,
        kind: tokenAt<WiringControlKind>(o['kind'], `${at}/kind`, CONTROL_KINDS),
      }
    : {
        reason,
        channel,
        name,
        nodeId,
        kind: tokenAt<WiringConsumerKind>(o['kind'], `${at}/kind`, CONSUMER_KINDS),
      };
};

/**
 * Decode a wiring DTO — the parsed object, or its JSON text — STRICTLY: every
 * member present, no unknown member, every token from its closed set, and the
 * format token exact. A DTO this module cannot represent faithfully is refused
 * with the first defect's location, never approximated: an approximated wiring
 * graph is a wrong answer to exactly the question the surface exists to answer.
 */
export const decodeWiringIntrospection = (
  value: unknown,
): WiringIntrospection | WiringDecodeError => {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    const o = objectAt(parsed, '', [
      'consumers',
      'controls',
      'edges',
      'format',
      'opaqueReader',
      'opaqueWriter',
      'unresolved',
      'untaggedStateReads',
    ]);
    if (o['format'] !== WIRING_INTROSPECTION_FORMAT) {
      refuse(`unsupported format '${String(o['format'])}'`, '/format');
    }
    return {
      format: WIRING_INTROSPECTION_FORMAT,
      controls: arrayAt(o['controls'], '/controls', decodeControl),
      consumers: arrayAt(o['consumers'], '/consumers', decodeConsumer),
      edges: arrayAt(o['edges'], '/edges', decodeEdge),
      unresolved: arrayAt(o['unresolved'], '/unresolved', decodeUnresolved),
      untaggedStateReads: arrayAt(o['untaggedStateReads'], '/untaggedStateReads', stringAt),
      opaqueReader: boolAt(o['opaqueReader'], '/opaqueReader'),
      opaqueWriter: boolAt(o['opaqueWriter'], '/opaqueWriter'),
    };
  } catch (e) {
    if (e instanceof Refusal) return { error: e.reason, path: e.at };
    return { error: e instanceof Error ? e.message : String(e), path: '' };
  }
};

/** True when {@link decodeWiringIntrospection} refused. */
export const isWiringDecodeError = (
  value: WiringIntrospection | WiringDecodeError,
): value is WiringDecodeError => 'error' in value;

// ─── the canonical JSON ─────────────────────────────────────────────────────

// Ordinal (UTF-16 code unit) comparison — the order the reference host's
// structural string comparison gives. Spelled out rather than left to
// `localeCompare`, which would make the bytes depend on the machine's locale.
const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byKey =
  <T>(key: (x: T) => readonly string[]) =>
  (a: T, b: T): number => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
      const c = ordinal(ka[i] as string, kb[i] as string);
      if (c !== 0) return c;
    }
    return ka.length - kb.length;
  };

// Deduplicate on the ENCODED entry (the reference host deduplicates on the
// whole record), keeping the first, then sort — a stable sort, as the
// reference host's is.
const canonical = <T>(
  items: readonly T[],
  encode: (x: T) => string,
  key: (x: T) => readonly string[],
): T[] => {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of items) {
    const e = encode(item);
    if (!seen.has(e)) {
      seen.add(e);
      kept.push(item);
    }
  }
  return kept.sort(byKey(key));
};

const sortedDistinct = <T extends string>(xs: readonly T[]): T[] => [...new Set(xs)].sort(ordinal);

const str = (s: string): string => JSON.stringify(s);

const controlJson = (c: WiringControlEntry): string =>
  `{"channel":${str(c.channel)},"kind":${str(c.kind)},"name":${str(c.name)},"nodeId":${str(c.nodeId)}}`;

const consumerJson = (r: WiringConsumerEntry): string =>
  `{"channel":${str(r.channel)},"kind":${str(r.kind)},"name":${str(r.name)},"nodeId":${str(r.nodeId)}}`;

const edgeJson = (e: WiringEdgeEntry): string =>
  `{"channel":${str(e.channel)},"consumer":${str(e.consumer)},"consumption":${str(
    e.consumption,
  )},"control":${str(e.control)},"controlKinds":[${sortedDistinct(e.controlKinds)
    .map(str)
    .join(',')}],"name":${str(e.name)}}`;

const unresolvedJson = (u: WiringUnresolvedEntry): string =>
  `{"channel":${str(u.channel)},"kind":${str(u.kind)},"name":${str(u.name)},"nodeId":${str(
    u.nodeId,
  )},"reason":${str(u.reason)}}`;

/** The DTO with every section in canonical order — what both renderings read. */
export const canonicalWiringIntrospection = (w: WiringIntrospection): WiringIntrospection => ({
  format: WIRING_INTROSPECTION_FORMAT,
  controls: canonical(w.controls, controlJson, (c) => [c.channel, c.name, c.nodeId, c.kind]),
  consumers: canonical(w.consumers, consumerJson, (r) => [r.channel, r.name, r.nodeId, r.kind]),
  edges: canonical(
    w.edges.map((e) => ({ ...e, controlKinds: sortedDistinct(e.controlKinds) })),
    edgeJson,
    (e) => [e.channel, e.name, e.control, e.consumer, e.consumption],
  ),
  unresolved: canonical(w.unresolved, unresolvedJson, (u) => [
    u.reason,
    u.channel,
    u.name,
    u.nodeId,
    u.kind,
  ]),
  untaggedStateReads: sortedDistinct(w.untaggedStateReads),
  opaqueReader: w.opaqueReader,
  opaqueWriter: w.opaqueWriter,
});

/**
 * The DTO's canonical JSON text: no whitespace, members in ordinal order,
 * sections deduplicated and sorted, strings escaped by `JSON.stringify`.
 * Byte-identical to the reference host's `Introspection.toJson` over the same
 * DTO.
 */
export const encodeWiringIntrospection = (w: WiringIntrospection): string => {
  const c = canonicalWiringIntrospection(w);
  return (
    `{"consumers":[${c.consumers.map(consumerJson).join(',')}]` +
    `,"controls":[${c.controls.map(controlJson).join(',')}]` +
    `,"edges":[${c.edges.map(edgeJson).join(',')}]` +
    `,"format":${str(WIRING_INTROSPECTION_FORMAT)}` +
    `,"opaqueReader":${c.opaqueReader ? 'true' : 'false'}` +
    `,"opaqueWriter":${c.opaqueWriter ? 'true' : 'false'}` +
    `,"unresolved":[${c.unresolved.map(unresolvedJson).join(',')}]` +
    `,"untaggedStateReads":[${c.untaggedStateReads.map(str).join(',')}]}`
  );
};

// ─── the REPL rendering ─────────────────────────────────────────────────────

/**
 * The printable form `__fuaran.describeWiring()` returns: edges first (what a
 * developer debugging a dead control is looking for), then the controls — a
 * `filter-write-back` control IS a write-back position — then every end that
 * met nothing. Consumers are counted, not listed. Byte-identical to the
 * reference host's `Introspection.describe` over the same DTO.
 */
export const describeWiringIntrospection = (w: WiringIntrospection): string => {
  const c = canonicalWiringIntrospection(w);
  const section = (title: string, rows: readonly string[]): string[] => [
    title,
    ...(rows.length === 0 ? ['  (none)'] : rows.map((r) => `  ${r}`)),
  ];
  const lines = [
    `wiring (${WIRING_INTROSPECTION_FORMAT}): ${c.edges.length} edges, ${c.controls.length} controls, ${c.consumers.length} consumers, ${c.unresolved.length} unresolved`,
    ...section(
      'edges:',
      c.edges.map(
        (e) =>
          `${e.channel} ${e.name}: ${e.control} -> ${e.consumer} [${e.consumption}] via ${e.controlKinds.join('+')}`,
      ),
    ),
    ...section(
      'controls:',
      c.controls.map((x) => `${x.channel} ${x.name} @ ${x.nodeId} (${x.kind})`),
    ),
    ...section(
      'unresolved:',
      c.unresolved.map((u) => `${u.reason} ${u.channel} ${u.name} @ ${u.nodeId} (${u.kind})`),
    ),
    `untagged state reads: ${
      c.untaggedStateReads.length === 0 ? '(none)' : c.untaggedStateReads.join(', ')
    }`,
    `opaque reader: ${c.opaqueReader ? 'yes' : 'no'}; opaque writer: ${c.opaqueWriter ? 'yes' : 'no'}`,
  ];
  return `${lines.join('\n')}\n`;
};
