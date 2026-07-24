// ============================================================================
//  @fuaran-ui/validator — manifest (§4d / VALIDATOR-MANIFEST.md).
//
//  Module authors hand-write a tiny JSON file declaring the typed contract the
//  validator gates against: registered query names, the message DU's case
//  names, and (optionally) per-query row types. The validator does not infer;
//  the manifest IS the contract.
//
//  This is the TS port of the F# tier's `Fuaran.UI.Validator.Manifest`. The
//  wire shape is identical (`queries` / `msgCases` / `queryRowTypes` /
//  `customNodeRatio`) so one `fuaran-validator.manifest.json` serves both
//  tiers. File-discovery convention (v1): the validator looks for
//  `fuaran-validator.manifest.json` in the project root it is given.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** In-memory view of the manifest after load. */
export interface Manifest {
  readonly queries: ReadonlySet<string>;
  readonly msgCases: ReadonlySet<string>;
  readonly queryRowTypes: ReadonlyMap<string, string>;
  /** `undefined` means "use the validator's default threshold". */
  readonly customNodeRatio: number | undefined;
}

export const emptyManifest: Manifest = {
  queries: new Set(),
  msgCases: new Set(),
  queryRowTypes: new Map(),
  customNodeRatio: undefined,
};

/** The on-disk wire shape (kept lenient — every field is optional). */
interface ManifestDto {
  readonly queries?: readonly string[];
  readonly msgCases?: readonly string[];
  readonly queryRowTypes?: Readonly<Record<string, string>>;
  readonly customNodeRatio?: number;
}

/**
 * Strip `//` line comments and trailing commas, matching the F# parser's
 * leniency (`AllowTrailingCommas` + `JsonCommentHandling.Skip`). Conservative:
 * only `//` outside string literals, and trailing commas before `}` / `]`.
 */
function relaxJson(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && json[i + 1] === '/') {
      while (i < json.length && json[i] !== '\n') i++;
      if (i < json.length) out += '\n';
      continue;
    }
    out += ch;
  }
  // Drop trailing commas: `,` followed by optional whitespace and `}` or `]`.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Parse a manifest JSON string. Throws on malformed input. */
export function parseManifest(json: string): Manifest {
  const dto = JSON.parse(relaxJson(json)) as ManifestDto | null;
  if (dto === null || typeof dto !== 'object') return emptyManifest;

  const queryRowTypes = new Map<string, string>();
  if (dto.queryRowTypes !== undefined) {
    for (const [k, v] of Object.entries(dto.queryRowTypes)) queryRowTypes.set(k, v);
  }

  return {
    queries: new Set(dto.queries ?? []),
    msgCases: new Set(dto.msgCases ?? []),
    queryRowTypes,
    customNodeRatio: dto.customNodeRatio,
  };
}

/**
 * Convention-based discovery: returns the manifest path if a
 * `fuaran-validator.manifest.json` exists in `projectDir`, `undefined`
 * otherwise. The validator emits FUARAN900 when none is present.
 */
export function discoverManifest(projectDir: string): string | undefined {
  const candidate = join(projectDir, 'fuaran-validator.manifest.json');
  return existsSync(candidate) ? candidate : undefined;
}

/** Load a manifest from disk; the empty manifest if `path` is missing. */
export function loadManifest(path: string): Manifest {
  return existsSync(path) ? parseManifest(readFileSync(path, 'utf8')) : emptyManifest;
}
