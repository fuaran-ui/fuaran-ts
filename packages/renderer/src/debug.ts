// @fuaran-ui/renderer/debug — the in-page introspection REPL, `window.__fuaran`
// (DEBUG-only / unstable).
//
// `<FuaranRenderer debug>` registers the global itself, loading this surface by
// dynamic import. The builder and register helpers are exported here so a host
// can wire the global on its own terms (e.g. a non-renderer debug surface). They
// left the package root in Phase 2076 so that a production bundle, which never
// sets `debug`, does not carry them.

export {
  DEBUG_GLOBAL_KEY,
  DEBUG_GLOBAL_VERSION,
  buildDebugGlobal,
  readRegisteredDebugGlobal,
  registerDebugGlobal,
  type FuaranDebugGlobal,
  type DebugError,
  type NodeGeometry,
  type ApplyEnvelope,
  type DebugGlobalOptions,
  type BindingState,
  type BindingStateError,
  type BindingStatus,
  type TreeOpJson,
} from './debugGlobal.js';
