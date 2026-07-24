#!/usr/bin/env node
// check-drift.mjs — the freshness check that keeps the agent-facing docs from rotting.
//
// The docs here carry runnable code. This script is how we guarantee that code still
// works against the CURRENT @fuaran-ui/client SDK — not the SDK as it was the day the
// prose was written. Run it from anywhere:
//
//     node docs/check-drift.mjs
//
// It does two things, both driven by inline markers in the Markdown so the docs stay
// the single source of truth (there is no second copy of the code to keep in sync):
//
//   1. Compile check. Every fenced code block preceded by `<!-- drift-check:compile -->`
//      is extracted to docs/.drift/*.ts and type-checked against the built client types
//      (see tsconfig.drift.json). A renamed / removed / re-typed SDK export makes the
//      snippet stop compiling and this check fails — exactly the drift we want to catch.
//
//   2. Symbol check. Every `<!-- drift-check:symbols <module> <name...> -->` marker
//      asserts each named export still exists in that module's built .d.ts. This covers
//      snippets we show but do not compile (e.g. the React render glue, which would drag
//      in DOM/React types the compile leg deliberately keeps out).
//
// Prerequisite: the client package is built (`pnpm --filter @fuaran-ui/client build`),
// so packages/client/dist/*.d.ts exist. `pnpm build` at the repo root does this.

import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(docsDir, '..');
const driftDir = join(docsDir, '.drift');

/** Built .d.ts for each module we drift-check imports against. */
const MODULE_DTS = {
  '@fuaran-ui/client': join(repoRoot, 'packages/client/dist/index.d.ts'),
  '@fuaran-ui/client/render': join(repoRoot, 'packages/client/dist/render.d.ts'),
};

const errors = [];

/** Every .md file in docs/ (non-recursive — the docs are flat). */
function docFiles() {
  return readdirSync(docsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(docsDir, f));
}

/** Pull `<!-- drift-check:<kind> <args> -->` markers immediately followed by a fenced
 *  code block out of a Markdown source. Returns { kind, args, code, doc }. */
function markers(mdPath) {
  const text = readFileSync(mdPath, 'utf8');
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^<!--\s*drift-check:(\w+)\s*(.*?)\s*-->\s*$/);
    if (!m) continue;
    // The next non-blank line must open a fenced block.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    const fence = lines[j]?.match(/^```(\w*)\s*$/);
    if (!fence) {
      errors.push(`${relative(repoRoot, mdPath)}: drift-check marker not followed by a code fence`);
      continue;
    }
    const code = [];
    let k = j + 1;
    for (; k < lines.length && !/^```\s*$/.test(lines[k]); k++) code.push(lines[k]);
    found.push({ kind: m[1], args: m[2].trim(), code: code.join('\n'), doc: mdPath });
  }
  return found;
}

/** Exported identifier names declared in a built .d.ts. */
function exportedNames(dtsPath) {
  const text = readFileSync(dtsPath, 'utf8');
  const names = new Set();
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (let part of m[1].split(',')) {
      part = part.trim().replace(/^type\s+/, '');
      if (!part) continue;
      const asMatch = part.match(/\bas\s+(\w+)$/);
      names.add(asMatch ? asMatch[1] : part.split(/\s+/)[0]);
    }
  }
  for (const m of text.matchAll(
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+(\w+)/g,
  )) {
    names.add(m[1]);
  }
  return names;
}

// --- Collect markers across every doc ---------------------------------------
const allMarkers = docFiles().flatMap(markers);
const compileBlocks = allMarkers.filter((x) => x.kind === 'compile');
const symbolChecks = allMarkers.filter((x) => x.kind === 'symbols');

// --- 1. Symbol checks (cheap; run first) ------------------------------------
for (const s of symbolChecks) {
  const [mod, ...want] = s.args.split(/\s+/);
  const dts = MODULE_DTS[mod];
  if (!dts || !existsSync(dts)) {
    errors.push(
      `${relative(repoRoot, s.doc)}: symbols marker names unknown/unbuilt module "${mod}"` +
        ` (build the client: pnpm --filter @fuaran-ui/client build)`,
    );
    continue;
  }
  const have = exportedNames(dts);
  for (const name of want) {
    if (!have.has(name)) {
      errors.push(
        `${relative(repoRoot, s.doc)}: doc references "${name}" from ${mod}, but it is no longer` +
          ` exported — the SDK surface drifted. Update the doc or restore the export.`,
      );
    }
  }
}

// --- 2. Compile checks ------------------------------------------------------
if (compileBlocks.length > 0) {
  const missingDts = Object.values(MODULE_DTS).filter((p) => !existsSync(p));
  if (missingDts.length > 0) {
    errors.push(
      'client types are not built — run `pnpm --filter @fuaran-ui/client build` first' +
        ` (missing: ${missingDts.map((p) => relative(repoRoot, p)).join(', ')})`,
    );
  } else {
    rmSync(driftDir, { recursive: true, force: true });
    mkdirSync(driftDir, { recursive: true });
    compileBlocks.forEach((b, idx) => {
      const label = `${b.args || 'block'}-${idx}`.replace(/[^\w.-]/g, '_');
      writeFileSync(join(driftDir, `${label}.ts`), `${b.code}\n`, 'utf8');
    });
    const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    const res = spawnSync(process.execPath, [tsc, '--noEmit', '-p', 'docs/tsconfig.drift.json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      errors.push(
        'a compile-marked doc snippet no longer type-checks against the current @fuaran-ui/client:\n' +
          `${(res.stdout || '') + (res.stderr || '')}`.trim(),
      );
    }
    rmSync(driftDir, { recursive: true, force: true });
  }
}

// --- Report -----------------------------------------------------------------
if (errors.length > 0) {
  console.error('✗ docs drift check FAILED:\n');
  for (const e of errors) console.error(`  • ${e}\n`);
  process.exit(1);
}
console.log(
  `✓ docs drift check passed — ${compileBlocks.length} compile block(s), ` +
    `${symbolChecks.length} symbol marker(s) validated against the built SDK.`,
);
