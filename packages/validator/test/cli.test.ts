// ============================================================================
//  @fuaran-ui/validator — API + CLI integration tests.
//
//  Exercises the on-disk path: manifest discovery, FUARAN900 absence warning,
//  the §4d JSON render shape, and the CLI core's exit-code contract (0 clean /
//  1 violation / 2 usage) + glob resolution, all against fixtures written to a
//  temp directory.
// ============================================================================

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateProject, renderFindingJson } from '../src/index.js';
import { runCli, type CliIO } from '../src/cliCore.js';

let dir: string;
let srcFile: string;
const manifestJson = `{
  // hand-written contract — trailing comma + comment tolerance is part of the format
  "queries": ["totalRevenue"],
  "msgCases": ["LoadData"],
}`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fuaran-validator-'));
  srcFile = join(dir, 'module.ts');
  writeFileSync(
    srcFile,
    `fuaran.dashboard({ id: 'root', children: [
       fuaran.metric({ id: 'rev', value: binding.query('totalRevneu', (r: any) => r.total) }),
       fuaran.link({ id: 'l', href: '', label: 'Home' }),
     ]});`,
    'utf8',
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function capture(): { io: CliIO; out: () => string; err: () => string } {
  let outBuf = '';
  let errBuf = '';
  return {
    io: { out: (t) => (outBuf += t), err: (t) => (errBuf += t) },
    out: () => outBuf,
    err: () => errBuf,
  };
}

describe('validateProject — on-disk manifest discovery', () => {
  it('discovers the sibling manifest and resolves FUARAN010 against it', () => {
    writeFileSync(join(dir, 'fuaran-validator.manifest.json'), manifestJson, 'utf8');
    const result = validateProject({ files: [srcFile], projectDir: dir });
    expect(result.manifestLoaded).toBe(true);
    expect(result.manifestPath).toBe(join(dir, 'fuaran-validator.manifest.json'));
    expect(result.filesWalked).toBe(1);
    const fuaran010 = result.findings.find((f) => f.code === 'FUARAN010');
    expect(fuaran010?.suggestion).toBe('totalRevenue');
    // The blank href warning fires regardless of manifest.
    expect(result.findings.map((f) => f.code)).toContain('FUARAN063');
    // Manifest present ⇒ no FUARAN900.
    expect(result.findings.map((f) => f.code)).not.toContain('FUARAN900');
  });

  it('emits FUARAN900 + silences schema checks when no manifest is found', () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'fuaran-validator-bare-'));
    try {
      const file = join(bareDir, 'm.ts');
      writeFileSync(file, `const b = binding.query('whatever', (r: any) => r.x);`, 'utf8');
      const result = validateProject({ files: [file], projectDir: bareDir });
      expect(result.manifestLoaded).toBe(false);
      const cs = result.findings.map((f) => f.code);
      expect(cs).toContain('FUARAN900');
      expect(cs).not.toContain('FUARAN010');
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it('renders the §4d JSON shape with snake_case available_fields', () => {
    const result = validateProject({ files: [srcFile], projectDir: dir });
    const f010 = result.findings.find((f) => f.code === 'FUARAN010')!;
    const json = renderFindingJson(f010);
    expect(json).toMatchObject({
      severity: 'error',
      code: 'FUARAN010',
      available_fields: ['totalRevenue'],
      suggestion: 'totalRevenue',
    });
    expect(typeof json.line).toBe('number');
    expect(typeof json.column).toBe('number');
  });
});

describe('runCli — exit-code contract', () => {
  it('exits 1 on an error-severity finding', () => {
    const cap = capture();
    const code = runCli(
      [srcFile, '--manifest', join(dir, 'fuaran-validator.manifest.json')],
      cap.io,
    );
    expect(code).toBe(1);
    expect(cap.out()).toContain('FUARAN010');
    expect(cap.err()).toContain('error(s)');
  });

  it('exits 0 when only warnings are present and --fail-on=error (default)', () => {
    const cleanDir = mkdtempSync(join(tmpdir(), 'fuaran-validator-clean-'));
    try {
      const file = join(cleanDir, 'm.ts');
      // Only a warning-severity defect (blank href) + FUARAN900 (warning).
      writeFileSync(file, `fuaran.link({ id: 'l', href: '', label: 'Home' });`, 'utf8');
      const cap = capture();
      expect(runCli([file], cap.io)).toBe(0);
      // …but --fail-on=warning escalates the same run to a non-zero exit.
      const cap2 = capture();
      expect(runCli([file, '--fail-on', 'warning'], cap2.io)).toBe(1);
    } finally {
      rmSync(cleanDir, { recursive: true, force: true });
    }
  });

  it('--format json emits a parseable array', () => {
    const cap = capture();
    runCli(
      [srcFile, '--manifest', join(dir, 'fuaran-validator.manifest.json'), '--format', 'json'],
      cap.io,
    );
    const parsed = JSON.parse(cap.out());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((p: { code: string }) => p.code === 'FUARAN010')).toBe(true);
  });

  it('exits 2 on a usage error (no files matched)', () => {
    const cap = capture();
    expect(runCli([join(dir, 'does-not-exist-*.ts')], cap.io)).toBe(2);
    expect(cap.err()).toContain('no .ts/.tsx files matched');
  });

  it('exits 2 on an unknown flag', () => {
    const cap = capture();
    expect(runCli(['--bogus'], cap.io)).toBe(2);
  });
});
