// ============================================================================
//  @fuaran-ui/renderer/customRegistry — the NodeKind.Custom bounded-escape
//  registry + the host effect-substrate runtime.
//
//  Mirrors the F# `IFuaranRuntime.RegisterCustomRenderer` shape (Phase 12.M /
//  Phase 70): a host wires a React component against a `moduleId`/`componentId`
//  pair, and `Custom` nodes carrying that pair dispatch to the registered
//  component. Registries are PER-`FuaranRenderer`-INSTANCE — never module-
//  global — matching the F# per-scope discipline; the host threads one in via
//  the `<FuaranRenderer runtime={...}>` prop and the default is empty.
// ============================================================================

import type { FunctionComponent } from 'react';

import type {
  ContentHash,
  FileReadEncoding,
  FileRef,
  InvokeArg,
  JsonValue,
  Node,
} from '@fuaran-ui/schema';

import type { GuestSeam } from './guestPrivilege.js';
import {
  payloadGateStamp,
  payloadObligationsFor,
  type CustomPayloadCard,
  type CustomPayloadObligation,
  type PayloadLanguages,
} from './payloadLanguage.js';

/** Props a registered custom React component receives. */
export interface CustomRendererProps {
  readonly moduleId: string;
  readonly componentId: string;
  readonly props: Readonly<Record<string, JsonValue>>;
}

/** A host-registered React component for a `NodeKind.Custom` body. */
export type CustomRenderer = FunctionComponent<CustomRendererProps>;

interface CustomRendererEntry {
  readonly render: CustomRenderer;
  readonly contentHash?: ContentHash;
  readonly payloadLanguages?: PayloadLanguages;
}

/**
 * An entry plus the identity it was registered under. Held separately from the
 * public {@link CustomRendererEntry} so `get` keeps returning exactly what it
 * always returned — and read rather than recovered from the map key, because a
 * `moduleId` may itself contain a dot and splitting the key would silently
 * attribute a card to the wrong component.
 */
interface IdentifiedEntry extends CustomRendererEntry {
  readonly moduleId: string;
  readonly componentId: string;
}

const key = (moduleId: string, componentId: string): string => `${moduleId}.${componentId}`;

/**
 * A per-instance map of `${moduleId}.${componentId}` → registered React
 * component (+ optional content hash for Phase 70 bounded-escape verification,
 * + optional Phase 1107 payload-language declarations per prop key).
 */
export class CustomRendererRegistry {
  private readonly map = new Map<string, IdentifiedEntry>();

  /** Register a renderer for a module/component pair. Chainable. */
  register(
    moduleId: string,
    componentId: string,
    render: CustomRenderer,
    contentHash?: ContentHash,
    payloadLanguages?: PayloadLanguages,
  ): this {
    const entry: IdentifiedEntry = {
      moduleId,
      componentId,
      render,
      ...(contentHash !== undefined ? { contentHash } : {}),
      ...(payloadLanguages !== undefined ? { payloadLanguages } : {}),
    };
    this.map.set(key(moduleId, componentId), entry);
    return this;
  }

  /** Look up a registered renderer, or `undefined` if none is registered. */
  get(moduleId: string, componentId: string): CustomRendererEntry | undefined {
    return this.map.get(key(moduleId, componentId));
  }

  /** True when a renderer is registered for the pair. */
  has(moduleId: string, componentId: string): boolean {
    return this.map.has(key(moduleId, componentId));
  }

  /**
   * Every declared-wire prop across every registered component (Phase 1107), for
   * a teaching surface or an eval harness that needs to know an inner language
   * EXISTS — which a prop's JSON shape could never tell it. Components declaring
   * none contribute no rows.
   */
  describePayloadLanguages(): CustomPayloadCard[] {
    const cards: CustomPayloadCard[] = [];

    for (const entry of this.map.values()) {
      if (entry.payloadLanguages === undefined) continue;

      for (const [propKey, declaration] of Object.entries(entry.payloadLanguages)) {
        cards.push({
          moduleId: entry.moduleId,
          componentId: entry.componentId,
          key: propKey,
          language: declaration.language,
          ...(declaration.gate !== undefined ? { gate: payloadGateStamp(declaration.gate) } : {}),
        });
      }
    }

    return cards;
  }

  /**
   * The payload obligations a prop bag leaves outstanding for one registered
   * component — what this registry CANNOT judge, said out loud rather than
   * passed over. An unregistered pair yields none: the registry only speaks for
   * what it knows.
   */
  payloadObligations(
    moduleId: string,
    componentId: string,
    props: Readonly<Record<string, JsonValue>>,
  ): CustomPayloadObligation[] {
    return payloadObligationsFor(this.map.get(key(moduleId, componentId))?.payloadLanguages, props);
  }
}

/** Construct a fresh, empty per-instance registry. */
export const createCustomRendererRegistry = (): CustomRendererRegistry =>
  new CustomRendererRegistry();

/**
 * Free-function form of `registry.register` — `registerCustomRenderer(registry,
 * 'charts', 'sparkline', MySparkline)`. Returns the registry for chaining.
 */
export const registerCustomRenderer = (
  registry: CustomRendererRegistry,
  moduleId: string,
  componentId: string,
  render: CustomRenderer,
  contentHash?: ContentHash,
  payloadLanguages?: PayloadLanguages,
): CustomRendererRegistry =>
  registry.register(moduleId, componentId, render, contentHash, payloadLanguages);

/**
 * The action shape handed to a {@link FuaranRuntime.canDispatch} policy gate —
 * the TS mirror of the F# `Fuaran.UI.Renderer.Runtime.ActionDescriptor` (Phase
 * 119). Only the host-effecting / navigational / tool-invoking / file-reading
 * actions are gated; `Dispatch` / `SetState` / `Notify` / `CommitLocal` /
 * `WriteToClipboard` / `Chain` are not (matching the F# gated set).
 */
export type ActionDescriptor =
  | { readonly kind: 'Call'; readonly endpoint: string }
  | { readonly kind: 'Navigate'; readonly route: string }
  | { readonly kind: 'AiTool'; readonly toolName: string }
  | { readonly kind: 'ReadFileBody'; readonly fileId: string }
  // Phase 90 — the in-page `window.__fuaran.apply(opJson)` mutation routes
  // through the same default-deny gate (FGP 3); `summary` is the raw op JSON.
  // Append-only parity mirror of the F# `ActionDescriptor.ApplyTreeOp`.
  | { readonly kind: 'ApplyTreeOp'; readonly summary: string };

/** Render a descriptor for diagnostics — mirror of the F# `ActionDescriptor.describe`. */
export const describeActionDescriptor = (descriptor: ActionDescriptor): string => {
  switch (descriptor.kind) {
    case 'Call':
      return `Call(${descriptor.endpoint})`;
    case 'Navigate':
      return `Navigate(${descriptor.route})`;
    case 'AiTool':
      return `AiTool(${descriptor.toolName})`;
    case 'ReadFileBody':
      return `ReadFileBody(${descriptor.fileId})`;
    case 'ApplyTreeOp':
      return `ApplyTreeOp(${descriptor.summary})`;
  }
};

/**
 * The host effect substrate. `Action.Dispatch` / `Action.Chain` /
 * `Action.CommitLocal` are renderer-native; the other action kinds route
 * through these optional ports. An unwired port no-ops with a `warn`. The
 * custom-renderer registry rides on this record so the host wires one object.
 */
export interface FuaranRuntime {
  readonly registry?: CustomRendererRegistry;
  readonly call?: (endpoint: string, onResult: (raw: unknown) => void) => void;
  readonly notify?: (channel: string, payload: JsonValue) => void;
  readonly navigate?: (route: string) => void;
  readonly setState?: (key: string, value: JsonValue) => void;
  /**
   * Phase 423 — the declarative filter write seam, the Filter-channel twin of `setState`. A chip
   * whose `FilterKind.onChange` is omitted (the AI-authored shape) writes `$filters.<name>` here on
   * change; the host updates its filter state + re-renders (the TS renderer is host-driven, so it
   * has no built-in reactive store — the same model as `setState`). `value === undefined` clears the
   * key (a cleared `ChoiceFilter` choice). Unwired ⇒ the write warns and is dropped.
   */
  readonly setFilter?: (name: string, value: JsonValue | undefined) => void;
  /**
   * Phase 427 — the declarative selection write seam, the Selection-channel
   * twin of `setFilter`. A data-bearing grid whose `onRowClick` is omitted
   * (the AI-authored shape) writes the clicked row here under its own NodeId;
   * the host updates its `sources.selections[nodeId]` + re-renders, and every
   * `Binding.Selection` reader of that grid sees the row (decoded
   * master-detail). `value === undefined` clears the selection. Unwired ⇒ the
   * write warns and is dropped.
   */
  readonly setSelection?: (nodeId: string, value: JsonValue | undefined) => void;
  /**
   * Phase 428 — the declarative query-result write seam, the Query-channel
   * twin of `setState`. An `Action.Call` whose `into` is `{kind:'Query',name}`
   * writes the decoded response here on completion; the host updates its
   * `sources.queryResults[name]` + re-renders, and every `Binding.Query name`
   * reader sees the result (data-preserving per the Phase 421 identity
   * accessor). Unwired ⇒ the write warns and is dropped.
   */
  readonly setQueryResult?: (name: string, value: JsonValue) => void;
  readonly invokeAiTool?: (toolName: string, args: JsonValue) => void;
  readonly writeToClipboard?: (text: string) => void;
  /**
   * Phase 136 — read a selected file's body. `file.handle` carries the browser
   * `File` blob; `encoding` picks the byte→string projection; `onRead` fires
   * with the read body (async at the host level). An unwired port falls back to
   * a `FileReader` read in the browser (see `runAction`).
   */
  readonly readFileBody?: (
    file: FileRef,
    encoding: FileReadEncoding,
    onRead: (body: string) => void,
  ) => void;
  /**
   * Phase 159 — default-deny dispatch gate, the TS mirror of the F#
   * `IFuaranRuntime.CanDispatch` (Phase 119). `runAction` consults this BEFORE
   * the gated effects (`Call` / `Navigate` / `AiTool` / `ReadFileBody`) fire.
   * Return `false` to deny — the renderer emits a diagnostic via `warn` and
   * skips the effect. An ABSENT gate allows (so existing hosts behave exactly as
   * before, matching the F# default runtimes returning `true`). A standalone
   * host that hydrates a server-emitted tree it does not fully trust (e.g. the
   * in-browser-decode hydration path, or a BYOK playground) supplies this —
   * typically consulting a hydrated allowlist — so a decoded tree's `Navigate` /
   * `AiTool` / `Call` cannot fire unapproved.
   */
  readonly canDispatch?: (descriptor: ActionDescriptor) => boolean;
  /**
   * Phase 283/284 — dispatch a host-registered capability as an effect
   * (`Action.Invoke`). `runAction` gates this by shape (reusing the `AiTool`
   * descriptor — the closest gate surface for a named host invocation), then
   * calls this port; an ABSENT port warns rather than silently dropping,
   * matching the F# `runAction` Invoke arm (gate, then dispatch / diagnostic).
   * A host wires real capability dispatch + Phase-27 replay here.
   */
  readonly invokeCapability?: (capabilityId: string, args: readonly InvokeArg[]) => void;
  /**
   * Phase 1021 — the `NodeKind.Mount` GUEST LOADER seam. Return the guest tree
   * for a scope id, or `undefined` for "nothing mounted here" (the default: a
   * `Mount` in a host that wires no loader renders the inert placeholder, never
   * a throw).
   *
   * **A host supplies this and nothing else about the guest.** The `Mount` arm
   * owns the single call to it and derives the guest's runtime + channel from
   * `deriveGuestPrivilege` in the same expression, so a loader cannot construct
   * a privileged guest context — with no {@link guestSeam} wired the guest is
   * unprivileged and its channel is clamped to `OutOnly`. See
   * `guestPrivilege.ts` for the whole contract.
   *
   * The guest space is `unknown`-typed by design: the host's `TMsg` stays behind
   * the boundary, and a guest dispatch reaches the host only through
   * {@link bubbleGuestAction}.
   */
  readonly loadGuest?: (scopeId: string) => Node<unknown> | undefined;
  /**
   * Phase 1021 — where a mounted guest's dispatch surfaces in the host. The
   * out-channel of the `Mount` boundary: the guest's `Action.Dispatch` payload
   * arrives here, tagged with the scope it came from, after the host's
   * `GuestSeam.gateBubble` (when one is wired). An ABSENT port swallows guest
   * dispatches — inert, matching an unwired `onBubble` on the reference host.
   */
  readonly bubbleGuestAction?: (scopeId: string, action: unknown) => void;
  /**
   * Phase 1021 — the host's guest capability policy. **Absent means the guest is
   * UNPRIVILEGED**, not that it is ungated: it receives a deny-all runtime and an
   * `OutOnly` channel. Wire one to grant a mounted guest any capability, or a
   * `TwoWay` channel. See `guestPrivilege.ts`.
   */
  readonly guestSeam?: GuestSeam;
  readonly warn?: (message: string) => void;
}

export const emptyRuntime: FuaranRuntime = {};
