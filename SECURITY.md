# Security Policy

## Supported versions

The `@fuaran-ui/*` packages are pre-1.0. Security fixes are applied to the latest released `0.x`
version on the `main` branch. Older pre-releases are not maintained.

## Scope

This repo is the TypeScript host of the Fuaran UI wire format: it decodes wire JSON — often
AI-emitted — and renders the typed tree into the DOM.

- **Render-time injection safety:** the renderer routes every string→DOM seam through its
  sanitization layer. A render path that lets tree content execute script is a vulnerability we
  want to hear about. The floor is normative rather than a house convention — §19 and §22 of the
  wire-format specification state it — and it is certified: the shared conformance corpus carries a
  `sanitization/` family of hostile payloads whose invariants this host asserts in its own suite,
  alongside every other conformant host. The per-seam posture:
  - **URL slots** (`href`, `src`, navigation destinations) are scheme-allow-listed by default deny.
    The string is first normalised exactly as the URL Standard's parser normalises it, so the value
    inspected is the value the browser will parse; protocol-relative destinations are rejected in
    every spelling a browser folds into an off-origin authority.
  - **Markdown bodies** go through a deterministic renderer that escapes by construction, with a
    defence-in-depth sweep over the result. That sweep's known limits are recorded in the corpus
    rather than implied: it is not a general-purpose HTML sanitiser, and it is not the primary gate.
  - **Text slots** reach the document escaped, never as markup.
  - **Attribute names** supplied through the extra-attributes hatch pass a positive `[A-Za-z0-9-]`
    allowlist, and a non-conforming name is **dropped rather than escaped** — HTML has no escape for
    an illegal character in an attribute name, so a space starts a new attribute and an `=` starts
    its value. The server renderer re-checks the name at the emission site rather than relying on
    upstream validation alone. Attribute **values** are escaped by the renderers; the value-level
    check is defence in depth beneath that escaping, never a replacement for it.
- **Wire decoding:** a decode path that admits malformed wire as valid is in scope. Parser resource
  exhaustion is a known position rather than a finding: this host does not yet enforce the wire
  format's §21 resource limits, and §21.5 of the specification records where each host stands.
- **Dispatch gating:** the gated action set (`Call`, `Navigate`, `AiTool`, `ReadFileBody`,
  `ApplyTreeOp`) is routed through the host's `canDispatch` policy hook before the effect runs. A
  path that performs one of those actions without consulting a hook the host supplied, or that
  reaches a host effect outside that set, is in scope. An absent hook allows: unlike the F#
  reference host, this tier does not yet refuse by default.

## Reporting a vulnerability

Please report suspected vulnerabilities privately — do **not** open a public issue.

- **Preferred:** GitHub's private vulnerability reporting for this repository (the repository's
  **Security** tab → **Report a vulnerability**). It is visible only to the maintainers, and it is
  where we reply, share a draft fix, and publish the advisory from.
- **Or email:** andrew@fuaran.com — include a description, the affected version, and steps to
  reproduce.

A useful report names the version you tested, the input or sequence that triggers the behaviour,
and what you believe the impact is. A proof of concept helps and is never required.

We aim to acknowledge a report within five business days. There is no bounty programme, and
nothing to sign: we do not ask reporters to accept terms in exchange for a response.

## What happens after you report

The same process applies in every repository of this project.

1. **Acknowledgement** within five business days, saying whether we have reproduced it yet.
2. **Triage.** A maintainer reproduces the report and settles two questions: whether it is a
   defect in this project's own code, and which of this project's published packages are affected.
   The second is not answered from the reporting repository alone — see the cross-host note below.
3. **Fix**, landing with a regression test that fails without it. Where the defect is in a
   guarantee this project documents, the document stating that guarantee is corrected in the same
   change.
4. **Release.** Every affected package gets a released version carrying the fix.
5. **Advisory**, published on each affected repository, requesting a CVE where one is warranted,
   crediting the reporter by whatever name they choose — or not at all, if they prefer.

**How affected versions are stated.** These packages are released independently of one another,
and consumers pin exact versions rather than floating ranges, so an advisory that says "upgrade to
the latest" is not actionable here. Each advisory therefore states, per published package:

- the registry id of the package, and the affected versions as an explicit range of versions that
  were actually published to that public registry — never "all earlier versions", and never a
  version that exists only in a development build, since no consumer can be on one;
- the first released version that carries the fix;
- whether the package is affected **directly** (the defect is in its own code) or **transitively**
  (it pins an affected version of another package in this project). A pinned consumer does not
  pick up a fixed dependency by upgrading nothing, so a transitively affected package gets its own
  fixed release and its own entry in the advisory, rather than a note telling the reader to go and
  upgrade something else.

**One defect can affect several of these repositories at once.** This project ships parallel
implementations of one wire format in several languages, written against a shared specification
and a shared conformance corpus rather than transpiled from one another. A defect in how one host
decodes, renders, or gates may therefore exist in the others or may not, and neither can be
assumed. Before an advisory is published, the same defect is looked for in every host, and the
advisory names every affected package across every language. Where a host is **not** affected, the
advisory says so explicitly: silence about a host reads as "unknown", which is the one thing an
advisory must never leave a consumer holding.

## Reports about a dependency or another project

Not every report is about code this project owns, and the handling differs.

- **A defect in one of our dependencies.** We do not publish it. It belongs to that project's own
  disclosure channel, and we will forward it there with your consent, or ask you to report it
  there yourself if you would rather hold the relationship. We honour that project's embargo. If
  the impact on our side can be mitigated without revealing the defect, we ship that mitigation
  during the embargo and describe it in neutral terms; if any honest mitigation would disclose the
  defect, we wait — and we tell you that we are waiting, and why.
- **A defect in an application built on these packages.** Host-supplied code runs with the host's
  own trust, so its issues belong with that application rather than here. If the host was
  following our documentation and our documentation was wrong, that is our defect and we take it.
- **A report that is already public when it reaches us.** The embargo question is then moot, and
  we will say so: we ship and publish as fast as we can, rather than ask anyone to un-say
  something.
- **Our own default window.** Where the defect is ours we propose a disclosure window at the
  acknowledgement rather than leaving it open — 90 days from that acknowledgement unless we agree
  something else with you, and sooner if the fix ships sooner. If we go quiet, or miss the window
  we proposed, publishing is your call and we will not treat it as a breach of anything.

## What is out of scope

- Findings that require an already-compromised operating system, browser binary, build machine, or
  package-registry account.
- Issues in an application that consumes these packages, including custom code that a host
  registers and that runs with the host's own trust — see the section above.
- Vulnerabilities in a third-party dependency: we will forward them, but the advisory is that
  project's to publish.
- Reports against a site or deployment this project does not operate.
- Automated scanner output with no demonstrated impact on this project's code.
- Missing hardening that is a documented deployment choice left to the host rather than a defect
  in the code here.
