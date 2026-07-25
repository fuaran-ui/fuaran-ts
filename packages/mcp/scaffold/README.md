# Scaffold parity + conformance

The MCP `scaffold` tool emits integration boilerplate for two targets —
`ts-react` and `fsharp-fable`. Parity between them is a **tested guarantee**, not
an aspiration: an agent must never scaffold a broken (or divergent) wiring.

## The contract

Two halves, both enforced by [`../test/scaffold-parity.test.ts`](../test/scaffold-parity.test.ts):

1. **Structural parity** ([`parity.ts`](parity.ts)). Each target's emission must
   wire its SDK **and** its renderer — `@fuaran-ui/client` + `@fuaran-ui/renderer`
   for `ts-react`; `Fuaran.UI.Client` + `Fuaran.UI.Renderer` for `fsharp-fable` —
   and must bundle **no secret literal** (the server-proxied default keeps the
   token/key server-side).

2. **Behavioral parity.** The two SDK legs the scaffolds wire must produce the
   **same canonical tree** for the same turn against the local
   [`@fuaran-ui/mock`](../../mock). The TS leg runs the `@fuaran-ui/client` SDK
   directly; the F# leg runs the shipped `Fuaran.UI.Cli` dotnet tool (the F#
   `Fuaran.UI.Client` SDK, wired). Same mock, same prompt, identical tree.

## TS scaffold typecheck

The `ts-react` emission typechecks as emitted — asserted by this package's
existing scaffold tests. The `fsharp-fable` emission uses the same
`Fuaran.UI.Client` calls the `Fuaran.UI.Cli` tool compiles, and its SDK leg is
exercised by the behavioral-parity test above.

## CI

The structural checks + the TS behavioral leg run in the standard `vitest` pass
(no toolchain beyond Node). The cross-tier F# leg runs when the `Fuaran.UI.Cli`
dll is built (a runner with the .NET SDK) and **skips gracefully** otherwise, so
a Node-only CI still enforces the rest. A drift in either SDK that breaks a
scaffold's SDK leg fails this test.
