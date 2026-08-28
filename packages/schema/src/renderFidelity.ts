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

/** Every declared obligation, paired with the kind that owes it, in table order. */
export const allObligations = (
  manifest: RenderFidelityManifest,
): readonly { readonly kind: string; readonly obligation: RenderObligation }[] =>
  manifest.kinds.flatMap((row) =>
    row.obligations.map((obligation) => ({ kind: row.kind, obligation })),
  );

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
