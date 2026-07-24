// ============================================================================
//  @fuaran-ui/validator — rule implementations.
//
//  Each rule maps a slice of the walker's facts to `Finding`s. The `code` +
//  `severity` of every rule match the F# tier's `Fuaran.UI.Validator` checks
//  byte-for-byte (the acceptance contract: a cross-implementation eval suite
//  scores both tiers uniformly). The message text is adapted to the TS
//  authoring surface (`binding.query` / `action.dispatch` / `node.with…` /
//  `fuaran.tabs` / `localeFormat.currency`) since it names the host API the
//  reader must edit.
//
//  Ported rule subset (the cleanly-portable, source-statically-decidable
//  rules over the `@fuaran-ui/ui` object-options surface):
//
//    FUARAN001  Error    Duplicate NodeId within one dashboard tree.
//    FUARAN002  Warning  Same NodeId across multiple trees.
//    FUARAN010  Error    binding.query name not in manifest.queries.
//    FUARAN020  Error    action.dispatch case not in manifest.msgCases.
//    FUARAN046  Warning  gridLayoutTemplated equivalent to typed Cols.
//    FUARAN047  Error    Tabs tabHeaders length ≠ children length.
//    FUARAN048  Error    Tabs tabTags length ≠ children length.
//    FUARAN049  Warning  Tabs activeTag set but tabTags absent.
//    FUARAN050  Warning  progress fraction literal outside [0, 1].
//    FUARAN060  Warning  withExtraAttribute key outside data-*/aria-* allowlist.
//    FUARAN061  Error    localeFormat.currency with a blank ISO-4217 code.
//    FUARAN063  Warning  link with a blank href.
//    FUARAN064  Warning  button disabled bound to binding.static(false) (no-op).
//    FUARAN900  Warning  No manifest found — schema-coupled checks silenced.
//
//  F#-tier codes deliberately out of scope for this v1 (no clean
//  TS-source-static analogue — they key on F#-record opt-out syntax, FCS
//  lambda type annotations, or deep manifest contracts): FUARAN030/031
//  (row-type lambda annotations), 040/041 (a11y `Accessibility = None`
//  opt-out), 042/043/044 (binding.local enclosing-context), 052/053/054/055
//  (Custom-escape health), 056/057/058/059/065 (fragment-reuse health),
//  062 (Custom build-time content-hash). See README "Coverage vs the F# tier".
// ============================================================================

import { create, withRecovery, type Finding } from './findings.js';
import type { Manifest } from './manifest.js';
import type { FuaranCtorCall, WalkResult } from './walker.js';

const LOOSE_BUCKET = '__loose__';

// ─── FUARAN001 / FUARAN002 — NodeId uniqueness ───────────────────────────────

export function nodeIdRules(calls: readonly FuaranCtorCall[]): Finding[] {
  const withIds = calls
    .filter((c) => c.nodeId !== undefined)
    .map((c) => ({ id: c.nodeId!, tree: c.treeRoot ?? LOOSE_BUCKET, call: c }));

  const findings: Finding[] = [];

  // Per-tree duplicates (Error) — one finding per occurrence, like the F# tier.
  const byTree = groupBy(withIds, (w) => w.tree);
  for (const [tree, items] of byTree) {
    if (tree === LOOSE_BUCKET) continue;
    for (const [id, dups] of groupBy(items, (w) => w.id)) {
      if (dups.length < 2) continue;
      for (const w of dups) {
        findings.push(
          create(
            'error',
            'FUARAN001',
            w.call.location,
            `Duplicate NodeId "${id}" within tree "${tree}" — every NodeId inside one fuaran.dashboard subtree must be unique (§4g op-target stability).`,
          ),
        );
      }
    }
  }

  // Cross-tree duplicates (Warning).
  for (const [id, items] of groupBy(withIds, (w) => w.id)) {
    const trees = [...new Set(items.map((w) => w.tree))];
    if (trees.length < 2) continue;
    const treeList = [...trees].sort().join(', ');
    for (const w of items) {
      findings.push(
        create(
          'warning',
          'FUARAN002',
          w.call.location,
          `NodeId "${id}" appears across multiple trees (${treeList}) — legitimate when modules share a stable id, but worth flagging.`,
        ),
      );
    }
  }

  return findings;
}

// ─── FUARAN010 — binding.query name resolution (manifest-gated) ───────────────

export function bindingQueryRule(manifest: Manifest, walk: WalkResult): Finding[] {
  if (manifest.queries.size === 0) return [];
  const registered = [...manifest.queries];
  const findings: Finding[] = [];
  for (const q of walk.queryRefs) {
    if (manifest.queries.has(q.name)) continue;
    const suggestion = suggestSimilar(registered, q.name);
    findings.push(
      withRecovery(
        registered,
        suggestion,
        create(
          'error',
          'FUARAN010',
          q.location,
          `Unresolved binding.query "${q.name}" — name is not in the module's manifest queries list.`,
        ),
      ),
    );
  }
  return findings;
}

// ─── FUARAN020 — action.dispatch case resolution (manifest-gated) ─────────────

export function dispatchRule(manifest: Manifest, walk: WalkResult): Finding[] {
  if (manifest.msgCases.size === 0) return [];
  const registered = [...manifest.msgCases];
  const findings: Finding[] = [];
  for (const d of walk.dispatchRefs) {
    if (manifest.msgCases.has(d.caseName)) continue;
    const suggestion = suggestSimilar(registered, d.caseName);
    findings.push(
      withRecovery(
        registered,
        suggestion,
        create(
          'error',
          'FUARAN020',
          d.location,
          `action.dispatch payload references unknown Msg case "${d.caseName}" — case is not in the module's manifest msgCases list.`,
        ),
      ),
    );
  }
  return findings;
}

// ─── FUARAN046 — gridLayoutTemplated equivalent to typed Cols ─────────────────

const REPEAT_ONE_FR = /^\s*repeat\(\s*\d+\s*,\s*1fr\s*\)\s*$/i;

export function gridTemplateRule(calls: readonly FuaranCtorCall[]): Finding[] {
  return calls.flatMap((c) => {
    if (c.ctor !== 'gridLayoutTemplated' || c.templateColumns === undefined) return [];
    if (!REPEAT_ONE_FR.test(c.templateColumns)) return [];
    return [
      withRecovery(
        [],
        'use fuaran.gridLayout with the typed cols field; reach for gridLayoutTemplated only when the sizing function (1fr 2fr, 100px repeat(...), min-content max-content, auto-fit minmax) cannot be expressed by cols',
        create(
          'warning',
          'FUARAN046',
          c.location,
          `fuaran.gridLayoutTemplated: templateColumns "${c.templateColumns}" is equivalent to the typed cols-based emission. Use fuaran.gridLayout with cols = N instead — the typed shape avoids the unbounded-string escape's review tax for no expressivity gain.`,
        ),
      ),
    ];
  });
}

// ─── FUARAN047 / 048 / 049 — Tabs shape ───────────────────────────────────────

export function tabsRules(calls: readonly FuaranCtorCall[]): Finding[] {
  return calls.flatMap((c) => {
    if ((c.ctor !== 'tabs' && c.ctor !== 'tabsTagged') || c.tabs === undefined) return [];
    const id = c.nodeId !== undefined ? `"${c.nodeId}"` : '<no id>';
    const t = c.tabs;
    const findings: Finding[] = [];

    if (
      t.childrenLength !== undefined &&
      t.tabHeadersLength !== undefined &&
      t.tabHeadersLength !== t.childrenLength
    ) {
      findings.push(
        create(
          'error',
          'FUARAN047',
          c.location,
          `fuaran.tabs ${id} declares tabHeaders with ${t.tabHeadersLength} entries but ${t.childrenLength} children — the renderer aligns headers 1:1 with children by index; mismatched lengths leave tabs without labels or labels without targets.`,
        ),
      );
    }
    if (
      t.childrenLength !== undefined &&
      t.tabTagsLength !== undefined &&
      t.tabTagsLength !== t.childrenLength
    ) {
      findings.push(
        create(
          'error',
          'FUARAN048',
          c.location,
          `fuaran.tabs ${id} declares tabTags with ${t.tabTagsLength} entries but ${t.childrenLength} children — the typed tag overlay maps tags to children by index; mismatched lengths break the tag → index round-trip.`,
        ),
      );
    }
    if (t.hasActiveTag && !t.hasTabTags) {
      findings.push(
        create(
          'warning',
          'FUARAN049',
          c.location,
          `fuaran.tabs ${id} sets activeTag but has no tabTags — the tag binding has nothing to resolve against; the renderer silently falls back to activeIndex. Populate tabTags alongside activeTag, or drop activeTag and rely on the integer-indexed activeIndex / onSelect.`,
        ),
      );
    }
    return findings;
  });
}

// ─── FUARAN050 — progress fraction range ──────────────────────────────────────

export function progressRangeRule(calls: readonly FuaranCtorCall[]): Finding[] {
  return calls.flatMap((c) => {
    if (c.ctor !== 'progress' || c.fractionLiteral === undefined) return [];
    if (c.fractionLiteral >= 0 && c.fractionLiteral <= 1) return [];
    return [
      withRecovery(
        [],
        'set fraction to a value in [0, 1], or use indeterminate = true',
        create(
          'warning',
          'FUARAN050',
          c.location,
          `fuaran.progress fraction literal ${c.fractionLiteral} is outside the known-bounded domain [0, 1]. A progress fraction is a bounded scalar — declare an honest 0..1 value, or set indeterminate = true with a caveat when no honest bound exists. supportedRange={"kind":"decimalRange","min":0,"max":1}`,
        ),
      ),
    ];
  });
}

// ─── FUARAN060 — withExtraAttribute key allowlist ─────────────────────────────

function isAllowedKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed === '') return false;
  if (trimmed.toLowerCase().startsWith('on')) return false;
  if (trimmed.toLowerCase() === 'style') return false;
  return trimmed.startsWith('data-') || trimmed.startsWith('aria-');
}

export function extraAttributeRule(walk: WalkResult): Finding[] {
  return walk.extraAttrCalls.flatMap((call) => {
    if (isAllowedKey(call.keyLiteral)) return [];
    const trimmed = call.keyLiteral.trim();
    const reason = trimmed.toLowerCase().startsWith('on')
      ? 'event-handler attribute (on*) — would inject inline script if it reached the DOM'
      : trimmed.toLowerCase() === 'style'
        ? 'raw CSS sink — vector for content-spoofing and legacy expression() injection'
        : 'outside the data-* / aria-* allowlist';
    return [
      withRecovery(
        ['data-<custom-name>', 'aria-<standard-name>'],
        'rename the key to a data-* test hook or aria-* accessibility attribute',
        create(
          'warning',
          'FUARAN060',
          call.location,
          `node.withExtraAttribute key "${call.keyLiteral}" is ${reason}. The render-time sanitization floor drops this entry, but the build-time signal catches it earlier. Use a data-* or aria-* key, or move the behaviour into a typed Action / accessibility field.`,
        ),
      ),
    ];
  });
}

// ─── FUARAN061 — localeFormat.currency blank ISO code ─────────────────────────

export function currencyRule(walk: WalkResult): Finding[] {
  return walk.currencyCalls.flatMap((call) => {
    if (call.isoLiteral.trim() !== '') return [];
    return [
      create(
        'error',
        'FUARAN061',
        call.location,
        'localeFormat.currency was given a blank ISO-4217 currency code. The renderer passes it to Intl.NumberFormat({ style: "currency", currency: "" }), which throws a RangeError at render time. Supply a valid ISO-4217 code (e.g. "GBP", "USD", "EUR").',
      ),
    ];
  });
}

// ─── FUARAN063 — blank link href ──────────────────────────────────────────────

export function linkHrefRule(calls: readonly FuaranCtorCall[]): Finding[] {
  return calls.flatMap((c) => {
    if (c.ctor !== 'link' || c.hrefLiteral === undefined) return [];
    if (c.hrefLiteral.trim() !== '') return [];
    return [
      withRecovery(
        [],
        'set href to a non-empty destination URL, or use fuaran.button + action.navigate for a stateful in-app gesture',
        create(
          'warning',
          'FUARAN063',
          c.location,
          'fuaran.link has a blank href. A link with an empty href renders an <a> that navigates to the current page — provide a real destination URL. If you meant an in-app routing gesture (no crawlable URL), use a button + action.navigate instead.',
        ),
      ),
    ];
  });
}

// ─── FUARAN064 — no-op disabled binding ───────────────────────────────────────

export function buttonDisabledRule(calls: readonly FuaranCtorCall[]): Finding[] {
  return calls.flatMap((c) => {
    if (c.ctor !== 'button' || !c.disabledStaticFalse) return [];
    return [
      withRecovery(
        [],
        'bind disabled to a binding.state (e.g. binding.state("loading", false)), or remove the no-op disabled: binding.static(false)',
        create(
          'warning',
          'FUARAN064',
          c.location,
          'fuaran.button disabled is bound to binding.static(false) — a constant-false disabled binding never disables the button, so it is equivalent to omitting disabled. This is almost always an unfinished binding: point disabled at the live state, e.g. disabled: binding.state("loading", false). A permanently-disabled placeholder uses binding.static(true) and is not flagged.',
        ),
      ),
    ];
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function groupBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = m.get(k);
    if (bucket === undefined) m.set(k, [item]);
    else bucket.push(item);
  }
  return m;
}

/** Levenshtein distance — small inputs, naive 2D DP (matches the F# tier). */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  return d[m]![n]!;
}

/** Best-guess suggestion for an unresolved name, matching the F# thresholds. */
function suggestSimilar(candidates: readonly string[], target: string): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const c of candidates) {
    const distance = levenshtein(target, c);
    if (best === undefined || distance < best.distance) best = { name: c, distance };
  }
  if (best === undefined) return undefined;
  return best.distance <= 3 && best.distance <= Math.max(2, Math.floor(target.length / 2))
    ? best.name
    : undefined;
}
