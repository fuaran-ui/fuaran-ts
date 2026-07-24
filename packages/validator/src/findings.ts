// ============================================================================
//  @fuaran-ui/validator — findings model.
//
//  A `Finding` is what a rule emits. The validator collects findings across
//  every source file it is given and renders them per the §4d AI-recovery
//  shape (`renderFindingJson`). Errors fail the CLI (non-zero exit); warnings
//  print and do not fail by default.
//
//  This mirrors the F# tier's `Fuaran.UI.Validator.Findings` module
//  (`Severity` / `Location` / `Finding` / `create` / `withRecovery`). The
//  `code` strings match the F# `FUARAN###` identities byte-for-byte so a
//  cross-implementation eval suite can score uniformly.
// ============================================================================

/** A finding's severity. Mirrors the F# `Severity` DU (`Error` / `Warning`). */
export type Severity = 'error' | 'warning';

/**
 * A finding's location in source. `line` / `column` are 1-based (matching the
 * F# tier's FCS convention and editors' gutter numbering).
 */
export interface Location {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/**
 * One emitted rule result. `code` is a short stable id (e.g. `"FUARAN001"`)
 * so an AI consumer can pattern-match on the failure class; `message` is
 * human-readable. `availableFields` / `suggestion` are the §4d AI-recovery
 * fields — populated when the finding is something a re-emission could fix
 * (unresolved query name → list of registered names + best-guess
 * suggestion), `undefined` otherwise.
 */
export interface Finding {
  readonly severity: Severity;
  readonly code: string;
  readonly location: Location;
  readonly message: string;
  readonly availableFields?: readonly string[];
  readonly suggestion?: string;
}

/** Construct a finding without AI-recovery fields (the common case). */
export function create(
  severity: Severity,
  code: string,
  location: Location,
  message: string,
): Finding {
  return { severity, code, location, message };
}

/** Attach the §4d AI-recovery fields to a finding. */
export function withRecovery(
  available: readonly string[],
  suggestion: string | undefined,
  finding: Finding,
): Finding {
  return suggestion !== undefined
    ? { ...finding, availableFields: available, suggestion }
    : { ...finding, availableFields: available };
}

export function isError(finding: Finding): boolean {
  return finding.severity === 'error';
}

/**
 * The §4d AI-recovery JSON shape (snake_case keys), byte-compatible with the
 * F# `ErrorRender.toJson` output documented in `VALIDATOR-MANIFEST.md`.
 * `available_fields` / `suggestion` are present only when populated.
 */
export interface FindingJson {
  readonly severity: Severity;
  readonly code: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly available_fields?: readonly string[];
  readonly suggestion?: string;
}

export function renderFindingJson(finding: Finding): FindingJson {
  const base: FindingJson = {
    severity: finding.severity,
    code: finding.code,
    file: finding.location.file,
    line: finding.location.line,
    column: finding.location.column,
    message: finding.message,
  };
  const withFields =
    finding.availableFields !== undefined
      ? { ...base, available_fields: finding.availableFields }
      : base;
  return finding.suggestion !== undefined
    ? { ...withFields, suggestion: finding.suggestion }
    : withFields;
}

/** Plain one-line rendering for the CLI's default (`--format plain`) output. */
export function renderFindingPlain(finding: Finding): string {
  const sev = finding.severity === 'error' ? 'error' : 'warning';
  const { file, line, column } = finding.location;
  const tail = finding.suggestion !== undefined ? ` (suggestion: ${finding.suggestion})` : '';
  return `${file}(${line},${column}): ${sev} ${finding.code}: ${finding.message}${tail}`;
}
