// fuaran_recipe — query → a matching cookbook recipe.
//
// Serves the bundled recipe bank: per recipe, the canonical natural-language
// prompts, the canonical F# emission (the structurally-correct target tree),
// the variant points (the parameterised slots + expected substitution
// behaviour), and the anti-patterns. An agent uses the match as the reference
// answer for what it is about to generate or hand-author — the same pattern
// bank that seeds Fuaran's own prompt-recognition fast paths.

import { RECIPES } from '../recipeBank.generated.js';
import type { RecipeEntry } from '../recipeTypes.js';

export interface RecipeArgs {
  /** Free-text description of the UI pattern wanted, e.g. "a row of KPI
   *  tiles with trend deltas" or "tabbed settings panel". */
  readonly query: string;
}

export interface RecipeSummary {
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  /** First sentence of what the recipe expresses. */
  readonly expresses: string;
}

export interface RecipeResult {
  /** The best-scoring recipe, or null when nothing scored at all. */
  readonly match: RecipeEntry | null;
  /** The next-best candidates, so the agent can re-query by tag/title. */
  readonly alternates: readonly RecipeSummary[];
  /** How many recipes the bank holds. */
  readonly available: number;
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'over',
  'add',
  'give',
  'show',
  'make',
  'want',
  'need',
  'panel',
  'component',
]);

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9%]+/g) ?? []).filter(
    (t) => t.length >= 3 && !STOPWORDS.has(t),
  );
}

function firstSentence(text: string): string {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text.replace(/\n/g, ' '));
  return (m ? m[0] : text).trim();
}

function score(query: string, queryTokens: readonly string[], recipe: RecipeEntry): number {
  const q = query.toLowerCase();
  const inText = (haystack: string, weight: number): number => {
    const h = haystack.toLowerCase();
    let s = 0;
    for (const t of queryTokens) {
      if (h.includes(t)) s += weight;
    }
    return s;
  };
  let s = 0;
  s += inText(recipe.title, 5);
  s += inText(recipe.tag.replace(/[.-]/g, ' '), 4);
  for (const prompt of recipe.prompts) {
    s += inText(prompt, 2);
    // A near-verbatim prompt hit is the strongest possible signal.
    if (prompt.toLowerCase().includes(q) || q.includes(prompt.toLowerCase())) s += 25;
  }
  s += inText(recipe.expresses, 1);
  return s;
}

export function runRecipe(args: RecipeArgs): RecipeResult {
  const queryTokens = tokens(args.query);
  const ranked = RECIPES.map((recipe) => ({
    recipe,
    s: score(args.query, queryTokens, recipe),
  }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s);

  const summary = (r: RecipeEntry): RecipeSummary => ({
    id: r.id,
    title: r.title,
    tag: r.tag,
    expresses: firstSentence(r.expresses),
  });

  return {
    match: ranked[0]?.recipe ?? null,
    alternates: ranked.slice(1, 4).map((r) => summary(r.recipe)),
    available: RECIPES.length,
  };
}

/** The whole bank as summaries — served when a query matches nothing, so the
 *  agent can see what exists instead of guessing new phrasings. */
export function listRecipes(): readonly RecipeSummary[] {
  return RECIPES.map((r) => ({
    id: r.id,
    title: r.title,
    tag: r.tag,
    expresses: firstSentence(r.expresses),
  }));
}
