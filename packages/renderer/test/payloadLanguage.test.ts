// Phase 1107 — the payload-language declaration on a registered component.
//
// A payload prop holding a whole inner wire format and a prop holding a label
// are the same thing to a registry that knows only "a string", so a prose
// payload passes every check a registry can make and fails at render. These
// tests pin the two states the declaration makes distinguishable, and pin the
// attribution line byte for byte against the reference tier's — two hosts
// writing the same fact must write the same bytes.

import { describe, expect, it } from 'vitest';

import { createCustomRendererRegistry, registerCustomRenderer } from '../src/customRegistry.js';
import {
  payloadAttribution,
  payloadGateStamp,
  payloadObligationsFor,
  payloadTag,
  type PayloadLanguages,
} from '../src/payloadLanguage.js';

const Widget = () => null;

const markdownGated: PayloadLanguages = {
  body: { language: 'markdown', gate: { gate: 'cmark', version: '0.31' } },
};

const markdownUngated: PayloadLanguages = {
  body: { language: 'markdown' },
};

describe('payload-language declaration', () => {
  it('renders the two declared states distinguishably', () => {
    expect(payloadTag({ language: 'markdown', gate: { gate: 'cmark', version: '0.31' } })).toBe(
      'markdown (gate cmark:0.31)',
    );

    // The ungated case says so loudly rather than by omission — a reader must
    // not have to notice a missing parenthetical to learn nothing judges it.
    expect(payloadTag({ language: 'markdown' })).toBe('markdown (NO GATE)');
  });

  it('degrades an empty gate version to the bare gate name', () => {
    expect(payloadGateStamp({ gate: 'cmark', version: '' })).toBe('cmark');
    expect(payloadGateStamp({ gate: 'cmark', version: '0.31' })).toBe('cmark:0.31');
  });

  it('distinguishes an undeclared prop from one owing a gate run', () => {
    const props = { body: 'just some prose' };

    // The gap: without the declaration there is nothing to report at all.
    expect(payloadObligationsFor(undefined, props)).toEqual([]);

    const obligations = payloadObligationsFor(markdownGated, props);
    expect(obligations).toHaveLength(1);
    expect(obligations[0]!.key).toBe('body');
    expect(obligations[0]!.language).toBe('markdown');
    expect(obligations[0]!.kind).toBe('GateOwed');
    expect(obligations[0]!.message).toContain('NOT run');
  });

  it('treats a declaration naming no gate as its own obligation class', () => {
    const obligations = payloadObligationsFor(markdownUngated, { body: '# heading' });

    expect(obligations).toHaveLength(1);
    // The remedies differ: one is "run it", the other is "there is nothing to
    // run" — so they must not collapse into one kind.
    expect(obligations[0]!.kind).toBe('Ungated');
    expect(obligations[0]!.gate).toBeUndefined();
    expect(obligations[0]!.message).toContain('no gate');
  });

  it('raises no obligation for a declared prop the bag does not carry', () => {
    expect(payloadObligationsFor(markdownGated, { other: 1 })).toEqual([]);
  });
});

describe('registry projection', () => {
  it('projects the declaration under the identity it was registered with', () => {
    const registry = createCustomRendererRegistry();
    // A moduleId containing a dot: recovering the identity by splitting the map
    // key would attribute this card to a component that does not exist.
    registerCustomRenderer(registry, 'docs.rich', 'note', Widget, undefined, markdownGated);
    registerCustomRenderer(registry, 'viz', 'spark', Widget);

    expect(registry.describePayloadLanguages()).toEqual([
      {
        moduleId: 'docs.rich',
        componentId: 'note',
        key: 'body',
        language: 'markdown',
        gate: 'cmark:0.31',
      },
    ]);
  });

  it('reports obligations for a registered pair and none for an unknown one', () => {
    const registry = createCustomRendererRegistry();
    registerCustomRenderer(registry, 'docs', 'note', Widget, undefined, markdownGated);

    expect(registry.payloadObligations('docs', 'note', { body: 'prose' })).toHaveLength(1);
    // The registry only speaks for what it knows.
    expect(registry.payloadObligations('other', 'thing', { body: 'prose' })).toEqual([]);
  });

  it('leaves an undeclared registration exactly as it was', () => {
    const registry = createCustomRendererRegistry();
    registerCustomRenderer(registry, 'viz', 'spark', Widget);

    expect(registry.describePayloadLanguages()).toEqual([]);
    expect(registry.payloadObligations('viz', 'spark', { points: '0,1' })).toEqual([]);
    expect(registry.get('viz', 'spark')?.render).toBe(Widget);
  });
});

describe('payload provenance', () => {
  const base = {
    moduleId: 'docs',
    componentId: 'note',
    key: 'body',
    language: 'markdown',
    gate: { gate: 'cmark', version: '0.31' },
  } as const;

  it('writes the same attribution line as the reference tier', () => {
    expect(payloadAttribution({ ...base, verdict: { kind: 'Accepted' } })).toBe(
      'via markdown gate cmark:0.31 — accepted',
    );

    expect(
      payloadAttribution({
        ...base,
        verdict: { kind: 'Refused', reason: 'unterminated fence' },
      }),
    ).toBe('via markdown gate cmark:0.31 — refused: unterminated fence');

    // An unjudged update says NOT RUN rather than being omitted: a stream that
    // drops it cannot tell "the gate was content" from "nobody looked".
    expect(payloadAttribution({ ...base, verdict: { kind: 'NotRun' } })).toBe(
      'via markdown gate cmark:0.31 — NOT RUN',
    );
  });

  it('renders a missing gate in the stamp slot rather than eliding it', () => {
    expect(
      payloadAttribution({
        moduleId: 'docs',
        componentId: 'note',
        key: 'body',
        language: 'markdown',
        verdict: { kind: 'NotRun' },
      }),
    ).toBe('via markdown gate <ungated> — NOT RUN');
  });
});
