// ============================================================================
//  Phase 1914 — certify the schema-to-form parity table against the reference
//  host (`Fuaran.UI.SchemaForm`, Phase 1816).
//
//  `fixtures/schema-form-parity.json` is a PAIRED test table: each case is a
//  schema (as TEXT, so member order, duplicate members and number literals
//  reach both hosts exactly as written) and the outcome the reference host
//  derives from it — the Form's canonical wire, or the refusal envelope.
//  `schemaForm.test.ts` holds this host to those bytes; this script is the
//  other half, and re-running it is how the table is re-certified after a
//  change to the mapping on either side.
//
//  The expected wire is the reference host's CANONICAL encoding
//  (`CanonicalJson.encodeNode`), the codec the wire-format corpus certifies.
//  The script also compares it with `SchemaForm.deriveWireFromText`, the
//  reference host's own tool/CLI output, and prints every case where the two
//  differ — each such line is a reference-host defect to fix there, never a
//  reason to edit the table by hand.
//
//  Usage — from a checkout with `fuaran-dotnet` beside `fuaran-ts`, after
//  `dotnet build src/Fuaran.UI.Cli` in `fuaran-dotnet`:
//
//      dotnet fsi packages/ui/test/schemaForm.parity.certify.fsx
//      pnpm exec prettier --write packages/ui/test/fixtures/schema-form-parity.json
//
//  To add a case, append `{ "name": ..., "schema": "<schema text>" }` to the
//  table's `cases` and re-run; the script fills in `outcome` and `wire`.
// ============================================================================

#I "../../../../fuaran-dotnet/src/Fuaran.UI.Cli/bin/Debug/net10.0"
#r "Fuaran.Core.Wire.dll"
#r "Fuaran.UI.dll"
#r "Fuaran.UI.OpStream.Abstractions.dll"

open System.IO
open System.Text.Json
open System.Text.Json.Nodes
open Fuaran.UI.SchemaForm

let tablePath =
  Path.Combine(__SOURCE_DIRECTORY__, "fixtures", "schema-form-parity.json")

let table = JsonNode.Parse(File.ReadAllText tablePath).AsObject()
let options = SchemaFormOptions.defaults<obj>

let canonical (text: string) : string * string =
  let refused refusals =
    "refused", Fuaran.Core.Canon.render (SchemaFormRefusal.toJson refusals)

  match Fuaran.Core.Json.parseTolerantOfNull text with
  | Error message ->
    refused
      [ { Path = ""
          Code = SchemaFormRefusalCode.SchemaNotJson message } ]
  | Ok schema ->
    match derive options schema with
    | Ok node -> "form", Fuaran.UI.OpStream.Abstractions.CanonicalJson.encodeNode node
    | Error refusals -> refused refusals

let mutable divergent = 0

for case in table["cases"].AsArray() do
  let case = case.AsObject()
  let name = case["name"].GetValue<string>()
  let schema = case["schema"].GetValue<string>()
  let outcome, wire = canonical schema
  case["outcome"] <- JsonValue.Create outcome
  case["wire"] <- JsonValue.Create wire

  let toolWire =
    match deriveWireFromText options schema with
    | Ok w
    | Error w -> w

  if toolWire <> wire then
    divergent <- divergent + 1
    printfn "reference-host divergence in '%s':\n  canonical: %s\n  deriveWire: %s" name wire toolWire

let writerOptions =
  JsonSerializerOptions(
    WriteIndented = true,
    Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
  )

File.WriteAllText(tablePath, table.ToJsonString writerOptions + "\n")
printfn "certified %d case(s); %d reference-host divergence(s)" (table["cases"].AsArray().Count) divergent
