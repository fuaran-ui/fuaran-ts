// @fuaran-ui/client — a small, typed client over the Fuaran generation endpoint.
//
// Canonical import:
//   import { FuaranClient, FuaranSession } from '@fuaran-ui/client';
//
// Renderer glue (decode + mount) lives at the `@fuaran-ui/client/render`
// subpath, which pulls in React + `@fuaran-ui/renderer`; the core entry below
// is dependency-light so it also runs in a server-proxy (Node) context.
//
// The integration collapses to: construct the client, `generate`, render, and
// let the session helper carry the tree so the next prompt is a repair diff.

export {
  SURFACE_VERSION,
  isSurfaceVersionCompatible,
  type AppliedOp,
  type TurnStage,
  type RecoverableError,
  type Produced,
  type AccessDenied,
  type TurnFailed,
  type TurnResult,
  type GenerateArgs,
} from './contract.js';

export { FuaranClient, type FuaranClientConfig, type FetchLike } from './client.js';

export { FuaranSession, type FuaranSessionOptions, type SessionTurnOptions } from './session.js';

// The typed repair loop — thread a recoverable failure's hint into the next turn
// so an apply-rejected emission self-corrects, bounded by a caller-set retry cap.
export {
  HINT_MARKER,
  isRepairable,
  threadHint,
  generateWithRepair,
  type RepairOptions,
} from './repair.js';

// The wire mapping is exported for advanced hosts that drive their own
// transport (e.g. a custom proxy that re-serialises the body); most callers use
// `FuaranClient` and never touch it.
export { toWireBody, parseTurnResponse, type ResolvedSecrets } from './wire.js';
