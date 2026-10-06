// @fuaran-ui/observer-core — workspace-internal. The observer scaffolding the
// layout and style observers share; each bundles it into its own dist.

export {
  browserSurface,
  createInMemoryObserver,
  createObserver,
  type BrowserConfig,
  type BrowserObserver,
  type BrowserSurface,
  type DeriveConfig,
  type Discovery,
  type ElementWatcher,
  type EmissionPolicy,
  type Flagged,
  type InMemoryConfig,
  type InMemoryObserver,
  type MutationWatcher,
  type ObservationSubscriber,
  type Observer,
} from './observer.js';

export { useObserver, type HookedObserver, type ObserverHookArgs } from './useObserver.js';
