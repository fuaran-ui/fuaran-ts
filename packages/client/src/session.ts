// @fuaran-ui/client — the turn-loop helper.
//
// A session holds the current tree between turns so each subsequent prompt is a
// *repair* against it (a cheap diff), not a from-scratch regeneration — the
// token-saving ergonomic the whole model hinges on. The first `next(prompt)` is
// a fresh generation; once a turn produces a tree the session remembers it, and
// the next `next(prompt)` sends it as `currentTreeJson` automatically.

import type { GenerateArgs, TurnResult } from './contract.js';
import type { FuaranClient } from './client.js';

/** Per-call options for {@link FuaranSession.next} — everything a
 *  {@link GenerateArgs} carries except `prompt` (the positional arg) and
 *  `currentTreeJson` (the session supplies it). */
export type SessionTurnOptions = Omit<GenerateArgs, 'prompt' | 'currentTreeJson'>;

/** Options for constructing a {@link FuaranSession}. */
export interface FuaranSessionOptions {
  /** Seed the session with an existing tree (its canonical wire JSON) so the
   *  first turn is already a repair. Omit to start with a fresh generation. */
  readonly initialTreeJson?: string;
}

/** A turn loop over a {@link FuaranClient} that carries the current tree forward.
 *  Stateful by design — one session is one editing conversation. */
export class FuaranSession {
  readonly #client: FuaranClient;
  #currentTreeJson: string | undefined;

  constructor(client: FuaranClient, options?: FuaranSessionOptions) {
    this.#client = client;
    this.#currentTreeJson = options?.initialTreeJson;
  }

  /** The canonical wire JSON of the tree the session is holding, or `undefined`
   *  before the first produced turn. */
  get currentTreeJson(): string | undefined {
    return this.#currentTreeJson;
  }

  /** Run the next turn. The held tree (if any) is sent as `currentTreeJson`, so
   *  this prompt repairs it rather than regenerating. On a `produced` result the
   *  session advances to the new tree; on `accessDenied` / `turnFailed` the held
   *  tree is left unchanged, so the caller can retry the same repair. */
  async next(prompt: string, options?: SessionTurnOptions): Promise<TurnResult> {
    const args: GenerateArgs = {
      prompt,
      ...(this.#currentTreeJson !== undefined ? { currentTreeJson: this.#currentTreeJson } : {}),
      ...options,
    };
    const result = await this.#client.generate(args);
    if (result.kind === 'produced') {
      this.#currentTreeJson = result.treeJson;
    }
    return result;
  }

  /** Forget the held tree — the next turn is a fresh generation again. */
  reset(): void {
    this.#currentTreeJson = undefined;
  }
}
