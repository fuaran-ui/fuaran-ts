# Regenerating the cross-host vector file

`test/vectors/cross-host-vectors.json` is a **committed artefact**, not a build output. It carries
several hundred documents together with the canonical bytes and the digests that an **independent
implementation of `canonical-json-sha256-v1`, written in another language**, produces for them. It is
what turns "this implementation agrees with itself" into "two implementations of a registered
algorithm agree", which is the only form of that claim worth anything: nothing downstream of a minted
content address is permitted to check it, so a divergence between two producers surfaces as a join
that silently misses rather than as an error anyone sees.

## When to regenerate

Only when the **rule** changes, or when the other implementation's population of generated documents
is deliberately extended. A regeneration is reviewed as a diff: an unchanged rule re-emits
byte-identically (the generator is seeded and its traversal is deterministic), so any diff at all is
a change in behaviour and wants a human reading it.

**Never regenerate to make a failing test pass.** A divergence is a genuine disagreement about a
registered algorithm; it is resolved against the specification, and the loser changes its code.

## How

1. In the repository holding the other implementation, emit the file to a scratch path. That
   repository's own test project carries the emitter — the invocation is
   `--emit-cross-host-vectors <path>` on its test binary. (The path is deliberately explicit rather
   than defaulted: one repository's layout should not be baked into another's tooling.)
2. Adopt it here:

   ```
   node scripts/regenerate-cross-host-vectors.mjs <path-to-emitted-file>
   ```

   The script checks shape and provenance only — the declared algorithm identifier, the counts
   against the arrays, unique ids, well-formed content addresses, known refusal names, and that the
   population has not silently shrunk. It deliberately does **not** check that the expectations agree
   with this implementation: a script that filtered out disagreements before they reached the test
   suite would replace the gate with a tautology.

3. `pnpm test` in this package. A red run at this point is the gate doing its job.

## Why the file is read rather than imported

`test/vectors.ts` loads it with `readFileSync` and throws a message naming what is missing and how to
restore it. An `import` of a missing JSON file fails as a module-resolution error, which reads like a
broken build rather than a missing gate — and a missing gate that reads like a build problem is a
missing gate somebody routes around.
