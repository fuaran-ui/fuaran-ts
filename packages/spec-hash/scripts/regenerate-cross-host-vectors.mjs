#!/usr/bin/env node
// ============================================================================
//  Adopt a freshly-emitted cross-host vector file.
//
//    node scripts/regenerate-cross-host-vectors.mjs <path-to-emitted-file>
//
//  The file is produced by an INDEPENDENT implementation of
//  `canonical-json-sha256-v1` in another language — see scripts/README.md for
//  the emitting command. This script does not produce it and must never be able
//  to: a "regeneration" that ran this package's own implementation would replace
//  a cross-host gate with a tautology, and every subsequent green run would mean
//  nothing.
//
//  So the checks below are all about SHAPE and PROVENANCE — is this a plausible
//  emission of the rule this package implements — and deliberately say nothing
//  about whether the expectations agree with us. That question belongs to
//  `test/cross-host.test.ts`, where a disagreement is a red test rather than a
//  silently-rejected copy.
// ============================================================================

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const destination = join(here, '..', 'test', 'vectors', 'cross-host-vectors.json');

const ALGORITHM_ID = 'canonical-json-sha256-v1';
const REFUSALS = new Set([
  'not-json',
  'duplicate-members',
  'number-not-representable',
  'ill-formed-unicode',
]);

const die = (message) => {
  console.error(`refusing to adopt the emitted file: ${message}`);
  process.exit(1);
};

const source = process.argv[2];
if (!source)
  die('no source path given. Usage: regenerate-cross-host-vectors.mjs <path-to-emitted-file>');
const sourcePath = resolve(source);
if (!existsSync(sourcePath)) die(`'${sourcePath}' does not exist`);

let file;
try {
  file = JSON.parse(readFileSync(sourcePath, 'utf8'));
} catch (error) {
  die(`'${sourcePath}' is not JSON: ${error.message}`);
}

if (file.algorithm !== ALGORITHM_ID) die(`it declares '${file.algorithm}', not '${ALGORITHM_ID}'`);
if (typeof file.note !== 'string' || !file.note.includes('GENERATED')) {
  die('it carries no provenance note marking it generated');
}
if (!Array.isArray(file.vectors) || !Array.isArray(file.refusals))
  die('it carries no vectors/refusals arrays');
if (file.vectors.length !== file.vectorCount)
  die(`vectorCount ${file.vectorCount} != ${file.vectors.length} vectors`);
if (file.refusals.length !== file.refusalCount) {
  die(`refusalCount ${file.refusalCount} != ${file.refusals.length} refusals`);
}
if (file.vectors.length === 0 || file.refusals.length === 0)
  die('an empty population would make the gate vacuous');

const ids = new Set();
for (const v of file.vectors) {
  if (typeof v.id !== 'string' || ids.has(v.id))
    die(`a vector has a missing or duplicate id: ${String(v.id)}`);
  ids.add(v.id);
  for (const field of ['rendered', 'canonical', 'digest']) {
    if (typeof v[field] !== 'string') die(`${v.id}: '${field}' is not a string`);
  }
  if (v.renderedPermuted !== null && typeof v.renderedPermuted !== 'string') {
    die(`${v.id}: 'renderedPermuted' is neither a string nor null`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(v.digest))
    die(`${v.id}: '${v.digest}' is not a lowercase sha256 content address`);
}
for (const r of file.refusals) {
  if (typeof r.id !== 'string' || ids.has(r.id))
    die(`a refusal has a missing or duplicate id: ${String(r.id)}`);
  ids.add(r.id);
  if (typeof r.rendered !== 'string') die(`${r.id}: 'rendered' is not a string`);
  if (!REFUSALS.has(r.refusal))
    die(`${r.id}: '${String(r.refusal)}' is not one of the rule's refusal names`);
}

if (existsSync(destination)) {
  const previous = JSON.parse(readFileSync(destination, 'utf8'));
  if (previous.vectorCount > file.vectorCount || previous.refusalCount > file.refusalCount) {
    // Shrinking is legitimate, but it weakens the gate without failing it — so it
    // is a thing a human says out loud rather than a thing a script does quietly.
    die(
      `the emitted file is SMALLER than the committed one (${String(previous.vectorCount)}/${String(
        previous.refusalCount,
      )} → ${String(file.vectorCount)}/${String(file.refusalCount)}). If that is intended, delete the ` +
        'committed file first and say why in the commit message.',
    );
  }
}

copyFileSync(sourcePath, destination);
console.log(
  `adopted ${String(file.vectorCount)} vectors + ${String(file.refusalCount)} refusals into ${destination}\n` +
    'Now run `pnpm test` in this package. A divergence here is a genuine cross-host disagreement about a\n' +
    'registered algorithm — resolve it against the specification, never by editing the expectations.',
);
