# Security Policy

## Supported versions

The `@fuaran-ui/*` packages are pre-1.0. Security fixes are applied to the latest released `0.x`
version on the `main` branch. Older pre-releases are not maintained.

## Reporting a vulnerability

Please report suspected vulnerabilities privately — do **not** open a public issue.

- **Preferred:** GitHub's private vulnerability reporting (the repository's **Security** tab →
  **Report a vulnerability**).
- **Or email:** andrew@fuaran.com — include a description, the affected version, and steps
  to reproduce.

We aim to acknowledge a report within five business days and to agree a disclosure timeline with
you. Please allow a reasonable window to ship a fix before any public disclosure.

## Scope

This repo is the TypeScript host of the Fuaran UI wire format: it decodes wire JSON — often
AI-emitted — and renders the typed tree into the DOM.

- **Render-time injection safety:** the renderer routes every string→DOM seam through its
  sanitization layer (URL scheme filtering on `href`/`src`, no raw HTML injection outside the
  documented Custom-renderer seam). A render path that lets tree content execute script is a
  vulnerability we want to hear about.
- **Wire decoding:** a decode path that admits malformed wire as valid is in scope. Parser resource
  exhaustion is a known position rather than a finding: this host does not yet enforce the wire
  format's §21 resource limits, and §21.5 of the specification records where each host stands.
- **Dispatch gating:** the gated action set (`Call`, `Navigate`, `AiTool`, `ReadFileBody`,
  `ApplyTreeOp`) is routed through the host's `canDispatch` policy hook before the effect runs. A
  path that performs one of those actions without consulting a hook the host supplied, or that
  reaches a host effect outside that set, is in scope. An absent hook allows: unlike the F#
  reference host, this tier does not yet refuse by default.

Custom renderers registered by a **host** run with the host's trust — issues in host-supplied
custom-renderer code belong with the host application, not this repo.
