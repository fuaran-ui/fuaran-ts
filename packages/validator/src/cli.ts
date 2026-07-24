#!/usr/bin/env node
// @fuaran-ui/validator — CLI bin shim. The parse/walk/report logic lives in
// `cliCore.ts` (`runCli`, pure + testable); this shim wires it to the real
// process streams and exit code.

import { runCli } from './cliCore.js';

process.exit(
  runCli(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  }),
);
