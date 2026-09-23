// ============================================================================
//  @fuaran-ui/renderer/runtimeHatches — the RUNTIME section of the escape-hatch
//  report, observed on this host (Phase 1842, porting the reference host's
//  Phase 1743 producer).
//
//  Some of the places arbitrary behaviour can enter a deployment are facts
//  about the RUNNING host, and no static walk of a composition can see them: a
//  guest renderer is registered by the host at startup, the content-hash floor
//  is whatever the host declared on its renderer, and the in-page introspection
//  surface is switched on by a prop. So they are observed HERE, beside the
//  things they observe, and reported as the canonical `hatchSection` document.
//
//  ── The document is a WIRE, joined by shape and never by type ───────────────
//  The same document is produced by a second, independent host, and read by
//  tooling in another tier that takes a dependency on neither. So its shape is
//  the contract, stated once here in the form a reader parses — member order
//  included, because two hosts serving the same document byte for byte is the
//  claim the relay corpus holds them to:
//
//      { "kind": "hatchSection", "version": 1, "section": "runtime",
//        "findings": [ { "predicate": "<id>", "hatch": <n>,
//                        "state": "open" | "closed" | "undecided",
//                        "account": "<prose>" } ] }
//
//  `hatch` is the inventory entry the finding mechanises, by NUMBER: the number
//  is the stable handle, and a title copied into code is a second copy of a
//  sentence that will move.
//
//  ── Three states, and the third is the point ────────────────────────────────
//  `undecided` is why this is not a boolean. An input this module was not
//  handed is reported undecided — never closed, and never omitted — because a
//  report that rendered "could not see" as "closed" would put a name behind a
//  claim nobody checked, and an omitted finding is indistinguishable from a
//  closed one to a reader.
//
//  ── Where this host's facts differ, the ACCOUNT says so ─────────────────────
//  The predicates, inventory numbers and states are shared with the reference
//  host. The account prose is not always, because two of the facts it reports
//  are different facts here: this host's content-hash floor is ambient on a
//  renderer's context rather than process-wide, and under an enforcing floor it
//  refuses an UNVERIFIABLE guest (no hash declared, or none registered) as well
//  as a mismatched one; and its registries are per renderer instance, with no
//  render scopes. An account that copied the reference host's sentence would
//  describe the other host.
//
//  Pure over what it is handed: no clock, no DOM, no module state.
// ============================================================================

import type { HashStrictness } from '@fuaran-ui/schema';

import { isEnforcingHashStrictness } from './customHash.js';
import type { CustomRendererRegistration, CustomRendererRegistry } from './customRegistry.js';

/** Whether a door is open, closed, or could not be seen. Closed set. */
export type HatchState = 'open' | 'closed' | 'undecided';

/** One predicate's answer about one inventory entry. */
// Type aliases rather than interfaces: only an alias gets the implicit index
// signature that lets the document stand as a relay envelope `payload`.
export type HatchFinding = {
  /** The predicate's own stable name. */
  readonly predicate: string;
  /** The inventory entry this predicate mechanises, by number. */
  readonly hatch: number;
  readonly state: HatchState;
  /** What admitted it, what was checked, or why it could not be decided. */
  readonly account: string;
};

/** The canonical `hatchSection` document, as this host produces it: the runtime section. */
export type HatchSectionDocument = {
  readonly kind: typeof HATCH_SECTION_KIND;
  readonly version: typeof HATCH_SECTION_VERSION;
  readonly section: typeof RUNTIME_SECTION;
  readonly findings: readonly HatchFinding[];
};

/** The document's own kind, carried IN it. */
export const HATCH_SECTION_KIND = 'hatchSection';
/** The document's own version — independent of any package or relay profile. */
export const HATCH_SECTION_VERSION = 1;
/** The only section a running host produces. `composition` is another producer's. */
export const RUNTIME_SECTION = 'runtime';

/** The registration predicate's stable name. */
export const CUSTOM_RENDERER_REGISTERED = 'custom-renderer-registered';
/** The mediation predicate's stable name. */
export const CUSTOM_HASH_FLOOR_PERMISSIVE = 'custom-hash-floor-permissive';
/** The development-surface predicate's stable name. */
export const DEVELOPMENT_SURFACE_LIVE = 'development-surface-live';

/** The inventory entry the guest boundary (`Custom` / `Mount`) is enumerated as. */
export const GUEST_BOUNDARY_HATCH = 2;
/** The inventory entry the development-mode surface is enumerated as. */
export const DEVELOPMENT_SURFACE_HATCH = 12;

/**
 * What the host handed the report. Every input is optional, and an ABSENT one
 * is reported undecided — the report says what it could not see rather than
 * guessing.
 */
export interface RuntimeHatchInputs {
  /**
   * The custom-renderer registry the host renders under. `null` is a positive
   * statement — the host renders with NO registry, so no guest renderer is
   * reachable from it; omitted means the host did not offer it.
   */
  readonly customRenderers?: CustomRendererRegistry | null;
  /** The content-hash floor the host renders under. Omitted means not offered. */
  readonly customHashFloor?: HashStrictness;
  /** Whether the in-page introspection surface is registered on the page. */
  readonly developmentSurfaceLive: boolean;
}

/** One registration, rendered for a reader: what it is, and whether a declared hash could be checked. */
export const describeRegistration = (r: CustomRendererRegistration): string =>
  `${r.moduleId}/${r.componentId} (${r.hasContentHash ? 'content hash registered' : 'no content hash'})`;

const unregisteredPlaceholder =
  'A `Custom` node in a tree rendered by this host reaches the unregistered placeholder.';

/** Is a guest renderer reachable at all? */
export const customRendererFinding = (
  registry: CustomRendererRegistry | null | undefined,
): HatchFinding => {
  const finding = (state: HatchState, account: string): HatchFinding => ({
    predicate: CUSTOM_RENDERER_REGISTERED,
    hatch: GUEST_BOUNDARY_HATCH,
    state,
    account,
  });
  if (registry === undefined)
    return finding(
      'undecided',
      'the host did not offer its custom-renderer registry to this report, so nothing here enumerates it. ' +
        'This is not a claim that none is registered: supply the registry to decide it.',
    );
  if (registry === null)
    return finding(
      'closed',
      'the host renders with no custom-renderer registry at all, so no guest renderer is reachable from it. ' +
        unregisteredPlaceholder,
    );
  const registrations = registry.registrations();
  if (registrations.length === 0)
    return finding(
      'closed',
      "the host's custom-renderer registry was read and holds no registration. " +
        unregisteredPlaceholder,
    );
  return finding(
    'open',
    `${registrations.length} custom renderer(s) registered: ` +
      registrations.map(describeRegistration).join('; '),
  );
};

const floorToken = (floor: HashStrictness): string => {
  switch (floor) {
    case 'AdvisoryWarning':
      return 'advisory-warning';
    case 'Enforced':
      return 'enforced';
    case 'StrictReplay':
      return 'strict-replay';
  }
};

/**
 * Is the mediation on the guest boundary in force? Reported for every floor,
 * the default included, so the finding is a positive statement about the
 * posture rather than an absence of complaint.
 */
export const customHashFloorFinding = (floor: HashStrictness | undefined): HatchFinding => {
  const finding = (state: HatchState, account: string): HatchFinding => ({
    predicate: CUSTOM_HASH_FLOOR_PERMISSIVE,
    hatch: GUEST_BOUNDARY_HATCH,
    state,
    account,
  });
  if (floor === undefined)
    return finding(
      'undecided',
      'the host did not offer the content-hash floor its renderer runs under, so nothing here can say ' +
        'whether a declared hash is checked. Supply the floor to decide it.',
    );
  if (isEnforcingHashStrictness(floor))
    return finding(
      'closed',
      `this renderer's content-hash floor is '${floorToken(floor)}': a guest whose declared hash ` +
        "disagrees with the registered renderer's is REFUSED rather than rendered, and so is one whose " +
        'hash cannot be verified at all — declared by the tree but not registered, or not declared.',
    );
  return finding(
    'open',
    `this renderer's content-hash floor is '${floorToken(floor)}' — the posture this host takes when ` +
      'no floor is declared, or one declared by name. A guest whose declared hash disagrees with the ' +
      "registered renderer's warns and renders anyway, so a declared hash mediates nothing here.",
  );
};

/** Is the in-page introspection surface live? */
export const developmentSurfaceFinding = (live: boolean): HatchFinding =>
  live
    ? {
        predicate: DEVELOPMENT_SURFACE_LIVE,
        hatch: DEVELOPMENT_SURFACE_HATCH,
        state: 'open',
        account:
          'the in-page introspection surface is registered on this page. The running ' +
          "application's typed layer is readable, and writable where the host wired an apply path. " +
          'A reader who obtained this report THROUGH that surface is holding the evidence.',
      }
    : {
        predicate: DEVELOPMENT_SURFACE_LIVE,
        hatch: DEVELOPMENT_SURFACE_HATCH,
        state: 'closed',
        account:
          'the introspection surface that produced this report is not registered on the page, so ' +
          'no in-page reader can reach it: it is readable only by the host code that holds it.',
      };

/**
 * The runtime section, over observations supplied as arguments. Reads no
 * ambient state — which is what makes every branch reachable from a test.
 * Members are emitted in the document's canonical order.
 */
export const observeRuntimeHatches = (inputs: RuntimeHatchInputs): HatchSectionDocument => ({
  kind: HATCH_SECTION_KIND,
  version: HATCH_SECTION_VERSION,
  section: RUNTIME_SECTION,
  findings: [
    customRendererFinding(inputs.customRenderers),
    customHashFloorFinding(inputs.customHashFloor),
    developmentSurfaceFinding(inputs.developmentSurfaceLive),
  ],
});
