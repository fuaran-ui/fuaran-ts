// @fuaran-ui/mock — the bundled prompt→tree fixtures.
//
// Each fixture is a canonical wire-format tree lifted verbatim from the shared
// conformance corpus (../wire-format-fixtures/nodes/), so every response the
// mock serves is a real, decodable tree — the SDK renders it exactly as it would
// a live endpoint's reply. A prompt is matched to a fixture by keyword; a
// no-match falls back to the deterministic placeholder (never an error).

/** One bundled fixture: the keywords that select it and its canonical wire JSON. */
export interface MockFixture {
  /** Lower-cased substrings that select this fixture (first match by array order wins). */
  readonly keywords: readonly string[];
  /** Canonical wire-format JSON of the tree served for a matching prompt. */
  readonly treeJson: string;
}

/** The bundled fixtures, in match-priority order. Trees are byte-copies of the
 *  shared corpus (nodes/metric-1, card-1, form-1, btn-1, callout-1, heading-1,
 *  badge-1) — deterministic and canonical. */
export const FIXTURES: readonly MockFixture[] = [
  {
    keywords: ['metric', 'revenue', 'kpi', 'stat', 'headline number'],
    treeJson:
      '{"id":"metric-1","kind":{"$type":"Metric","format":{"$type":"Currency","code":"GBP"},"icon":"trending-up","label":"Revenue","subtext":"vs last month","tone":"Brand","trend":{"$type":"Static","value":0.07},"trendFormat":{"$type":"Percent","decimals":1},"value":{"$type":"Static","value":1234.5}}}',
  },
  {
    keywords: ['dashboard', 'card', 'summary', 'insights', 'panel'],
    treeJson:
      '{"id":"card-1","kind":{"$type":"Box","children":[{"id":"metric-1","kind":{"$type":"Metric","format":{"$type":"Currency","code":"GBP"},"icon":"trending-up","label":"Revenue","subtext":"vs last month","tone":"Brand","trend":{"$type":"Static","value":0.07},"trendFormat":{"$type":"Percent","decimals":1},"value":{"$type":"Static","value":1234.5}}}],"heading":"Insights","layout":{"$type":"Flex","direction":"Vertical","wrap":false},"role":"Card"}}',
  },
  {
    keywords: ['form', 'sign up', 'signup', 'sign-up', 'login', 'log in', 'field', 'input'],
    treeJson:
      '{"id":"form-1","kind":{"$type":"Form","disabled":{"$type":"State","defaultValue":false,"key":"formBusy"},"fields":[{"help":"Full legal name","id":"name","kind":{"$type":"Text","onChange":"<closure>","value":{"$type":"Static","value":""}},"label":"Name","required":true},{"id":"age","kind":{"$type":"Number","onChange":"<closure>","value":{"$type":"Static","value":0}},"label":"Age","required":false},{"id":"agree","kind":{"$type":"Checkbox","onToggle":"<closure>","value":{"$type":"Static","value":false}},"label":"I agree","required":true},{"id":"tier","kind":{"$type":"Choice","onChange":"<closure>","options":{"$type":"Static","value":[{"label":"Basic","value":"basic"},{"label":"Pro","value":"pro"}]},"value":{"$type":"Static","value":"basic"}},"label":"Tier","required":false},{"id":"notes","kind":{"$type":"TextArea","onChange":"<closure>","rows":5,"value":{"$type":"Static","value":""}},"label":"Notes","required":false}],"onSubmit":{"$type":"Chain","ops":[]},"submitLabel":"Save"}}',
  },
  {
    keywords: ['button', 'cta', 'action', 'submit button'],
    treeJson:
      '{"id":"btn-1","kind":{"$type":"Button","disabled":{"$type":"State","defaultValue":false,"key":"loading"},"icon":"refresh","label":"Refresh","onClick":{"$type":"Chain","ops":[]},"variant":"Primary"}}',
  },
  {
    keywords: ['callout', 'alert', 'notice', 'banner', 'warning', 'heads up'],
    treeJson:
      '{"id":"callout-1","kind":{"$type":"Callout","body":"Live data is delayed.","dismissable":true,"heading":"Heads up","icon":"alert","tone":"Warning"}}',
  },
  {
    keywords: ['heading', 'title', 'header', 'section title'],
    treeJson:
      '{"id":"heading-1","kind":{"$type":"Heading","level":2,"text":"Channel performance","variant":"Standard"}}',
  },
  {
    keywords: ['badge', 'tag', 'pill', 'label chip'],
    treeJson: '{"id":"badge-1","kind":{"$type":"Badge","label":"Beta","variant":"Info"}}',
  },
];

/** The deterministic placeholder tree returned when no fixture matches. A valid
 *  canonical Heading, so the SDK still decodes + renders it — never an error. */
export const PLACEHOLDER_TREE_JSON =
  '{"id":"mock-placeholder","kind":{"$type":"Heading","level":2,"text":"Mock response (no cookbook match)","variant":"Standard"}}';

/** A small canonical TreeOp returned in the `Ops` array on a repair turn (a
 *  request carrying a current tree) — the "diff" half of the fresh-vs-repair
 *  branch. Structurally a valid UpdateProp. */
export const REPAIR_OP_JSON =
  '{"$type":"UpdateProp","path":"Text","target":"mock-placeholder","value":"repaired by mock"}';

/**
 * Match a prompt to a fixture's canonical tree JSON. Case-insensitive keyword
 * containment, first fixture (in declaration order) with a matching keyword
 * wins; a no-match returns the placeholder. Pure + deterministic.
 */
export function matchTree(prompt: string): string {
  const p = prompt.toLowerCase();
  for (const fixture of FIXTURES) {
    if (fixture.keywords.some((k) => p.includes(k))) {
      return fixture.treeJson;
    }
  }
  return PLACEHOLDER_TREE_JSON;
}
