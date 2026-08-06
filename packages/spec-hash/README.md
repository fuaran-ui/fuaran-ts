# @fuaran-ui/spec-hash

A reference implementation of the **`canonical-json-sha256-v1`** minting canonicalisation: a rule for
turning a JSON rendering into a stable content address, so that two parties which agree on a document
address it identically without either being able to check that the other did.

**Workspace-internal.** This package is `private` and is not published to npm. It exists to hold this
repository to a registered rule owned by a specification, and to prove that agreement against an
independent implementation of the same rule; publishing it is a separate, deliberate act.

## The rule

1. **Parse** the rendering into values.
2. **Serialise** them with no insignificant whitespace, UTF-8, JSON string escaping (short escapes
   where they exist), ECMAScript `Number::toString` for numbers, and two rules specific to this
   algorithm:
   - **every object's members are ordered ordinally ascending by key, recursively.** A document's
     interior is not a versioned record with a published field order; there is nothing to preserve,
     and sorting is precisely what makes two authoring orders address one identity.
   - **arrays keep their order.** An array's order is data: two renderings that differ in it are two
     different documents and must address differently.
3. **Digest** the resulting bytes with SHA-256 and form `sha256:{lowercase hex}`.

Three renderings are **outside the rule's domain** and are refused rather than resolved arbitrarily:
duplicate member names within one object; a number not exactly representable as an IEEE-754 binary64
(render it as a string instead); and ill-formed Unicode.

The canonical form is an **intermediate that exists only to be hashed** — the transmitted payload is
not required to be those bytes. Two renderings differing only in member order or insignificant
whitespace therefore differ byte-for-byte and carry the same address, which is the whole property,
stated the other way round.

## Use

```ts
import { canonicalise, describeRefusal, mint } from '@fuaran-ui/spec-hash';

const rendered = '{"b":2,"a":1}';

const address = mint(rendered);
if (address.ok)
  console.log(address.value); // sha256:…
else console.error(describeRefusal(address.refusal));

// The intermediate, for when two parties disagree and need to see WHERE.
const bytes = canonicalise(rendered); // { ok: true, value: '{"a":1,"b":2}' }
```

`mint` uses Node's SHA-256. `mintWith(sha256Hex, rendered)` takes the digest as a parameter, for a
host with its own (a browser's WebCrypto, a native binding); the rule itself is platform-free.

## What the tests check

- **`test/corpus.test.ts`** — every vector of the specification's own `spec-hash` family: the
  canonical intermediate byte for byte, the digest, the pair that differ only in authoring order and
  address identically, and the one reject vector (an address minted over the raw rendering instead of
  over the canonical bytes — the error the rule exists to exclude, and one nothing downstream is
  permitted to notice).
- **`test/cross-host.test.ts`** — several hundred documents with the canonical bytes and digests an
  independent implementation in another language produces for them, including its refusals. See
  [`scripts/README.md`](scripts/README.md).
- **`test/go-red.test.ts`** — that the two suites above can fail: that a one-character edit moves the
  address, that a corrupted expectation is detected, that the corpus's unicode vector genuinely
  discriminates code-unit from code-point ordering, that an unsorted implementation fails the
  permuted vector, and that each refusal is a thing the platform parser would otherwise resolve
  silently.

**The corpus is not vendored.** It is resolved at `../fuaran-model-execution-spec/wire-fixtures`
relative to this repository, and its absence is a loud failure naming the checkout — never a skip. A
gate that quietly does nothing when it cannot find what it is checking against leaves the build
green, and everybody reads that as agreement.
