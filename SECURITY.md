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
- **Wire decoding:** a decode path that admits malformed wire as valid, or parser resource
  exhaustion (unbounded depth or size), is in scope.
- **Dispatch gating:** interactive dispatch is default-deny — a tree cannot invoke a host action
  the host did not register. A bypass of that gate is in scope.

Custom renderers registered by a **host** run with the host's trust — issues in host-supplied
custom-renderer code belong with the host application, not this repo.
