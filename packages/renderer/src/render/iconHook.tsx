// ============================================================================
//  @fuaran-ui/renderer/render/iconHook — the uniform icon hook.
//
//  Every icon-bearing spec (tab header / Fact / Metric / Callout / Button)
//  renders its icon as ONE empty placement element:
//
//    <span class="fuaran-icon fuaran-{kind}-icon" data-icon="{name}" aria-hidden="true"></span>
//
//  The icon NAME rides the `data-icon` attribute, never the text content — the
//  reference CSS ships no glyphs, so a host with no icon system sees nothing
//  (not the raw name), and a host maps `data-icon` to glyphs via its own
//  mechanism (CSS `::before` content, font classes, or hydration-time SVG
//  injection). `aria-hidden` because every icon-bearing spec pairs the icon
//  with a visible text label. Mirrors the F# renderers' `iconHook`.
// ============================================================================

import type { ReactElement } from 'react';

export const iconHook = (kindClass: string, name: string): ReactElement => (
  <span className={`fuaran-icon ${kindClass}`} data-icon={name} aria-hidden="true" />
);
