// The byte-parity oracle for the bound-grid documents beside this script.
//
// Decodes every `*.json` node document in <dir> with the reference host's
// decoder and writes the reference SERVER renderer's HTML for it, rendered with
// no host sources (`BindingResolver.empty`), to <dir>/<name>.reference.txt as
// UTF-8 with no BOM and no trailing newline. `boundGridParity.test.ts` holds the
// TypeScript server renderer to those bytes.
//
// Regenerate (from a fuaran-dotnet checkout at the reference revision):
//
//   dotnet build src/Fuaran.UI.Renderer.Server.Tests -c Release
//   dotnet fsi <this file> <fuaran-dotnet>/src/Fuaran.UI.Renderer.Server.Tests/bin/Release/net10.0 <dir>
//
// The test project's output is used because it carries the decoder and the
// server renderer in one folder.
open System
open System.IO
open System.Reflection

let args = fsi.CommandLineArgs |> Array.skip 1
let binDir, dir = args[0], args[1]

AppDomain.CurrentDomain.add_AssemblyResolve (fun _ e ->
  let path = Path.Combine(binDir, AssemblyName(e.Name).Name + ".dll")
  if File.Exists path then Assembly.LoadFrom path else null)

let load (name: string) =
  Assembly.LoadFrom(Path.Combine(binDir, name + ".dll"))

let decodeNode =
  (load "Fuaran.UI.Ops").GetType("Fuaran.UI.Ops.JsonDecode").GetMethod("decodeNodeObj")

let render =
  (load "Fuaran.UI.Renderer.Server").GetType("Fuaran.UI.Renderer.Server.Render").GetMethod("render")

let noSources =
  (load "Fuaran.UI.Renderer.Core").GetType("Fuaran.UI.Renderer.BindingResolver").GetProperty("empty").GetValue(null)

for file in Directory.GetFiles(dir, "*.json") |> Array.sort do
  let result = decodeNode.Invoke(null, [| box (File.ReadAllText file) |])
  let resultType = result.GetType()

  if (resultType.GetProperty("Tag").GetValue(result) :?> int) <> 0 then
    failwithf "%s: decode failed: %A" file (resultType.GetProperty("ErrorValue").GetValue(result))

  let node = resultType.GetProperty("ResultValue").GetValue(result)
  let html = render.Invoke(null, [| noSources; node |]) :?> string

  let out =
    Path.Combine(dir, Path.GetFileNameWithoutExtension file + ".reference.txt")

  File.WriteAllBytes(out, Text.UTF8Encoding(false).GetBytes html)
  printfn "%s" out
