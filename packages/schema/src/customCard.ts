// ============================================================================
//  Contract cards — the artefact that makes a foreign `Custom` node LEGIBLE
//  (WIRE_FORMAT.md §25).
//
//  A registered custom component is first-class inside its own deployment: an
//  emitter targets its declared prop schema, a validator checks the prop bag, a
//  renderer dispatches to it. Cross the deployment boundary and all three
//  disappear at once, so a conformant host receiving the same node can only name
//  the component and stop. What the issuing deployment had, and the receiver did
//  not, was never a RENDERER — it was the DESCRIPTION. A card is that
//  description, transportable.
//
//  THIS PACKAGE IS THE READER, AND THE DIVERGENCE FROM THE REFERENCE TIER IS
//  NAMED. The F# tier's registry PROJECTS cards out of prop schemas it already
//  holds; nothing in this repo holds a prop schema, so what lands here is the
//  decode side plus the derivations §25.4 states over it. The canonical encoder
//  is here too, but only so a round-trip can be byte-compared against the corpus
//  — a host that never publishes cards still has to prove it read them
//  faithfully.
//
//  WHY `@fuaran-ui/schema` AND NOT THE RENDERER. Card reading is not a rendering
//  concern: a validator, a CLI, an inspector and a server renderer all want it,
//  and the dependency direction is renderer → schema. That does mean the two
//  payload-obligation message builders below MIRROR the ones in
//  `@fuaran-ui/renderer/payloadLanguage`, which cannot be imported from here.
//  The mirror is deliberate and the strings are byte-identical to both that
//  module and the F# tier: a card's entire claim is that it says what the
//  contract says, and two hosts disagreeing about the words would falsify it.
//
//  A CARD IS NOT A RENDERER, not a permission, and not evidence that a component
//  is safe to run. Nothing here dispatches to anything.
// ============================================================================

import type { ContentHash, JsonValue } from './types.js';
import { err, ok, type Result } from './result.js';

// ─── The document ────────────────────────────────────────────────────────────

/** The `$card` format-version tag. `"1"` is the only version. */
export const CARD_FORMAT_VERSION = '1';

/** The `$cards` bundle format-version tag. */
export const CARD_BUNDLE_FORMAT_VERSION = '1';

/**
 * The conventional location a host MAY serve its bundle at (§25.5).
 *
 * A convention and nothing more: no host is obliged to serve it, none may assume
 * another does, and nothing here fetches it. It exists so that hosts which do
 * choose to serve a bundle all choose the same path.
 */
export const CARD_WELL_KNOWN_PATH = '/.well-known/fuaran-cards.json';

/**
 * The content-identity half of a card — the algorithm and the digest, and
 * deliberately NOT a strictness.
 *
 * A `Custom` node's {@link ContentHash} carries one because the emitter of that
 * tree is declaring a policy about its own replay. A card describes a component,
 * not anyone's tree; a strictness here would be a foreign deployment's policy
 * arriving as data.
 */
export interface CardContentHash {
  readonly algorithm: string;
  readonly hash: string;
}

/** One declared prop of a carded component. */
export interface CardPropRow {
  readonly name: string;
  /** The stable type tag: `string` / `int` / … / `enum(a|b|c)`. */
  readonly type: string;
  readonly required: boolean;
  /** The inner wire format this prop's value is written in, where one is declared. */
  readonly payloadLanguage?: string;
  /** The `gate:version` stamp of the gate that judges it. Absent = declared-but-ungated. */
  readonly payloadGate?: string;
}

/** A contract card (§25.1). */
export interface ContractCard {
  readonly moduleId: string;
  readonly componentId: string;
  /** Declaration order — a schema is ordered, and the array is not sorted. */
  readonly props: readonly CardPropRow[];
  readonly contentHash: CardContentHash;
  /** One line saying what the component IS. Absent where the issuer declared none. */
  readonly summary?: string;
}

// ─── Refusals ────────────────────────────────────────────────────────────────

/**
 * A card refusal, in the §6 `DecodeError` envelope every other refusal in this
 * format uses. Not its own vocabulary: a second refusal shape would be one more
 * thing for hosts to learn, and the corpus manifest's `expectedErrorCode` /
 * `expectedPath` columns would have nothing to record.
 */
export interface CardDecodeError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

const fail = (code: string, path: string, message: string): CardDecodeError => ({
  code,
  path,
  message,
});

// ─── Canonical encoding ──────────────────────────────────────────────────────
//
// Written here rather than reached for from `@fuaran-ui/ops`, which depends on
// THIS package. A card carries no numbers, so none of the canonical float layout
// is in play — object-key ordering and string escaping are the whole of §2 that
// applies.

const escapeCanonical = (s: string): string => {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out;
};

type CanonValue = string | boolean | readonly CanonValue[] | { readonly [k: string]: CanonValue };

const renderCanonical = (v: CanonValue): string => {
  if (typeof v === 'string') return `"${escapeCanonical(v)}"`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `[${v.map(renderCanonical).join(',')}]`;
  const o = v as { readonly [k: string]: CanonValue };
  // Ordinal key sort — `localeCompare` is locale-dependent and would not be the
  // same order on every machine, which is the one thing a canonical encoder
  // cannot be.
  const keys = Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `"${escapeCanonical(k)}":${renderCanonical(o[k]!)}`).join(',')}}`;
};

const cardValue = (card: ContractCard): CanonValue => ({
  $card: CARD_FORMAT_VERSION,
  componentId: card.componentId,
  contentHash: { algorithm: card.contentHash.algorithm, hash: card.contentHash.hash },
  moduleId: card.moduleId,
  props: card.props.map((p) => ({
    name: p.name,
    ...(p.payloadLanguage !== undefined
      ? {
          payload: {
            ...(p.payloadGate !== undefined ? { gate: p.payloadGate } : {}),
            language: p.payloadLanguage,
          },
        }
      : {}),
    required: p.required,
    type: p.type,
  })),
  ...(card.summary !== undefined ? { summary: card.summary } : {}),
});

/** One card as canonical wire bytes. */
export const encodeContractCard = (card: ContractCard): string => renderCanonical(cardValue(card));

/**
 * A card bundle as canonical wire bytes, cards sorted by
 * `(moduleId, componentId)` Ordinal — so two deployments holding the same cards
 * publish the same bytes whatever order their registries iterated in.
 */
export const encodeCardBundle = (cards: readonly ContractCard[]): string => {
  const sorted = [...cards].sort((a, b) => {
    if (a.moduleId !== b.moduleId) return a.moduleId < b.moduleId ? -1 : 1;
    return a.componentId === b.componentId ? 0 : a.componentId < b.componentId ? -1 : 1;
  });
  return renderCanonical({
    $cards: CARD_BUNDLE_FORMAT_VERSION,
    cards: sorted.map(cardValue),
  });
};

// ─── Prop type tags ──────────────────────────────────────────────────────────

/** The closed set of scalar type tags a prop row may declare. */
const SCALAR_TAGS = new Set(['string', 'int', 'float', 'bool', 'object', 'array', 'json']);

/**
 * Whether a type tag is one this build can read — `undefined` for a tag from a
 * newer producer.
 *
 * Refusing an unreadable tag is normative (§25.3), and this is why: resolving it
 * to a permissive type would silently turn a check into a pass, which is worse
 * than not reading the card at all.
 */
export const parsePropTypeTag = (
  tag: string,
): { readonly enumChoices?: readonly string[] } | undefined => {
  if (SCALAR_TAGS.has(tag)) return {};
  if (tag.startsWith('enum(') && tag.endsWith(')')) {
    const inner = tag.slice(5, -1);
    // `enum()` is unrepresentable in this spelling — an enum admitting nothing,
    // written as though it admitted one empty choice.
    if (inner === '') return undefined;
    return { enumChoices: inner.split('|') };
  }
  return undefined;
};

const matchesTag = (tag: string, value: JsonValue): boolean => {
  const parsed = parsePropTypeTag(tag);
  if (parsed === undefined) return true; // unresolvable — reported separately, never judged
  if (parsed.enumChoices !== undefined)
    return typeof value === 'string' && parsed.enumChoices.includes(value);
  switch (tag) {
    case 'string':
      return typeof value === 'string';
    // JSON has one number type; the reference tier accepts a whole number for
    // `float` and refuses a fractional one for `int`, and this mirrors it.
    case 'int':
      return typeof value === 'number' && Number.isInteger(value);
    case 'float':
      return typeof value === 'number';
    case 'bool':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'json':
      return true;
    default:
      return false;
  }
};

// ─── Decode ──────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first present key the shape does not declare — default-deny by shape. */
const firstUndeclared = (
  declared: readonly string[],
  o: Record<string, unknown>,
): string | undefined => Object.keys(o).find((k) => !declared.includes(k));

const decodePropRow = (path: string, value: unknown): Result<CardPropRow, CardDecodeError> => {
  if (!isRecord(value)) return err(fail('WRONG_TYPE', path, 'a prop row must be an object'));

  const stray = firstUndeclared(['name', 'payload', 'required', 'type'], value);
  if (stray !== undefined)
    return err(fail('UNDECLARED_FIELD', `${path}.${stray}`, `undeclared key '${stray}'`));

  const name = value['name'];
  if (name === undefined) return err(fail('MISSING_FIELD', `${path}.name`, 'name is required'));
  if (typeof name !== 'string')
    return err(fail('WRONG_TYPE', `${path}.name`, 'name must be a string'));

  const typeTag = value['type'];
  if (typeTag === undefined) return err(fail('MISSING_FIELD', `${path}.type`, 'type is required'));
  if (typeof typeTag !== 'string')
    return err(fail('WRONG_TYPE', `${path}.type`, 'type must be a string'));
  if (parsePropTypeTag(typeTag) === undefined)
    return err(
      fail(
        'UNKNOWN_DU_CASE',
        `${path}.type`,
        `'${typeTag}' is not a declared prop type in this build`,
      ),
    );

  const required = value['required'];
  if (required === undefined)
    return err(fail('MISSING_FIELD', `${path}.required`, 'required is required'));
  if (typeof required !== 'boolean')
    return err(fail('WRONG_TYPE', `${path}.required`, 'required must be a boolean'));

  const payload = value['payload'];
  if (payload === undefined) return ok({ name, type: typeTag, required });
  if (!isRecord(payload))
    return err(fail('WRONG_TYPE', `${path}.payload`, 'payload must be an object'));

  const payloadStray = firstUndeclared(['gate', 'language'], payload);
  if (payloadStray !== undefined)
    return err(
      fail(
        'UNDECLARED_FIELD',
        `${path}.payload.${payloadStray}`,
        `undeclared key '${payloadStray}'`,
      ),
    );

  const language = payload['language'];
  if (language === undefined)
    return err(fail('MISSING_FIELD', `${path}.payload.language`, 'language is required'));
  if (typeof language !== 'string')
    return err(fail('WRONG_TYPE', `${path}.payload.language`, 'language must be a string'));

  const gate = payload['gate'];
  if (gate !== undefined && typeof gate !== 'string')
    return err(fail('WRONG_TYPE', `${path}.payload.gate`, 'gate must be a string when present'));

  return ok({
    name,
    type: typeTag,
    required,
    payloadLanguage: language,
    ...(typeof gate === 'string' ? { payloadGate: gate } : {}),
  });
};

const decodeCardAt = (path: string, value: unknown): Result<ContractCard, CardDecodeError> => {
  if (!isRecord(value)) return err(fail('WRONG_TYPE', path, 'a card must be an object'));

  const stray = firstUndeclared(
    ['$card', 'componentId', 'contentHash', 'moduleId', 'props', 'summary'],
    value,
  );
  if (stray !== undefined)
    return err(fail('UNDECLARED_FIELD', `${path}.${stray}`, `undeclared key '${stray}'`));

  const version = value['$card'];
  if (version === undefined)
    return err(fail('MISSING_FIELD', `${path}.$card`, '$card is required'));
  if (typeof version !== 'string')
    return err(fail('WRONG_TYPE', `${path}.$card`, '$card must be a string'));
  if (version !== CARD_FORMAT_VERSION)
    return err(
      fail(
        'UNSUPPORTED_VERSION',
        `${path}.$card`,
        `card format version '${version}' is not supported by this decoder`,
      ),
    );

  for (const key of ['moduleId', 'componentId'] as const) {
    const v = value[key];
    if (v === undefined) return err(fail('MISSING_FIELD', `${path}.${key}`, `${key} is required`));
    if (typeof v !== 'string')
      return err(fail('WRONG_TYPE', `${path}.${key}`, `${key} must be a string`));
  }

  const rawHash = value['contentHash'];
  if (rawHash === undefined)
    return err(fail('MISSING_FIELD', `${path}.contentHash`, 'contentHash is required'));
  if (!isRecord(rawHash))
    return err(fail('WRONG_TYPE', `${path}.contentHash`, 'contentHash must be an object'));

  const hashStray = firstUndeclared(['algorithm', 'hash'], rawHash);
  if (hashStray !== undefined)
    return err(
      fail('UNDECLARED_FIELD', `${path}.contentHash.${hashStray}`, `undeclared key '${hashStray}'`),
    );

  for (const key of ['algorithm', 'hash'] as const) {
    const v = rawHash[key];
    if (v === undefined)
      return err(fail('MISSING_FIELD', `${path}.contentHash.${key}`, `${key} is required`));
    if (typeof v !== 'string')
      return err(fail('WRONG_TYPE', `${path}.contentHash.${key}`, `${key} must be a string`));
  }

  const rawProps = value['props'];
  if (rawProps === undefined)
    return err(fail('MISSING_FIELD', `${path}.props`, 'props is required'));
  if (!Array.isArray(rawProps))
    return err(fail('WRONG_TYPE', `${path}.props`, 'props must be an array'));

  const props: CardPropRow[] = [];
  for (let i = 0; i < rawProps.length; i++) {
    const row = decodePropRow(`${path}.props[${i}]`, rawProps[i]);
    if (!row.ok) return row;
    props.push(row.value);
  }

  const summary = value['summary'];
  if (summary !== undefined && typeof summary !== 'string')
    return err(fail('WRONG_TYPE', `${path}.summary`, 'summary must be a string when present'));

  return ok({
    moduleId: value['moduleId'] as string,
    componentId: value['componentId'] as string,
    props,
    contentHash: { algorithm: rawHash['algorithm'] as string, hash: rawHash['hash'] as string },
    ...(typeof summary === 'string' ? { summary } : {}),
  });
};

const parseJson = (json: string, what: string): Result<unknown, CardDecodeError> => {
  try {
    return ok(JSON.parse(json) as unknown);
  } catch (e) {
    return err(fail('INVALID_JSON', '$', `${what} is not valid JSON: ${String(e)}`));
  }
};

/** Decode one card document (§25.1). */
export const decodeContractCard = (json: string): Result<ContractCard, CardDecodeError> => {
  const parsed = parseJson(json, 'card');
  if (!parsed.ok) return parsed;
  return decodeCardAt('$', parsed.value);
};

/**
 * Decode a card bundle (§25.2), refusing a document that carries two cards for
 * one identity.
 *
 * Refused rather than last-write-wins: a STORE resolves duplicates by the order
 * its host folded them in, but a DOCUMENT has no order to appeal to, so
 * accepting one would make the description a reader gets depend on decoder
 * implementation detail.
 */
export const decodeCardBundle = (
  json: string,
): Result<readonly ContractCard[], CardDecodeError> => {
  const parsed = parseJson(json, 'card bundle');
  if (!parsed.ok) return parsed;

  const value = parsed.value;
  if (!isRecord(value)) return err(fail('WRONG_TYPE', '$', 'a card bundle must be an object'));

  const stray = firstUndeclared(['$cards', 'cards'], value);
  if (stray !== undefined)
    return err(fail('UNDECLARED_FIELD', `$.${stray}`, `undeclared key '${stray}'`));

  const version = value['$cards'];
  if (version === undefined) return err(fail('MISSING_FIELD', '$.$cards', '$cards is required'));
  if (typeof version !== 'string')
    return err(fail('WRONG_TYPE', '$.$cards', '$cards must be a string'));
  if (version !== CARD_BUNDLE_FORMAT_VERSION)
    return err(
      fail(
        'UNSUPPORTED_VERSION',
        '$.$cards',
        `card bundle format version '${version}' is not supported by this decoder`,
      ),
    );

  const rawCards = value['cards'];
  if (rawCards === undefined) return err(fail('MISSING_FIELD', '$.cards', 'cards is required'));
  if (!Array.isArray(rawCards)) return err(fail('WRONG_TYPE', '$.cards', 'cards must be an array'));

  const cards: ContractCard[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawCards.length; i++) {
    const decoded = decodeCardAt(`$.cards[${i}]`, rawCards[i]);
    if (!decoded.ok) return decoded;
    const key = `${decoded.value.moduleId} ${decoded.value.componentId}`;
    if (seen.has(key))
      return err(
        fail(
          'DUPLICATE_CARD',
          `$.cards[${i}]`,
          `the bundle carries two cards for '${decoded.value.moduleId}.${decoded.value.componentId}'`,
        ),
      );
    seen.add(key);
    cards.push(decoded.value);
  }

  return ok(cards);
};

// ─── The three-way hash verdict (§25.4) ──────────────────────────────────────

/**
 * Whether a card can be said to describe the node in front of it.
 *
 * A `moduleId`/`componentId` pair is an ADDRESS: two deployments can ship
 * different components at the same address, and the same component at two
 * versions certainly will. So a card matching by name is not thereby a
 * description of THIS node, and the three cases are different licences to speak
 * rather than three degrees of confidence in one answer.
 */
export type CardHashVerdict =
  | { readonly kind: 'matches' }
  | { readonly kind: 'unverified'; readonly reason: string }
  | { readonly kind: 'mismatch' };

/** Compare a node's declared content hash against the card's. */
export const verifyCardHash = (
  declared: ContentHash | undefined,
  card: ContractCard,
): CardHashVerdict => {
  if (declared === undefined)
    return {
      kind: 'unverified',
      reason: 'the node declares no content hash, so there is nothing to compare',
    };
  if (declared.algorithm !== card.contentHash.algorithm)
    return {
      kind: 'unverified',
      reason: `the node's hash is ${declared.algorithm} and the card's is ${card.contentHash.algorithm}; two digests under different algorithms cannot be compared`,
    };
  return declared.hash === card.contentHash.hash ? { kind: 'matches' } : { kind: 'mismatch' };
};

/**
 * The stable marker a placeholder emits so the verdict is machine-readable and
 * not merely legible — what a conformance suite asserts against, because prose
 * in a placeholder is for a person.
 */
export const cardVerdictMarker = (verdict: CardHashVerdict): string =>
  verdict.kind === 'matches'
    ? 'described'
    : verdict.kind === 'unverified'
      ? 'unverified'
      : 'hash-mismatch';

// ─── Card-driven prop validation ─────────────────────────────────────────────

/** One prop-schema defect, in the reference tier's `FUARAN068` vocabulary. */
export interface CardPropDefect {
  readonly code: string;
  readonly key: string;
  readonly message: string;
}

/** Why a declared-wire payload prop carries an outstanding obligation. */
export type CardPayloadObligationKind = 'GateOwed' | 'Ungated';

export interface CardPayloadObligation {
  readonly key: string;
  readonly language: string;
  readonly gate?: string;
  readonly kind: CardPayloadObligationKind;
  readonly message: string;
}

/**
 * The card-derived answers about one prop bag: what is WRONG with it, what is
 * still OWED on it, and what this reader could not judge at all.
 *
 * The third list is the one a card introduces and a registry never needed. A
 * card written by a newer producer can name a type tag this build has never
 * heard of — not a defect on the NODE, which may be perfectly correct, but a
 * stated limit on the reader.
 */
export interface CardValidation {
  readonly defects: readonly CardPropDefect[];
  readonly obligations: readonly CardPayloadObligation[];
  readonly unresolvable: readonly string[];
}

/** The `CustomPropDefect` code — a registered component's prop bag violates its declared schema. */
export const CARD_PROP_DEFECT_CODE = 'FUARAN068';

/**
 * Validate a node's prop bag against a CARD — the same check a host holding the
 * contract performs, available to a host that holds only the description. This
 * is the half of the mechanism that is not cosmetic: a foreign host can now say
 * a `Custom` node is MALFORMED, where before it could only fail to render it.
 *
 * The messages are byte-identical to the reference tier's. A card's entire claim
 * is that it says what the contract says.
 */
export const validateAgainstCard = (
  card: ContractCard,
  props: Readonly<Record<string, JsonValue>>,
): CardValidation => {
  const defects: CardPropDefect[] = [];
  const obligations: CardPayloadObligation[] = [];
  const unresolvable: string[] = [];

  for (const row of card.props) {
    if (parsePropTypeTag(row.type) === undefined) {
      unresolvable.push(row.name);
      continue;
    }

    const present = Object.prototype.hasOwnProperty.call(props, row.name);

    if (row.required && !present) {
      defects.push({
        code: CARD_PROP_DEFECT_CODE,
        key: row.name,
        message: `required prop '${row.name}' (${row.type}) is missing`,
      });
      continue;
    }
    if (!present) continue;

    const value = props[row.name]!;
    if (!matchesTag(row.type, value)) {
      defects.push({
        code: CARD_PROP_DEFECT_CODE,
        key: row.name,
        message: `prop '${row.name}' is not a ${row.type}`,
      });
      continue;
    }

    // A declared-wire prop that is ABSENT raises nothing (there is no payload to
    // judge) and one that is present with the wrong shape already has a defect
    // saying so — reporting both would double-count one fault.
    if (row.payloadLanguage !== undefined) {
      obligations.push(
        row.payloadGate === undefined
          ? {
              key: row.name,
              language: row.payloadLanguage,
              kind: 'Ungated',
              message: `prop '${row.name}' declares a '${row.payloadLanguage}' payload but names no gate — nothing can judge it`,
            }
          : {
              key: row.name,
              language: row.payloadLanguage,
              gate: row.payloadGate,
              kind: 'GateOwed',
              message: `prop '${row.name}' carries a '${row.payloadLanguage}' payload; the '${row.payloadGate}' gate judges it and has NOT run here`,
            },
      );
    }
  }

  return { defects, obligations, unresolvable };
};

// ─── The placeholder derivation (§25.4) ──────────────────────────────────────

/** The identity line every placeholder carries, carded or not. */
export const cardLabel = (moduleId: string, componentId: string): string =>
  `[fuaran:custom ${moduleId}.${componentId}]`;

/**
 * The payload annotation a card row carries, rendered exactly as the reference
 * tier renders the contract-side declaration — the two must print the same thing
 * or a reader comparing a card against the deployment that issued it sees a
 * difference that is not there.
 */
export const cardPayloadTag = (
  language: string | undefined,
  gate: string | undefined,
): string | undefined => {
  if (language === undefined) return undefined;
  return gate === undefined ? `${language} (NO GATE)` : `${language} (gate ${gate})`;
};

/** One prop row as a placeholder prints it. Never a prop VALUE. */
export const cardPropLine = (row: CardPropRow): string => {
  const required = row.required ? ' (required)' : '';
  const tag = cardPayloadTag(row.payloadLanguage, row.payloadGate);
  return tag === undefined
    ? `${row.name}: ${row.type}${required}`
    : `${row.name}: ${row.type}${required} [${tag}]`;
};

/**
 * Everything a host needs to emit an honest placeholder for a `Custom` node it
 * cannot render, derived from a card rather than invented.
 */
export interface CardPlaceholder {
  readonly moduleId: string;
  readonly componentId: string;
  readonly label: string;
  /** Absent where the card declares none, and absent under `mismatch` whatever the card says. */
  readonly summary?: string;
  /** Empty under `mismatch`. */
  readonly propLines: readonly string[];
  readonly verdict: CardHashVerdict;
  readonly validation: CardValidation;
}

const EMPTY_VALIDATION: CardValidation = { defects: [], obligations: [], unresolvable: [] };

/**
 * Derive the whole placeholder for one node from one card.
 *
 * Under `mismatch` the summary and the prop rows are WITHHELD: the card
 * describes a different shape at the same address, and printing its description
 * would be the guess §25.4 forbids — a confident wrong description being worse
 * than none. What is not withheld is the identity and the fact of the mismatch,
 * because hiding those would leave a reader with less than the uncarded
 * placeholder gave them.
 */
export const describeFromCard = (
  declared: ContentHash | undefined,
  props: Readonly<Record<string, JsonValue>>,
  card: ContractCard,
): CardPlaceholder => {
  const verdict = verifyCardHash(declared, card);
  const withheld = verdict.kind === 'mismatch';

  return {
    moduleId: card.moduleId,
    componentId: card.componentId,
    label: cardLabel(card.moduleId, card.componentId),
    ...(!withheld && card.summary !== undefined ? { summary: card.summary } : {}),
    propLines: withheld ? [] : card.props.map(cardPropLine),
    verdict,
    validation: withheld ? EMPTY_VALIDATION : validateAgainstCard(card, props),
  };
};

// ─── The store ───────────────────────────────────────────────────────────────

/**
 * A host-supplied lookup of contract cards.
 *
 * Deliberately the same shape as a renderer registry and deliberately not the
 * same thing. A registry says "I can render this"; a store says "I can describe
 * this". All four combinations are meaningful, which is exactly why folding
 * cards into a renderer registry would be wrong: it would make a description
 * obtainable only where a renderer already existed — i.e. in every case except
 * the one this artefact exists for.
 */
export class CardStore {
  private readonly map = new Map<string, ContractCard>();

  /** Add a card. Re-adding an identity replaces it; a BUNDLE refuses duplicates at decode. */
  add(card: ContractCard): this {
    this.map.set(`${card.moduleId} ${card.componentId}`, card);
    return this;
  }

  get(moduleId: string, componentId: string): ContractCard | undefined {
    return this.map.get(`${moduleId} ${componentId}`);
  }

  get size(): number {
    return this.map.size;
  }

  /** Fold a card list into a store. */
  static of(cards: readonly ContractCard[]): CardStore {
    const store = new CardStore();
    for (const c of cards) store.add(c);
    return store;
  }
}
