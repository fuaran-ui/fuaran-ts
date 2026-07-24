# @fuaran-ui/conformance

Third-party certification kit for the **Fuaran UI wire format**: implement the
contract, run this, get a report.

The canonical wire format is specified language-neutrally in the Fuaran
language repo's `docs/WIRE_FORMAT.md`, with an executable fixture corpus as
the conformance authority. This package bundles a versioned snapshot of that
corpus and a runner that drives **any** candidate implementation over it
through a small adapter seam — no access to in-house test suites required.

The full certification procedure (what "conformant" means, mandatory vs
optional legs, how to read the report, corpus versioning) lives in
[`CONFORMANCE.md`](../../CONFORMANCE.md) at the repo root. This README is the
quick-start.

## Quick start

```bash
npm install @fuaran-ui/conformance
```

Write an adapter module plugging in your implementation's codec:

```js
// my-host.adapter.mjs
import { decodeNode, encodeNode, decodeOp, encodeOp } from 'my-host';

export const adapter = {
  // string → { ok: true, value } | { ok: false, error: { code, path, message? } }
  decodeNode,
  // value (from decodeNode) → canonical-JSON string
  encodeNode,
  decodeOp,
  encodeOp,
};

export const implementation = { name: 'my-host', version: '1.2.3' };
```

Run the kit:

```bash
npx fuaran-conformance ./my-host.adapter.mjs --json report.json
```

or programmatically:

```js
import { runConformance, formatReport } from '@fuaran-ui/conformance';
import { adapter, implementation } from './my-host.adapter.mjs';

const report = runConformance(adapter, { implementation });
console.log(formatReport(report));
```

Every hook is optional — a decode-only or node-only host certifies the legs it
implements and receives an honest `partially-conformant` verdict with the
remaining legs marked `skipped`, never a blanket fail. CLI exit codes:
`0` conformant, `2` partially-conformant, `1` non-conformant.

## What gets checked

| Leg                                       | Needs                     | Assertion                                                                 |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------------------------- |
| `node-decode` / `op-decode`               | `decodeNode` / `decodeOp` | every accept fixture decodes without error                                |
| `node-byte-identity` / `op-byte-identity` | decode + encode hook      | `encode(decode(input))` is **byte-identical** to the canonical form       |
| `node-reject` / `op-reject`               | `decodeNode` / `decodeOp` | malformed input fails with the canonical error code at the canonical path |
| `lenient-accept`                          | decode + encode hook      | every §16 shorthand decodes and normalises to the verbose canonical bytes |
| `schema-validation`                       | decode + encode hook      | the host's output validates against the canonical Draft 2020-12 schema    |
| `apply`                                   | —                         | reserved; corpus v1 ships no apply fixtures                               |

## Corpus versioning

The corpus snapshot is bundled with the package and versioned with it. Every
report names the corpus manifest version and a SHA-256 content digest —
certification is **per corpus version**. The corpus advances with the spec
(`WIRE_FORMAT.md` §11 forward-coupling rule): when a new wire-format case
lands, a new kit release ships the regenerated corpus, and hosts re-certify
against it. Use `--corpus <dir>` (or the `corpusRoot` option) to certify
against an external corpus checkout instead of the bundled snapshot.

## License

Apache-2.0.
