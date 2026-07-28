// ============================================================================
//  @fuaran-ui/renderer/changeHub — the committed-tree-change signal.
//
//  The in-page introspection surface (`debugGlobal.ts`) is REBUILT on every
//  committed tree change: the renderer's registration effect closes over the
//  live tree, so a new tree means a new surface object. A change subscription
//  registered on one surface instance would therefore be silently dropped by
//  the very event it exists to report.
//
//  The hub is the fix: subscriptions live here, outside any one surface
//  instance, so `subscribe(cb)` survives every rebuild. It also owns the
//  **tree revision** — an opaque token that changes whenever the tree does, the
//  staleness signal a reader compares for equality and never parses.
//
//  Coalescing: notification is deferred to a microtask and collapses every
//  commit made in the same turn into ONE notification carrying the LATEST
//  revision. A change is a staleness signal, not a change log — a reader that
//  needs the new state re-reads it. This also collapses the natural double-fire
//  of an in-page apply (the apply path commits, then the host's re-render
//  registers a fresh surface for the same tree), with the `apply` cause winning
//  over `host` because it is the more specific answer.
// ============================================================================

/** Why the tree changed. `apply` — an in-page/relayed `TreeOp` did it; `host` — the host changed its own tree. */
export type ChangeCause = 'apply' | 'host';

/** One committed tree change: the revision after the change, and what caused it. */
export interface TreeChange {
  readonly treeRevision: string;
  readonly cause: ChangeCause;
}

/** A change subscriber. Registered with {@link ChangeHub.subscribe}. */
export type ChangeListener = (change: TreeChange) => void;

/**
 * The committed-tree-change hub — revision ownership plus the subscription
 * registry that outlives any single introspection-surface instance.
 */
export interface ChangeHub {
  /** The current tree-revision token. Opaque: compare for equality, never parse. */
  revision(): string;
  /**
   * Register a listener for committed tree changes. Returns an unsubscribe
   * handle; calling it twice is harmless. Never polls — the hub pushes.
   */
  subscribe(listener: ChangeListener): () => void;
  /**
   * Record a committed tree change and return the resulting revision.
   * Idempotent on tree identity: committing the SAME tree object twice bumps
   * nothing and notifies nobody, so a re-registration caused by a `sources` or
   * `runtime` change is not reported as a tree change.
   */
  commit(tree: object, cause: ChangeCause): string;
}

/** Schedule `run` on the microtask queue (falling back to a resolved promise). */
const soon = (run: () => void): void => {
  if (typeof queueMicrotask === 'function') queueMicrotask(run);
  else void Promise.resolve().then(run);
};

/** Build an isolated change hub. Hosts (and tests) that want their own signal use this. */
export const createChangeHub = (): ChangeHub => {
  const listeners = new Set<ChangeListener>();
  let counter = 0;
  let current = 'r-0';
  let lastTree: object | undefined;
  let pendingCause: ChangeCause | undefined;
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    const cause = pendingCause;
    pendingCause = undefined;
    if (cause === undefined) return;
    const change: TreeChange = { treeRevision: current, cause };
    // Snapshot: a listener that unsubscribes (or subscribes) during delivery
    // must not perturb this delivery pass.
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch {
        /* a failing subscriber never breaks the notification of the others */
      }
    }
  };

  return {
    revision: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    commit: (tree, cause) => {
      if (tree === lastTree) return current;
      lastTree = tree;
      counter += 1;
      current = `r-${counter}`;
      // `apply` is the more specific cause and wins the coalesced window.
      pendingCause = pendingCause === 'apply' ? 'apply' : cause;
      if (!scheduled) {
        scheduled = true;
        soon(flush);
      }
      return current;
    },
  };
};

/**
 * The page-wide hub the renderer's debug surface uses by default. One page,
 * one tree-revision sequence — so two `<FuaranRenderer debug>` instances do not
 * hand a reader two conflicting notions of "current".
 */
export const pageChangeHub: ChangeHub = createChangeHub();
