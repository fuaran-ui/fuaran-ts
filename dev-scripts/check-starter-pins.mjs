#!/usr/bin/env node
// Starter-template pin check.
//
// A starter under `templates/` is meant to be opened directly — copied out with
// degit, or imported into a browser sandbox straight from this repository's
// GitHub tree. Both routes run a plain `npm install` against the public
// registry with no workspace around them, so a `workspace:*` range there is not
// a link problem but a packaging one: it makes the directory uninstallable
// everywhere except inside this checkout.
//
// Two invariants, checked over every `templates/*/package.json`:
//
//   1. NO `workspace:` PROTOCOL in a starter's dependencies. This is the one
//      that breaks the sandbox outright.
//   2. EVERY `@fuaran-ui/*` RANGE TRACKS THE WORKSPACE VERSION of that package
//      — the declared range must be exactly `^<version>` as `packages/<pkg>`
//      declares it. Without this, bumping a package's minor leaves the starter
//      silently pinned to the previous line: it keeps installing and keeps
//      building, against packages the workspace has moved past, and nothing
//      says so.
//
// What this does NOT check, said plainly rather than left to be assumed: that
// the pinned version is PUBLISHED. The check is offline and deterministic by
// design, and a version bumped here but not yet released is a legitimate
// intermediate state — it is the release tag, not this script, that makes the
// pin obtainable from a sandbox.
//
// Run by the root `test` script, so it rides the ordinary gate.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const listPackageJsons = (dir) => {
  const root = join(repoRoot, dir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, 'package.json'))
    .filter((path) => existsSync(path));
};

// name -> version, for every package this workspace publishes.
const workspaceVersions = new Map(
  listPackageJsons('packages').map((path) => {
    const pkg = readJson(path);
    return [pkg.name, pkg.version];
  }),
);

const failures = [];

for (const path of listPackageJsons('templates')) {
  const pkg = readJson(path);
  const where = `templates/${pkg.name}`;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  for (const [name, range] of Object.entries(deps)) {
    if (typeof range === 'string' && range.startsWith('workspace:')) {
      failures.push(
        `${where}: "${name}": "${range}" — a starter must be installable outside this workspace. ` +
          `Pin the published version instead (see dev-scripts/check-starter-pins.mjs).`,
      );
      continue;
    }

    const workspaceVersion = workspaceVersions.get(name);
    if (workspaceVersion === undefined) continue;

    const expected = `^${workspaceVersion}`;
    if (range !== expected) {
      failures.push(
        `${where}: "${name}": "${range}" — the workspace is at ${workspaceVersion}. ` +
          `Set it to "${expected}" in the same change-set as the version bump ` +
          `(the pin is obtainable from a sandbox once that version is published).`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('Starter-template pin check FAILED:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('');
  process.exit(1);
}

console.log(`Starter-template pin check OK (${listPackageJsons('templates').length} template(s)).`);
