#!/usr/bin/env node
// README package-list drift check.
//
// The README's package tables are the first thing a reader meets, and for a
// monorepo that publishes twenty-one packages under one scope they are also the
// only place the SHIPPED SET is stated in prose. That makes drift here a
// distribution problem rather than a tidiness one: a package absent from the
// README is a package nobody looking at the repository knows exists, however
// well it is documented in its own directory.
//
// It had drifted exactly that way — four entries plus a sentence naming four
// more, against seventeen published packages — because there was nothing to
// notice. Adding a package to a workspace is a `packages/<name>/package.json`;
// nothing about that act touches the README, and nothing failed when it did not.
//
// The invariant, checked over every `packages/*/package.json`:
//
//   EVERY PUBLISHABLE PACKAGE IS NAMED SOMEWHERE IN README.md.
//
// "Publishable" means not `"private": true` — a workspace-internal package
// (the spec-hash reference implementation, the plugin bundle) ships to nobody,
// so a reader has no interest in it and the README correctly omits it.
//
// Three deliberate limits, said plainly rather than left to be discovered:
//
//   * It checks PRESENCE, not correctness. A package named in the README with a
//     wrong description passes; nothing offline can tell a stale role from a
//     current one.
//   * It checks the README ONLY, not CLAUDE.md or the per-package READMEs.
//     Those have their own readers and their own failure modes.
//   * It does not check the reverse direction — a README naming a package that
//     no longer exists. That is a real defect, but the same string may appear
//     legitimately in prose (a link, a migration note, a comparison), so the
//     check would be answering a question about intent from a substring match.
//     Deletion of a published package is rare and deliberate; drift by addition
//     is neither, which is why only that direction is automated.
//
// Run by the root `test` script, so it rides the ordinary gate.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = join(repoRoot, 'README.md');

if (!existsSync(readmePath)) {
  console.error('check-readme-packages: README.md not found at the repository root.');
  process.exit(1);
}

const readme = readFileSync(readmePath, 'utf8');
const packagesRoot = join(repoRoot, 'packages');

const publishable = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesRoot, entry.name, 'package.json'))
  .filter((path) => existsSync(path))
  .map((path) => JSON.parse(readFileSync(path, 'utf8')))
  .filter((pkg) => pkg.private !== true);

const missing = publishable.map((pkg) => pkg.name).filter((name) => !readme.includes(name));

if (missing.length > 0) {
  console.error(
    'check-readme-packages: package(s) this workspace publishes are not named in README.md:\n' +
      missing.map((n) => `  - ${n}`).join('\n') +
      '\n\nAdd a row to the package table. A published package the README does not mention is one\n' +
      'nobody reading the repository knows exists.',
  );
  process.exit(1);
}

console.log(
  `check-readme-packages: ${publishable.length} publishable package(s), all named in README.md.`,
);
