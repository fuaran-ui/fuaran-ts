# @fuaran-ui/ui

Smart constructors, the bounded-type kit, and pre-emit validation for the **Fuaran UI language contract** — the ergonomic TypeScript author surface over [`@fuaran-ui/schema`](https://www.npmjs.com/package/@fuaran-ui/schema).

This is the layer that distinguishes "a TypeScript implementation of the Fuaran contract" from "TypeScript users hand-writing JSON". The module layout mirrors the F# `Fuaran.X` surface so the [AI authoring guide](https://github.com/fuaran-ui/fuaran-dotnet/blob/main/docs/AI_AUTHORING_GUIDE.md) recipes translate mechanically.

## Usage

```ts
import { fuaran, node, type NodeId } from '@fuaran-ui/ui';

const tree = fuaran.dashboard({
  id: 'root' as NodeId,
  children: [
    fuaran.metric({ id: 'sales' as NodeId, label: 'Sales', value: '£42k' }),
    node.onLoading(
      fuaran.skeleton('sales-loading' as NodeId, 1),
      fuaran.metric({
        id: 'revenue' as NodeId,
        label: 'Revenue',
        value: 128_000,
        format: { kind: 'Currency', code: 'GBP' },
      }),
    ),
  ],
});
```

### Namespaces

- **`fuaran`** — components: `dashboard`, `stack`, `gridLayout`, `gridLayoutTemplated`, `splitPanel`, `tabs`, `tabsTagged`, `card`, `stepper`, `summaryList`, `disclosure`, `metric`, `heading`, `labelValueRow`, `markdown`, `markdownSpec`, `badge`, `sparkline`, `spacer`, `callout`, `progress`, `skeleton`, `button`, `select`, `form`, `filters`, `fileUpload`, `chart`, `table`, `map`, `grid`, `custom`, `errorBoundary`, `fragmentDecl`, `fragmentRef`.
- **`binding`** — `static`, `query`, `filter`, `selection`, `state`, `computed`, `i18n`, `local`.
- **`action`** — `dispatch`, `call`, `notify`, `navigate`, `setState`, `aiTool`, `chain`, `commitLocal`, `writeToClipboard`.
- **`format`** — `currency`, `percent`, `number`, `significantDigits`, `date`, `none`.
- **`column`** — `text`, `numeric`, `date`, `bool`, `editable`, `withPill`, `withFormat`, `withWidth`, `erase`.
- **`node`** — postfix modifiers: `onLoading`, `onEmpty`, `onError`, `withTone`, `withWeight`, `withEmphasis`, `withAccessibility`, `withMotion`, `withExtraAttribute`.
- **`formFieldKind`** / **`filterKind`** — `rangedNumber`, `numberStepped`, `segmentedChoice`, `segmentedFilter`.

### Pre-emit validation

```ts
import { preEmitValidate } from '@fuaran-ui/ui';

const result = preEmitValidate(tree);
if (!result.ok) {
  // result.error is a readonly PreEmitDefect[] — every defect found, not just the first.
  // Defect codes (EMPTY_NODE_ID, DUPLICATE_NODE_ID, …) match the F# values.
}
```

This package re-exports the full `@fuaran-ui/schema` surface, so you can import the types from here too.

## Stability

The smart-constructor signatures are **alpha** until the sample app validates them (see [`../../STABILITY.md`](https://github.com/fuaran-ui/fuaran-ts/blob/main/STABILITY.md)). The wire-mirroring types re-exported from `@fuaran-ui/schema` are stable.

## Licence

Apache 2.0. See [`../../LICENSE`](https://github.com/fuaran-ui/fuaran-ts/blob/main/LICENSE).
