// ============================================================================
//  Sync the bundled corpus snapshot from the authoritative workspace corpus.
//
//  The authoritative corpus lives in the workspace repo at
//  ../wire-format-fixtures (relative to this repo's root — the canonical
//  side-by-side workspace layout). This script clean-copies the certification
//  payload set (manifest.json, schema.json, nodes/, ops/, reject/, lenient/)
//  into this package's corpus/ directory; the conformance/ tooling
//  subdirectory of the authority is intentionally NOT copied (it is the
//  in-house cross-host gate, not part of the published kit).
//
//  Run after any corpus regeneration (fuaran's --emit-corpus), then commit the
//  snapshot with the package. test/corpus-sync.test.ts fails the build if the
//  snapshot drifts from the authority.
// ============================================================================

import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
// packages/conformance → fuaran-ts → workspace root → wire-format-fixtures
const authority = join(packageRoot, '..', '..', '..', 'wire-format-fixtures');
const snapshot = join(packageRoot, 'corpus');

if (!existsSync(join(authority, 'manifest.json'))) {
  console.error(
    `Authoritative corpus not found at ${authority}\n` +
      `This script requires the canonical workspace layout (the workspace repo's ` +
      `wire-format-fixtures/ as a sibling of this fuaran-ts checkout).`,
  );
  process.exit(1);
}

rmSync(snapshot, { recursive: true, force: true });
mkdirSync(snapshot, { recursive: true });

copyFileSync(join(authority, 'manifest.json'), join(snapshot, 'manifest.json'));
copyFileSync(join(authority, 'schema.json'), join(snapshot, 'schema.json'));
for (const dir of ['nodes', 'ops', 'reject', 'lenient', 'envelope', 'elicitation']) {
  cpSync(join(authority, dir), join(snapshot, dir), { recursive: true });
}

console.log(`Corpus snapshot synced: ${authority} → ${snapshot}`);
