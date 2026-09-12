// ============================================================================
//  The AUTHOR direction — rebuilding a decoded tree through `@fuaran-ui/ui`.
//
//  Every other leg in this kit runs wire -> decode -> encode, so it verifies the
//  decoder and the encoder AGAINST EACH OTHER. A change to an author-facing
//  in-memory type is invisible to that shape by construction: the decoder
//  produces the new form and the encoder consumes it, and the pair agrees at
//  every step. Phase 1661 is the worked example — `TextSource.I18n.args` widened
//  from a bare-value bag to `Record<string, Binding<JsonValue>>`, the whole
//  corpus stayed byte-identical (a `Static` argument carrying a value encodes
//  BARE, WIRE_FORMAT.md §5), the suite stayed green, and the break surfaced days
//  later in a consumer that CONSTRUCTS a tree rather than decoding one.
//
//  So this module walks a decoded tree and REBUILDS every author-facing value in
//  it through the `@fuaran-ui/ui` surface — `binding.*`, `action.*`,
//  `localeFormat.*`, `locale.*`, and typed `TextSource` construction — which is
//  the path a program that emits authoring source takes. Two guards fall out of
//  that, and the first is the load-bearing one:
//
//   * COMPILE TIME. Every rebuild below is written against the authoring type
//     (`Binding<JsonValue>`, `TextSource`, `Action<unknown>`, `Format`), so a
//     widening of one of those types stops this module compiling until it is
//     taught the new form. That is the check Phase 1661 did not have: a second
//     author site that must move with the type.
//   * RUN TIME. The rebuilt tree is encoded and required to be byte-identical to
//     the fixture, over every node fixture in the corpus, so a constructor that
//     stops producing the canonical shape fails by fixture name.
//
//  WHAT THIS DOES NOT DO, and why it is a boundary rather than a gap. It does
//  not rebuild the node SHELL through `fuaran.dashboard` / `fuaran.metric` / …,
//  because those constructors have no total inverse from a decoded value:
//  `binding.query` takes an accessor FUNCTION, `column.text` takes a row
//  projection, `binding.computed` takes a closure. A wire document cannot name
//  those, so "decode, then re-author the shell" is not a function that exists.
//  The shell cover is a projector — wire JSON to generated authoring source —
//  and one exists, in the consumer that broke; what has NOT existed is any
//  author-direction cover inside THIS repository, which is the gap that let
//  Phase 1661 ship.
//
//  Where the authoring surface offers no constructor for a case, the rebuild is
//  a TYPED OBJECT LITERAL annotated with the authoring type. The compile-time
//  guard is identical either way (an annotated literal is checked against the
//  same type the constructor returns), and each such site is named below with
//  the reason — the list is itself a finding about the authoring surface, and
//  `author-direction.test.ts` pins it so it cannot grow silently.
// ============================================================================

import { action, binding, locale, localeFormat } from '@fuaran-ui/ui';
import type {
  Action,
  ApiEndpoint,
  Binding,
  Format,
  JsonValue,
  LocaleSource,
  Node,
  NavigateTarget,
  NodeId,
  TextSource,
} from '@fuaran-ui/ui';

/** A plain JS object in a decoded tree (never an array, a `Date` or a function). */
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/**
 * Which union cases this walk actually rebuilt, counted per `<union>.<case>`.
 * The test asserts the exercised set rather than trusting the walk ran at all —
 * a re-author that silently matched nothing would pass a byte comparison
 * perfectly, being the identity.
 */
export type ReauthorTally = Map<string, number>;

const bump = (tally: ReauthorTally, key: string): void => {
  tally.set(key, (tally.get(key) ?? 0) + 1);
};

/**
 * Does `o` have exactly the member set this union case declares? Discriminants
 * are not globally unique in the schema — `Query` is both a `Binding` case and a
 * `CallResultTarget` case, `Literal` is both a `TextSource` case and a `ColExpr`
 * case — so the rebuild dispatches on the discriminant AND the shape, and leaves
 * anything that does not match to the structural copy.
 */
const shaped = (o: Obj, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((r) => r in o) &&
  Object.keys(o).every((k) => k === 'kind' || required.includes(k) || optional.includes(k));

// ─── Opaque payloads ────────────────────────────────────────────────────────
//
// A `Binding.Static` value, a `Notify` payload, an `AiTool` argument bag: the
// authoring surface takes these as `T` / `JsonValue` and never looks inside, so
// neither does this walk. Recursing into them would be worse than useless — a
// caller's own JSON object carrying a `kind` member is not a `TextSource`, and
// rebuilding it as one would be a rebuild the author never performs.
const opaque = (v: unknown): unknown => v;

// ─── The author-facing unions ───────────────────────────────────────────────

const reauthorFormat = (f: Format): Format => {
  switch (f.kind) {
    case 'Number':
      return localeFormat.number(f.decimals);
    case 'Percent':
      return localeFormat.percent(f.decimals);
    case 'Currency':
      return localeFormat.currency(f.isoCode);
    case 'Date':
      return localeFormat.date(f.dateStyle);
    case 'RelativeTime':
      return localeFormat.relativeTime(f.unit);
    // NO CONSTRUCTOR — `localeFormat` offers no `duration` or `since`.
    case 'Duration':
      return { kind: 'Duration', unit: f.unit, style: f.style };
    case 'Since':
      return f.unit === undefined ? { kind: 'Since' } : { kind: 'Since', unit: f.unit };
  }
};

const reauthorLocale = (l: LocaleSource): LocaleSource =>
  l.kind === 'Ambient' ? locale.ambient() : locale.explicit(l.tag);

/**
 * An `I18n` argument bag. THIS is the Phase 1661 site: the annotation on
 * `args` is what fails to compile if the slot's argument type widens again, and
 * `binding.static` is what a literal argument must be spelled as — a bare value
 * here is what the encoder refuses.
 */
const reauthorI18nArgs = (
  args: Readonly<Record<string, Binding<JsonValue>>>,
  tally: ReauthorTally,
): Readonly<Record<string, Binding<JsonValue>>> => {
  const out: Record<string, Binding<JsonValue>> = {};
  for (const [name, arg] of Object.entries(args)) out[name] = reauthorBinding(arg, tally);
  return out;
};

export const reauthorBinding = <T>(b: Binding<T>, tally: ReauthorTally): Binding<T> => {
  bump(tally, `Binding.${b.kind}`);
  switch (b.kind) {
    case 'Static':
      return binding.static(opaque(b.value) as T);
    case 'Query':
      // `binding.query` cannot carry `dependsOn` (Phase 1674) — a typed literal
      // where it is present, the constructor where it is not.
      return b.dependsOn === undefined
        ? binding.query<unknown, T>(b.name, b.accessor)
        : { kind: 'Query', name: b.name, accessor: b.accessor, dependsOn: b.dependsOn };
    case 'Filter':
      // NO CONSTRUCTOR for the defaulted arm — `binding.filter` takes a name only.
      return 'defaultValue' in b
        ? { kind: 'Filter', name: b.name, defaultValue: opaque(b.defaultValue) }
        : binding.filter<T>(b.name);
    case 'Selection':
      if (b.field !== undefined)
        return binding.selectionField<T>(b.nodeId, b.field, b.defaultValue);
      return b.defaultValue === undefined
        ? binding.selection<unknown, T>(b.nodeId, b.accessor)
        : binding.selectionWithDefault<unknown, T>(b.nodeId, b.accessor, b.defaultValue);
    case 'State':
      // NO CONSTRUCTOR for the declared-default arm — `binding.state` cannot
      // spell `defaultDeclared`, which the wire uses to keep an explicitly
      // authored default distinct from the structural one.
      return b.defaultDeclared === undefined
        ? binding.state<T>(b.key, opaque(b.defaultValue) as T)
        : {
            kind: 'State',
            key: b.key,
            defaultValue: opaque(b.defaultValue) as T,
            defaultDeclared: b.defaultDeclared,
          };
    case 'Computed':
      return binding.computed<T>(b.compute);
    // NO CONSTRUCTOR — the authoring surface has no `binding.now`.
    case 'Now':
      return b.grain === undefined
        ? { kind: 'Now', project: b.project }
        : { kind: 'Now', project: b.project, grain: b.grain };
    case 'I18n':
      // One arm for two slots: `Binding.I18n` and `TextSource.I18n` carry the
      // same argument type and differ only in the slot's presence (§5).
      return (
        b.args === undefined
          ? binding.i18n(b.key)
          : binding.i18n(b.key, reauthorI18nArgs(b.args, tally))
      ) as Binding<T>;
    case 'Local': {
      // NO TOTAL CONSTRUCTOR — `binding.local` takes a REQUIRED `onCommit` and
      // cannot spell `codec` or `commitTo`, so a decoded declarative local
      // buffer has no constructor spelling. The nested parts that ARE author
      // values (the initial binding, the codec `Format`) still go through the
      // surface.
      const l = b.local;
      return {
        kind: 'Local',
        local: {
          ...l,
          initialFrom: reauthorBinding(l.initialFrom, tally),
          ...(l.codec === undefined ? {} : { codec: reauthorFormat(l.codec) }),
        },
      };
    }
    case 'Format':
      return binding.format(
        reauthorBinding(b.source, tally),
        reauthorFormat(b.format),
        reauthorLocale(b.locale),
      ) as Binding<T>;
    case 'Transform':
      // NO TOTAL CONSTRUCTOR — `binding.transform` wraps a bare source into
      // `{kind:'Data'}` and `binding.transformLive` injects its own empty
      // `initial`, so neither reproduces a decoded `TransformSource`.
      return b.params === undefined
        ? { kind: 'Transform', source: b.source, pipeline: b.pipeline }
        : { kind: 'Transform', source: b.source, pipeline: b.pipeline, params: b.params };
    // NO CONSTRUCTOR — the authoring surface has no `binding.expr`; a column
    // expression is built through the `df(...)` pipeline surface instead.
    case 'Expr':
      return b.params === undefined
        ? { kind: 'Expr', expr: b.expr }
        : { kind: 'Expr', expr: b.expr, params: b.params };
    case 'Invoke':
      return binding.invoke<T>(b.capabilityId, b.args);
  }
};

export const reauthorText = (t: TextSource, tally: ReauthorTally): TextSource => {
  bump(tally, `TextSource.${t.kind}`);
  switch (t.kind) {
    // NO CONSTRUCTOR — `@fuaran-ui/ui` exports no `TextSource` family at all.
    // Its `text()` coercion is module-private, so an author reaching for a
    // non-literal `TextSource` writes the record by hand. That is exactly the
    // slot Phase 1661 widened, and the absence of a constructor is why the
    // widening reached consumers with no compile error anywhere in this repo.
    case 'Literal':
      return { kind: 'Literal', value: t.value };
    case 'Bound':
      return { kind: 'Bound', binding: reauthorBinding(t.binding, tally) };
    case 'I18n':
      return { kind: 'I18n', key: t.key, args: reauthorI18nArgs(t.args, tally) };
  }
};

export const reauthorAction = (a: Action<unknown>, tally: ReauthorTally): Action<unknown> => {
  bump(tally, `Action.${a.kind}`);
  switch (a.kind) {
    case 'Dispatch':
      return action.dispatch(opaque(a.msg));
    case 'Call':
      if (a.onResult !== undefined) return action.call<unknown, unknown>(a.endpoint, a.onResult);
      if (a.into?.kind === 'State') return action.callIntoState(a.endpoint, a.into.key);
      if (a.into?.kind === 'Query') return action.callIntoQuery(a.endpoint, a.into.name);
      // NO CONSTRUCTOR — a fire-and-forget command call has neither.
      return a.into === undefined
        ? { kind: 'Call', endpoint: a.endpoint as ApiEndpoint }
        : { kind: 'Call', endpoint: a.endpoint as ApiEndpoint, into: a.into };
    case 'Notify':
      return action.notify(a.channel, opaque(a.payload) as JsonValue);
    case 'Navigate':
      return action.navigateTo(reauthorText(a.route, tally), a.target as NavigateTarget);
    case 'SetState':
      if (a.valueFrom !== undefined)
        return action.setStateFrom(a.key, reauthorBinding(a.valueFrom, tally));
      // NO CONSTRUCTOR for the valueless arm — `action.setState` requires a value.
      return 'value' in a
        ? action.setState(a.key, opaque(a.value) as JsonValue)
        : { kind: 'SetState', key: a.key };
    case 'AiTool':
      return action.aiTool(a.toolName, opaque(a.args) as JsonValue);
    case 'Chain':
      return action.chain(a.actions.map((x) => reauthorAction(x, tally)));
    case 'CommitLocal':
      return action.commitLocal(a.nodeId);
    case 'WriteToClipboard':
      return action.writeToClipboard(reauthorText(a.text, tally));
    case 'Print':
      return action.print();
    case 'Confirm':
      return action.confirm(
        reauthorText(a.prompt, tally),
        reauthorAction(a.onConfirm, tally),
        a.onCancel === undefined ? undefined : reauthorAction(a.onCancel, tally),
      );
    case 'Focus':
      return action.focus(a.nodeId);
    case 'ReadFileBody':
      return action.readFileBody(a.file, a.encoding, a.onRead);
    case 'Invoke':
      return action.invoke(a.capabilityId, a.args);
  }
};

// ─── Locating the author-facing values inside a decoded tree ────────────────
//
// The walk is structural: it copies the tree and rebuilds any object whose
// discriminant AND member set match one of the unions above. It is deliberately
// NOT driven by per-node-kind knowledge of where each slot lives — that would be
// a second copy of the schema, and a stale one. A mis-identification is not
// silent: every rebuild above is the identity on a well-formed value, so an
// object rebuilt through the wrong union fails the byte comparison by fixture
// name.

const BINDING_CASES: ReadonlyMap<string, readonly [readonly string[], readonly string[]]> = new Map(
  [
    ['Static', [['value'], []]],
    ['Query', [['name', 'accessor'], ['dependsOn']]],
    ['Filter', [['name'], ['defaultValue']]],
    [
      'Selection',
      [
        ['nodeId', 'accessor'],
        ['defaultValue', 'field'],
      ],
    ],
    ['State', [['key', 'defaultValue'], ['defaultDeclared']]],
    ['Computed', [['compute'], []]],
    ['Now', [['project'], ['grain']]],
    ['Local', [['local'], []]],
    ['Format', [['source', 'format', 'locale'], []]],
    ['Transform', [['source', 'pipeline'], ['params']]],
    ['Expr', [['expr'], ['params']]],
    ['Invoke', [['capabilityId', 'args'], []]],
  ] as [string, readonly [readonly string[], readonly string[]]][],
);

const ACTION_CASES: ReadonlyMap<string, readonly [readonly string[], readonly string[]]> = new Map([
  ['Dispatch', [['msg'], []]],
  ['Call', [['endpoint'], ['onResult', 'into']]],
  ['Notify', [['channel', 'payload'], []]],
  ['Navigate', [['route', 'target'], []]],
  ['SetState', [['key'], ['value', 'valueFrom']]],
  ['AiTool', [['toolName', 'args'], []]],
  ['Chain', [['actions'], []]],
  ['CommitLocal', [['nodeId'], []]],
  ['WriteToClipboard', [['text'], []]],
  ['Print', [[], []]],
  ['Confirm', [['prompt', 'onConfirm'], ['onCancel']]],
  ['Focus', [['nodeId'], []]],
  ['ReadFileBody', [['file', 'encoding', 'onRead'], []]],
] as [string, readonly [readonly string[], readonly string[]]][]);

const TEXT_CASES: ReadonlyMap<string, readonly [readonly string[], readonly string[]]> = new Map([
  ['Literal', [['value'], []]],
  ['Bound', [['binding'], []]],
  ['I18n', [['key', 'args'], []]],
] as [string, readonly [readonly string[], readonly string[]]][]);

const matched = (
  cases: ReadonlyMap<string, readonly [readonly string[], readonly string[]]>,
  o: Obj,
  kind: string,
): boolean => {
  const spec = cases.get(kind);
  return spec !== undefined && shaped(o, spec[0], spec[1]);
};

const reauthorValue = (o: Obj, tally: ReauthorTally): unknown => {
  const kind = o['kind'];
  if (typeof kind !== 'string') return undefined;

  // `I18n` is shared between `Binding` and `TextSource`, and `Invoke` between
  // `Binding` and `Action`. In both pairs the two cases carry the same members
  // and rebuild identically, so the order below decides nothing observable.
  if (kind === 'I18n' && matched(TEXT_CASES, o, kind))
    return reauthorText(o as unknown as TextSource, tally);
  if (matched(BINDING_CASES, o, kind))
    return reauthorBinding(o as unknown as Binding<unknown>, tally);
  if (kind === 'I18n' && 'key' in o) return reauthorBinding(o as unknown as Binding<string>, tally);
  if (matched(ACTION_CASES, o, kind)) return reauthorAction(o as unknown as Action<unknown>, tally);
  return undefined;
};

const walk = (v: unknown, tally: ReauthorTally): unknown => {
  if (Array.isArray(v)) return v.map((x) => walk(x, tally));
  if (!isObj(v)) return v;

  const rebuilt = reauthorValue(v, tally);
  if (rebuilt !== undefined) return rebuilt;

  const out: Obj = {};
  for (const [k, val] of Object.entries(v)) out[k] = walk(val, tally);
  return out;
};

/**
 * Rebuild every author-facing value in a decoded node through `@fuaran-ui/ui`.
 * The node shell is copied structurally — see the header for why re-authoring it
 * is not a function that exists.
 */
export const reauthorNode = (n: Node<unknown>, tally: ReauthorTally): Node<unknown> =>
  walk(n, tally) as Node<unknown>;

/** The node id a rebuilt tree keeps, for the caller's error messages. */
export const nodeIdOf = (n: Node<unknown>): NodeId => n.id;
