// ============================================================================
//  @fuaran-ui/observer-core — the observer scaffolding the layout and style
//  observers share (Phase 2075).
//
//  Both published observers are the same machine over a different reading of
//  an element: a registry of addressable nodes, a subscriber list whose
//  members cannot poison each other, change detection on the derived flags,
//  and — in the browser — `[data-fuaran-node-id]` self-discovery, a
//  MutationObserver rescan, and an animation-frame flush with a wall-clock
//  debounce. This module is that machine once, generic over the INPUT read
//  from an element and the OBSERVATION derived from it. What differs stays in
//  each package: the snapshot, the derivation, and how changes are DISCOVERED
//  (geometry via ResizeObserver; resolved style via attribute mutations).
//
//  PRIVATE and unpublished: each observer package bundles this code into its
//  own dist, and keeps its public classes and hook as thin wrappers, so no
//  public import path names this package.
// ============================================================================

/** Handler signature for `subscribe` — receives `(nodeId, observation)`. */
export type ObservationSubscriber<Obs> = (nodeId: string, observation: Obs) => void;

/** The observer contract both packages publish under their own names. */
export interface Observer<Obs> {
  observe(nodeId: string): Obs | undefined;
  observeTree(rootNodeId: string): Obs[];
  subscribe(handler: ObservationSubscriber<Obs>): () => void;
  register(nodeId: string, element?: unknown): void;
  unregister(nodeId: string): void;
}

/** The emission policy both option records carry. */
export interface EmissionPolicy {
  readonly debounceMs: number;
  readonly emitOnFlagChangeOnly: boolean;
}

/** An observation carries the flags its change detection compares. */
export interface Flagged<Flag> {
  readonly flags: readonly Flag[];
}

/** What every observer needs to turn an input into an emission decision. */
export interface DeriveConfig<Input, Obs extends Flagged<Flag>, Flag> {
  readonly policy: EmissionPolicy;
  /** Derive the observation (and its flags) for one node's input. */
  readonly derive: (nodeId: string, input: Input) => Obs;
  readonly flagsEqual: (a: readonly Flag[], b: readonly Flag[]) => boolean;
}

/** A subscriber list in which one throwing handler cannot starve the others. */
const subscriberList = <Obs>() => {
  const handlers: ObservationSubscriber<Obs>[] = [];
  return {
    add(handler: ObservationSubscriber<Obs>): () => void {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    emit(nodeId: string, obs: Obs): void {
      for (const handler of handlers) {
        try {
          handler(nodeId, obs);
        } catch {
          // A subscriber throwing must not poison sibling subscribers.
        }
      }
    },
  };
};

// ─── In-memory ───────────────────────────────────────────────────────────────

/** The fixture-driven observer: the shared contract plus fixture registration. */
export interface InMemoryObserver<Input, Obs> extends Observer<Obs> {
  /** Register or replace a fixture; fires an initial emission unconditionally. */
  registerFixture(nodeId: string, input: Input, parent?: string): void;
  /** Replace a registered node's input; honours `emitOnFlagChangeOnly`. No-op if absent. */
  update(nodeId: string, input: Input): void;
}

export interface InMemoryConfig<Input, Obs extends Flagged<Flag>, Flag> extends DeriveConfig<
  Input,
  Obs,
  Flag
> {
  /** The input a bare `register` (no fixture) records, so a renderer mount hook
   * calling it on the in-memory observer does not crash. */
  readonly baseline: () => Input;
}

interface Fixture<Input> {
  readonly input: Input;
  readonly parent?: string;
}

/**
 * The substrate-free observer: fixtures in, observations out. `observeTree`
 * walks a parent-pointer graph breadth-first, so the result is deterministic
 * by tree level then insertion order (the browser observer's DOM walk is the
 * production path).
 */
export const createInMemoryObserver = <Input, Obs extends Flagged<Flag>, Flag>(
  config: InMemoryConfig<Input, Obs, Flag>,
): InMemoryObserver<Input, Obs> => {
  const registry = new Map<string, Fixture<Input>>();
  const lastFlags = new Map<string, readonly Flag[]>();
  const subscribers = subscriberList<Obs>();

  const registerFixture = (nodeId: string, input: Input, parent?: string): void => {
    registry.set(nodeId, parent !== undefined ? { input, parent } : { input });
    const obs = config.derive(nodeId, input);
    lastFlags.set(nodeId, obs.flags);
    subscribers.emit(nodeId, obs);
  };

  return {
    registerFixture,
    update(nodeId, input) {
      const existing = registry.get(nodeId);
      if (existing === undefined) return;
      registry.set(
        nodeId,
        existing.parent !== undefined ? { input, parent: existing.parent } : { input },
      );
      const obs = config.derive(nodeId, input);
      const previous = lastFlags.get(nodeId) ?? [];
      lastFlags.set(nodeId, obs.flags);
      const shouldEmit = config.policy.emitOnFlagChangeOnly
        ? !config.flagsEqual(obs.flags, previous)
        : true;
      if (shouldEmit) subscribers.emit(nodeId, obs);
    },
    observe(nodeId) {
      const fixture = registry.get(nodeId);
      return fixture === undefined ? undefined : config.derive(nodeId, fixture.input);
    },
    observeTree(rootNodeId) {
      if (!registry.has(rootNodeId)) return [];
      const children = new Map<string, string[]>();
      for (const [nodeId, fixture] of registry) {
        if (fixture.parent !== undefined) {
          const bucket = children.get(fixture.parent) ?? [];
          bucket.push(nodeId);
          children.set(fixture.parent, bucket);
        }
      }
      const acc: Obs[] = [];
      const queue: string[] = [rootNodeId];
      while (queue.length > 0) {
        const nodeId = queue.shift()!;
        const fixture = registry.get(nodeId);
        if (fixture !== undefined) acc.push(config.derive(nodeId, fixture.input));
        queue.push(...(children.get(nodeId) ?? []));
      }
      return acc;
    },
    subscribe: (handler) => subscribers.add(handler),
    register(nodeId) {
      if (!registry.has(nodeId)) registerFixture(nodeId, config.baseline());
    },
    unregister(nodeId) {
      registry.delete(nodeId);
      lastFlags.delete(nodeId);
    },
  };
};

// ─── Browser ─────────────────────────────────────────────────────────────────

/** A MutationObserver-shaped object, generic over the init record its owner
 * declares (each package publishes its own slice). */
export interface MutationWatcher<Init> {
  observe(target: Node, options: Init): void;
  disconnect(): void;
}

/** An extra per-element change source — the layout observer's ResizeObserver. */
export interface ElementWatcher {
  observe(element: Element): void;
  unobserve(element: Element): void;
  disconnect(): void;
}

/** How an observer DISCOVERS that a registered node needs re-reading. */
export interface Discovery<Init> {
  /** The init record the root MutationObserver is armed with. */
  readonly mutationInit: Init;
  /** Re-schedule every still-present node on any mutation (resolved style
   * changes on attribute mutations); `false` reschedules only new nodes. */
  readonly rescheduleOnMutation: boolean;
  /** An optional per-element watcher, built once, that calls `schedule` with an
   * element whose input may have changed. */
  readonly watch?: (schedule: (element: Element) => void) => ElementWatcher;
}

/** The resolved browser surface — every field already defaulted by the caller. */
export interface BrowserSurface<Init> {
  readonly root: Element;
  readonly now: () => number;
  readonly requestFrame: (cb: () => void) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly MutationObserverCtor: new (cb: () => void) => MutationWatcher<Init>;
}

export interface BrowserConfig<Input, Obs extends Flagged<Flag>, Flag, Init> extends DeriveConfig<
  Input,
  Obs,
  Flag
> {
  readonly surface: BrowserSurface<Init>;
  /** Read the input from a registered element. */
  readonly snapshot: (element: Element) => Input;
  readonly discover: Discovery<Init>;
}

/** The browser observer: the shared contract plus teardown. */
export interface BrowserObserver<Obs> extends Observer<Obs> {
  /** Disconnect every watcher and cancel any pending frame. Idempotent. */
  dispose(): void;
}

/** Default an injectable surface from the live browser globals. */
export const browserSurface = <Init>(deps: {
  readonly root?: Element;
  readonly now?: () => number;
  readonly requestFrame?: (cb: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly MutationObserverCtor?: new (cb: () => void) => MutationWatcher<Init>;
}): BrowserSurface<Init> => ({
  root: deps.root ?? (globalThis as { document?: { body: Element } }).document!.body,
  now: deps.now ?? (() => performance.now()),
  requestFrame: deps.requestFrame ?? ((cb) => requestAnimationFrame(cb)),
  cancelFrame: deps.cancelFrame ?? ((h) => cancelAnimationFrame(h)),
  MutationObserverCtor:
    deps.MutationObserverCtor ??
    (globalThis as { MutationObserver?: new (cb: () => void) => MutationWatcher<Init> })
      .MutationObserver!,
});

const NODE_ID = 'data-fuaran-node-id';

/**
 * The self-discovering browser observer. Discovers addressable elements via
 * `[data-fuaran-node-id]` (the attribute the renderer emits on every node
 * wrapper), re-reads them on the animation-frame flush, derives flags, and
 * emits per the debounce + change-detection policy: the first emission of a
 * node is unconditional, later ones respect `debounceMs` and, under
 * `emitOnFlagChangeOnly`, a change in the flags.
 */
export const createObserver = <Input, Obs extends Flagged<Flag>, Flag, Init>(
  config: BrowserConfig<Input, Obs, Flag, Init>,
): BrowserObserver<Obs> => {
  const { surface, policy, discover } = config;
  const registry = new Map<string, Element>();
  const lastFlags = new Map<string, readonly Flag[]>();
  const lastEmitAt = new Map<string, number>();
  const lastObservation = new Map<string, Obs>();
  const subscribers = subscriberList<Obs>();
  const pending = new Set<string>();
  let rafHandle: number | undefined = undefined;
  let disposed = false;

  const build = (nodeId: string, element: Element): Obs =>
    config.derive(nodeId, config.snapshot(element));

  const flush = (): void => {
    rafHandle = undefined;
    const nowMs = surface.now();
    const due = [...pending];
    pending.clear();
    for (const nodeId of due) {
      const element = registry.get(nodeId);
      if (element === undefined) continue;
      const obs = build(nodeId, element);
      const previousFlags = lastFlags.get(nodeId) ?? [];
      const previousEmitAt = lastEmitAt.get(nodeId) ?? -1;
      const initial = previousEmitAt < 0;
      const respectsDebounce = initial || nowMs - previousEmitAt >= policy.debounceMs;
      const flagsChanged = !config.flagsEqual(obs.flags, previousFlags);
      const shouldEmit =
        respectsDebounce && (initial || (policy.emitOnFlagChangeOnly ? flagsChanged : true));
      lastObservation.set(nodeId, obs);
      if (shouldEmit) {
        lastFlags.set(nodeId, obs.flags);
        lastEmitAt.set(nodeId, nowMs);
        subscribers.emit(nodeId, obs);
      }
    }
  };

  const scheduleFlush = (nodeId: string): void => {
    pending.add(nodeId);
    if (rafHandle === undefined) rafHandle = surface.requestFrame(flush);
  };

  const watcher = discover.watch?.((target) => {
    for (const [nodeId, element] of registry) {
      if (element === target) {
        scheduleFlush(nodeId);
        break;
      }
    }
  });

  const registerElement = (nodeId: string, element: Element): void => {
    if (!registry.has(nodeId)) {
      registry.set(nodeId, element);
      watcher?.observe(element);
      scheduleFlush(nodeId);
    }
  };

  const unregisterElement = (nodeId: string): void => {
    const element = registry.get(nodeId);
    if (element === undefined) return;
    watcher?.unobserve(element);
    registry.delete(nodeId);
    lastFlags.delete(nodeId);
    lastEmitAt.delete(nodeId);
    lastObservation.delete(nodeId);
  };

  const scan = (): Set<string> => {
    const seen = new Set<string>();
    for (const element of surface.root.querySelectorAll(`[${NODE_ID}]`)) {
      const nodeId = element.getAttribute(NODE_ID);
      if (nodeId) {
        seen.add(nodeId);
        registerElement(nodeId, element);
        if (discover.rescheduleOnMutation) scheduleFlush(nodeId);
      }
    }
    return seen;
  };

  const rescan = (): void => {
    const seen = scan();
    for (const nodeId of [...registry.keys()]) {
      if (!seen.has(nodeId)) unregisterElement(nodeId);
    }
  };

  const mutationObserver = new surface.MutationObserverCtor(rescan);
  scan();
  mutationObserver.observe(surface.root, discover.mutationInit);

  return {
    observe(nodeId) {
      const element = registry.get(nodeId);
      if (element !== undefined) return build(nodeId, element);
      return lastObservation.get(nodeId);
    },
    observeTree(rootNodeId) {
      const rootEl = registry.get(rootNodeId);
      if (rootEl === undefined) return [];
      const result = [build(rootNodeId, rootEl)];
      for (const element of rootEl.querySelectorAll(`[${NODE_ID}]`)) {
        const nodeId = element.getAttribute(NODE_ID);
        if (nodeId) result.push(build(nodeId, element));
      }
      return result;
    },
    subscribe: (handler) => subscribers.add(handler),
    register(nodeId, element) {
      if (element instanceof Element) registerElement(nodeId, element);
    },
    unregister: unregisterElement,
    dispose() {
      if (disposed) return;
      disposed = true;
      watcher?.disconnect();
      mutationObserver.disconnect();
      if (rafHandle !== undefined) surface.cancelFrame(rafHandle);
    },
  };
};
