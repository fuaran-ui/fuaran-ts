// fuaran_validate — wire JSON → pass/fail + diagnostics.
//
// Decodes the payload through the same canonical-JSON codec every conformant
// host trusts (`@fuaran-ui/ops` `decodeNode` / `decodeOp`), so "valid" here
// means exactly what it means to the renderer and the apply engine. A failure
// carries the stable six-code `DecodeError` surface (code + `$`-rooted dotted
// path + message + expected shape) — designed for AI self-repair.

import { decodeNode, decodeOp, type DecodeError } from '@fuaran-ui/ops';

export interface ValidateArgs {
  /** The wire JSON to validate. */
  readonly json: string;
  /** What the payload claims to be: a `Node` tree (default) or a `TreeOp`. */
  readonly kind?: 'node' | 'op' | undefined;
}

export interface ValidateResult {
  readonly valid: boolean;
  readonly kind: 'node' | 'op';
  /** Empty when valid; otherwise the decode diagnostics (first failure — the
   *  decoder is fail-fast, matching the canonical codec's contract). */
  readonly diagnostics: readonly DecodeError[];
}

export function runValidate(args: ValidateArgs): ValidateResult {
  const kind = args.kind ?? 'node';
  const decoded = kind === 'op' ? decodeOp(args.json) : decodeNode(args.json);
  return decoded.ok
    ? { valid: true, kind, diagnostics: [] }
    : { valid: false, kind, diagnostics: [decoded.error] };
}
