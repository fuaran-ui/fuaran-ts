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
