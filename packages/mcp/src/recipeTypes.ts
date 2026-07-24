// The shape of one bundled cookbook recipe served by `fuaran_recipe`.

export interface RecipeEntry {
  /** Two-digit recipe number, e.g. "02". */
  readonly id: string;
  /** Human title, e.g. "Metric strip". */
  readonly title: string;
  /** Semantic tag, e.g. "ui.metric-strip". */
  readonly tag: string;
  /** What the recipe expresses — the visible artefact and why this is its
   *  canonical shape. */
  readonly expresses: string;
  /** Canonical natural-language prompts the pattern answers. */
  readonly prompts: readonly string[];
  /** The canonical emission in its F# manifestation — the structurally-correct
   *  target tree (valid against the build-time validator without amendment). */
  readonly emissionFsharp: string;
  /** The variant-points table (markdown): the parameterised slots in the
   *  canonical tree and the expected substitution behaviour for each. */
  readonly variantPoints: string;
  /** Anti-patterns / pitfalls (markdown): what NOT to emit, and why. */
  readonly antiPatterns: string;
}
