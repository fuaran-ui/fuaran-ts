// @fuaran-ui/react — the render half of the adapter.
//
// `useFuaranGenerate` owns the tree; this renders it through
// `@fuaran-ui/renderer` and gives the three non-ready states a sensible default
// so a caller does not hand-write the same `undefined` / error branches. Pass
// `loading` / `empty` / `renderError` to override any of them.

import type { ReactElement, ReactNode } from 'react';

import { FuaranRenderer, type FuaranRendererProps } from '@fuaran-ui/renderer';

import type { FuaranTurnError, UseFuaranGenerateResult } from './useFuaranGenerate.js';

/** Human-readable one-liner for a turn failure — the default error rendering. */
export function describeTurnError(error: FuaranTurnError): string {
  switch (error.kind) {
    case 'accessDenied':
      return `Access denied: ${error.reason}`;
    case 'turnFailed':
      return `The ${error.error.stage} stage failed (${error.error.code}): ${error.error.message}`;
    case 'decodeFailed':
      return `The response was not a decodable tree at ${error.error.path}: ${error.error.message}`;
  }
}

export interface FuaranGeneratedProps<TMsg = unknown> extends Omit<
  FuaranRendererProps<TMsg>,
  'tree'
> {
  /** The value returned by {@link useFuaranGenerate}. */
  readonly state: UseFuaranGenerateResult<TMsg>;
  /** Shown while a turn is in flight. Defaults to a polite status line. */
  readonly loading?: ReactNode;
  /** Shown before the first tree exists. Defaults to nothing. */
  readonly empty?: ReactNode;
  /** Shown when the last turn failed. Defaults to a `role="alert"` line. */
  readonly renderError?: (error: FuaranTurnError) => ReactNode;
}

/**
 * Render the tree a {@link useFuaranGenerate} loop is holding.
 *
 * ```tsx
 * const state = useFuaranGenerate({ client });
 * return <FuaranGenerated state={state} />;
 * ```
 */
export function FuaranGenerated<TMsg = unknown>(
  props: FuaranGeneratedProps<TMsg>,
): ReactElement | null {
  const { state, loading, empty, renderError, ...rendererProps } = props;

  // A held tree keeps rendering while the next turn is in flight, so the UI does
  // not blank out mid-edit; the loading slot only shows when there is nothing yet.
  if (state.tree !== undefined) {
    return <FuaranRenderer<TMsg> {...rendererProps} tree={state.tree} />;
  }

  if (state.status === 'generating') {
    return <>{loading ?? <p role="status">Generating…</p>}</>;
  }

  if (state.error !== undefined) {
    return (
      <>
        {renderError !== undefined ? (
          renderError(state.error)
        ) : (
          <p role="alert">{describeTurnError(state.error)}</p>
        )}
      </>
    );
  }

  return empty !== undefined ? <>{empty}</> : null;
}
