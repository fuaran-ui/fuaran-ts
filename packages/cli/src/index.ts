// @fuaran-ui/cli — the shell CLI over the Fuaran public surfaces.
//
// `fuaran generate | validate | recipe | scaffold`. The `run` core is exported
// for embedding and testing; the `fuaran` bin is a thin wrapper over it.

export { run, type RunResult } from './run.js';
