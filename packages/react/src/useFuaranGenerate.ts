// @fuaran-ui/react — the `useFuaranGenerate` hook.
//
// The framework-idiomatic layer over `@fuaran-ui/client`: the hook OWNS the
// current tree as React state, so the turn-loop is automatic — the first prompt
// is a fresh generation and every prompt after it is a cheap **repair diff**
// against the tree the last turn produced. The caller never threads
// `currentTreeJson` by hand.
//
// `repair` additionally runs the Phase 225 closed loop: on an apply/parse-stage
// rejection it threads the endpoint's hint back into the next turn (bounded), so
// a rejected emission self-corrects without the caller plumbing anything.

import { useCallback, useMemo, useRef, useState } from 'react';

import type { Node } from '@fuaran-ui/schema';
import type { DecodeError } from '@fuaran-ui/ops';
import {
  generateWithRepair,
  type FuaranClient,
  type GenerateArgs,
  type RecoverableError,
  type TurnResult,
} from '@fuaran-ui/client';
import { decodeProducedTree } from '@fuaran-ui/client/render';

/** Why the last turn did not yield a renderable tree. Discriminated so a caller
 *  branches on the cause rather than on a string. */
export type FuaranTurnError =
  | { readonly kind: 'accessDenied'; readonly reason: string }
  | { readonly kind: 'turnFailed'; readonly error: RecoverableError }
  | { readonly kind: 'decodeFailed'; readonly error: DecodeError };

/** Where the hook is in the turn cycle. */
export type FuaranGenerateStatus = 'idle' | 'generating' | 'ready' | 'error';

/** Per-call options — everything a {@link GenerateArgs} carries except `prompt`
 *  (the argument) and `currentTreeJson` (the hook supplies it). */
export type FuaranTurnOptions = Omit<GenerateArgs, 'prompt' | 'currentTreeJson'>;

export interface UseFuaranGenerateOptions {
  /** The client the hook drives. Construct it once (e.g. `useMemo`) so the hook
   *  is not handed a new client every render. */
  readonly client: FuaranClient;
  /** Seed with an existing tree's canonical wire JSON so the first turn is
   *  already a repair. Omit to start with a fresh generation. */
  readonly initialTreeJson?: string;
  /** Maximum repair re-issues inside {@link UseFuaranGenerateResult.repair}.
   *  Defaults to the SDK default (2). */
  readonly maxRepairRetries?: number;
}

export interface UseFuaranGenerateResult<TMsg = unknown> {
  /** The decoded tree, ready to hand to `<FuaranRenderer tree={tree} />`.
   *  `undefined` until a turn has produced one. */
  readonly tree: Node<TMsg> | undefined;
  /** Canonical wire JSON of the held tree — the thing the next turn repairs. */
  readonly treeJson: string | undefined;
  readonly status: FuaranGenerateStatus;
  /** The last turn's failure, or `undefined` when the last turn succeeded. */
  readonly error: FuaranTurnError | undefined;
  /** True while a turn is in flight (also `status === 'generating'`). */
  readonly busy: boolean;
  /** Run a turn. Automatically a repair diff once a tree is held. */
  readonly generate: (prompt: string, options?: FuaranTurnOptions) => Promise<TurnResult>;
  /** Run a turn with the closed repair loop — an apply/parse rejection threads
   *  the endpoint's hint into the next attempt, bounded by `maxRepairRetries`. */
  readonly repair: (prompt: string, options?: FuaranTurnOptions) => Promise<TurnResult>;
  /** Forget the held tree, so the next turn is a fresh generation again. */
  readonly reset: () => void;
}

/**
 * Own the prompt→UI turn-loop as React state.
 *
 * ```tsx
 * const client = useMemo(() => new FuaranClient({ endpoint: '/api/fuaran' }), []);
 * const { tree, generate, busy } = useFuaranGenerate({ client });
 * // …
 * {tree !== undefined && <FuaranRenderer tree={tree} />}
 * ```
 */
export function useFuaranGenerate<TMsg = unknown>(
  options: UseFuaranGenerateOptions,
): UseFuaranGenerateResult<TMsg> {
  const { client, initialTreeJson, maxRepairRetries } = options;

  const [treeJson, setTreeJson] = useState<string | undefined>(initialTreeJson);
  const [tree, setTree] = useState<Node<TMsg> | undefined>(undefined);
  const [status, setStatus] = useState<FuaranGenerateStatus>('idle');
  const [error, setError] = useState<FuaranTurnError | undefined>(undefined);

  // The held tree is read inside async callbacks, so keep a ref alongside the
  // state to avoid a stale closure when two turns are issued back to back.
  const treeJsonRef = useRef<string | undefined>(initialTreeJson);

  /** Fold a turn's outcome into hook state; returns the result unchanged so the
   *  caller can branch on it too. */
  const absorb = useCallback((result: TurnResult): TurnResult => {
    if (result.kind === 'produced') {
      const decoded = decodeProducedTree<TMsg>(result);
      if (decoded.ok) {
        treeJsonRef.current = result.treeJson;
        setTreeJson(result.treeJson);
        setTree(decoded.tree);
        setError(undefined);
        setStatus('ready');
      } else {
        // The turn produced, but the payload is not a decodable tree — surface
        // it as a decode failure and leave the held tree untouched.
        setError({ kind: 'decodeFailed', error: decoded.error });
        setStatus('error');
      }
      return result;
    }

    // Non-produced outcomes never advance the held tree, so the caller can retry
    // the same repair against it.
    setError(
      result.kind === 'accessDenied'
        ? { kind: 'accessDenied', reason: result.reason }
        : { kind: 'turnFailed', error: result.error },
    );
    setStatus('error');
    return result;
  }, []);

  const buildArgs = useCallback((prompt: string, turnOptions?: FuaranTurnOptions): GenerateArgs => {
    const held = treeJsonRef.current;
    return {
      prompt,
      ...(held !== undefined ? { currentTreeJson: held } : {}),
      ...turnOptions,
    };
  }, []);

  const generate = useCallback(
    async (prompt: string, turnOptions?: FuaranTurnOptions): Promise<TurnResult> => {
      setStatus('generating');
      return absorb(await client.generate(buildArgs(prompt, turnOptions)));
    },
    [absorb, buildArgs, client],
  );

  const repair = useCallback(
    async (prompt: string, turnOptions?: FuaranTurnOptions): Promise<TurnResult> => {
      setStatus('generating');
      const result = await generateWithRepair(
        client,
        buildArgs(prompt, turnOptions),
        maxRepairRetries !== undefined ? { maxRetries: maxRepairRetries } : {},
      );
      return absorb(result);
    },
    [absorb, buildArgs, client, maxRepairRetries],
  );

  const reset = useCallback(() => {
    treeJsonRef.current = undefined;
    setTreeJson(undefined);
    setTree(undefined);
    setError(undefined);
    setStatus('idle');
  }, []);

  return useMemo(
    () => ({
      tree,
      treeJson,
      status,
      error,
      busy: status === 'generating',
      generate,
      repair,
      reset,
    }),
    [tree, treeJson, status, error, generate, repair, reset],
  );
}
