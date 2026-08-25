// ============================================================================
//  The `NodeKind.Mount` guest-privilege contract (Phase 783 posture, ported to
//  this host by Phase 1021).
//
//  `Mount` is described as an isolation boundary. For an AUTHORED tree it is;
//  for a DECODED one it was not, in two ways on the reference host — and this
//  host had neither guard, because it had no guest loader at all. That made the
//  gap latent rather than absent: the moment a loader landed it would have
//  landed with pre-hardening semantics, on a public tier.
//
//  So the contract is established BEFORE the loader, and the loader is reachable
//  only through it (see the `Mount` arm of `render/core.tsx`, which owns the one
//  call to `FuaranRuntime.loadGuest` and derives privilege from its result in
//  the same expression). A host supplies `loadGuest`; it never constructs the
//  guest's context, so it cannot construct a privileged one.
//
//  The two guarantees, in the order they must hold:
//
//    1. **No seam means UNPRIVILEGED.** With no `GuestSeam` wired, the guest
//       receives {@link unprivilegedGuestRuntime}: every capability refused,
//       every refusal recorded through the host's `warn` channel, `canDispatch`
//       false, no custom renderers in any scope, and no nested guest loading (so
//       a guest cannot mount its own guests to climb back out through a
//       differently-wired branch). Unregistered must mean unprivileged; the
//       reference host's pre-783 default handed the guest the host's own runtime
//       unwrapped, which is the exact inverse of the declared posture.
//
//    2. **`OutOnly` is CLAMPED before anything reads the channel.**
//       `ChannelDirection` is a required wire field, so a decoded tree simply
//       writes `TwoWay`; `OutOnly` was only ever the default of the AUTHORING
//       smart constructor. `TwoWay` is a host grant (`GuestSeam.grantTwoWay`),
//       never a wire-declared property, and a refused upgrade is WARNED rather
//       than dropped silently — a silent clamp is indistinguishable from a guest
//       that simply never pushed.
//
//  The clamp is at the RENDERER, not the decoder, deliberately: the decoder
//  preserves what the wire said, so canonical round-trip and the shared
//  conformance corpus are untouched, and the host's own policy decides what is
//  honoured.
// ============================================================================

import type { CapabilityTag, ChannelDirection, GuestChannel } from '@fuaran-ui/schema';

import type { FuaranRuntime } from './customRegistry.js';

/**
 * The policy surface of a `NodeKind.Mount`, handed to the host's `GuestSeam`.
 *
 * Deliberately NOT the `MountSpec<TMsg>` itself: a capability policy needs the
 * mount's identity, its declared capabilities and its channel, none of which are
 * `TMsg`-typed, and a seam shared across `TMsg` instantiations must not be
 * generic in one.
 */
export interface GuestSeamContext {
  /** The guest's runtime scope id (`MountSpec.scopeId`). */
  readonly scopeId: string;
  /**
   * The capabilities the mount DECLARES for the guest (`MountSpec.capabilities`).
   * A gate reads these as a *request*, not a grant — deciding what to allow is
   * the host policy's job.
   */
  readonly capabilities: readonly CapabilityTag[];
  /**
   * The guest channel as the renderer will ACTUALLY honour it. Its `direction`
   * is `OutOnly` unless the seam granted otherwise via `grantTwoWay` — never
   * simply what the tree declared.
   */
  readonly channel: GuestChannel;
  /**
   * What the TREE asked for. A gate deciding `grantTwoWay` reads this one:
   * `channel` is what will happen, this is what was requested.
   */
  readonly declaredDirection: ChannelDirection;
}

/**
 * Host-pluggable capability seam for rendered `Mount` guests (§4o).
 *
 * Wired per renderer instance on `FuaranRuntime.guestSeam` — the reference host
 * installs it process-wide; this one carries it on the runtime record for the
 * same reason its custom-renderer registry is per-instance.
 *
 * - `wrapRuntime ctx hostRuntime` returns the `FuaranRuntime` the guest gets. A
 *   capability-scoping host returns a restricted runtime; returning
 *   `hostRuntime` unchanged is the identity policy — and note that identity here
 *   is a DELIBERATE grant of everything the host can do, which is precisely what
 *   the no-seam default must not be.
 * - `gateBubble ctx rawBubble` returns the function the guest's dispatches run
 *   through. A gate may drop, transform, or pass through.
 * - `grantTwoWay ctx` decides whether this mount gets a `TwoWay` channel.
 *   `() => false` is the safe policy and the one to write unless a specific
 *   mount genuinely needs host→guest push.
 *
 * All three are consulted per rendered mount, not per host, so a policy may vary
 * by scope id / capability set without being re-wired.
 */
export interface GuestSeam {
  readonly wrapRuntime: (ctx: GuestSeamContext, hostRuntime: FuaranRuntime) => FuaranRuntime;
  readonly gateBubble: (
    ctx: GuestSeamContext,
    rawBubble: (action: unknown) => void,
  ) => (action: unknown) => void;
  readonly grantTwoWay: (ctx: GuestSeamContext) => boolean;
}

/** The msg-agnostic half of a `MountSpec` the privilege derivation reads. */
export interface GuestMountDeclaration {
  readonly scopeId: string;
  readonly channel: GuestChannel;
  readonly capabilities: readonly CapabilityTag[];
}

/**
 * The runtime a mounted guest gets when no `GuestSeam` is wired. Every port is
 * absent or refusing; `warn` is the ONE thing that still reaches the host,
 * because refusing to say anything would make an unwired mount silently inert —
 * which is how this defect survived on the reference host.
 */
export const unprivilegedGuestRuntime = (host: FuaranRuntime, scopeId: string): FuaranRuntime => {
  const refuse = (what: string): void => {
    host.warn?.(
      `[fuaran:mount] guest '${scopeId}' attempted ${what} with no GuestSeam wired — refused. Wire runtime.guestSeam to grant a mounted guest any capability.`,
    );
  };
  return {
    // No `registry`: no custom renderers, in any scope. Reaching one is exactly
    // the confused-deputy shape the per-instance registry exists to close.
    call: (endpoint) => refuse(`Call(${endpoint})`),
    notify: (channel) => refuse(`Notify(${channel})`),
    navigate: (route) => refuse(`Navigate(${route})`),
    setState: (key) => refuse(`SetState(${key})`),
    setFilter: (name) => refuse(`SetFilter(${name})`),
    setSelection: (nodeId) => refuse(`SetSelection(${nodeId})`),
    setQueryResult: (name) => refuse(`SetQueryResult(${name})`),
    invokeAiTool: (toolName) => refuse(`AiTool(${toolName})`),
    invokeCapability: (capabilityId) => refuse(`Invoke(${capabilityId})`),
    writeToClipboard: () => refuse('WriteToClipboard'),
    readFileBody: (file) => refuse(`ReadFileBody(${file.id})`),
    // Diagnostics still reach the host.
    warn: (message) => host.warn?.(message),
    canDispatch: () => false,
    // No nested guest loading.
  };
};

/** What the `Mount` arm renders a guest under. */
export interface GuestPrivilege {
  /** The runtime the guest renders with. */
  readonly runtime: FuaranRuntime;
  /** The channel as it will actually be honoured. */
  readonly channel: GuestChannel;
  /** Whether the tree's `TwoWay` request was granted by the host. */
  readonly twoWayGranted: boolean;
  /** The (possibly gated) function a guest dispatch runs through. */
  readonly dispatch: (action: unknown) => void;
}

/**
 * Derive the privilege a mounted guest renders under. Total and pure apart from
 * the downgrade `warn`, so every combination is pinnable in tests without a
 * render — the same shape as {@link classifyCustomHashUnder}.
 *
 * The ORDER is the contract: clamp first, then let the seam see both what was
 * asked for and what will otherwise happen, then apply the capability policy.
 * A seam that reads the channel before the clamp would be reading the tree's
 * claim, which is the thing being defended against.
 */
export const deriveGuestPrivilege = (
  spec: GuestMountDeclaration,
  hostRuntime: FuaranRuntime,
  rawBubble: (action: unknown) => void,
  seam: GuestSeam | undefined,
): GuestPrivilege => {
  const declaredDirection = spec.channel.direction;
  const clampedChannel: GuestChannel = { ...spec.channel, direction: 'OutOnly' };
  const clampedCtx: GuestSeamContext = {
    scopeId: spec.scopeId,
    capabilities: spec.capabilities,
    channel: clampedChannel,
    declaredDirection,
  };

  // The grant decision reads the CLAMPED context, so a policy sees what will
  // happen by default and what was asked for, and says yes or no to the
  // difference.
  const twoWayGranted = seam !== undefined && seam.grantTwoWay(clampedCtx);
  const channel: GuestChannel = twoWayGranted
    ? { ...spec.channel, direction: 'TwoWay' }
    : clampedChannel;

  if (declaredDirection === 'TwoWay' && !twoWayGranted) {
    hostRuntime.warn?.(
      `[fuaran:mount] mount '${spec.scopeId}' declared a TwoWay guest channel; downgraded to OutOnly. TwoWay is a host grant (GuestSeam.grantTwoWay), not a wire-declared property.`,
    );
  }

  const seamCtx: GuestSeamContext = { ...clampedCtx, channel };

  return seam !== undefined
    ? {
        runtime: seam.wrapRuntime(seamCtx, hostRuntime),
        channel,
        twoWayGranted,
        dispatch: seam.gateBubble(seamCtx, rawBubble),
      }
    : {
        runtime: unprivilegedGuestRuntime(hostRuntime, spec.scopeId),
        channel,
        twoWayGranted,
        dispatch: rawBubble,
      };
};
