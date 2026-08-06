// ============================================================================
//  `canonical-json-sha256-v1` — the public surface.
//
//  The rule itself is in `./canonical.js` and is platform-free; the only thing
//  this file adds is a SHA-256, taken from Node's `crypto` rather than
//  hand-rolled. `mintWith` remains exported for a host that has its own digest
//  (a browser's async WebCrypto, a native binding), so the binding here is a
//  convenience and never a constraint.
// ============================================================================

import { createHash } from 'node:crypto';

import { mintWith, type MintOutcome } from './canonical.js';

export {
  ALGORITHM_ID,
  canonicalise,
  describeRefusal,
  escapeString,
  formatNumber,
  isWellFormedUnicode,
  mintWith,
  type MintOutcome,
  type MintRefusal,
} from './canonical.js';

export { parseJson, type JsonMember, type JsonValue } from './json.js';

/** SHA-256 over the UTF-8 bytes of `text`, as lowercase hex with no prefix. */
export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Mint a content address from a rendering: canonicalise it, then SHA-256 the
 * resulting bytes and form `sha256:{lowercase hex}`.
 *
 * The algorithm is named INSIDE the value so that a future digest change is a visible
 * discontinuity rather than a silent one.
 */
export const mint = (rendered: string): MintOutcome<string> => mintWith(sha256Hex, rendered);
