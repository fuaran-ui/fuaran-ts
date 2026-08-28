// ============================================================================
//  @fuaran-ui/renderer/payloadLanguage — a registered custom component's prop
//  can declare that its value is not merely a string but a WIRE FORMAT in its
//  own right, with its own decoder and its own gate.
//
//  WHY THIS EXISTS. A payload prop carrying a whole inner language and a prop
//  carrying a label are, to a registry that knows only "string", the same thing.
//  So a payload that is prose rather than its declared format passes every check
//  a registry can make and fails later, at render, where the failure is
//  expensive and hard to attribute. The declaration makes the two different
//  before render.
//
//  WHAT THIS TIER CAN AND CANNOT SAY. It can say an inner language EXISTS and
//  name the gate that judges it. It cannot RUN that gate: the one definition of
//  a format's gate belongs to the domain that owns the format, and a renderer
//  holds no decoder for any of them. So the answer here is an OBLIGATION, never
//  a verdict — "a gate is owed", or the worse "nothing can judge this at all".
//
//  DIVERGENCE FROM THE REFERENCE TIER, NAMED. The F# tier declares this on a
//  PROP SCHEMA it already holds, so it derives the declared set. This registry
//  is a RENDERER registry and carries no prop schema at all, so the declaration
//  is handed to `register` keyed by prop name. Same vocabulary, same tags, same
//  attribution line, different carrier — do not "unify" them by inventing a prop
//  schema here, which is a much larger surface than this fact needs.
// ============================================================================

import type { JsonValue } from '@fuaran-ui/schema';

/**
 * The identity of the gate that judges a declared payload language: which gate,
 * and which version of it. `version` is opaque on purpose — a content hash, a
 * tool version, a corpus stamp; the domain that owns the gate decides, and the
 * only property this layer relies on is that it changes when the gate does.
 */
export interface PayloadGate {
  readonly gate: string;
  readonly version: string;
}

/**
 * A declaration that a prop's value is written in an inner wire format.
 * `gate` is optional because "declared but ungated" is a real, distinguishable
 * state — a claim with no falsifier — and NOT the same thing as undeclared.
 */
export interface PayloadLanguage {
  readonly language: string;
  readonly gate?: PayloadGate;
}

/** Every declared-wire prop of one registered component, keyed by prop name. */
export type PayloadLanguages = Readonly<Record<string, PayloadLanguage>>;

/**
 * The single-token form a card row or a provenance record stores. An empty
 * `version` degrades to the bare gate name rather than emitting a trailing
 * colon — matching the reference tier's `AsStamp`.
 */
export const payloadGateStamp = (gate: PayloadGate): string =>
  gate.version === '' ? gate.gate : `${gate.gate}:${gate.version}`;

/**
 * The prompt-facing rendering of a declared payload language — the one line a
 * teaching surface prints beside a prop's type, so every such surface prints the
 * same thing. The ungated case says so loudly: a reader must not have to notice
 * a missing parenthetical to learn that nothing judges the payload.
 */
export const payloadTag = (declaration: PayloadLanguage): string =>
  declaration.gate === undefined
    ? `${declaration.language} (NO GATE)`
    : `${declaration.language} (gate ${payloadGateStamp(declaration.gate)})`;

/**
 * Why a declared-wire payload prop carries an outstanding obligation. Not a
 * defect vocabulary: neither case says the payload is wrong, only that this
 * registry cannot say it is right.
 *
 * - `GateOwed` — a gate is named and did not run here. It cannot: see the
 *   header. A run is owed before the payload can be called valid.
 * - `Ungated` — a language is declared and no gate is named, so nothing can
 *   judge the payload at all. Distinct because the remedies differ: one is "run
 *   it", the other is "there is nothing to run".
 */
export type PayloadObligationKind = 'GateOwed' | 'Ungated';

/** One outstanding payload obligation on a prop bag. */
export interface CustomPayloadObligation {
  readonly key: string;
  readonly language: string;
  readonly gate?: PayloadGate;
  readonly kind: PayloadObligationKind;
  readonly message: string;
}

/**
 * One declared-wire prop of a registered component, projected for a teaching
 * surface or an eval harness. `gate` is carried as its own absence rather than
 * folded into the language string, so a card consumer never has to parse one out
 * of the other.
 */
export interface CustomPayloadCard {
  readonly moduleId: string;
  readonly componentId: string;
  readonly key: string;
  readonly language: string;
  readonly gate?: string;
}

/**
 * The obligations a prop bag leaves outstanding against a component's payload
 * declarations. One entry per declared prop that is PRESENT in the bag.
 *
 * An ABSENT declared prop raises nothing — there is no payload to judge. Unlike
 * the reference tier there is no shape check to defer to here, so a present prop
 * of any JSON shape raises its obligation: this registry cannot rule the value
 * out, and silently dropping the obligation would be the very reading the
 * declaration exists to remove.
 */
export const payloadObligationsFor = (
  declarations: PayloadLanguages | undefined,
  props: Readonly<Record<string, JsonValue>>,
): CustomPayloadObligation[] => {
  if (declarations === undefined) return [];

  return Object.keys(declarations)
    .filter((key) => Object.prototype.hasOwnProperty.call(props, key))
    .map((key) => {
      const declaration = declarations[key]!;
      const { gate } = declaration;

      return gate === undefined
        ? ({
            key,
            language: declaration.language,
            kind: 'Ungated',
            message: `prop '${key}' declares a '${declaration.language}' payload but names no gate — nothing can judge it`,
          } satisfies CustomPayloadObligation)
        : ({
            key,
            language: declaration.language,
            gate,
            kind: 'GateOwed',
            message: `prop '${key}' carries a '${declaration.language}' payload; the '${payloadGateStamp(
              gate,
            )}' gate judges it and has NOT run here`,
          } satisfies CustomPayloadObligation);
    });
};

/** What a domain gate concluded about a payload it was handed. */
export type PayloadGateVerdict =
  | { readonly kind: 'Accepted' }
  | { readonly kind: 'Refused'; readonly reason: string }
  // No gate ran — the payload was updated unjudged. Recorded, never omitted: a
  // stream that leaves the unjudged case out cannot distinguish "the gate ran
  // and was content" from "nobody looked", and that reading is exactly how an
  // unjudged payload becomes an assumed-good one.
  | { readonly kind: 'NotRun' };

/**
 * The provenance record for one update to a declared-wire payload prop. The
 * WIRING is per-host and deliberately so — this tier holds no op-stream sink and
 * can run no domain gate. What it owns is the shape both ends agree on, so two
 * hosts writing the same fact write the same bytes.
 */
export interface PayloadUpdateProvenance {
  readonly moduleId: string;
  readonly componentId: string;
  readonly key: string;
  readonly language: string;
  readonly gate?: PayloadGate;
  readonly verdict: PayloadGateVerdict;
}

/**
 * The stable one-line attribution a stream stores — "via `<language>` gate
 * `<stamp>` — `<verdict>`". An ungated declaration renders `<ungated>` in the
 * stamp slot rather than eliding it, so the line never reads as though a gate
 * were named. Byte-identical to the reference tier's `attribution`.
 */
export const payloadAttribution = (provenance: PayloadUpdateProvenance): string => {
  const stamp = provenance.gate === undefined ? '<ungated>' : payloadGateStamp(provenance.gate);

  const verdict =
    provenance.verdict.kind === 'Accepted'
      ? 'accepted'
      : provenance.verdict.kind === 'Refused'
        ? `refused: ${provenance.verdict.reason}`
        : 'NOT RUN';

  return `via ${provenance.language} gate ${stamp} — ${verdict}`;
};
