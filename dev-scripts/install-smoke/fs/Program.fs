// The nuget.org leg of the clean-machine install smoke — see ../README.md.
//
// The same tree the npm leg authors, through the F# tier's own ergonomic
// surface, printed through the same canonical encoder a consumer would reach
// for. Nothing here references this repository or any sibling checkout.
module Smoke

open Fuaran.UI
open Fuaran.UI.Types

[<EntryPoint>]
let main _ =
  let heading: Node<obj> =
    Fuaran.heading
      "smoke-heading"
      { Defaults.heading with
          Level = 1
          Text = TextSource.Literal "Clean-machine install smoke" }

  let metric: Node<obj> =
    Fuaran.metric
      "smoke-metric"
      { Defaults.metric with
          Label = TextSource.Literal "Revenue"
          Value = Binding.Static(Some 142500.0)
          Format = CellFormat.Currency "GBP"
          Tone = ToneVariant.Brand }

  printfn "%s" (Fuaran.UI.Generated.encodeNode (Fuaran.dashboard "smoke" { Children = [ heading; metric ] }))
  0
