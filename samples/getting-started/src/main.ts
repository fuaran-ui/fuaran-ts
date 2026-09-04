// Getting started — the six-lesson tour, in TypeScript.
//
// Six short lessons that between them explain what this language is for. Run the
// whole tour, or one lesson at a time:
//
//     pnpm start              # all six
//     pnpm start replay       # just one
//
// FIVE OF THE SIX NEED NO KEY, NO NETWORK AND NO BROWSER. Only the last one calls a
// model, and only when you supply your own key — so nothing here is unrunnable
// because you have not signed up for anything.
//
// The same six lessons exist for the F# and Python hosts. They are siblings, not
// ports: all three are conformant hosts of one wire format, so a tree authored in
// any of them is read by all of them — and lesson 3 makes that concrete.

import { encodeNode, decodeNode, apply, type TreeOp } from '@fuaran-ui/ops';
import { fuaran, format, preEmitValidate, type Node } from '@fuaran-ui/ui';
import { nodeId } from '@fuaran-ui/schema';
import {
  applyTo,
  computeHash,
  genesisPreviousHash,
  humanActor,
  actorId,
  verifyChain,
  type Actor,
  type OpRecord,
} from '@fuaran-ui/op-stream';
import { renderToHtml } from '@fuaran-ui/renderer-server';

// ─────────────────────────────────────────────────────────────────────────────
//  LESSON 1 — A user interface is a value.
//
//  There is no template language here, and no component to instantiate. You build a
//  typed tree with ordinary functions, and the canonical encoder turns it into JSON
//  that any conformant host can render. Because it is a value, you can hold it in a
//  variable, put it in an array, return it from a function, send it over a socket
//  and compare two of them for equality — none of which is true of a rendered view.
//
//  What to notice in the output: the JSON has no code in it. Not "no code we
//  execute" — no code at all. A tree can carry a `SetState` action or a declarative
//  data pipeline, both of which are DATA the host interprets. It cannot carry a
//  function, which is why an untrusted emission is safe to render (lesson 4).
// ─────────────────────────────────────────────────────────────────────────────

/** A small sales dashboard. Every constructor is a plain function over a typed
 *  options object, so a wrong field name is a compile error rather than a blank area
 *  on a page. */
const salesDashboard = (): Node<never> =>
  fuaran.dashboard<never>({
    id: 'sales',
    children: [
      fuaran.heading<never>({ id: 'sales-title', level: 1, text: 'Q4 sales' }),
      fuaran.gridLayout<never>({
        id: 'sales-kpis',
        cols: 3,
        children: [
          fuaran.metric<never>({
            id: 'sales-revenue',
            label: 'Revenue',
            value: 142500,
            format: format.currency('GBP'),
            tone: 'Brand',
          }),
          fuaran.metric<never>({
            id: 'sales-orders',
            label: 'Orders',
            value: 1284,
            format: format.number(0),
          }),
          fuaran.metric<never>({
            id: 'sales-conversion',
            label: 'Conversion',
            value: 0.043,
            format: format.percent(1),
            tone: 'Success',
          }),
        ],
      }),
      fuaran.callout<never>({
        id: 'sales-note',
        tone: 'Info',
        heading: 'Where this came from',
        body: 'This whole page is one value. The JSON below is all a renderer needs.',
      }),
    ],
  });

const lessonAuthoring = (): void => {
  const tree = salesDashboard();
  console.log('The tree, as canonical wire JSON:');
  console.log();
  console.log(encodeNode(tree));
  console.log();

  // The encoder is canonical: the same tree always produces the same bytes, with
  // object keys in a fixed order and numbers in a pinned format. That is what makes
  // a tree hashable, cacheable, diffable and comparable ACROSS hosts — the property
  // lesson 3 leans on to replay a session exactly.
  console.log(`Encoded twice, byte-identical: ${encodeNode(tree) === encodeNode(tree)}`);

  // And it renders to HTML on the server, with no browser and no bundler — the same
  // tree a React client would draw.
  const html = renderToHtml(tree);
  console.log(`Server-rendered HTML: ${html.length} characters, starting ${html.slice(0, 60)}…`);
};

// ─────────────────────────────────────────────────────────────────────────────
//  LESSON 2 — Edit the tree, don't regenerate it.
//
//  The obvious way to change an AI-authored interface is to ask the model for a new
//  one. It is also the wrong way, for three reasons that have nothing to do with
//  cost: the model may change parts you did not ask about, you cannot say what
//  changed, and you cannot undo it.
//
//  A `TreeOp` is the alternative — a typed, addressed edit. "Set the label of
//  sales-revenue to Net revenue" is one op against one node. It applies
//  deterministically, it fails BY NAME when it does not fit, and it is small enough
//  to log, review, reverse and replay (lesson 3).
// ─────────────────────────────────────────────────────────────────────────────

const renameRevenue: TreeOp<never> = {
  kind: 'UpdateProp',
  target: nodeId('sales-revenue'),
  path: 'Label',
  value: 'Net revenue',
};

const warnOnRevenue: TreeOp<never> = {
  kind: 'UpdateProp',
  target: nodeId('sales-revenue'),
  path: 'Tone',
  value: 'Warning',
};

const addressesNothing: TreeOp<never> = {
  kind: 'UpdateProp',
  target: nodeId('no-such-node'),
  path: 'Label',
  value: '…',
};

const lessonOps = (): void => {
  const before = salesDashboard();

  let tree = before;
  for (const op of [renameRevenue, warnOnRevenue]) {
    const result = apply(tree, op);
    if (!result.ok) {
      console.log(`unexpected apply failure: ${JSON.stringify(result.error)}`);
      return;
    }
    tree = result.value.newTree;
  }

  console.log('Two typed ops applied. What changed:');
  console.log();
  const beforeParts = encodeNode(before).split('},{');
  const afterParts = encodeNode(tree).split('},{');
  beforeParts.forEach((b, i) => {
    const a = afterParts[i];
    if (a !== undefined && a !== b) {
      console.log(`  before: ${b}`);
      console.log(`  after:  ${a}`);
    }
  });
  console.log();
  console.log('Every other node in the tree is byte-identical.');

  // A refusal is a value, not an exception. An orchestrator reads the error, tells
  // the model what was wrong, and asks again — a loop that converges, rather than a
  // crash that needs a human.
  const refused = apply(before, addressesNothing);
  console.log();
  if (refused.ok) {
    console.log('the bad op unexpectedly succeeded');
  } else {
    console.log('An op that addresses nothing is refused by name:');
    console.log(`  ${JSON.stringify(refused.error)}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  LESSON 3 — A session is a hash-chained list of ops, and it replays exactly.
//
//  Lesson 2 made an edit addressable. This makes a SESSION reproducible: keep the
//  ops, in order, each carrying the hash of the one before it, and the tree at any
//  point is a fold over a prefix. Three things follow:
//
//    * EXACT REPLAY — not "renders the same", the same tree byte-for-byte under the
//      canonical encoder, which is what makes a bug report reproducible.
//    * TIME TRAVEL FOR FREE — any prefix is a real state, so "what did this look
//      like three edits ago" needs no snapshot machinery.
//    * TAMPER EVIDENCE — each record's hash covers the op, its position, the actor,
//      the timestamp and the outcome, so a record edited after the fact is named.
//
//  AND THE HASHES BELOW ARE NOT TYPESCRIPT'S. Run the same lesson in the F# or
//  Python tour and the two chain hashes printed are character for character the ones
//  printed here — the pre-image is a shared, versioned envelope over the canonical op
//  bytes, so a chain written by one host verifies in another. That is the whole
//  reason to have a specification rather than a library.
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_TIMESTAMP = 1_767_268_800; // 2026-01-01T12:00:00Z — stable output, run to run.

const link = (
  streamId: string,
  actor: Actor,
  previous: OpRecord<never> | undefined,
  op: TreeOp<never>,
): OpRecord<never> => {
  const sequence = previous === undefined ? 1 : previous.sequence + 1;
  const previousHash = previous === undefined ? genesisPreviousHash : previous.hash;
  return {
    streamId,
    sequence,
    previousHash,
    hash: computeHash(previousHash, op, sequence, FIXED_TIMESTAMP, actor, undefined, {
      kind: 'Success',
    }),
    op,
    actor,
    timestampUnixSeconds: FIXED_TIMESTAMP,
    resultEnvelope: { kind: 'Success' },
  };
};

const lessonReplay = (): void => {
  const seed = salesDashboard();

  // Two edits: one a person made, one a model made on their behalf.
  const steps: readonly (readonly [Actor, TreeOp<never>])[] = [
    [humanActor('ada'), renameRevenue],
    [{ kind: 'agent', model: 'some-model', version: '1', id: 'assistant' }, warnOnRevenue],
  ];

  const records: OpRecord<never>[] = [];
  for (const [actor, op] of steps) {
    records.push(link('getting-started', actor, records[records.length - 1], op));
  }

  const replayed = applyTo(seed, records);
  if (!replayed.ok) {
    console.log(`replay failed: ${JSON.stringify(replayed.error)}`);
    return;
  }

  console.log(`Replayed ${records.length} records. Chain:`);
  for (const record of records) {
    console.log(
      `  ${record.sequence}  ${actorId(record.actor).padEnd(28)}  ${record.hash.slice(0, 12)}…`,
    );
  }

  // Replay is a pure function of (seed, records), so a second run of the same input
  // is the same output. This is the property the whole provenance story rests on.
  const again = applyTo(seed, records);
  console.log();
  if (again.ok) {
    console.log(
      `Replayed twice, byte-identical: ${encodeNode(replayed.value) === encodeNode(again.value)}`,
    );
  }

  // Any PREFIX is a real state — time travel with no snapshot machinery.
  const oneStepBack = applyTo(seed, records.slice(0, 1));
  if (oneStepBack.ok) {
    console.log(
      'State after 1 of 2 ops differs from the final state: ' +
        `${encodeNode(oneStepBack.value) !== encodeNode(replayed.value)}`,
    );
  }

  // Tamper with a record's op AFTER it was hashed.
  //
  // NOTE A HOST DIFFERENCE, because it matters and the sample would be lying if it
  // hid it: this host's `applyTo` FOLDS, it does not verify. Verification is a
  // separate call, `verifyChain`, and a host that folds without it has a replay
  // engine but no tamper detection. The F# host's equivalent verifies first and
  // refuses the whole segment. Same chain, same hashes, different default — so on
  // this host, verify explicitly.
  const tampered = records.map((r, i) =>
    i === 1
      ? {
          ...r,
          op: {
            kind: 'UpdateProp',
            target: nodeId('sales-revenue'),
            path: 'Tone',
            value: 'Critical',
          } as TreeOp<never>,
        }
      : r,
  );

  const broken = verifyChain(tampered);
  console.log();
  if (broken === undefined) {
    console.log('the tampered chain unexpectedly verified');
  } else {
    console.log('A record edited after the fact breaks the chain:');
    console.log(`  ${JSON.stringify(broken)}`);
    console.log();
    console.log('  `applyTo` on this host folds without verifying, so this check is a');
    console.log('  separate call. Run it before you trust a stream you did not write.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  LESSON 4 — Safety is a property of the shape, not of a filter.
//
//  The usual way to make model output safe is to inspect it: scan for script tags,
//  strip attributes, sanitise. That is a losing position, because it asks you to
//  enumerate what is dangerous.
//
//  Here the argument runs the other way. The wire format can express a closed set of
//  node kinds with typed fields — and executable code is not one of them, so there is
//  nothing to strip. An emission is either a well-formed tree from that closed
//  vocabulary or it is REFUSED, and the refusal says which field, at which path, and
//  what was expected.
//
//  Two gates, answering different questions: the DECODER asks "is this a tree at
//  all", and the PRE-EMIT VALIDATOR asks "is this tree coherent" — decodable, and
//  still not something you want to render.
// ─────────────────────────────────────────────────────────────────────────────

const refusals: readonly (readonly [string, string])[] = [
  [
    'a node kind that does not exist',
    '{"id":"x","kind":{"$type":"ScriptBlock","code":"alert(1)"}}',
  ],
  ['a required field left out', '{"id":"x","kind":{"$type":"Metric","label":"Revenue"}}'],
  ['a field of the wrong type', '{"id":"x","kind":{"$type":"Heading","level":"one","text":"Hi"}}'],
  [
    'an attempt to smuggle markup through a text field',
    '{"id":"x","kind":{"$type":"Heading","level":1,' +
      '"text":{"$type":"Html","raw":"<script>alert(1)</script>"}}}',
  ],
];

const lessonSafety = (): void => {
  const good = encodeNode(salesDashboard());
  const decoded = decodeNode(good);
  if (decoded.ok) {
    console.log(`A well-formed emission decodes. (${good.length} bytes)`);
  } else {
    console.log(`unexpected: the good emission failed to decode: ${JSON.stringify(decoded.error)}`);
  }

  console.log();
  console.log('And these do not:');
  console.log();
  for (const [what, wire] of refusals) {
    const result = decodeNode(wire);
    if (result.ok) {
      console.log(`  ${what.padEnd(46)} ACCEPTED — this is a defect, please report it`);
    } else {
      console.log(`  ${what.padEnd(46)} refused: ${JSON.stringify(result.error)}`);
    }
  }

  // Note what did NOT happen: nothing was sanitised, no allow-list was consulted, and
  // no string was inspected for dangerous content. The last case fails for the same
  // structural reason as the others — `Html` is not in the closed text vocabulary —
  // not because anything recognised `<script>`.
  console.log();
  console.log('Nothing above was sanitised. There is no code case in the vocabulary to strip.');

  // The second gate. This tree decodes perfectly and is still incoherent: two switch
  // cases match the same value, so the second branch can never render. A user
  // experiences that as "the app ignores one of my options"; a developer never sees
  // it in a log, because nothing failed.
  const deadBranch = fuaran.dashboard<never>({
    id: 'dead-branch',
    children: [
      fuaran.switch<never>({
        id: 'mode',
        stateKey: 'mode',
        cases: [
          { match: 'calm', child: fuaran.markdown<never>('calm', 'Quiet tones.') },
          {
            match: 'calm',
            child: fuaran.markdown<never>('calm-again', 'Never renders.'),
          },
        ],
        default: fuaran.markdown<never>('neither', '_Pick a mode._'),
      }),
    ],
  });

  const validated = preEmitValidate(deadBranch);
  console.log();
  if (validated.ok) {
    console.log('the incoherent tree unexpectedly validated');
  } else {
    console.log('A tree can decode and still be incoherent. The pre-emit validator:');
    for (const defect of validated.error) {
      console.log(`  ${JSON.stringify(defect)}`);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  LESSON 5 — Declare the operations, and most prompts stop needing a model.
//
//  THE CONTRAST IS THE LESSON, so read the two halves of the output side by side.
//
//  A control can PUBLISH the operations it supports: each one a name, a typed
//  signature of holes, and a declared effect. That declaration is data, so it can be
//  searched. Ask "what can I run with the context I have" and you get an answer
//  computed by structural matching over the registry — deterministic, total, in
//  memory, offline, and identical on every host and every run. No model call. No
//  network.
//
//  The model is then reserved for what genuinely needs judgement. That is a much
//  smaller job, and — because the operations are typed — its output is checkable
//  before it runs.
//
//  What no sample can show you is a bank LEARNED from a corpus of real sessions.
//  That is not part of the open language tier, and its absence is deliberate.
// ─────────────────────────────────────────────────────────────────────────────

import {
  emptyFunctionRegistry,
  registerFunction,
  findBySignature,
  type FunctionEntry,
  type FunctionRegistry,
  type RegistrySigEntry,
} from '@fuaran-ui/ui';

const textHole = (addr: string, name: string): RegistrySigEntry => ({
  addr,
  name,
  kind: 'value',
  space: { kind: 'AnyString' },
  required: true,
});

const declaredBank = (): { registry: FunctionRegistry; titles: Map<string, string> } => {
  const declarations: readonly (readonly [string, string, string, readonly RegistrySigEntry[]])[] =
    [
      [
        'sample.kpi-tile',
        'KPI tile',
        'Metric',
        [textHole('kpi.label', 'label'), textHole('kpi.value', 'value')],
      ],
      [
        'sample.notice',
        'Notice banner',
        'Callout',
        [textHole('notice.heading', 'heading'), textHole('notice.body', 'body')],
      ],
    ];

  const titles = new Map<string, string>();
  let registry = emptyFunctionRegistry;
  for (const [id, title, resultType, holes] of declarations) {
    const entry: FunctionEntry = { id, resultType, holes };
    const registered = registerFunction(entry, registry);
    if (registered.ok) registry = registered.value;
    titles.set(id, title);
  }
  return { registry, titles };
};

const lessonOperations = (): void => {
  const { registry, titles } = declaredBank();

  console.log('WITHOUT a model — a structural search over what is declared.');
  console.log();

  const context = [textHole('kpi.label', 'label'), textHole('kpi.value', 'value')];
  const runnable = findBySignature('Subsumes', { resultType: null, available: context }, registry);
  console.log('  Context: a label and a value.');
  console.log(`  Runnable right now: ${runnable.map((e) => titles.get(e.id) ?? e.id).join(', ')}`);

  const wantCallout = findBySignature(
    'Subsumes',
    {
      resultType: 'Callout',
      available: [textHole('notice.heading', 'heading'), textHole('notice.body', 'body')],
    },
    registry,
  );
  console.log(
    `  Asking specifically for a Callout: ${wantCallout.map((e) => titles.get(e.id) ?? e.id).join(', ')}`,
  );

  const first = runnable[0];
  if (first !== undefined) {
    const built = fuaran.metric<never>({
      id: 'kpi',
      label: 'Net revenue',
      value: 142500,
      format: format.currency('GBP'),
      tone: 'Brand',
    });
    console.log();
    console.log(`  Dispatched ${first.id} -> ${encodeNode(built)}`);
  }

  console.log();
  console.log('WITH a model — for the request no declaration covers.');
  console.log();
  console.log('  "Show me last quarter\'s revenue as a KPI"');
  console.log('     -> the search above answers this. Deterministic, offline, no key.');
  console.log();
  console.log('  "Rework this page so a colour-blind reader can still tell the');
  console.log('   at-risk workstreams from the healthy ones, and explain why"');
  console.log('     -> no declaration covers that. It needs judgement, and it is');
  console.log('        exactly the kind of request worth paying a model for.');
  console.log();
  console.log('  The point is not that models are unnecessary. It is that most requests');
  console.log('  in a real application are the first kind, and answering those by search');
  console.log('  rather than by generation makes them instant, free, offline and repeatable.');
};

// ─────────────────────────────────────────────────────────────────────────────
//  LESSON 6 — Bring your own key: prompt, decode, render.
//
//      prompt -> the model emits wire JSON -> DECODE STRICTLY -> render
//
//  The middle step is the one that matters. The model's output is untrusted text;
//  the decoder turns it into a typed tree or refuses it by name (lesson 4). Nothing
//  between those two points inspects the string for danger, because by the time you
//  hold a tree there is nothing dangerous left to find.
//
//  This lesson needs your own key, and it is the only one that does. There is no
//  SDK: Node's global `fetch`, and one JSON body.
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You emit user interfaces as canonical Fuaran wire-format JSON and nothing else. ' +
  'A node is {"id":"…","kind":{"$type":"…",…}}. Useful kinds: Box (role Dashboard or ' +
  'Card, with children), Heading (level, text), Metric (label, value ' +
  '{"$type":"Static","value":n}, format {"$type":"Currency","code":"GBP"} or ' +
  '{"$type":"Number","decimals":0}), Markdown (text), Callout (tone ' +
  'Info|Success|Warning|Critical, body). Text fields are plain JSON strings. Reply ' +
  'with ONE JSON object and no prose, no explanation and no code fence.';

const PROMPT =
  "A dashboard for a small bookshop: this month's revenue in pounds, books sold, " +
  'and a short note welcoming the reader.';

const keyFrom = (argv: readonly string[]): string | undefined => {
  const flag = argv.indexOf('--key');
  if (flag >= 0 && argv[flag + 1] !== undefined) return argv[flag + 1];
  const fromEnv = process.env['ANTHROPIC_API_KEY'];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined;
};

/** Pull the first balanced JSON object out of a reply, so a model that wraps its
 *  answer in a sentence or a code fence still works. This is presentation tolerance,
 *  NOT safety tolerance — whatever comes out still faces the strict decoder. */
const firstJsonObject = (text: string): string | undefined => {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) escaped = false;
    else if (ch === '\\' && inString) escaped = true;
    else if (ch === '"') inString = !inString;
    else if (!inString) {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
};

const lessonAi = async (argv: readonly string[]): Promise<void> => {
  const key = keyFrom(argv);
  if (key === undefined) {
    console.log('No key, so no call was made.');
    console.log();
    console.log('  Set ANTHROPIC_API_KEY (or pass --key <k>) and re-run to see the whole loop:');
    console.log('  prompt -> emitted wire JSON -> strict decode -> rendered HTML.');
    console.log();
    console.log("  The key is read from this process's environment, sent to the provider you");
    console.log('  chose, and nothing else. This sample stores nothing and logs nothing.');
    console.log();
    console.log('  The prompt it would send:');
    console.log(`    ${PROMPT}`);
    return;
  }

  console.log(`Prompt: ${PROMPT}`);
  console.log();

  let reply: string;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: PROMPT }],
      }),
    });
    const payload = (await response.json()) as {
      content?: readonly { type?: string; text?: string }[];
    };
    if (!response.ok) {
      console.log(`The call failed: ${response.status} ${JSON.stringify(payload).slice(0, 300)}`);
      return;
    }
    reply = (payload.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  } catch (error) {
    console.log(`The call failed: ${String(error)}`);
    return;
  }

  const wire = firstJsonObject(reply);
  if (wire === undefined) {
    console.log('The model replied with no JSON object at all:');
    console.log(`  ${reply.slice(0, 300)}`);
    return;
  }

  console.log(`Emitted ${wire.length} bytes of wire JSON.`);
  console.log();

  // THE GATE. Everything before this is untrusted text.
  const decoded = decodeNode(wire);
  if (!decoded.ok) {
    console.log('Refused by the strict decoder — and this is the system working:');
    console.log(`  ${JSON.stringify(decoded.error)}`);
    console.log();
    console.log('  A real orchestrator hands that error back to the model and asks again.');
    console.log('  The error names the path and the expectation, so the second attempt');
    console.log('  usually lands. Nothing was rendered, and nothing had to be sanitised.');
    return;
  }

  console.log('Decoded. Rendering it server-side, with no browser:');
  console.log();
  console.log(renderToHtml(decoded.value));
};

// ─────────────────────────────────────────────────────────────────────────────

const lessons: readonly (readonly [
  string,
  string,
  (argv: readonly string[]) => void | Promise<void>,
])[] = [
  ['authoring', 'A user interface is a value', lessonAuthoring],
  ['ops', "Edit the tree, don't regenerate it", lessonOps],
  ['replay', 'A session replays exactly', lessonReplay],
  ['safety', 'Safety is a property of the shape', lessonSafety],
  ['operations', 'Declared operations need no model', lessonOperations],
  ['ai', 'Bring your own key: prompt, decode, render', lessonAi],
];

const main = async (argv: readonly string[]): Promise<number> => {
  const names = new Set(lessons.map(([name]) => name));
  const requested = argv.filter((a) => names.has(a));
  const selected =
    requested.length === 0 ? lessons : lessons.filter(([n]) => requested.includes(n));

  if (selected.length === 0) {
    console.log('No such lesson. Available:');
    for (const [name, title] of lessons) console.log(`  ${name.padEnd(12)} ${title}`);
    return 1;
  }

  for (const [name, title, run] of selected) {
    const heading = `${name} — ${title}`;
    console.log();
    console.log(`══ ${heading} ${'═'.repeat(Math.max(1, 66 - heading.length))}`);
    console.log();
    await run(argv);
  }

  console.log();
  console.log(`══ done ${'═'.repeat(61)}`);
  console.log();
  console.log('Next: samples/demo for the same vocabulary rendered by React in a browser,');
  console.log('and samples/hydration for the server-render-then-hydrate path.');
  return 0;
};

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
