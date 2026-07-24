# Fuaran wire-format conformance certification

This document is the certification procedure for implementations of the
**Fuaran UI wire format** — the canonical JSON serialisation of a `Node` tree
and a `TreeOp`, specified language-neutrally in the Fuaran language repo's
[`docs/WIRE_FORMAT.md`](../fuaran/docs/WIRE_FORMAT.md).

The spec + fixture corpus + JSON Schema — not any single implementation — are
the canonical artefact. Any implementation, in any language, that certifies
against the corpus per this procedure is a **conformant host** of the
contract. This document plus the published `@fuaran-ui/conformance` package
are everything a third-party implementer needs: no access to any in-house
test suite is required.

## The conformant-host roster

The authoritative list of hosts and their roles lives in the spec's
[`WIRE_FORMAT.md` §11.0](../fuaran/docs/WIRE_FORMAT.md) (the single source of
truth every forward-coupling obligation references). The **codec hosts** — held
to the full byte-identity certification below — are:

| Host        | Language   | Package / repo                                       |
| ----------- | ---------- | ---------------------------------------------------- |
| `fuaran`    | F#         | `Fuaran.UI.*` (the reference — generates the corpus) |
| `fuaran-ts` | TypeScript | `@fuaran-ui/*`                                       |
| `fuaran-py` | Python     | `fuaran-py`                                          |
| `fuaran-go` | Go         | `fuaran-go` (headless)                               |
| `fuaran-rs` | Rust       | `fuaran-rs` (headless + WASM client)                 |

The Swift (`fuaran-swift`) and Kotlin (`fuaran-kt`) native surfaces are
**render projections over the Rust core, not codec hosts** — they consume a
decoded tree for native rendering and never canonically encode, so they carry
no byte-identity leg (their bar is render-coverage over the node corpus). See
§11.0 for the codec-host vs render-projection distinction.

## What "conformant host" means

A host certifies by running the certification kit over the **conformance
corpus**: a versioned fixture set of canonical `Node` wire forms, canonical
`TreeOp` wire forms, and malformed reject inputs, plus the canonical
Draft 2020-12 JSON Schema. The kit exercises the host through these **legs**:

| Leg                      | Tier      | Needs (adapter hooks)     | Assertion                                                                                                                 |
| ------------------------ | --------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `node-decode`            | mandatory | `decodeNode`              | every canonical `Node` fixture decodes without error                                                                      |
| `node-byte-identity`     | mandatory | `decodeNode + encodeNode` | `encode(decode(input))` is **byte-identical** to the canonical form                                                       |
| `node-reject`            | mandatory | `decodeNode`              | every malformed `Node` input fails with the canonical error **code** at the canonical **path** prefix                     |
| `op-decode`              | mandatory | `decodeOp`                | every canonical `TreeOp` fixture decodes without error                                                                    |
| `op-byte-identity`       | mandatory | `decodeOp + encodeOp`     | `encode(decode(input))` is **byte-identical** to the canonical form                                                       |
| `op-reject`              | mandatory | `decodeOp`                | every malformed `TreeOp` input fails with the canonical error code at the canonical path prefix                           |
| `lenient-accept`         | mandatory | a decode + encode pair    | every §16 shorthand decodes AND `encode(decode(shorthand))` is **byte-identical** to the verbose canonical form           |
| `envelope-round-trip`    | mandatory | `negotiateEnvelope`       | every §15 versioned envelope negotiates + tolerantly decodes + re-renders **byte-identically** (must-ignore-but-preserve) |
| `envelope-reject`        | mandatory | `negotiateEnvelope`       | every Foreign-profile envelope hard-refuses with `FOREIGN_PROFILE` at the canonical path                                  |
| `elicitation-round-trip` | mandatory | `roundTripElicitation`    | every §18 elicitation envelope / outcome decodes with the fixture's named entry point and re-encodes **byte-identically** |
| `elicitation-reject`     | mandatory | `roundTripElicitation`    | every malformed §18 artefact fails with the canonical error code at the canonical path prefix                             |
| `elicitation-answer`     | mandatory | `validateAnswerDocument`  | every §18.4 `{answer, contract}` document validates / refuses exactly as the canonical host does                          |
| `schema-validation`      | mandatory | a decode + encode pair    | the host's own canonical output validates against the canonical JSON Schema (`schema.json`)                               |
| `apply`                  | optional  | `applyOp`                 | **reserved** — corpus v1 ships no apply fixtures; the hook exists so the seam is stable when they land                    |

Byte-identity is the load-bearing assertion. The committed corpus **is** the
canonical encoding (each accept fixture's payload is the canonical encoder's
output for that tree), so byte-equality with the corpus is byte-equality with
every other conformant host — two hosts that both certify cannot silently
disagree on the wire.

The three verdicts:

- **`conformant`** — every mandatory leg was attempted and passed. The host is
  a full conformant implementation of the wire contract for the certified
  corpus version.
- **`partially-conformant`** — every attempted leg passed, but one or more
  mandatory legs were skipped because the adapter does not provide the hooks
  they need. This is an honest partial certification: a decode-only host (e.g.
  a renderer that consumes wire but never emits it) certifies the decode +
  reject legs; an op-less host certifies the node legs. The report names
  exactly which legs were certified and which were not attempted.
- **`non-conformant`** — at least one attempted leg failed. The report carries
  a per-fixture finding for every failure (fixture id, what diverged, and for
  byte-identity failures the first differing byte offset with context).

A partial host never receives a blanket fail, and a partial certification
never silently presents as a full one — the verdict string and the per-leg
`skipped` markers travel together in every report.

## Running the kit

```bash
npm install @fuaran-ui/conformance
```

Write an adapter module that plugs your implementation's codec into the
adapter seam. Every hook is optional; values your decoder returns are opaque
to the runner (it only passes them back into your encoder), so there is no
type-level coupling to any `@fuaran-ui` package:

```js
// my-host.adapter.mjs
import { decodeNode, encodeNode, decodeOp, encodeOp } from 'my-host';

export const adapter = {
  // (json: string) => { ok: true, value } | { ok: false, error: { code, path, message? } }
  decodeNode,
  // (value) => string  — canonical-JSON re-encoding of a decoded value
  encodeNode,
  decodeOp,
  encodeOp,
};

export const implementation = { name: 'my-host', version: '1.2.3' };
```

The decode error shape mirrors `WIRE_FORMAT.md` §6: `code` is one of the six
canonical `DecodeError` codes (`INVALID_JSON`, `MISSING_FIELD`, `WRONG_TYPE`,
`UNKNOWN_DU_CASE`, `WRONG_NODE_KIND`, `EMPTY_NODE_ID`), `path` is the
`$`-rooted dotted path to the offending position.

Run via the CLI:

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

CLI exit codes: `0` conformant, `2` partially-conformant, `1` non-conformant
(or usage error). The `--corpus <dir>` flag (API: `corpusRoot`) certifies
against an external corpus checkout instead of the bundled snapshot — useful
for certifying against a corpus version newer than your installed kit.

### Certifying a host that isn't JavaScript

Two equally valid routes:

1. **Thin JS bridge.** Expose your host's four codec entry points to Node
   (subprocess, FFI, WASM, HTTP — anything), wrap them in an adapter module,
   and run the kit normally. The adapter seam was designed for this: strings
   in, strings out, opaque values between.
2. **Native corpus consumption.** Consume the corpus directly in your own
   test harness per `WIRE_FORMAT.md` §12 (the manifest tells you, per
   fixture, what to decode, what to compare byte-for-byte, and which error
   code/path to expect), and present the results in this document's report
   format, naming the corpus version + digest. This is how the F# reference
   host certifies (worked example 2 below).

## Reading the report

```text
Fuaran wire-format conformance report
  kit            @fuaran-ui/conformance@<kit version>
  implementation <your host> <version>
  corpus         v<manifest version> (<N> fixtures, bundled|external)
  corpus digest  sha256:<digest>
  generated      <ISO-8601 timestamp>

  ✓|✗|– <leg>  mandatory|optional  <passed>/<total> | <skip reason>
      <fixture id>: <finding summary>
        <detail — e.g. first differing byte offset with context windows>

  verdict: CONFORMANT | PARTIALLY-CONFORMANT | NON-CONFORMANT
```

- **corpus / corpus digest** — the corpus version certified against: the
  manifest version plus a SHA-256 digest over the manifest, the schema, and
  every fixture payload. A certification claim is meaningless without these
  two values; quote them whenever you state that a host is conformant.
- **legs** — `✓` pass, `✗` fail (with per-fixture findings), `–` skipped
  (with the missing hooks named). Mandatory vs optional tiers are printed so
  a partial certification is legible at a glance.
- The structured JSON report (`--json`) carries the same content
  machine-readably (`ConformanceReport` in the package's typings).

## Corpus versioning — the forward-coupling caveat

**Certification is per corpus version.** The corpus advances with the spec
under the forward-coupling rule (`WIRE_FORMAT.md` §11): every new
`NodeKind` / `Spec` / `TreeOp` / `Binding` / `Action` case lands in the
encoder, decoder, schema, and corpus in the same change-set. When the corpus
advances:

- a new release of `@fuaran-ui/conformance` ships the regenerated snapshot
  (the bundled corpus is versioned with the package);
- a report produced against the previous corpus digest remains a true
  statement about that corpus version, but does **not** certify conformance
  with the new one — new fixtures exercise wire shapes the old run never saw;
- hosts re-certify by updating the kit (or pointing `--corpus` at the new
  corpus) and re-running.

Decoders should expect the corpus to grow most often by **addition** (new
accept fixtures for new cases, new reject fixtures for their malformed
variants). A host that certified cleanly and follows the spec's
unknown-key-tolerant, unknown-discriminator-rejecting decode rules typically
re-certifies against an advanced corpus with no code change unless the new
cases themselves are in scope for it.

## Worked example 1 — the TypeScript reference host

The TS reference implementation (`@fuaran-ui/ops`) certifies through the
public kit itself — the adapter is the ten-line module at
[`packages/conformance/examples/fuaran-ts-ops.adapter.mjs`](packages/conformance/examples/fuaran-ts-ops.adapter.mjs),
and the kit's own test suite re-runs this certification on every build
(`packages/conformance/test/self-certification.test.ts`), so the published
runner and the reference host cannot drift apart. Verbatim CLI output:

```text
Fuaran wire-format conformance report
  kit            @fuaran-ui/conformance@0.1.0
  implementation @fuaran-ui/ops 0.1.0
  corpus         v1 (92 fixtures, bundled)
  corpus digest  sha256:71472d781df3a4cfd378d585cfe951a3c9d920cde9ba0bd0bf5dfe408ba60e91
  generated      2026-06-12T07:31:09.430Z

  ✓ node-decode          mandatory  53/53
  ✓ node-byte-identity   mandatory  53/53
  ✓ node-reject          mandatory  22/22
  ✓ op-decode            mandatory  11/11
  ✓ op-byte-identity     mandatory  11/11
  ✓ op-reject            mandatory  6/6
  ✓ schema-validation    mandatory  64/64
  – apply                optional   corpus v1 ships no apply fixtures — leg reserved

  verdict: CONFORMANT
  Certification is per corpus version — re-certify when the corpus advances (WIRE_FORMAT.md §11).
```

## Worked example 2 — the F# reference host

The F# language tier certifies by the **native corpus consumption** route:
its corpus-consuming test suite (`Fuaran.UI.JsonDecode.Tests` in the Fuaran
language repo) loads the same manifest and asserts, per fixture, exactly the
kit's leg semantics — round-trip byte-equality with the canonical form,
reject code + path-prefix equality, and schema validation of every accept
fixture against `schema.json` (plus a stale-schema guard and a corpus
coverage gate the kit does not require). Suite run of 2026-06-12 against the
same corpus, cross-checked into the kit's report format:

```text
Fuaran wire-format conformance report
  kit            native corpus consumption (WIRE_FORMAT.md §12) — Fuaran.UI.JsonDecode.Tests
  implementation Fuaran.UI (F# language tier)
  corpus         v1 (92 fixtures, external — workspace wire-format-fixtures/)
  corpus digest  sha256:71472d781df3a4cfd378d585cfe951a3c9d920cde9ba0bd0bf5dfe408ba60e91
  generated      2026-06-12

  ✓ node-decode          mandatory  53/53
  ✓ node-byte-identity   mandatory  53/53
  ✓ node-reject          mandatory  22/22
  ✓ op-decode            mandatory  11/11
  ✓ op-byte-identity     mandatory  11/11
  ✓ op-reject            mandatory  6/6
  ✓ schema-validation    mandatory  64/64
  – apply                optional   corpus v1 ships no apply fixtures — leg reserved

  verdict: CONFORMANT
```

A note on this host's special position: the corpus payloads are generated
from the F# encoder, so its byte-identity legs hold partly by construction at
generation time — the suite's assertions then pin the _current_ encoder and
decoder to the _committed_ corpus, which is what catches drift after any
subsequent change. For every other host (including the TS reference host
above), byte-identity against the corpus is the full cross-implementation
parity claim.

## Reporting a certification

When publishing a conformance claim for your implementation, state:

1. the implementation name + version,
2. the verdict,
3. the corpus manifest version + SHA-256 digest,
4. for a partial certification, the legs certified vs skipped,

— ideally by attaching the kit's report output verbatim. A claim without the
corpus version + digest is not verifiable and should not be relied on.

## See also

- [`fuaran/docs/WIRE_FORMAT.md`](../fuaran/docs/WIRE_FORMAT.md) — the
  canonical spec (§6 error envelope, §11 forward-coupling, §12 corpus
  consumption, §13 JSON Schema).
- [`packages/conformance/README.md`](packages/conformance/README.md) — the
  kit's quick-start.
- [`STABILITY.md`](STABILITY.md) — the TS package set's stability policy; the
  wire format's own stability contract is byte-equality with the corpus.
