#!/usr/bin/env node
// ============================================================================
//  @fuaran-ui/conformance — CLI.
//
//    fuaran-conformance <adapter-module> [--corpus <dir>] [--json <file>]
//
//  <adapter-module> is a path to a JS/TS-compiled module that exports the
//  candidate implementation:
//
//    export const adapter = { decodeNode, encodeNode, decodeOp, encodeOp };
//    export const implementation = { name: 'my-host', version: '1.2.3' };
//
//  (or the same two fields on the default export). Prints the human-readable
//  report; `--json` additionally writes the structured report. Exit codes:
//  0 = conformant, 2 = partially-conformant, 1 = non-conformant or usage error.
// ============================================================================

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ConformanceAdapter, ImplementationInfo } from './adapter.js';
import { formatReport } from './report.js';
import { runConformance } from './run.js';

interface AdapterModule {
  readonly adapter?: ConformanceAdapter;
  readonly implementation?: ImplementationInfo;
  readonly default?: {
    readonly adapter?: ConformanceAdapter;
    readonly implementation?: ImplementationInfo;
  };
}

const usage = (): never => {
  console.error(
    'Usage: fuaran-conformance <adapter-module> [--corpus <dir>] [--json <file>]\n\n' +
      '  <adapter-module>  module exporting `adapter` (decode/encode hooks) and\n' +
      '                    `implementation` ({ name, version? })\n' +
      '  --corpus <dir>    certify against an external corpus checkout instead of\n' +
      '                    the snapshot bundled with this package\n' +
      '  --json <file>     also write the structured report as JSON\n',
  );
  process.exit(1);
};

const args = process.argv.slice(2);
let modulePath: string | undefined;
let corpusRoot: string | undefined;
let jsonOut: string | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--corpus') corpusRoot = args[++i] ?? usage();
  else if (arg === '--json') jsonOut = args[++i] ?? usage();
  else if (modulePath === undefined && arg !== undefined && !arg.startsWith('--')) {
    modulePath = arg;
  } else usage();
}
if (modulePath === undefined) usage();

const loaded = (await import(pathToFileURL(resolve(modulePath as string)).href)) as AdapterModule;
const adapter = loaded.adapter ?? loaded.default?.adapter;
const implementation = loaded.implementation ?? loaded.default?.implementation;
if (adapter === undefined || implementation === undefined) {
  console.error(
    `The adapter module must export \`adapter\` and \`implementation\` ` +
      `(named or on the default export). Loaded: ${modulePath}`,
  );
  process.exit(1);
}

const report = runConformance(adapter, {
  implementation,
  ...(corpusRoot === undefined ? {} : { corpusRoot }),
});

console.log(formatReport(report));
if (jsonOut !== undefined) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nStructured report written to ${jsonOut}`);
}

process.exit(
  report.verdict === 'conformant' ? 0 : report.verdict === 'partially-conformant' ? 2 : 1,
);
