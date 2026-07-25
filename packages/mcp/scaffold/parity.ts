// Scaffold parity — the reference contract both targets must satisfy.
//
// The MCP `scaffold` tool emits integration boilerplate for `ts-react` and
// `fsharp-fable`. Parity is a tested guarantee, not an aspiration: each target's
// emission must wire its SDK + renderer, run the turn-loop, and keep secrets out
// of the client — and the two SDK legs the scaffolds wire must produce the SAME
// canonical tree for the same turn (proven in scaffold-parity.test.ts against the
// local mock). This module owns the structural half of that contract.

import { runScaffold, type ScaffoldResult, type ScaffoldTarget } from '../src/index.js';

/** Substrings each target's emission must contain — the endpoint call, the
 *  canonical decode, and the renderer.
 *
 *  ts-react wires the browser-capable `@fuaran-ui/client` SDK. The F#/Fable
 *  scaffold speaks the one wire contract DIRECTLY (a `fetch` to the proxy +
 *  `Fuaran.UI.Ops` canonical decode + `Fuaran.UI.Renderer`), because the .NET
 *  `Fuaran.UI.Client` SDK is a server/desktop tier and does not run in the
 *  browser — the browser F# host is the wire contract, not the .NET client. Both
 *  legs produce the same canonical tree (the behavioral-parity test proves it). */
export const REQUIRED_REFS: Record<ScaffoldTarget, readonly string[]> = {
  'ts-react': ['@fuaran-ui/client', '@fuaran-ui/renderer'],
  'fsharp-fable': ['Fuaran.UI.Ops', 'Fuaran.UI.Renderer'],
};

/** The concatenated text of every emitted file for a target. */
export function emittedText(result: ScaffoldResult): string {
  return result.files.map((f) => f.contents).join('\n');
}

/** Substrings each target's emission must NOT contain.
 *
 *  The F#/Fable panel is a BROWSER artefact, so it must never reference the
 *  `Fuaran.UI.Client` package: that tier is plain .NET (it opens
 *  `System.Net.Http`) and is deliberately not source-packed for Fable, so an
 *  emission naming it is broken on arrival. `Fuaran.UI.Client` belongs on the
 *  SERVER side of the proxy. Empty for `ts-react`, whose client SDK is
 *  browser-capable by design. */
export const FORBIDDEN_REFS: Record<ScaffoldTarget, readonly string[]> = {
  'ts-react': [],
  'fsharp-fable': ['Fuaran.UI.Client', 'FuaranClient', 'FuaranSession'],
};

/** A structural parity report for one target: does it wire the required
 *  surfaces, avoid the forbidden ones, and stay free of a secret literal? */
export interface ParityReport {
  readonly target: ScaffoldTarget;
  readonly missingRefs: readonly string[];
  readonly forbiddenRefs: readonly string[];
  readonly hasSecretLiteral: boolean;
}

/** Check a target's scaffold against the structural parity contract. */
export function checkScaffold(target: ScaffoldTarget): ParityReport {
  const result = runScaffold({ target });
  const text = emittedText(result);
  const missingRefs = REQUIRED_REFS[target].filter((ref) => !text.includes(ref));
  const forbiddenRefs = FORBIDDEN_REFS[target].filter((ref) => text.includes(ref));
  // A committed BYOK key would look like `sk-...`; the server-proxied default
  // must never bundle one.
  const hasSecretLiteral = /sk-[A-Za-z0-9]{8}/.test(text);
  return { target, missingRefs, forbiddenRefs, hasSecretLiteral };
}

/** Every target the scaffold tool must emit — the parity check iterates these. */
export const TARGETS: readonly ScaffoldTarget[] = ['ts-react', 'fsharp-fable'];
