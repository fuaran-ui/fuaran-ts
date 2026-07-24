# @fuaran-ui/validator

Build-time validator for **TypeScript-authored Fuaran UI trees**. A
TypeScript-compiler-API source walker over the [`@fuaran-ui/ui`](../ui)
smart-constructor surface that surfaces the same `FUARAN###` defect codes as
the F# tier's `Fuaran.UI.Validator`, so a cross-implementation eval suite scores
both tiers uniformly.

It catches authoring mistakes **before they ship** — a duplicate `NodeId`, a
mistyped `binding.query` name, a `tabHeaders`/`children` length mismatch, a
blank `href`, a no-op `disabled` binding, a blank currency code, a dangerous
`withExtraAttribute` key — that the runtime parse-time decoder
([`@fuaran-ui/ops`](../ops)) and the runtime tree check
([`@fuaran-ui/ui`](../ui)'s `preEmitValidate`) either can't see (a human typo in
source) or only catch at runtime.

> AI-emitted JSON is already validated at parse time against the schema. This
> package serves the **human-authoring** TypeScript developer who writes Fuaran
> trees by hand and wants the mistake caught at build time, the same way the F#
> author gets it from `dotnet run -- Validate`.

## Install

```sh
npm install --save-dev @fuaran-ui/validator
# or: pnpm add -D @fuaran-ui/validator
```

`typescript` is a runtime dependency (the parser) — you almost certainly have
it already.

## CLI

```sh
fuaran-validate "src/**/*.ts" "src/**/*.tsx"
fuaran-validate src/app.ts --manifest fuaran-validator.manifest.json --format json
fuaran-validate "src/**/*.tsx" --fail-on warning   # treat warnings as failures too
```

Flags:

| Flag                       | Default      | Meaning                                                  |
| -------------------------- | ------------ | -------------------------------------------------------- |
| `--manifest PATH`          | (discovered) | Explicit manifest path; overrides discovery.             |
| `--project-dir DIR`        | `cwd`        | Directory searched for `fuaran-validator.manifest.json`. |
| `--format plain\|json`     | `plain`      | `json` emits the §4d AI-recovery array.                  |
| `--fail-on error\|warning` | `error`      | Severity that drives a non-zero exit.                    |

**Exit codes** (mirroring the F# tier): `0` clean · `1` ≥1 finding at/above the
`--fail-on` threshold · `2` usage error / no files matched. Wire it into CI as a
`lint` step.

## Programmatic API

```ts
import { validateProject, validateSources, renderFindingJson } from '@fuaran-ui/validator';

// On disk (discovers the manifest in projectDir):
const result = validateProject({ files: ['src/app.ts'], projectDir: 'src' });
for (const f of result.findings) console.log(f.code, f.message);

// In memory (editor plugins, build-pipeline integration, tests):
const { findings } = validateSources([{ fileName: 'app.ts', source }], { manifest });
```

Both return a `RunResult` (`findings`, `manifestPath`, `manifestLoaded`,
`filesWalked`); the caller decides reporting + exit-code policy.

## Manifest

The validator does not infer — the hand-written `fuaran-validator.manifest.json`
**is** the contract for the schema-coupled checks. Same wire shape as the F#
tier (one file serves both):

```jsonc
{
  "queries": ["totalRevenue", "salesRows"], // names accepted by binding.query
  "msgCases": ["LoadData", "Reset"], // case names accepted by action.dispatch
}
```

Without a manifest, the schema-coupled checks (`FUARAN010` / `FUARAN020`) are
silenced and a single `FUARAN900` warning surfaces the silenced state. See
[`fuaran/docs/VALIDATOR-MANIFEST.md`](../../../fuaran/docs/VALIDATOR-MANIFEST.md)
for the full format.

## Defect codes

| Code        | Severity | Trigger                                                                                                 |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `FUARAN001` | error    | Duplicate `NodeId` within one `fuaran.dashboard` subtree.                                               |
| `FUARAN002` | warning  | Same `NodeId` across multiple trees.                                                                    |
| `FUARAN010` | error    | `binding.query("name", …)` where `name` ∉ manifest `queries`.                                           |
| `FUARAN020` | error    | `action.dispatch(msg)` whose case ∉ manifest `msgCases`.                                                |
| `FUARAN046` | warning  | `fuaran.gridLayoutTemplated` whose `templateColumns` is `repeat(N, 1fr)` (use the typed `cols`).        |
| `FUARAN047` | error    | `fuaran.tabs` `tabHeaders` length ≠ `children` length.                                                  |
| `FUARAN048` | error    | `fuaran.tabs` `tabTags` length ≠ `children` length.                                                     |
| `FUARAN049` | warning  | `fuaran.tabs` `activeTag` set but `tabTags` absent.                                                     |
| `FUARAN050` | warning  | `fuaran.progress` `fraction` literal outside `[0, 1]`.                                                  |
| `FUARAN060` | warning  | `node.withExtraAttribute("key", …)` key outside the `data-*` / `aria-*` allowlist (or `on*` / `style`). |
| `FUARAN061` | error    | `localeFormat.currency("")` — blank ISO-4217 code.                                                      |
| `FUARAN063` | warning  | `fuaran.link` with a blank `href`.                                                                      |
| `FUARAN064` | warning  | `fuaran.button` `disabled` bound to `binding.static(false)` (a no-op).                                  |
| `FUARAN900` | warning  | No `fuaran-validator.manifest.json` found — schema checks silenced.                                     |

Each finding carries an optional §4d AI-recovery payload (`availableFields` +
`suggestion`) that `--format json` renders as `available_fields` / `suggestion`.

## Coverage vs the F# tier

This v1 ports the rules that are **statically decidable from the TypeScript
source** over the `@fuaran-ui/ui` object-options surface. The F# tier carries
additional codes that key on F#-specific shapes with no clean TypeScript-source
analogue and are therefore **out of scope** here:

- `FUARAN030` / `031` — `Fuaran.grid` lambda row-type annotations (F#-AST type annotations).
- `FUARAN040` / `041` — accessibility `Accessibility = None` record opt-out (no TS opt-out syntax — TS authors simply don't call `node.withAccessibility`).
- `FUARAN042` / `043` / `044` — `binding.local` enclosing-context rules.
- `FUARAN052` / `053` / `054` / `055` — Custom bounded-escape health.
- `FUARAN056` / `057` / `058` / `059` / `065` — fragment-reuse health.
- `FUARAN062` — Custom build-time content-hash.

Statically-undecidable inputs (a value bound to a variable, a `binding.query`
name, a computed source) leave the corresponding fact unknown and the rule
conservatively does not fire — matching the F# validator's
no-full-type-checker-resolution boundary.

## Limitations

- The walker matches the canonical namespace identifiers `fuaran` / `binding` /
  `action` / `node` / `localeFormat` (the names from
  `import { … } from '@fuaran-ui/ui'`). An aliased import is not tracked —
  the same posture as the F# walker matching the literal `Fuaran.` / `binding.`
  qualifiers.
- Only literal arguments are analysed; nothing is type-checked or constant-folded.

Apache-2.0. Part of the [Fuaran UI](https://github.com/fuaran-ui/fuaran-ts)
TypeScript reference implementation.
