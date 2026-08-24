// ============================================================================
//  @fuaran-ui/renderer-server/markdown — DisplayKind.Markdown → sanitised HTML.
//
//  THE SERVER AND THE CLIENT RUN THE SAME MARKDOWN RENDERER. This module is a
//  re-export of the deterministic GFM renderer in @fuaran-ui/renderer (reached
//  through its React-free `/markdown` subpath, the same way `/sanitize` is), so
//  a server-rendered markdown body is byte-identical to the client-rendered one
//  over the whole shared corpus — the property `test/markdownCorpus.test.ts`
//  asserts fixture by fixture.
//
//  It used to parse through npm `marked` and sanitise the result. That was a
//  SECOND markdown implementation on the server side of a renderer whose entire
//  contract is parity with the client, and the two disagreed on 27 of the
//  corpus's 57 fixtures: void-element spelling, entity decoding, raw-HTML
//  passthrough, the `fuaran-table*` / `fuaran-task-*` class vocabulary, and —
//  the one that stopped being cosmetic — every destination the tree's egress
//  policy refuses. `marked` has no policy notion at all, so a refusal the
//  corpus pins as `about:blank#fuaran-egress-refused` rendered as the live
//  destination. Sanitisation still runs: the deterministic renderer escapes by
//  construction AND passes its output through `sanitizeMarkdownHtml`, so this
//  path did not lose the floor it had, it stopped needing to be the only one.
//
//  `toHtml` is the permissive case — the pure `source -> html` function the
//  corpus has pinned since Phase 292. `toHtmlWithEgress` is what a host
//  rendering a DECODED tree wants, with `denyNonLocalEgress` or its own
//  declaration. Which one the server's own render path calls is a separate
//  question from which are available here, and it is not this module's to
//  answer.
// ============================================================================

export { toHtml, toHtmlWithEgress } from '@fuaran-ui/renderer/markdown';
