// fuaran — the CLI executable. A thin wrapper over the shared `run` core.

import { run } from './run.js';

const { code, out } = await run(process.argv.slice(2));
process.stdout.write(out);
process.exit(code);
