// @fuaran-ui/react — the React adapter over the Fuaran generation endpoint.
//
// Canonical use:
//   const client = useMemo(() => new FuaranClient({ endpoint: '/api/fuaran' }), []);
//   const state  = useFuaranGenerate({ client });
//   return <FuaranGenerated state={state} />;
//
// The hook owns the current tree, so the turn-loop (first prompt generates,
// every later prompt repairs) is automatic; `repair` runs the closed
// hint-threading loop. Rendering goes through `@fuaran-ui/renderer` — import its
// stylesheet once in your app entry: `import '@fuaran-ui/renderer/css'`.

export {
  useFuaranGenerate,
  type FuaranGenerateStatus,
  type FuaranTurnError,
  type FuaranTurnOptions,
  type UseFuaranGenerateOptions,
  type UseFuaranGenerateResult,
} from './useFuaranGenerate.js';

export {
  FuaranGenerated,
  describeTurnError,
  type FuaranGeneratedProps,
} from './FuaranGenerated.js';

// Phase 1546 — this adapter holds no raw-HTML sink of its own; every one it can
// reach belongs to `@fuaran-ui/renderer`, which mints through the
// `fuaran-renderer` Trusted Types policy. The name is re-exported here so an app
// wiring its CSP from this package alone has the string it must pin:
//
//   Content-Security-Policy: require-trusted-types-for 'script';
//                            trusted-types fuaran-renderer
export { TRUSTED_TYPES_POLICY_NAME } from '@fuaran-ui/renderer';
