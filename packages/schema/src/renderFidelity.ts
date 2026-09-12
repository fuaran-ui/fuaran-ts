// ============================================================================
//  Render-fidelity manifest — the TypeScript reader (WIRE_FORMAT.md §13).
//
//  The canonical wire format ships a generated per-`NodeKind` declaration at
//  `wire-format-fixtures/render-fidelity.json`: for each `kind.$type`, what the
//  wire carries (source), what the parity-checked render pins (fallback), and
//  what — if anything — is declared client-only rich.
//
//  This module is the reader and the badge derivation, NOT a copy of the data.
//  That distinction is the whole point: the tiers were prose until the manifest
//  landed, and any surface that wanted to SAY which tier it was delivering had
//  to hand-annotate. A hand annotation in this repo would be a second source of
//  truth that drifts from the F# declaration silently, which is exactly the
//  defect the artefact exists to remove. So nothing here enumerates kinds or
//  states a posture; the manifest is passed in, parsed, and read.
//
//  Loading is the caller's, because a browser bundle has no filesystem: pass
//  the parsed JSON (fetched, imported, or read from the corpus checkout). This
//  package therefore stays dependency-free and usable on either side.
// ============================================================================

/**
 * How a kind's declared client-only tier relates to the parity-checked DOM.
 *
 * `clientOnly` REPLACES or upgrades the fallback's DOM after hydration and is
 * excluded from every parity comparison by contract. `behavioural` attaches
 * behaviour at hydration and must NOT alter the hydrated DOM — which is why
 * the overlay contract admits a focus trap and refuses a portal. `none` is a
 * positive statement: the fallback is the whole render.
 */
export type RichTierClass = 'none' | 'behavioural' | 'clientOnly';

export interface RichTier {
  readonly class: RichTierClass;
  /** Why this class means what it means — carried by the artefact itself. */
  readonly meaning: string;
  /** `clientOnly` only: what does the upgrading (highlighting, KaTeX, …). */
  readonly technique?: string;
  /** `behavioural` only: what is attached (focus trap, keyboard nav, …). */
  readonly enhancement?: string;
  /** Where the enhancement attaches. */
  readonly seam?: string;
}

/**
 * A render obligation a conformant host owes for a kind (WIRE_FORMAT.md §13) —
 * one member of a CLOSED vocabulary of checkable claims.
 *
 * The `fallback` prose beside it is complete, normative, and unfalsifiable by a
 * machine: a host can render the kind, pass every byte-parity fixture, and still
 * have silently dropped an obligation the paragraph states. These claims are the
 * checkable remainder — each names one consequence a host's render suite can
 * assert in emitted output, bound to the section that states it.
 *
 * The id is deliberately NOT typed as a union of literals here. This module is
 * the READER: the artefact carries the closed set in `obligationVocabulary`, and
 * a host resolves ids against that rather than against a copy compiled into this
 * package — a copy would go stale against a newer corpus in exactly the silent
 * way the artefact exists to prevent. A host that meets an id its own checkers
 * do not cover must report it, never assume it.
 */
export interface RenderObligation {
  /** The vocabulary token, resolvable in `manifest.obligationVocabulary`. */
  readonly id: string;
  /** The normative sentence, as the cited section states it for this kind. */
  readonly statement: string;
  /** The spec section that states it (`WIRE_FORMAT.md 3.6.6`). */
  readonly section: string;
}

/** One entry of the closed obligation vocabulary. */
export interface ObligationVocabularyEntry {
  readonly id: string;
  /** What the claim means kind-independently — what a host prints when it must
   * report the claim as unchecked with substance rather than as a bare token. */
  readonly meaning: string;
}

/** One kind's declared render-fidelity posture. */
export interface FidelityRow {
  /** The wire discriminator (`kind.$type`). */
  readonly kind: string;
  /** Whether the kind carries an explicit, phase-pinned fidelity contract. */
  readonly sensitive: boolean;
  readonly source: string;
  readonly fallback: string;
  readonly rich: RichTier;
  /** Corpus-relative fixture paths pinning the fallback. */
  readonly fixtures: readonly string[];
  /**
   * The checkable render obligations this kind owes. Empty means the row states
   * no checkable claim — NOT that its fallback prose is optional.
   */
  readonly obligations: readonly RenderObligation[];
  readonly contract: string;
}

/**
 * One checkable claim a node-level TRAIT owes (Phase 1696).
 *
 * The sibling of `RenderObligation` over the other subject population, plus
 * `rule`: the ordinal of the numbered rule in the cited section. It is carried
 * rather than left to be matched from the prose — §3.1 states five numbered
 * obligations and a conformant host registers five checkers, and without the
 * ordinal the correspondence between them is a reader's reconstruction rather
 * than a fact in the artefact. Absent where the section does not number its
 * rules.
 */
export interface TraitObligation {
  readonly id: string;
  readonly statement: string;
  readonly section: string;
  readonly rule?: number;
}

/** Which kinds a trait's obligations ride. */
export interface TraitScope {
  /**
   * `allKinds` for a member riding the node envelope; `namedKinds` with the
   * list beside it otherwise. Tagged rather than a bare list because "every
   * kind" must not be spellable as an empty array, which reads as the opposite
   * claim.
   */
  readonly scope: 'allKinds' | 'namedKinds';
  readonly kinds: readonly string[];
}

/**
 * One node-level TRAIT: a member that rides the node ENVELOPE rather than any
 * one kind (Phase 1696).
 *
 * `style.direction` is owed by a `Badge`, a `Markdown` and a `DataGrid` alike
 * and belongs to none of them, so declaring it on kind rows would state
 * forty-odd claims where there is one. `trait` is the wire PATH of the member it
 * governs, which is why a host can key one registry by `subject/claim`: a dotted
 * path can never collide with a `kind.$type`.
 */
export interface TraitRow {
  readonly trait: string;
  readonly summary: string;
  readonly appliesTo: TraitScope;
  /** Corpus-relative fixture paths that CARRY the trait. */
  readonly fixtures: readonly string[];
  readonly obligations: readonly TraitObligation[];
  readonly contract: string;
}

export interface FidelityTierDefinition {
  readonly tier: string;
  readonly meaning: string;
}

export interface RenderFidelityManifest {
  readonly version: number;
  readonly $id: string;
  readonly description: string;
  readonly tiers: readonly FidelityTierDefinition[];
  /**
   * The closed set of obligation claims that exist, independent of which kinds
   * happen to declare them. A host keys its checker registry by these ids and
   * can therefore report one it does not implement.
   */
  readonly obligationVocabulary: readonly ObligationVocabularyEntry[];
  /**
   * The node-level traits, whose claims ride any kind. Drawn from the SAME
   * closed `obligationVocabulary` as the kind rows: the vocabulary answers which
   * claims exist, which has nothing to do with which subject owes one.
   */
  readonly traits: readonly TraitRow[];
  readonly kinds: readonly FidelityRow[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const requireString = (o: Record<string, unknown>, key: string, where: string): string => {
  const v = o[key];
  if (typeof v !== 'string') throw new Error(`render-fidelity: ${where}.${key} must be a string`);
  return v;
};

const parseRich = (value: unknown, kind: string): RichTier => {
  if (!isRecord(value)) throw new Error(`render-fidelity: ${kind}.rich must be an object`);
  const cls = requireString(value, 'class', `${kind}.rich`);
  if (cls !== 'none' && cls !== 'behavioural' && cls !== 'clientOnly')
    throw new Error(`render-fidelity: ${kind}.rich.class is an unknown tier class '${cls}'`);
  const technique = value['technique'];
  const enhancement = value['enhancement'];
  const seam = value['seam'];
  return {
    class: cls,
    meaning: requireString(value, 'meaning', `${kind}.rich`),
    ...(typeof technique === 'string' ? { technique } : {}),
    ...(typeof enhancement === 'string' ? { enhancement } : {}),
    ...(typeof seam === 'string' ? { seam } : {}),
  };
};

/**
 * Obligations are parsed leniently only in ABSENCE — an artefact predating the
 * obligation vocabulary carries no `obligations` key, and reading that as an
 * empty list is honest. A key that is PRESENT and malformed throws, because a
 * host that silently read a malformed obligation list as empty would report
 * itself fully conformant while checking nothing.
 */
const parseObligations = (value: unknown, kind: string): readonly RenderObligation[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error(`render-fidelity: ${kind}.obligations must be an array`);
  return value.map((entry): RenderObligation => {
    if (!isRecord(entry))
      throw new Error(`render-fidelity: ${kind}.obligations[] must hold objects`);
    return {
      id: requireString(entry, 'id', `${kind}.obligations[]`),
      statement: requireString(entry, 'statement', `${kind}.obligations[]`),
      section: requireString(entry, 'section', `${kind}.obligations[]`),
    };
  });
};

/**
 * Parse the generated artefact. Throws with the offending path rather than
 * returning a partially-populated manifest: a fidelity surface that silently
 * degrades to "no data" is how a badge starts lying.
 */
export const parseRenderFidelityManifest = (value: unknown): RenderFidelityManifest => {
  if (!isRecord(value)) throw new Error('render-fidelity: the manifest must be a JSON object');
  const version = value['version'];
  const rawKinds = value['kinds'];
  const rawTiers = value['tiers'];
  const rawId = value['$id'];
  const rawDescription = value['description'];

  if (typeof version !== 'number')
    throw new Error('render-fidelity: manifest.version must be a number');
  if (!Array.isArray(rawKinds)) throw new Error('render-fidelity: manifest.kinds must be an array');
  if (!Array.isArray(rawTiers)) throw new Error('render-fidelity: manifest.tiers must be an array');

  const kinds = rawKinds.map((entry): FidelityRow => {
    if (!isRecord(entry)) throw new Error('render-fidelity: manifest.kinds[] must hold objects');
    const kind = requireString(entry, 'kind', 'kinds[]');
    const rawFixtures = entry['fixtures'];
    const fixtures = Array.isArray(rawFixtures) ? rawFixtures : [];
    return {
      kind,
      sensitive: entry['sensitive'] === true,
      source: requireString(entry, 'source', kind),
      fallback: requireString(entry, 'fallback', kind),
      rich: parseRich(entry['rich'], kind),
      fixtures: fixtures.map((f) => {
        if (typeof f !== 'string')
          throw new Error(`render-fidelity: ${kind}.fixtures[] must be strings`);
        return f;
      }),
      obligations: parseObligations(entry['obligations'], kind),
      contract: requireString(entry, 'contract', kind),
    };
  });

  const tiers = rawTiers.map((entry): FidelityTierDefinition => {
    if (!isRecord(entry)) throw new Error('render-fidelity: manifest.tiers[] must hold objects');
    return {
      tier: requireString(entry, 'tier', 'tiers[]'),
      meaning: requireString(entry, 'meaning', 'tiers[]'),
    };
  });

  // An ABSENT `traits` key parses as empty, on the terms `obligationVocabulary`
  // below is parsed on: traits are additive within a major version, so a reader
  // must survive an artefact that predates the section.
  const rawTraits = value['traits'];
  if (rawTraits !== undefined && !Array.isArray(rawTraits))
    throw new Error('render-fidelity: manifest.traits must be an array');

  const traits = (rawTraits ?? []).map((entry: unknown): TraitRow => {
    if (!isRecord(entry)) throw new Error('render-fidelity: manifest.traits[] must hold objects');
    const name = requireString(entry, 'trait', 'traits[]');
    const rawScope = entry['appliesTo'];
    if (!isRecord(rawScope))
      throw new Error(`render-fidelity: ${name}.appliesTo must be an object`);
    const scope = requireString(rawScope, 'scope', `${name}.appliesTo`);
    if (scope !== 'allKinds' && scope !== 'namedKinds')
      throw new Error(`render-fidelity: ${name}.appliesTo.scope is unknown: '${scope}'`);
    const rawScopeKinds = rawScope['kinds'];
    const scopeKinds = Array.isArray(rawScopeKinds) ? rawScopeKinds : [];
    const rawTraitFixtures = entry['fixtures'];
    const traitFixtures = Array.isArray(rawTraitFixtures) ? rawTraitFixtures : [];
    const rawTraitObligations = entry['obligations'];
    if (!Array.isArray(rawTraitObligations))
      throw new Error(`render-fidelity: ${name}.obligations must be an array`);
    return {
      trait: name,
      summary: requireString(entry, 'summary', name),
      appliesTo: {
        scope,
        kinds: scopeKinds.map((k: unknown) => {
          if (typeof k !== 'string')
            throw new Error(`render-fidelity: ${name}.appliesTo.kinds[] must be strings`);
          return k;
        }),
      },
      fixtures: traitFixtures.map((f: unknown) => {
        if (typeof f !== 'string')
          throw new Error(`render-fidelity: ${name}.fixtures[] must be strings`);
        return f;
      }),
      obligations: rawTraitObligations.map((o: unknown): TraitObligation => {
        if (!isRecord(o))
          throw new Error(`render-fidelity: ${name}.obligations[] must hold objects`);
        const where = `${name}.obligations[]`;
        const rule = o['rule'];
        return {
          id: requireString(o, 'id', where),
          statement: requireString(o, 'statement', where),
          section: requireString(o, 'section', where),
          ...(typeof rule === 'number' ? { rule } : {}),
        };
      }),
      contract: requireString(entry, 'contract', name),
    };
  });

  const rawVocabulary = value['obligationVocabulary'];
  if (rawVocabulary !== undefined && !Array.isArray(rawVocabulary))
    throw new Error('render-fidelity: manifest.obligationVocabulary must be an array');

  const obligationVocabulary = (rawVocabulary ?? []).map(
    (entry: unknown): ObligationVocabularyEntry => {
      if (!isRecord(entry))
        throw new Error('render-fidelity: manifest.obligationVocabulary[] must hold objects');
      return {
        id: requireString(entry, 'id', 'obligationVocabulary[]'),
        meaning: requireString(entry, 'meaning', 'obligationVocabulary[]'),
      };
    },
  );

  return {
    version,
    $id: typeof rawId === 'string' ? rawId : '',
    description: typeof rawDescription === 'string' ? rawDescription : '',
    tiers,
    obligationVocabulary,
    traits,
    kinds,
  };
};

/**
 * The declared posture of a wire kind, or `undefined` for a kind the manifest
 * does not carry — which is the honest answer for a kind arriving over the
 * §15.3 tolerance path, and must be reported as unknown rather than assumed
 * single-tier.
 */
export const fidelityOf = (
  manifest: RenderFidelityManifest,
  wireKind: string,
): FidelityRow | undefined => manifest.kinds.find((r) => r.kind === wireKind);

export interface BadgeSegment {
  readonly tier: 'source' | 'fallback' | 'rich';
  /**
   * Whether the kind HAS this tier. False on `rich` is a positive statement
   * ("the fallback is the whole render"), not missing information.
   */
  readonly present: boolean;
  readonly detail: string;
}

/**
 * The three-segment fidelity badge for a row: source / fallback / rich.
 *
 * The port of `Fuaran.UI.RenderFidelity.badge`. Same manifest, same three
 * segments, same order, so a badge reads identically whichever host produced
 * the page.
 */
export const fidelityBadge = (row: FidelityRow): readonly BadgeSegment[] => [
  { tier: 'source', present: true, detail: row.source },
  { tier: 'fallback', present: true, detail: row.fallback },
  {
    tier: 'rich',
    present: row.rich.class !== 'none',
    detail:
      row.rich.class === 'none'
        ? row.rich.meaning
        : row.rich.class === 'behavioural'
          ? `behaviour only, no DOM change: ${row.rich.enhancement ?? ''} (${row.rich.seam ?? ''})`
          : `client-only, outside every parity comparison: ${row.rich.technique ?? ''} (${row.rich.seam ?? ''})`,
  },
];

/**
 * Which tier a given target actually delivers for a kind.
 *
 * `noScript` is the scripts-disabled / crawler / non-browser reader: it always
 * gets the fallback, by contract. A hydrated browser gets the rich tier where
 * one is declared as `clientOnly`; a `behavioural` tier changes no DOM, so the
 * delivered RENDER is still the fallback even after hydration.
 */
export const deliveredTier = (
  row: FidelityRow,
  target: 'noScript' | 'hydrated',
): 'fallback' | 'rich' =>
  target === 'hydrated' && row.rich.class === 'clientOnly' ? 'rich' : 'fallback';

// ─── Obligation coverage (WIRE_FORMAT.md §13) ────────────────────────────────
//
// The reporting shape every adopting host uses, declared here so the hosts
// answer the same question in the same words rather than each inventing a way
// to say "we did not check that". The port of `Fuaran.UI.RenderFidelity`'s
// coverage surface.

/**
 * Every declared obligation, paired with the SUBJECT that owes it, in table
 * order: the kind rows first, then the trait rows.
 *
 * Both arrays, deliberately. The whole mechanism is that the ENUMERATION is the
 * artefact's, so a trait declared tomorrow must reach a host's report without
 * that host changing anything but its answer — and a reader iterating `kinds`
 * alone would hold a green gate over an unowed claim.
 *
 * The field is still called `kind` because every caller reads it as "who owes
 * this"; a trait id carries a dot, which is what tells the two populations
 * apart.
 */
export const allObligations = (
  manifest: RenderFidelityManifest,
): readonly {
  readonly kind: string;
  readonly obligation: RenderObligation | TraitObligation;
}[] => [
  ...manifest.kinds.flatMap((row) =>
    row.obligations.map((obligation) => ({ kind: row.kind, obligation })),
  ),
  ...manifest.traits.flatMap((row) =>
    row.obligations.map((obligation) => ({ kind: row.trait, obligation })),
  ),
];

/**
 * A host's answer for one declared obligation.
 *
 * `unchecked` is the case the whole mechanism exists for. A host that renders a
 * kind and has no checker for one of its claims must say so, WITH a reason —
 * not checked is not passed, and an obligation that quietly falls out of a
 * host's suite is exactly the silent failure the closed vocabulary replaces.
 * `notRendered` is distinct: nothing is owed, rather than owed and unpaid.
 */
export type ObligationOutcome =
  | { readonly status: 'asserted' }
  | { readonly status: 'unchecked'; readonly reason: string }
  | { readonly status: 'notRendered'; readonly reason: string };

/** One line of a host's obligation report. */
export interface ObligationReport {
  readonly kind: string;
  readonly claimId: string;
  readonly statement: string;
  readonly section: string;
  readonly outcome: ObligationOutcome;
}

/**
 * Project the manifest through a host's own answer, one line per declared
 * obligation. The ENUMERATION is the manifest's, never the host's — so a newly
 * declared obligation appears in the report the moment it lands rather than
 * when someone remembers it.
 */
export const reportObligations = (
  manifest: RenderFidelityManifest,
  statusOf: (kind: string, claimId: string) => ObligationOutcome,
): readonly ObligationReport[] =>
  allObligations(manifest).map(({ kind, obligation }) => ({
    kind,
    claimId: obligation.id,
    statement: obligation.statement,
    section: obligation.section,
    outcome: statusOf(kind, obligation.id),
  }));

/**
 * The report lines a host must SURFACE: everything it did not assert. Empty is
 * the only silent result — anything else is printed, so an unchecked obligation
 * is visible in the run rather than inferable from its absence.
 */
export const unassertedObligations = (
  report: readonly ObligationReport[],
): readonly ObligationReport[] => report.filter((line) => line.outcome.status !== 'asserted');

/**
 * The one-line rendering of a report line, so the same sentence appears in every
 * host's output.
 */
export const describeObligationReport = (line: ObligationReport): string => {
  const outcome =
    line.outcome.status === 'asserted'
      ? 'asserted'
      : line.outcome.status === 'unchecked'
        ? `UNCHECKED (${line.outcome.reason})`
        : `not rendered (${line.outcome.reason})`;
  return `${line.kind}/${line.claimId} [${line.section}]: ${outcome}`;
};
