// ============================================================================
//  The `Binding.State` SEEDING rule on the TypeScript render path (Phase 1075).
//
//  The shared-data-source charter's §3.1 pair, executed on this tier: a
//  `DataGrid` bound to `$state.members` and carrying the rows on its own
//  `defaultValue`, beside a `Badge` whose `Transform` derives a count over the
//  SAME key with no data of its own. Before this phase `defaultValue` was a
//  per-reader fallback, nothing wrote the grid's rows into the store, and the
//  badge derived over an empty table.
//
//  The document under test is byte-for-byte the one the F# tier's
//  `SharedSourceSeedingTests` decodes, so a divergence between the two
//  reference hosts fails here rather than at a corpus sweep months later.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { collectStateSeeds, decodeNode } from '@fuaran-ui/ops';
import { renderToHtml } from '../src/render.js';

const gridJson =
  '{"id":"member-grid","kind":{"$type":"DataGrid","columns":[{"field":"team","kind":{"$type":"Text"},"label":"Team"}],"rowKeyField":"team","source":{"$type":"State","defaultValue":[{"team":"Ops"},{"team":"Research"}],"key":"members"}}}';

// `"defaultValue":[]` is how a Transform's source slot spells "I read this key
// and carry no data of my own" on the wire today — a bare
// `{"$type":"State","key":k}` wrapper is refused as un-unwrappable
// (`WIRE_FORMAT.md` §16). It declares nothing, so it neither seeds the slot
// empty nor conflicts with the grid beside it.
const badgeJson =
  '{"id":"member-count","kind":{"$type":"Badge","label":{"$type":"Bound","binding":{"$type":"Transform","pipeline":[{"$type":"groupBy","aggs":[{"fn":"count","name":"n","of":"team"}],"keys":[]}],"source":{"$type":"State","defaultValue":[],"key":"members"}}},"variant":"Info"}}';

const pairJson = (childrenInOrder: readonly string[]) =>
  `{"id":"shared-source-pair","kind":{"$type":"Box","children":[${childrenInOrder.join(
    ',',
  )}],"heading":"Members","layout":{"$type":"Auto"},"role":"Dashboard"}}`;

const decode = (json: string) => {
  const r = decodeNode(json);
  if (!r.ok) throw new Error(`decode failed: ${JSON.stringify(r)}`);
  return r.value;
};

describe('Binding.State seeding (Phase 1075 — the shared-data-source charter O1)', () => {
  it("the charter's §3.1 pair: the grid's declaration seeds the slot the badge derives from", () => {
    const tree = decode(pairJson([gridJson, badgeJson]));

    const seeds = collectStateSeeds(tree);
    expect(Object.keys(seeds)).toEqual(['members']);
    expect(seeds['members']).toEqual([{ team: 'Ops' }, { team: 'Research' }]);
  });

  it('the SSR frame renders the derived count, not an empty badge', () => {
    const html = renderToHtml(decode(pairJson([gridJson, badgeJson])));

    expect(html).toContain('>2<');
    // The grid reads the SAME slot and reports the same two rows.
    expect(html).toContain('Ops');
    expect(html).toContain('Research');
  });

  it('the before-state: the badge alone renders nothing derived', () => {
    const html = renderToHtml(decode(badgeJson));

    expect(html).not.toContain('>2<');
  });

  it('order-independent: the badge declared BEFORE the grid reads the same rows', () => {
    // Charter §5 — the pass runs over the whole tree before any binding
    // resolves, so a forward reference is not a special case. This is also the
    // assertion the empty-declaration rule exists for: without it the badge's
    // `"defaultValue":[]` would win the first-declaration race and seed the
    // slot empty.
    const html = renderToHtml(decode(pairJson([badgeJson, gridJson])));

    expect(html).toContain('>2<');
  });

  it('precedence: a host-furnished value wins over the seed', () => {
    // Charter §4 — a seed is the value before anything else has said anything.
    const html = renderToHtml(decode(pairJson([gridJson, badgeJson])), {
      sources: { state: { members: [{ team: 'Ops' }] } },
    });

    expect(html).toContain('>1<');
  });

  it('a host-reserved key is never seeded', () => {
    // A seed is a tree-originated write; letting one land in the host-reserved
    // namespace would give the wire a way around a deliberate floor.
    const reserved = gridJson.replace('"key":"members"', '"key":"host.members"');

    expect(Object.keys(collectStateSeeds(decode(pairJson([reserved]))))).toEqual([]);
  });

  it('a form field auto-bound at decode does NOT seed its own key', () => {
    // The decoder synthesises `{kind:'State', key:<field id>, defaultValue:''}`
    // for a value-less field; the F# tier keeps the slot absent and auto-binds
    // at render instead. A synthesised default is not a declaration, and
    // seeding it would put a `''` under the field's key on this tier and
    // nothing on the other, from ONE document.
    const form =
      '{"id":"f","kind":{"$type":"Form","fields":[{"id":"name","kind":{"$type":"Text"},"label":"Name","required":false}],"onSubmit":{"$type":"Navigate","href":"/x"},"submitLabel":"Save"}}';

    expect(Object.keys(collectStateSeeds(decode(form)))).toEqual([]);
  });

  it('an explicit declaration on a form field DOES seed', () => {
    // The go-red partner: the exclusion is the decoder's synthesis, not the
    // slot. A field carrying a value the encoder would emit is a declaration
    // like any other.
    const form =
      '{"id":"f","kind":{"$type":"Form","fields":[{"id":"name","kind":{"$type":"Text","value":{"$type":"State","defaultValue":"Ada","key":"name"}},"label":"Name","required":false}],"onSubmit":{"$type":"Navigate","href":"/x"},"submitLabel":"Save"}}';

    expect(collectStateSeeds(decode(form))).toEqual({ name: 'Ada' });
  });
});
