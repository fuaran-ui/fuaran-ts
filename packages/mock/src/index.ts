// @fuaran-ui/mock — a local, offline stand-in for the Fuaran generation endpoint.
//
// Serves the same TurnRequest → TurnResult contract but returns canonical trees
// from the bundled conformance corpus by prompt match — deterministic, offline,
// and free (no access token, no BYOK key). Build + test an SDK integration loop
// against it, then swap to the real endpoint with a single base-URL change.

export {
  handleTurn,
  handleTurnBody,
  MOCK_SURFACE_VERSION,
  type MockTurnRequest,
  type MockReply,
} from './handler.js';

export {
  createMockServer,
  startMockServer,
  DEFAULT_MOCK_PORT,
  type MockServerOptions,
} from './server.js';

export {
  FIXTURES,
  PLACEHOLDER_TREE_JSON,
  REPAIR_OP_JSON,
  matchTree,
  type MockFixture,
} from './fixtures.js';
