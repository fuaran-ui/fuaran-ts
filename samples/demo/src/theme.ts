// A sample dark theme (mirrors the F# tier's Phase 12.K `Dark` sample theme
// shape). Applying it via `<FuaranRenderer theme={darkTheme} />` injects the
// theme's CSS custom properties as inline variables at the render root, so the
// same tree renders in a dark palette with no stylesheet swap.

import { type Theme, defaultTheme } from '@fuaran-ui/renderer';

export const darkTheme: Theme = {
  ...defaultTheme,
  tones: {
    default: { background: '#0f172a', foreground: '#e2e8f0', border: '#334155' },
    subdued: { background: '#1e293b', foreground: '#94a3b8', border: '#334155' },
    brand: { background: '#1e1b4b', foreground: '#c7d2fe', border: '#4338ca' },
    success: { background: '#052e1a', foreground: '#6ee7b7', border: '#065f46' },
    warning: { background: '#451a03', foreground: '#fcd34d', border: '#92400e' },
    critical: { background: '#450a0a', foreground: '#fca5a5', border: '#991b1b' },
    info: { background: '#082f49', foreground: '#7dd3fc', border: '#0369a1' },
  },
};

export { defaultTheme };
