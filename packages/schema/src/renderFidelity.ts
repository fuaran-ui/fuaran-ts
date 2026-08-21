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

  return {
    version,
    $id: typeof rawId === 'string' ? rawId : '',
    description: typeof rawDescription === 'string' ? rawDescription : '',
    tiers,
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
