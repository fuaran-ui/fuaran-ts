// ============================================================================
//  @fuaran-ui/ops — the elicitation envelope: question-as-UI with a typed
//  answer contract (WIRE_FORMAT.md §18).
//
//  An elicitation poses a question AS a live Fuaran tree: a canonical Node
//  plus a declared answer contract — which nodes' committed state entries
//  constitute the answer, each typed by a value space — resolving to exactly
//  one typed outcome (`Answered` with canonical typed JSON conforming to the
//  contract / `Declined` / `TimedOut` / `Superseded`). Never prose to
//  re-parse.
//
//  A conformant TS implementation of the §18 contract, certified against the
//  workspace ../wire-format-fixtures/ corpus (`elicitation-round-trip` /
//  `elicitation-reject` / `elicitation-answer-accept` /
//  `elicitation-answer-reject` families). Like §17's teleport bundle, this is
//  an additive top-level artefact: the Node wire form is embedded unchanged
//  and no NodeKind / Action / Binding case is added — the envelope wraps a
//  tree, it does not extend the tree vocabulary.
//
//  Strictness (default-deny by shape): every object position rejects
//  undeclared keys (`UNDECLARED_FIELD`); decode is fail-fast in the §18.4
//  pinned order so every host surfaces the same first error. No clock is read
//  anywhere here — `timeoutMs` is data; the presenting HOST's clock dispatches
//  `TimedOut`.
// ============================================================================

import type { Node, Result } from '@fuaran-ui/schema';

import { allNodeIds } from './apply.js';
import { decodeNode, type DecodeError, type DecodeErrorCode } from './decode.js';
import { encodeNode, renderAstCanonical } from './encode.js';
import { type JsonAst, parse } from './parse.js';

// ─── Wire constants ──────────────────────────────────────────────────────────

/** The envelope format-version tag key (`$`-prefixed, reserved per §2.1). */
export const ELICITATION_KEY = '$elicitation';
/** The envelope format version this codec produces and accepts. */
export const ELICITATION_VERSION = '1';

// ─── Error surface ───────────────────────────────────────────────────────────

/**
 * The elicitation error surface: the six §6 codes plus the §18.5 codes, kept
 * OUT of the core `DecodeErrorCode` set (same posture as §15's
 * `FOREIGN_PROFILE`).
 */
export type ElicitationErrorCode =
  | DecodeErrorCode
  | 'UNSUPPORTED_VERSION'
  | 'UNDECLARED_FIELD'
  | 'CONTRACT_EMPTY'
  | 'CONTRACT_DUPLICATE_FIELD'
  | 'CONTRACT_UNKNOWN_NODE'
  | 'ANSWER_MISSING_FIELD'
  | 'ANSWER_UNDECLARED_FIELD'
  | 'ANSWER_TYPE_MISMATCH'
  | 'ANSWER_OUT_OF_SPACE'
  | 'DEFAULT_NONCONFORMANT';

export interface ElicitationError {
  readonly code: ElicitationErrorCode;
  readonly path: string;
  readonly message: string;
}

const elErr = (code: ElicitationErrorCode, path: string, message: string): ElicitationError => ({
  code,
  path,
  message,
});

/** Re-root an inner decode error under `prefix` (`$.kind` → `$.tree.kind`). */
const rePath = (prefix: string, e: DecodeError): ElicitationError => ({
  code: e.code,
  path:
    e.path === '$'
      ? prefix
      : e.path.startsWith('$')
        ? prefix + e.path.slice(1)
        : `${prefix}.${e.path}`,
  message: e.message,
});

// ─── Typed shapes ────────────────────────────────────────────────────────────

/**
 * A value space — the platform's established `$type`-tagged space vocabulary
 * (the same wire shape the capability codec uses). `min`/`max` inclusive;
 * `anyString` is the only unbounded space.
 */
export type AnswerSpace =
  | { readonly kind: 'intRange'; readonly min: number; readonly max: number }
  | { readonly kind: 'floatRange'; readonly min: number; readonly max: number }
  | { readonly kind: 'stringLen'; readonly min: number; readonly max: number }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'anyString' };

/** One declared answer field (§18.1). */
export interface AnswerField {
  /** The key this field's value takes in the answer object. */
  readonly name: string;
  /** The id of the NODE whose committed state carries the value. */
  readonly nodeId: string;
  /** The state key the node's binding writes the value under. */
  readonly stateKey: string;
  readonly space: AnswerSpace;
  readonly required: boolean;
}

/** The declared answer contract — non-empty on the wire (`CONTRACT_EMPTY`). */
export interface AnswerContract {
  readonly fields: readonly AnswerField[];
}

/** A typed answer value — the JSON scalar shapes a space ranges over. */
export type AnswerValue = string | number;

/** An answer object: declared field names → scalar values. */
export type Answer = ReadonlyMap<string, AnswerValue>;

/** The elicitation envelope (§18.1). */
export interface ElicitationEnvelope {
  readonly id: string;
  readonly tree: Node<unknown>;
  readonly contract: AnswerContract;
  /** Milliseconds, ≥ 1. DATA only — the presenting host's clock acts on it. */
  readonly timeoutMs?: number;
  /** A proposed answer; must itself conform to the contract. */
  readonly defaultAnswer?: Answer;
}

/** The closed outcome set (§18.3). */
export type ElicitationOutcome =
  | { readonly kind: 'Answered'; readonly answer: Answer }
  | { readonly kind: 'Declined' }
  | { readonly kind: 'TimedOut' }
  | { readonly kind: 'Superseded'; readonly by?: string };

/** An outcome on the wire, correlated to its elicitation by id. */
export interface ElicitationOutcomeEnvelope {
  readonly elicitationId: string;
  readonly outcome: ElicitationOutcome;
}

// ─── Shared JSON helpers ─────────────────────────────────────────────────────

/**
 * §18.2 integer classification, identical across hosts: a whole-valued JSON
 * number within 32-bit signed range IS an integer (JSON has one number type —
 * `1.0` and `1` denote the same value; the canonical layout renders it `1`).
 */
const isInt32 = (v: number): boolean => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;

const jstr = (value: string): JsonAst => ({ kind: 'JString', value });
const jnum = (value: number): JsonAst => ({ kind: 'JNumber', value });
const jobj = (entries: readonly (readonly [string, JsonAst])[]): JsonAst => ({
  kind: 'JObject',
  fields: new Map(entries),
});

/** First key of `fields` (document order) not in `allowed` — default-deny by shape. */
const firstUndeclared = (
  allowed: readonly string[],
  fields: ReadonlyMap<string, JsonAst>,
): string | undefined => {
  for (const k of fields.keys()) if (!allowed.includes(k)) return k;
  return undefined;
};

const requireNonEmptyStr = (
  path: string,
  name: string,
  fields: ReadonlyMap<string, JsonAst>,
): Result<string, ElicitationError> => {
  const v = fields.get(name);
  if (v === undefined)
    return { ok: false, error: elErr('MISSING_FIELD', path, `missing required field '${name}'`) };
  if (v.kind !== 'JString')
    return { ok: false, error: elErr('WRONG_TYPE', path, `'${name}' must be a string`) };
  if (v.value === '')
    return { ok: false, error: elErr('WRONG_TYPE', path, `'${name}' must be a non-empty string`) };
  return { ok: true, value: v.value };
};

// ─── Value-space codec ───────────────────────────────────────────────────────

const encodeSpace = (s: AnswerSpace): JsonAst => {
  switch (s.kind) {
    case 'intRange':
      return jobj([
        ['$type', jstr('intRange')],
        ['max', jnum(s.max)],
        ['min', jnum(s.min)],
      ]);
    case 'floatRange':
      return jobj([
        ['$type', jstr('floatRange')],
        ['max', jnum(s.max)],
        ['min', jnum(s.min)],
      ]);
    case 'stringLen':
      return jobj([
        ['$type', jstr('stringLen')],
        ['max', jnum(s.max)],
        ['min', jnum(s.min)],
      ]);
    case 'enum':
      return jobj([
        ['$type', jstr('enum')],
        ['values', { kind: 'JArray', items: s.values.map(jstr) }],
      ]);
    case 'anyString':
      return jobj([['$type', jstr('anyString')]]);
  }
};

const decodeSpace = (path: string, jv: JsonAst): Result<AnswerSpace, ElicitationError> => {
  if (jv.kind !== 'JObject')
    return { ok: false, error: elErr('WRONG_TYPE', path, 'space must be a JSON object') };
  const tagJ = jv.fields.get('$type');
  if (tagJ === undefined)
    return {
      ok: false,
      error: elErr('MISSING_FIELD', `${path}.$type`, "space must carry a '$type' discriminator"),
    };
  if (tagJ.kind !== 'JString')
    return { ok: false, error: elErr('WRONG_TYPE', `${path}.$type`, "'$type' must be a string") };
  const tag = tagJ.value;

  const strict = <T>(
    allowed: readonly string[],
    k: () => Result<T, ElicitationError>,
  ): Result<T, ElicitationError> => {
    const stray = firstUndeclared(['$type', ...allowed], jv.fields);
    if (stray !== undefined)
      return {
        ok: false,
        error: elErr(
          'UNDECLARED_FIELD',
          `${path}.${stray}`,
          `undeclared key '${stray}' on a '${tag}' space`,
        ),
      };
    return k();
  };

  const intBound = (name: string): Result<number, ElicitationError> => {
    const v = jv.fields.get(name);
    if (v === undefined)
      return {
        ok: false,
        error: elErr('MISSING_FIELD', `${path}.${name}`, `missing required field '${name}'`),
      };
    if (v.kind !== 'JNumber' || !Number.isInteger(v.value))
      return {
        ok: false,
        error: elErr('WRONG_TYPE', `${path}.${name}`, `'${name}' must be an integer`),
      };
    return { ok: true, value: v.value };
  };

  const numBound = (name: string): Result<number, ElicitationError> => {
    const v = jv.fields.get(name);
    if (v === undefined)
      return {
        ok: false,
        error: elErr('MISSING_FIELD', `${path}.${name}`, `missing required field '${name}'`),
      };
    if (v.kind !== 'JNumber')
      return {
        ok: false,
        error: elErr('WRONG_TYPE', `${path}.${name}`, `'${name}' must be a number`),
      };
    return { ok: true, value: v.value };
  };

  const ordered = <T>(lo: number, hi: number, mk: () => T): Result<T, ElicitationError> =>
    hi < lo
      ? { ok: false, error: elErr('WRONG_TYPE', path, 'space bounds must satisfy min <= max') }
      : { ok: true, value: mk() };

  const range = (
    kind: 'intRange' | 'floatRange' | 'stringLen',
    bound: (name: string) => Result<number, ElicitationError>,
  ): Result<AnswerSpace, ElicitationError> =>
    strict(['max', 'min'], () => {
      const min = bound('min');
      if (!min.ok) return min;
      const max = bound('max');
      if (!max.ok) return max;
      return ordered(min.value, max.value, () => ({ kind, min: min.value, max: max.value }));
    });

  switch (tag) {
    case 'intRange':
      return range('intRange', intBound);
    case 'floatRange':
      return range('floatRange', numBound);
    case 'stringLen':
      return range('stringLen', intBound);
    case 'enum':
      return strict(['values'], () => {
        const v = jv.fields.get('values');
        if (v === undefined)
          return {
            ok: false,
            error: elErr('MISSING_FIELD', `${path}.values`, "missing required field 'values'"),
          };
        if (v.kind !== 'JArray' || v.items.some((it) => it.kind !== 'JString'))
          return {
            ok: false,
            error: elErr('WRONG_TYPE', `${path}.values`, "'values' must be an array of strings"),
          };
        if (v.items.length === 0)
          return {
            ok: false,
            error: elErr('WRONG_TYPE', `${path}.values`, "'values' must be a non-empty array"),
          };
        return {
          ok: true,
          value: {
            kind: 'enum',
            values: v.items.map((it) => (it as { kind: 'JString'; value: string }).value),
          },
        };
      });
    case 'anyString':
      return strict([], () => ({ ok: true, value: { kind: 'anyString' } }));
    default:
      return {
        ok: false,
        error: elErr(
          'UNKNOWN_DU_CASE',
          `${path}.$type`,
          `unknown value-space discriminator '${tag}'`,
        ),
      };
  }
};

// ─── Answer objects ──────────────────────────────────────────────────────────

const encodeAnswerAst = (answer: Answer): JsonAst =>
  jobj([...answer.entries()].map(([k, v]) => [k, typeof v === 'string' ? jstr(v) : jnum(v)]));

const decodeAnswerObject = (basePath: string, jv: JsonAst): Result<Answer, ElicitationError> => {
  if (jv.kind !== 'JObject')
    return { ok: false, error: elErr('WRONG_TYPE', basePath, 'answer must be a JSON object') };
  const out = new Map<string, AnswerValue>();
  for (const [k, v] of jv.fields) {
    if (v.kind === 'JString') out.set(k, v.value);
    else if (v.kind === 'JNumber') out.set(k, v.value);
    else
      return {
        ok: false,
        error: elErr(
          'WRONG_TYPE',
          `${basePath}.${k}`,
          'answer values must be JSON scalars (string or number)',
        ),
      };
  }
  return { ok: true, value: out };
};

// ─── Answer conformance (§18.4) ──────────────────────────────────────────────

/**
 * Validate a typed answer against `contract`, reporting at `basePath`.
 * Deterministic fail-fast order: (1) undeclared keys, in Ordinal key order;
 * (2) per contract field, in declaration order — missing-required, then
 * JSON-type-vs-space, then in-space.
 */
export const validateAnswerAt = (
  basePath: string,
  contract: AnswerContract,
  answer: Answer,
): Result<undefined, ElicitationError> => {
  const declared = new Set(contract.fields.map((f) => f.name));
  const stray = [...answer.keys()].sort().find((k) => !declared.has(k));
  if (stray !== undefined)
    return {
      ok: false,
      error: elErr(
        'ANSWER_UNDECLARED_FIELD',
        `${basePath}.${stray}`,
        `'${stray}' is not a declared answer field`,
      ),
    };

  for (const field of contract.fields) {
    const path = `${basePath}.${field.name}`;
    const value = answer.get(field.name);
    if (value === undefined) {
      if (field.required)
        return {
          ok: false,
          error: elErr(
            'ANSWER_MISSING_FIELD',
            path,
            `required answer field '${field.name}' is missing`,
          ),
        };
      continue;
    }

    const mismatch = (expected: string): Result<undefined, ElicitationError> => ({
      ok: false,
      error: elErr(
        'ANSWER_TYPE_MISMATCH',
        path,
        `'${field.name}' must be ${expected} for its declared space`,
      ),
    });
    const outOfSpace = (detail: string): Result<undefined, ElicitationError> => ({
      ok: false,
      error: elErr(
        'ANSWER_OUT_OF_SPACE',
        path,
        `'${field.name}' is outside its declared space: ${detail}`,
      ),
    });

    const s = field.space;
    switch (s.kind) {
      case 'intRange': {
        if (typeof value !== 'number' || !isInt32(value)) return mismatch('an integer');
        if (value < s.min || value > s.max)
          return outOfSpace(`${value} is not in [${s.min}, ${s.max}]`);
        break;
      }
      case 'floatRange': {
        if (typeof value !== 'number') return mismatch('a number');
        if (value < s.min || value > s.max)
          return outOfSpace(`${value} is not in [${s.min}, ${s.max}]`);
        break;
      }
      case 'stringLen': {
        if (typeof value !== 'string') return mismatch('a string');
        if (value.length < s.min || value.length > s.max)
          return outOfSpace('the string violates its declared space');
        break;
      }
      case 'enum': {
        if (typeof value !== 'string') return mismatch('a string');
        if (!s.values.includes(value)) return outOfSpace('the string violates its declared space');
        break;
      }
      case 'anyString': {
        if (typeof value !== 'string') return mismatch('a string');
        break;
      }
    }
  }
  return { ok: true, value: undefined };
};

/**
 * Validate an answer at the standard `$.answer` root — the gate a resolution
 * host runs before an `Answered` outcome reaches the asking agent.
 */
export const validateAnswer = (
  contract: AnswerContract,
  answer: Answer,
): Result<undefined, ElicitationError> => validateAnswerAt('$.answer', contract, answer);

// ─── Contract codec ──────────────────────────────────────────────────────────

const encodeField = (f: AnswerField): JsonAst =>
  jobj([
    ['name', jstr(f.name)],
    ['nodeId', jstr(f.nodeId)],
    ['required', { kind: 'JBool', value: f.required }],
    ['space', encodeSpace(f.space)],
    ['stateKey', jstr(f.stateKey)],
  ]);

const encodeContract = (c: AnswerContract): JsonAst =>
  jobj([['fields', { kind: 'JArray', items: c.fields.map(encodeField) }]]);

const decodeContract = (
  basePath: string,
  nodeExists: (nodeId: string) => boolean,
  jv: JsonAst,
): Result<AnswerContract, ElicitationError> => {
  if (jv.kind !== 'JObject')
    return { ok: false, error: elErr('WRONG_TYPE', basePath, 'contract must be a JSON object') };
  const stray = firstUndeclared(['fields'], jv.fields);
  if (stray !== undefined)
    return {
      ok: false,
      error: elErr(
        'UNDECLARED_FIELD',
        `${basePath}.${stray}`,
        `undeclared key '${stray}' on the contract`,
      ),
    };
  const fieldsJ = jv.fields.get('fields');
  if (fieldsJ === undefined)
    return {
      ok: false,
      error: elErr('MISSING_FIELD', `${basePath}.fields`, "missing required field 'fields'"),
    };
  if (fieldsJ.kind !== 'JArray')
    return {
      ok: false,
      error: elErr('WRONG_TYPE', `${basePath}.fields`, "'fields' must be an array"),
    };
  if (fieldsJ.items.length === 0)
    return {
      ok: false,
      error: elErr(
        'CONTRACT_EMPTY',
        `${basePath}.fields`,
        'an answer contract must declare at least one field',
      ),
    };

  const out: AnswerField[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < fieldsJ.items.length; i++) {
    const item = fieldsJ.items[i]!;
    const path = `${basePath}.fields[${i}]`;
    if (item.kind !== 'JObject')
      return { ok: false, error: elErr('WRONG_TYPE', path, 'answer field must be a JSON object') };
    const strayF = firstUndeclared(
      ['name', 'nodeId', 'required', 'space', 'stateKey'],
      item.fields,
    );
    if (strayF !== undefined)
      return {
        ok: false,
        error: elErr(
          'UNDECLARED_FIELD',
          `${path}.${strayF}`,
          `undeclared key '${strayF}' on an answer field`,
        ),
      };
    const name = requireNonEmptyStr(`${path}.name`, 'name', item.fields);
    if (!name.ok) return name;
    const nodeId = requireNonEmptyStr(`${path}.nodeId`, 'nodeId', item.fields);
    if (!nodeId.ok) return nodeId;
    if (!nodeExists(nodeId.value))
      return {
        ok: false,
        error: elErr(
          'CONTRACT_UNKNOWN_NODE',
          `${path}.nodeId`,
          `'${nodeId.value}' names no node in the elicitation tree`,
        ),
      };
    const requiredJ = item.fields.get('required');
    if (requiredJ === undefined)
      return {
        ok: false,
        error: elErr('MISSING_FIELD', `${path}.required`, "missing required field 'required'"),
      };
    if (requiredJ.kind !== 'JBool')
      return {
        ok: false,
        error: elErr('WRONG_TYPE', `${path}.required`, "'required' must be a boolean"),
      };
    const spaceJ = item.fields.get('space');
    if (spaceJ === undefined)
      return {
        ok: false,
        error: elErr('MISSING_FIELD', `${path}.space`, "missing required field 'space'"),
      };
    const space = decodeSpace(`${path}.space`, spaceJ);
    if (!space.ok) return space;
    const stateKey = requireNonEmptyStr(`${path}.stateKey`, 'stateKey', item.fields);
    if (!stateKey.ok) return stateKey;
    if (seen.has(name.value))
      return {
        ok: false,
        error: elErr(
          'CONTRACT_DUPLICATE_FIELD',
          `${path}.name`,
          `duplicate answer field name '${name.value}'`,
        ),
      };
    seen.add(name.value);
    out.push({
      name: name.value,
      nodeId: nodeId.value,
      stateKey: stateKey.value,
      space: space.value,
      required: requiredJ.value,
    });
  }
  return { ok: true, value: { fields: out } };
};

// ─── Envelope codec ──────────────────────────────────────────────────────────

/**
 * Encode an elicitation envelope to canonical wire bytes. Fails only when the
 * tree is not wire-representable.
 */
export const encodeElicitation = (env: ElicitationEnvelope): Result<string, ElicitationError> => {
  const treeAst = parse(encodeNode(env.tree));
  if (!treeAst.ok)
    return {
      ok: false,
      error: elErr(
        'WRONG_TYPE',
        '$.tree',
        `tree is not wire-representable: ${treeAst.error.message}`,
      ),
    };
  const entries: (readonly [string, JsonAst])[] = [
    [ELICITATION_KEY, jstr(ELICITATION_VERSION)],
    ['contract', encodeContract(env.contract)],
  ];
  if (env.defaultAnswer !== undefined)
    entries.push(['default', encodeAnswerAst(env.defaultAnswer)]);
  entries.push(['id', jstr(env.id)]);
  if (env.timeoutMs !== undefined) entries.push(['timeoutMs', jnum(env.timeoutMs)]);
  entries.push(['tree', treeAst.value]);
  return { ok: true, value: renderAstCanonical(jobj(entries)) };
};

/**
 * Decode + validate an elicitation envelope (fail-fast, §18.4 order): stray
 * keys → version tag → id → tree (standard node decode, errors re-rooted
 * under `$.tree`) → contract (structure, duplicates, node membership) →
 * timeoutMs → default conformance.
 */
export const decodeElicitation = (json: string): Result<ElicitationEnvelope, ElicitationError> => {
  const parsed = parse(json);
  if (!parsed.ok)
    return {
      ok: false,
      error: elErr('INVALID_JSON', '$', `input is not valid JSON: ${parsed.error.message}`),
    };
  const root = parsed.value;
  if (root.kind !== 'JObject')
    return {
      ok: false,
      error: elErr('WRONG_TYPE', '$', 'elicitation envelope must be a JSON object'),
    };

  const stray = firstUndeclared(
    [ELICITATION_KEY, 'contract', 'default', 'id', 'timeoutMs', 'tree'],
    root.fields,
  );
  if (stray !== undefined)
    return {
      ok: false,
      error: elErr(
        'UNDECLARED_FIELD',
        `$.${stray}`,
        `undeclared key '${stray}' on the elicitation envelope`,
      ),
    };

  const versionJ = root.fields.get(ELICITATION_KEY);
  if (versionJ === undefined)
    return {
      ok: false,
      error: elErr(
        'MISSING_FIELD',
        `$.${ELICITATION_KEY}`,
        `missing required field '${ELICITATION_KEY}'`,
      ),
    };
  if (versionJ.kind !== 'JString')
    return {
      ok: false,
      error: elErr('WRONG_TYPE', `$.${ELICITATION_KEY}`, `'${ELICITATION_KEY}' must be a string`),
    };
  if (versionJ.value !== ELICITATION_VERSION)
    return {
      ok: false,
      error: elErr(
        'UNSUPPORTED_VERSION',
        `$.${ELICITATION_KEY}`,
        `unsupported elicitation format version '${versionJ.value}' (this codec accepts '${ELICITATION_VERSION}')`,
      ),
    };

  const id = requireNonEmptyStr('$.id', 'id', root.fields);
  if (!id.ok) return id;

  const treeJ = root.fields.get('tree');
  if (treeJ === undefined)
    return { ok: false, error: elErr('MISSING_FIELD', '$.tree', "missing required field 'tree'") };
  const tree = decodeNode(renderAstCanonical(treeJ));
  if (!tree.ok) return { ok: false, error: rePath('$.tree', tree.error) };

  const ids = new Set(allNodeIds(tree.value));
  const contractJ = root.fields.get('contract');
  if (contractJ === undefined)
    return {
      ok: false,
      error: elErr('MISSING_FIELD', '$.contract', "missing required field 'contract'"),
    };
  const contract = decodeContract('$.contract', (nodeId) => ids.has(nodeId), contractJ);
  if (!contract.ok) return contract;

  let timeoutMs: number | undefined;
  const timeoutJ = root.fields.get('timeoutMs');
  if (timeoutJ !== undefined) {
    if (timeoutJ.kind !== 'JNumber' || !Number.isInteger(timeoutJ.value) || timeoutJ.value < 1)
      return {
        ok: false,
        error: elErr('WRONG_TYPE', '$.timeoutMs', "'timeoutMs' must be an integer >= 1"),
      };
    timeoutMs = timeoutJ.value;
  }

  let defaultAnswer: Answer | undefined;
  const defaultJ = root.fields.get('default');
  if (defaultJ !== undefined) {
    const answer = decodeAnswerObject('$.default', defaultJ);
    if (!answer.ok) return answer;
    const conform = validateAnswerAt('$.default', contract.value, answer.value);
    if (!conform.ok)
      return {
        ok: false,
        error: elErr(
          'DEFAULT_NONCONFORMANT',
          conform.error.path,
          `default answer is non-conformant (${conform.error.code}): ${conform.error.message}`,
        ),
      };
    defaultAnswer = answer.value;
  }

  return {
    ok: true,
    value: {
      id: id.value,
      tree: tree.value,
      contract: contract.value,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(defaultAnswer !== undefined ? { defaultAnswer } : {}),
    },
  };
};

// ─── Outcome codec ───────────────────────────────────────────────────────────

/** Encode an outcome to canonical wire bytes. Total — no embedded tree. */
export const encodeElicitationOutcome = (env: ElicitationOutcomeEnvelope): string => {
  const o = env.outcome;
  const entries: (readonly [string, JsonAst])[] = [['$type', jstr(o.kind)]];
  if (o.kind === 'Answered') entries.push(['answer', encodeAnswerAst(o.answer)]);
  if (o.kind === 'Superseded' && o.by !== undefined) entries.push(['by', jstr(o.by)]);
  entries.push(['elicitationId', jstr(env.elicitationId)]);
  return renderAstCanonical(jobj(entries));
};

/**
 * Decode an outcome envelope. Contract conformance of an `Answered` answer is
 * NOT checked here (the outcome does not carry the contract) — a resolution
 * host pairs the outcome with its pending elicitation and runs
 * `validateAnswer` before the answer reaches the asking agent (§18.4).
 */
export const decodeElicitationOutcome = (
  json: string,
): Result<ElicitationOutcomeEnvelope, ElicitationError> => {
  const parsed = parse(json);
  if (!parsed.ok)
    return {
      ok: false,
      error: elErr('INVALID_JSON', '$', `input is not valid JSON: ${parsed.error.message}`),
    };
  const root = parsed.value;
  if (root.kind !== 'JObject')
    return { ok: false, error: elErr('WRONG_TYPE', '$', 'outcome must be a JSON object') };

  const tagJ = root.fields.get('$type');
  if (tagJ === undefined)
    return {
      ok: false,
      error: elErr('MISSING_FIELD', '$.$type', "outcome must carry a '$type' discriminator"),
    };
  if (tagJ.kind !== 'JString')
    return { ok: false, error: elErr('WRONG_TYPE', '$.$type', "'$type' must be a string") };
  const tag = tagJ.value;

  const strict = (allowed: readonly string[]): ElicitationError | undefined => {
    const stray = firstUndeclared(['$type', 'elicitationId', ...allowed], root.fields);
    return stray === undefined
      ? undefined
      : elErr('UNDECLARED_FIELD', `$.${stray}`, `undeclared key '${stray}' on a '${tag}' outcome`);
  };

  const withId = (
    allowed: readonly string[],
    mk: (id: string) => Result<ElicitationOutcomeEnvelope, ElicitationError>,
  ): Result<ElicitationOutcomeEnvelope, ElicitationError> => {
    const strayErr = strict(allowed);
    if (strayErr !== undefined) return { ok: false, error: strayErr };
    const id = requireNonEmptyStr('$.elicitationId', 'elicitationId', root.fields);
    if (!id.ok) return id;
    return mk(id.value);
  };

  switch (tag) {
    case 'Answered':
      return withId(['answer'], (id) => {
        const answerJ = root.fields.get('answer');
        if (answerJ === undefined)
          return {
            ok: false,
            error: elErr('MISSING_FIELD', '$.answer', "missing required field 'answer'"),
          };
        const answer = decodeAnswerObject('$.answer', answerJ);
        if (!answer.ok) return answer;
        return {
          ok: true,
          value: { elicitationId: id, outcome: { kind: 'Answered', answer: answer.value } },
        };
      });
    case 'Declined':
      return withId([], (id) => ({
        ok: true,
        value: { elicitationId: id, outcome: { kind: 'Declined' } },
      }));
    case 'TimedOut':
      return withId([], (id) => ({
        ok: true,
        value: { elicitationId: id, outcome: { kind: 'TimedOut' } },
      }));
    case 'Superseded':
      return withId(['by'], (id) => {
        const byJ = root.fields.get('by');
        if (byJ === undefined)
          return {
            ok: true,
            value: { elicitationId: id, outcome: { kind: 'Superseded' } },
          };
        if (byJ.kind !== 'JString' || byJ.value === '')
          return {
            ok: false,
            error: elErr('WRONG_TYPE', '$.by', "'by' must be a non-empty string"),
          };
        return {
          ok: true,
          value: { elicitationId: id, outcome: { kind: 'Superseded', by: byJ.value } },
        };
      });
    default:
      return {
        ok: false,
        error: elErr('UNKNOWN_DU_CASE', '$.$type', `unknown outcome discriminator '${tag}'`),
      };
  }
};

// ─── Answer-conformance document (§18.4, the fixture-harness operation) ──────

/**
 * Validate a `{"answer": {…}, "contract": {…}}` conformance document — the
 * operation the `elicitation-answer-accept` / `elicitation-answer-reject`
 * corpus families drive. The document carries no tree, so the
 * `CONTRACT_UNKNOWN_NODE` probe does not apply here.
 */
export const validateAnswerDocument = (json: string): Result<undefined, ElicitationError> => {
  const parsed = parse(json);
  if (!parsed.ok)
    return {
      ok: false,
      error: elErr('INVALID_JSON', '$', `input is not valid JSON: ${parsed.error.message}`),
    };
  const root = parsed.value;
  if (root.kind !== 'JObject')
    return {
      ok: false,
      error: elErr('WRONG_TYPE', '$', 'answer-conformance document must be a JSON object'),
    };
  const stray = firstUndeclared(['answer', 'contract'], root.fields);
  if (stray !== undefined)
    return {
      ok: false,
      error: elErr(
        'UNDECLARED_FIELD',
        `$.${stray}`,
        `undeclared key '${stray}' on an answer-conformance document`,
      ),
    };
  const contractJ = root.fields.get('contract');
  if (contractJ === undefined)
    return {
      ok: false,
      error: elErr('MISSING_FIELD', '$.contract', "missing required field 'contract'"),
    };
  const contract = decodeContract('$.contract', () => true, contractJ);
  if (!contract.ok) return contract;
  const answerJ = root.fields.get('answer');
  if (answerJ === undefined)
    return {
      ok: false,
      error: elErr('MISSING_FIELD', '$.answer', "missing required field 'answer'"),
    };
  const answer = decodeAnswerObject('$.answer', answerJ);
  if (!answer.ok) return answer;
  return validateAnswerAt('$.answer', contract.value, answer.value);
};
