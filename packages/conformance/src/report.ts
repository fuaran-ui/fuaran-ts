// ============================================================================
//  @fuaran-ui/conformance — the certification report.
//
//  One `LegResult` per conformance leg. A leg is `skipped` (never attempted)
//  when the adapter lacks the hooks it needs — that is a capability statement,
//  not a failure. The verdict distinguishes the three honest outcomes:
//
//    conformant            every mandatory leg attempted and passed
//    partially-conformant  every attempted leg passed; ≥1 mandatory leg skipped
//    non-conformant        ≥1 attempted leg failed
//
//  so a partial host (decode-only, node-only, …) certifies the legs it
//  implements rather than receiving a blanket fail.
// ============================================================================

import type { ImplementationInfo } from './adapter.js';

export type LegId =
  | 'node-decode'
  | 'node-byte-identity'
  | 'node-reject'
  | 'op-decode'
  | 'op-byte-identity'
  | 'op-reject'
  | 'lenient-accept'
  | 'envelope-round-trip'
  | 'envelope-reject'
  | 'elicitation-round-trip'
  | 'elicitation-reject'
  | 'elicitation-answer'
  | 'schema-validation'
  | 'apply';

export type LegStatus = 'pass' | 'fail' | 'skipped';

export interface FixtureFailure {
  readonly fixtureId: string;
  readonly summary: string;
  readonly detail?: string;
}

export interface LegResult {
  readonly leg: LegId;
  /** Mandatory legs must all pass for the `conformant` verdict. */
  readonly mandatory: boolean;
  readonly status: LegStatus;
  /** Why the leg was not attempted (only when `status === 'skipped'`). */
  readonly skipReason?: string;
  readonly fixturesTotal: number;
  readonly fixturesPassed: number;
  readonly failures: readonly FixtureFailure[];
}

export type Verdict = 'conformant' | 'partially-conformant' | 'non-conformant';

export interface ConformanceReport {
  readonly kit: { readonly name: string; readonly version: string };
  readonly implementation: ImplementationInfo;
  readonly corpus: {
    readonly manifestVersion: number;
    readonly digest: string;
    readonly fixtureCount: number;
    readonly source: 'bundled' | 'external';
  };
  readonly legs: readonly LegResult[];
  readonly verdict: Verdict;
  /** ISO-8601 generation timestamp. */
  readonly generatedAt: string;
}

export const computeVerdict = (legs: readonly LegResult[]): Verdict => {
  if (legs.some((l) => l.status === 'fail')) return 'non-conformant';
  if (legs.some((l) => l.mandatory && l.status === 'skipped')) return 'partially-conformant';
  return 'conformant';
};

const statusGlyph: Record<LegStatus, string> = { pass: '✓', fail: '✗', skipped: '–' };

/** Render a report as a human-readable text block (what the CLI prints). */
export const formatReport = (report: ConformanceReport): string => {
  const lines: string[] = [];
  const impl =
    report.implementation.version === undefined
      ? report.implementation.name
      : `${report.implementation.name} ${report.implementation.version}`;
  lines.push(`Fuaran wire-format conformance report`);
  lines.push(`  kit            ${report.kit.name}@${report.kit.version}`);
  lines.push(`  implementation ${impl}`);
  lines.push(
    `  corpus         v${report.corpus.manifestVersion} (${report.corpus.fixtureCount} fixtures, ${report.corpus.source})`,
  );
  lines.push(`  corpus digest  sha256:${report.corpus.digest}`);
  lines.push(`  generated      ${report.generatedAt}`);
  lines.push('');
  for (const leg of report.legs) {
    const tier = leg.mandatory ? 'mandatory' : 'optional ';
    const counts =
      leg.status === 'skipped'
        ? (leg.skipReason ?? 'skipped')
        : `${leg.fixturesPassed}/${leg.fixturesTotal}`;
    lines.push(`  ${statusGlyph[leg.status]} ${leg.leg.padEnd(20)} ${tier}  ${counts}`);
    for (const f of leg.failures) {
      lines.push(`      ${f.fixtureId}: ${f.summary}`);
      if (f.detail !== undefined)
        for (const detailLine of f.detail.split('\n')) lines.push(`        ${detailLine}`);
    }
  }
  lines.push('');
  lines.push(`  verdict: ${report.verdict.toUpperCase()}`);
  if (report.verdict === 'partially-conformant') {
    const skipped = report.legs
      .filter((l) => l.mandatory && l.status === 'skipped')
      .map((l) => l.leg);
    lines.push(`  (mandatory legs not attempted: ${skipped.join(', ')})`);
  }
  lines.push(
    `  Certification is per corpus version — re-certify when the corpus advances (WIRE_FORMAT.md §11).`,
  );
  return lines.join('\n');
};
