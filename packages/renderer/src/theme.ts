// ============================================================================
//  @fuaran-ui/renderer/theme — typed Theme record + themeToCss bridge (Phase 12.K).
//
//  A typed CSS-variable bundle the renderer can project to a `:root { … }`
//  block (or inject as inline custom properties at the render root). Mirrors
//  the F# Theme module's variable naming (toCssVariables) — tones (7×3),
//  spacing (5), font scale (7), font weights (4), line heights (3), radii (3).
//  `defaultTheme` carries values aligned with the packaged reference CSS so
//  `<FuaranRenderer theme={defaultTheme}>` reproduces the default look without
//  importing the stylesheet.
// ============================================================================

/** A resolved CSS colour value (hex / oklch / any raw CSS colour string). */
export type ColorValue = string;

export interface ToneStops {
  readonly background: ColorValue;
  readonly foreground: ColorValue;
  readonly border: ColorValue;
}

export interface Tones {
  readonly default: ToneStops;
  readonly subdued: ToneStops;
  readonly brand: ToneStops;
  readonly success: ToneStops;
  readonly warning: ToneStops;
  readonly critical: ToneStops;
  readonly info: ToneStops;
}

export interface Spacing {
  readonly xs: string;
  readonly sm: string;
  readonly md: string;
  readonly lg: string;
  readonly xl: string;
}

export interface FontScale {
  readonly xs: string;
  readonly sm: string;
  readonly base: string;
  readonly lg: string;
  readonly xl: string;
  readonly xxl: string;
  readonly xxxl: string;
}

export interface FontWeight {
  readonly regular: number;
  readonly medium: number;
  readonly semibold: number;
  readonly bold: number;
}

export interface LineHeight {
  readonly tight: number;
  readonly normal: number;
  readonly relaxed: number;
}

export interface Radius {
  readonly sm: string;
  readonly md: string;
  readonly lg: string;
}

export interface Theme {
  readonly tones: Tones;
  readonly spacing: Spacing;
  readonly fontScale: FontScale;
  readonly fontWeight: FontWeight;
  readonly lineHeight: LineHeight;
  readonly radius: Radius;
}

const tonesInOrder = (tones: Tones): Array<readonly [string, ToneStops]> => [
  ['default', tones.default],
  ['subdued', tones.subdued],
  ['brand', tones.brand],
  ['success', tones.success],
  ['warning', tones.warning],
  ['critical', tones.critical],
  ['info', tones.info],
];

/** Emit the `[name, value]` CSS-variable pairs a Theme projects (stable order). */
export const themeToCssVariables = (theme: Theme): Array<readonly [string, string]> => {
  const pairs: Array<readonly [string, string]> = [];
  for (const [name, stops] of tonesInOrder(theme.tones)) {
    pairs.push([`--fuaran-tone-${name}-bg`, stops.background]);
    pairs.push([`--fuaran-tone-${name}-fg`, stops.foreground]);
    pairs.push([`--fuaran-tone-${name}-border`, stops.border]);
  }
  pairs.push(['--fuaran-space-xs', theme.spacing.xs]);
  pairs.push(['--fuaran-space-sm', theme.spacing.sm]);
  pairs.push(['--fuaran-space-md', theme.spacing.md]);
  pairs.push(['--fuaran-space-lg', theme.spacing.lg]);
  pairs.push(['--fuaran-space-xl', theme.spacing.xl]);
  pairs.push(['--fuaran-text-xs', theme.fontScale.xs]);
  pairs.push(['--fuaran-text-sm', theme.fontScale.sm]);
  pairs.push(['--fuaran-text-base', theme.fontScale.base]);
  pairs.push(['--fuaran-text-lg', theme.fontScale.lg]);
  pairs.push(['--fuaran-text-xl', theme.fontScale.xl]);
  pairs.push(['--fuaran-text-2xl', theme.fontScale.xxl]);
  pairs.push(['--fuaran-text-3xl', theme.fontScale.xxxl]);
  pairs.push(['--fuaran-font-weight-regular', String(theme.fontWeight.regular)]);
  pairs.push(['--fuaran-font-weight-medium', String(theme.fontWeight.medium)]);
  pairs.push(['--fuaran-font-weight-semibold', String(theme.fontWeight.semibold)]);
  pairs.push(['--fuaran-font-weight-bold', String(theme.fontWeight.bold)]);
  pairs.push(['--fuaran-line-height-tight', String(theme.lineHeight.tight)]);
  pairs.push(['--fuaran-line-height-normal', String(theme.lineHeight.normal)]);
  pairs.push(['--fuaran-line-height-relaxed', String(theme.lineHeight.relaxed)]);
  pairs.push(['--fuaran-radius-sm', theme.radius.sm]);
  pairs.push(['--fuaran-radius-md', theme.radius.md]);
  pairs.push(['--fuaran-radius-lg', theme.radius.lg]);
  return pairs;
};

/** Project a Theme to a `:root { … }` CSS string. */
export const themeToCss = (theme: Theme): string => {
  const body = themeToCssVariables(theme)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `:root {\n${body}\n}`;
};

/** Project a Theme to a React inline-style record (CSS custom properties). */
export const themeToStyle = (theme: Theme): Record<string, string> => {
  const style: Record<string, string> = {};
  for (const [name, value] of themeToCssVariables(theme)) style[name] = value;
  return style;
};

/** Default theme aligned with the packaged reference CSS. */
export const defaultTheme: Theme = {
  tones: {
    default: { background: '#ffffff', foreground: '#1a1a1a', border: '#e2e2e2' },
    subdued: { background: '#f6f6f6', foreground: '#555555', border: '#e2e2e2' },
    brand: { background: '#eef2ff', foreground: '#3730a3', border: '#c7d2fe' },
    success: { background: '#ecfdf5', foreground: '#065f46', border: '#a7f3d0' },
    warning: { background: '#fffbeb', foreground: '#92400e', border: '#fde68a' },
    critical: { background: '#fef2f2', foreground: '#991b1b', border: '#fecaca' },
    info: { background: '#eff6ff', foreground: '#1e40af', border: '#bfdbfe' },
  },
  spacing: { xs: '0.25rem', sm: '0.5rem', md: '1rem', lg: '1.5rem', xl: '2.5rem' },
  fontScale: {
    xs: '0.75rem',
    sm: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
    xl: '1.375rem',
    xxl: '1.75rem',
    xxxl: '2.25rem',
  },
  fontWeight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
  lineHeight: { tight: 1.2, normal: 1.5, relaxed: 1.75 },
  radius: { sm: '0.25rem', md: '0.5rem', lg: '0.75rem' },
};
