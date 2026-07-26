// @fuaran-ui/client — the typed repair loop.
//
// The endpoint already returns a recoverable envelope (stage + code + a
// model-facing message that, for the `apply` stage, carries the §3.6 apply-error
// hint). The closed loop that distinguishes Fuaran from a raw LLM call is
// "emit -> apply -> recover -> re-emit": on a repairable failure, thread the
// hint back into the next turn so the emission self-corrects. This makes that a
// first-class, one-call SDK affordance instead of manual plumbing, with a
// caller-set bound so it never loops forever.
//
// Parity: `fuaran-dotnet/src/Fuaran.UI.Client/Repair.fs` mirrors `isRepairable`, the
// `threadHint` prompt augmentation (byte-identical marker text), and the bounded
// `generateWithRepair` loop.

import type { GenerateArgs, RecoverableError, TurnResult, TurnStage } from './contract.js';
import type { FuaranClient } from './client.js';

/** The marker prefixing a threaded repair hint in the next prompt — kept
 *  byte-identical to the F# client so parity fixtures match. */
export const HINT_MARKER = '[repair]';

/** A failure is *repairable* when re-emitting against its hint can plausibly fix
 *  it: the `apply` stage (the emission addressed a non-existent node / the §3.6
 *  default-deny gate) and the `parse` stage (a malformed emission). An
 *  `access-token` failure (bad credential) and a `provider` failure (transport /
 *  provider error) are terminal — retrying the same call will not help, so the
 *  loop surfaces them immediately. */
export function isRepairable(stage: TurnStage): boolean {
  return stage === 'apply' || stage === 'parse';
}

/** Thread a recoverable error's hint into the next turn's prompt. The original
 *  prompt is preserved and the current tree carried, so the turn stays a repair;
 *  the model sees the stage, code, and the (§3.6) hint it must re-emit against. */
export function threadHint(args: GenerateArgs, error: RecoverableError): GenerateArgs {
  const augmented = `${args.prompt}\n\n${HINT_MARKER} the previous emission was rejected at the ${error.stage} stage (${error.code}). Re-emit against this: ${error.message}`;
  return { ...args, prompt: augmented };
}

/** Options for {@link generateWithRepair}. */
export interface RepairOptions {
  /** The maximum number of repair re-issues after the first attempt. `0` is a
   *  single attempt (no repair). Defaults to `2`. */
  readonly maxRetries?: number;
}

/** Run a generation turn with the closed repair loop. On a repairable
 *  `turnFailed`, re-issue the turn with the hint threaded in, up to `maxRetries`
 *  times; a `produced` / `accessDenied` / terminal failure ends the loop
 *  immediately, and the final envelope is surfaced when the retries are
 *  exhausted. */
export async function generateWithRepair(
  client: FuaranClient,
  args: GenerateArgs,
  options?: RepairOptions,
): Promise<TurnResult> {
  let remaining = Math.max(0, options?.maxRetries ?? 2);
  let attemptArgs = args;

  for (;;) {
    const result = await client.generate(attemptArgs);
    if (result.kind === 'turnFailed' && remaining > 0 && isRepairable(result.error.stage)) {
      attemptArgs = threadHint(attemptArgs, result.error);
      remaining -= 1;
      continue;
    }
    return result;
  }
}
