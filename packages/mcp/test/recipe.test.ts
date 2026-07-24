// fuaran_recipe returns real cookbook recipes from the bundled bank.

import { describe, expect, it } from 'vitest';

import { listRecipes, runRecipe } from '../src/index.js';
import { RECIPES } from '../src/recipeBank.generated.js';

describe('the bundled recipe bank', () => {
  it('holds a non-trivial set of complete recipes', () => {
    expect(RECIPES.length).toBeGreaterThanOrEqual(10);
    for (const recipe of RECIPES) {
      expect(recipe.title).not.toBe('');
      expect(recipe.tag).toMatch(/^ui\./);
      expect(recipe.prompts.length).toBeGreaterThanOrEqual(3);
      expect(recipe.expresses).not.toBe('');
      expect(recipe.emissionFsharp).toContain('open Fuaran.UI');
    }
  });
});

describe('fuaran_recipe matching', () => {
  it('finds the metric strip for a KPI-tiles query', () => {
    const result = runRecipe({ query: 'a row of metric tiles with trend deltas' });
    expect(result.match?.tag).toBe('ui.metric-strip');
    expect(result.match?.emissionFsharp).toContain('Fuaran.gridLayout');
    expect(result.match?.variantPoints).toContain('Slot');
  });

  it('finds the tabbed panel for a tabs query', () => {
    const result = runRecipe({ query: 'tabbed settings with mutually exclusive panels' });
    expect(result.match?.tag).toBe('ui.tabs');
  });

  it('matches a canonical prompt near-verbatim', () => {
    const anyRecipe = RECIPES[0]!;
    const result = runRecipe({ query: anyRecipe.prompts[0]! });
    expect(result.match?.id).toBe(anyRecipe.id);
  });

  it('offers alternates alongside the match', () => {
    const result = runRecipe({ query: 'a dashboard with charts and a data grid' });
    expect(result.match).not.toBeNull();
    expect(result.alternates.length).toBeGreaterThan(0);
    expect(result.available).toBe(RECIPES.length);
  });

  it('returns no match (not a wrong match) for an unrelated query', () => {
    const result = runRecipe({ query: 'zzzzz qqqqq xxxxx' });
    expect(result.match).toBeNull();
  });

  it('lists the whole bank as summaries', () => {
    const all = listRecipes();
    expect(all.length).toBe(RECIPES.length);
    expect(all[0]!.expresses.length).toBeLessThan(400);
  });
});
