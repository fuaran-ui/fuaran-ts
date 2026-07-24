// ============================================================================
//  @fuaran-ui/renderer-server/markdown — DisplayKind.Markdown → sanitised HTML.
//
//  Mirrors @fuaran-ui/renderer's markdown module: parse markdown to HTML via the
//  same vetted parser (`marked`), then route the output through the shared
//  `sanitizeMarkdownHtml` seam (imported from the React-free
//  @fuaran-ui/renderer/sanitize subpath) before it is poured into the server
//  HTML. Hosts needing DOMPurify-level sanitization layer it consumer-side —
//  this renderer-side pass is the floor, not the ceiling (per Phase 56).
// ============================================================================

import { sanitizeMarkdownHtml } from '@fuaran-ui/renderer/sanitize';
import { marked } from 'marked';

/** Render markdown source to sanitised HTML. `marked.parse` is sync with `async: false`. */
export const toHtml = (source: string): string => {
  const raw = marked.parse(source, { async: false });
  return sanitizeMarkdownHtml(raw);
};
