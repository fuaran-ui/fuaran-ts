#!/usr/bin/env node
// =============================================================================
//  Bundle-size measurement — the browser-artefact axis of the performance gate.
//
//  The perf gate had no browser-artefact axis at all: every metric it budgets is
//  a .NET wall-time or allocation number, while `@fuaran-ui/renderer` — the
//  surface a stranger actually downloads — shipped with no size budget of any
//  kind. This script is that axis's producer. It emits the same
//  `PERF_BASELINE_SCHEMA.md` envelope every other producer emits, so the gate
//  reads it with no new code path.
//
//  ── WHAT IS MEASURED (pin this, not just the number) ────────────────────────
//  A size is only comparable to another size taken the same way, so every
//  degree of freedom is fixed here rather than left to the caller:
//
//   * The INPUT is the committed production build — `pnpm build` at the repo
//     root, which for `@fuaran-ui/renderer` runs both tsup configs (the
//     ESM/CJS package build AND the minified standalone IIFE). No dev build, no
//     alternate mode, no partial filter.
//   * The FILE SET per metric is fixed and stated in `metrics` below. Source
//     maps and `.d.ts` declarations are excluded: neither reaches a browser.
//   * The COMPRESSION is gzip at LEVEL 9 with the default window, over each
//     file's own bytes, summed. Level is pinned because a different level is a
//     different number for identical bytes; per-file rather than over a
//     concatenation because per-file is what a server actually sends.
//   * An EMPTY file set is an ERROR, never a zero. A measurement taken before
//     the build has run would otherwise report a huge improvement and arm a
//     budget nothing can ever breach again.
//
//  ── USAGE ───────────────────────────────────────────────────────────────────
//    node dev-scripts/measure-bundle-size.mjs               # refresh the baseline
//    node dev-scripts/measure-bundle-size.mjs --out cur.json # a CURRENT measurement
//    node dev-scripts/measure-bundle-size.mjs --emit-template # the pending template
//    node dev-scripts/measure-bundle-size.mjs --check         # measure + diff vs baseline
//
//  Exit 0 on success, 1 when a declared file set was empty (or `--check` found a
//  difference), 2 on a usage / IO error.
// =============================================================================

import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const defaultOut = join(here, 'bundle-size-baseline.json');

/** The gzip level every measurement uses. Pinned: a different level is a different number. */
const GZIP_LEVEL = 9;

/**
 * The declared metric catalogue. Each entry names a metric id, the directory it
 * measures, and the exact predicate that decides membership of the file set.
 * Adding a metric here is a contract change on the gate side too — the budget
 * table's `bundle.` prefix rule covers it, but the baseline must be recaptured.
 */
const metrics = [
  {
    id: 'bundle.renderer.esm.gzip_b',
    dir: 'packages/renderer/dist',
    accept: (f) => f.endsWith('.js') && !f.endsWith('.map'),
    note: 'Gzipped bytes of the ESM package build (dist/*.js, entries + shared chunks; maps and .d.ts excluded).',
  },
  {
    id: 'bundle.renderer.cjs.gzip_b',
    dir: 'packages/renderer/dist',
    accept: (f) => f.endsWith('.cjs') && !f.endsWith('.map'),
    note: 'Gzipped bytes of the CommonJS package build (dist/*.cjs).',
  },
  {
    id: 'bundle.renderer.standalone.gzip_b',
    dir: 'packages/renderer/standalone',
    accept: (f) => f.endsWith('.js') && !f.endsWith('.map'),
    note: 'Gzipped bytes of the minified self-contained IIFE bundle — React and the decoder bundled in. The single artefact a browser consumer downloads.',
  },
  {
    id: 'bundle.renderer_server.esm.gzip_b',
    dir: 'packages/renderer-server/dist',
    accept: (f) => f.endsWith('.js') && !f.endsWith('.map'),
    note: 'Gzipped bytes of the server renderer ESM build (dist/*.js).',
  },
  {
    id: 'bundle.renderer_server.cjs.gzip_b',
    dir: 'packages/renderer-server/dist',
    accept: (f) => f.endsWith('.cjs') && !f.endsWith('.map'),
    note: 'Gzipped bytes of the server renderer CommonJS build (dist/*.cjs).',
  },
];

/** Files matching `accept`, sorted, so the reported set is order-stable. */
function fileSet(metric) {
  const dir = join(repoRoot, metric.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter(metric.accept)
    .sort()
    .map((f) => join(dir, f));
}

/** Summed gzip size, at the pinned level, of each file's own bytes. */
function measure(metric) {
  const files = fileSet(metric);
  if (files.length === 0) return { value: null, files: [] };
  let total = 0;
  for (const f of files) total += gzipSync(readFileSync(f), { level: GZIP_LEVEL }).length;
  return {
    value: total,
    files: files.map((f) => f.slice(repoRoot.length + 1).replaceAll('\\', '/')),
  };
}

/** The producer half of the shared baseline envelope. */
function envelope(status, capturedAtUtc, runtime, entries) {
  return {
    schema_version: 1,
    artifact: 'bundle-size',
    status,
    captured_at_utc: capturedAtUtc,
    runtime,
    metrics: entries,
  };
}

/**
 * A bundle size is a property of the BUILD, not of the machine — the same
 * sources produce the same bytes on any host — so this artifact's `runtime` is
 * recorded for provenance and the gate's host-comparability rule deliberately
 * does not withhold a `B`-unit metric on a host mismatch. Recording the toolchain
 * is what matters: a tsup or esbuild upgrade legitimately moves these numbers.
 */
function runtimeInfo() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const tsup = pkg.devDependencies?.tsup ?? 'unknown';
  return {
    dotnet: `node ${process.version}; tsup ${tsup}`,
    os: `${os.type()} ${os.release()}`,
    cpu: 'host-independent (gzip over committed build output)',
  };
}

function pendingTemplate() {
  return envelope(
    'pending',
    '',
    { dotnet: '', os: '', cpu: '' },
    metrics.map((m) => ({ id: m.id, value: null, unit: 'B', note: m.note })),
  );
}

function capture() {
  const results = metrics.map((m) => ({ metric: m, ...measure(m) }));
  const empty = results.filter((r) => r.value === null);
  const entries = results.map((r) => ({
    id: r.metric.id,
    value: r.value,
    unit: 'B',
    note: r.note ?? r.metric.note,
    files: r.files,
  }));
  const complete = empty.length === 0;
  const artifact = envelope(
    complete ? 'captured' : 'pending',
    complete ? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') : '',
    runtimeInfo(),
    entries,
  );
  return { artifact, empty };
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 && argv[outIdx + 1] ? resolve(argv[outIdx + 1]) : defaultOut;

  if (flags.has('--emit-template')) {
    writeFileSync(out, JSON.stringify(pendingTemplate(), null, 2) + '\n');
    console.log(`Wrote pending bundle-size template: ${out}`);
    return 0;
  }

  const { artifact, empty } = capture();

  if (flags.has('--check')) {
    if (!existsSync(defaultOut)) {
      console.error(`no committed baseline at ${defaultOut} — run without --check first.`);
      return 2;
    }
    const base = JSON.parse(readFileSync(defaultOut, 'utf8'));
    let differed = false;
    for (const m of artifact.metrics) {
      const b = base.metrics.find((x) => x.id === m.id);
      const before = b?.value ?? null;
      const delta = before && m.value ? ((m.value - before) / before) * 100 : NaN;
      const mark = before === m.value ? '=' : '≠';
      if (before !== m.value) differed = true;
      console.log(
        `  ${mark} ${m.id.padEnd(38)} ${String(before).padStart(8)} → ${String(m.value).padStart(8)} B  ${
          Number.isNaN(delta) ? '' : `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`
        }`,
      );
    }
    return differed ? 1 : 0;
  }

  writeFileSync(out, JSON.stringify(artifact, null, 2) + '\n');
  console.log(`Wrote bundle-size baseline (${artifact.status}): ${out}`);
  for (const m of artifact.metrics) {
    console.log(
      `  ${m.id.padEnd(38)} ${String(m.value).padStart(8)} B  (${m.files.length} file(s))`,
    );
  }
  if (empty.length > 0) {
    console.error(
      `\n${empty.length} metric(s) measured an EMPTY file set — has \`pnpm build\` run? An empty set is an error, never a zero:`,
    );
    for (const e of empty) console.error(`  · ${e.metric.id} — ${e.metric.dir}`);
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
