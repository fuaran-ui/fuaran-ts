// ============================================================================
//  The merge-conformance corpus's sample validator gate (Phase 184), shared by
//  the tree-merge legs (merge.test.ts) and the merge-by-fold legs
//  (fold.test.ts): one port of the F# `ValidatorGate` introduced-defect diff
//  and verdict codec, and of the sample domain validator the gated fixtures
//  certify against. Test-side, as the reference keeps it: the invariant is a
//  documented sample, not a production API surface.
// ============================================================================

import type { Node } from '@fuaran-ui/schema';

// ─── Phase 184 validator-gated port (Leg B of the verdict-determinism gate) ───
//
// A faithful TS port of the F# `ValidatorGate` (introduced-defect diff + verdict
// codec) plus the sample domain validator the gated corpus certifies against
// (`MergeCorpus.gatedValidator`: "at most one Brand-toned pane per dashboard").
// Mirrored test-side, exactly as the F# corpus ports it test-side — the
// invariant is a documented sample, not a production API surface. A host MUST
// reproduce this exact invariant + codec to match the committed verdict bytes.

export interface MergeDefect {
  readonly code: string;
  readonly nodeId: string;
  readonly facet: string;
  readonly message: string;
}

/** Host-independent ordering key (nodeId, facet, code) — the verdict is
 * byte-stable regardless of the walker's internal emission order. */
const orderKey = (d: MergeDefect): string => `${d.nodeId}\u0000${d.facet}\u0000${d.code}`;
const sortCanonical = (defects: readonly MergeDefect[]): MergeDefect[] =>
  [...defects].sort((x, y) => {
    const kx = orderKey(x);
    const ky = orderKey(y);
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });

/** The sample DOMAIN validator the gated fixtures certify against: "at most one
 * `Brand`-toned pane per dashboard". Each offending child is a defect on its
 * `style.tone` cell. Mirrors `MergeCorpus.gatedValidator` — inspects the root
 * node only (not recursive), exactly as the F# walker does. */
const gatedValidator = (tree: Node<unknown>): MergeDefect[] => {
  // Phase 390 — a dashboard is a `Box` with the Dashboard role.
  if (
    tree.kind.kind !== 'Layout' ||
    tree.kind.layout.kind !== 'Box' ||
    tree.kind.layout.spec.role !== 'Dashboard'
  )
    return [];
  const brandKids = tree.kind.layout.spec.children.filter((c) => c.style.tone === 'Brand');
  if (brandKids.length <= 1) return [];
  return brandKids.map((c) => {
    const id = c.id as unknown as string;
    return {
      code: 'TESTBRAND001',
      nodeId: id,
      facet: 'style.tone',
      message: `Pane '${id}' shares Brand tone with a sibling — at most one Brand pane per dashboard.`,
    };
  });
};

/** Diff identity for the introduced-defect test — `(code, nodeId, facet)`. */
const identity = (d: MergeDefect): string => `${d.code}\u0000${d.nodeId}\u0000${d.facet}`;

/** Defects present in `merged` but in NEITHER parent — the ones the merge
 * INTRODUCED (a defect already present in a parent was not caused by the merge,
 * so it is carried through, never flagged). Sorted canonically. */
export const introducedDefects = (
  parentA: Node<unknown>,
  parentB: Node<unknown>,
  merged: Node<unknown>,
): MergeDefect[] => {
  const parentKeys = new Set([
    ...gatedValidator(parentA).map(identity),
    ...gatedValidator(parentB).map(identity),
  ]);
  return sortCanonical(gatedValidator(merged).filter((d) => !parentKeys.has(identity(d))));
};

/** Mirror of the F# `ValidatorGate.appendEscaped` — only `"`, `\`, and control
 * chars need escaping for the ASCII-ish defect fields (the em-dash is > space,
 * emitted as-is). */
const escapeJson = (s: string): string => {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch < ' ') out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
};

/** Canonical JSON of a gated-merge VERDICT: the introduced-defect set as a
 * sorted array of `{code,facet,message,nodeId}` objects (keys alphabetical,
 * entries in (nodeId,facet,code) order). Byte-stable across hosts. */
export const encodeVerdict = (defects: readonly MergeDefect[]): string =>
  '[' +
  sortCanonical(defects)
    .map(
      (d) =>
        '{"code":' +
        escapeJson(d.code) +
        ',"facet":' +
        escapeJson(d.facet) +
        ',"message":' +
        escapeJson(d.message) +
        ',"nodeId":' +
        escapeJson(d.nodeId) +
        '}',
    )
    .join(',') +
  ']';
