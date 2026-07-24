// @fuaran-ui/mcp — MCP server exposing Fuaran to coding agents.
//
// Canonical use is the `fuaran-mcp` executable (see the README for the
// one-line install into Claude Code or any MCP client). This module surface
// exists for hosts that embed the server programmatically and for tests.

export { createFuaranMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';
export type { CreateServerOptions } from './server.js';

export {
  readConfigFromEnv,
  redactSecrets,
  ENV_ENDPOINT,
  ENV_ACCESS_TOKEN,
  ENV_PROVIDER_KEY,
  type FuaranMcpConfig,
} from './config.js';

export { runValidate, type ValidateArgs, type ValidateResult } from './tools/validate.js';
export {
  runAsk,
  buildAnswerPage,
  coerceAnswer,
  resolveOutcome,
  startElicitationServer,
  type AskArgs,
  type AskResult,
  type ElicitationServerHandle,
} from './tools/ask.js';
export {
  runRecipe,
  listRecipes,
  type RecipeArgs,
  type RecipeResult,
  type RecipeSummary,
} from './tools/recipe.js';
export { runGenerate, type GenerateToolArgs, type GenerateToolResult } from './tools/generate.js';
export {
  runScaffold,
  type ScaffoldArgs,
  type ScaffoldResult,
  type ScaffoldFile,
  type ScaffoldTarget,
  type ScaffoldPattern,
} from './tools/scaffold.js';
export type { RecipeEntry } from './recipeTypes.js';
