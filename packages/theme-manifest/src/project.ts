// ============================================================================
//  @fuaran-ui/theme-manifest/project — ingest existing token surfaces.
//
//  Port of Fuaran.UI.ThemeManifest.Project. Lower the adoption floor: project an
//  app's existing token surface into a baseline ThemeManifest (tokens + inferable
//  role bindings) the operator then enriches with invariants. Three source
//  formats + a merge:
//    - projectFromFuaranToneVars  — the renderer's `--fuaran-tone-{tone}-{slot}`
//      contract (role inference is direct: the contract is already semantic).
//    - projectFromCssCustomProperties — a generic :root (+ dark block) set; roles
//      left unbound; light/dark preserved (`@dark` suffix).
//    - projectFromDtcg — a DTCG / tokens.json file (values lossless; grouping not
//      mined for bindings, per DTCG's caveat).
//    - merge — combine a base + override with last-write-wins precedence.
// ============================================================================

import { type DecodeManifestResult, decodeManifest } from './decode.js';
import {
  type ManifestRole,
  type ManifestToken,
  type RoleBinding,
  type ThemeManifest,
  emptyManifest,
  toneOfString,
} from './manifest.js';

// ─── Lightweight CSS custom-property scanning ─────────────────────────────────

/** One selector block — its selector text + the `--name → value` declarations inside it. */
export interface CssBlock {
  readonly selector: string;
  readonly declarations: ReadonlyArray<readonly [string, string]>;
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Scan flat `selector { … }` blocks, keeping only custom-property (`--`) declarations. */
export const scanCssBlocks = (css: string): CssBlock[] => {
  const cleaned = stripComments(css);
  const out: CssBlock[] = [];
  for (const chunk of cleaned.split('}')) {
    const brace = chunk.indexOf('{');
    if (brace < 0) continue;
    const selector = chunk.slice(0, brace).trim();
    const body = chunk.slice(brace + 1);
    const declarations: Array<readonly [string, string]> = [];
    for (const decl of body.split(';')) {
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      const name = decl.slice(0, colon).trim();
      const value = decl.slice(colon + 1).trim();
      if (name.startsWith('--')) declarations.push([name, value]);
    }
    if (declarations.length > 0) out.push({ selector, declarations });
  }
  return out;
};

// ─── Value-type inference (DTCG `$type`) ──────────────────────────────────────

const inferType = (value: string): string => {
  const v = value.trim().toLowerCase();
  if (
    v.startsWith('#') ||
    v.startsWith('rgb') ||
    v.startsWith('hsl') ||
    v.startsWith('oklch') ||
    v.startsWith('oklab') ||
    v.startsWith('color(')
  ) {
    return 'color';
  }
  if (v.endsWith('px') || v.endsWith('rem') || v.endsWith('em') || v.endsWith('%'))
    return 'dimension';
  if (v.endsWith('ms') || v.endsWith('s')) return 'duration';
  return '';
};

const token = (name: string, value: string): ManifestToken => ({
  name,
  type: inferType(value),
  value,
});

const dedupeTokens = (ts: readonly ManifestToken[]): ManifestToken[] => {
  // last-write-wins by name
  const byName = new Map<string, ManifestToken>();
  for (const t of ts) byName.set(t.name, t);
  return [...byName.values()];
};

// ─── Fuaran-tone projector ────────────────────────────────────────────────────

const toneFromCss = (s: string): boolean => toneOfString(cap(s)) !== undefined;
const cap = (s: string): string =>
  s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1).toLowerCase();

/**
 * Project a `--fuaran-tone-{tone}-{slot}` custom-property set into a manifest.
 * Token names are `tone.{tone}.{slot}`; each tone whose `bg` slot is present gets
 * a `ToneVariant` role binding to that token. Role inference is direct.
 */
export const projectFromFuaranToneVars = (css: string): ThemeManifest => {
  const decls = scanCssBlocks(css).flatMap((b) => b.declarations);
  const tokens = dedupeTokens(
    decls.flatMap(([name, value]) => {
      const stripped = name.replace(/^-+/, '');
      if (!stripped.startsWith('fuaran-tone-')) return [];
      const rest = stripped.slice('fuaran-tone-'.length);
      const parts = rest.split('-');
      if (parts.length !== 2) return [];
      const [tone, slot] = parts as [string, string];
      if (!toneFromCss(tone)) return [];
      return [token(`tone.${tone.toLowerCase()}.${slot.toLowerCase()}`, value)];
    }),
  );
  const roles: RoleBinding[] = tokens.flatMap((t) => {
    const parts = t.name.split('.');
    if (parts.length === 3 && parts[0] === 'tone' && parts[2] === 'bg') {
      const tone = toneOfString(cap(parts[1]!));
      if (tone !== undefined) return [{ role: { kind: 'Tone', tone }, tokenName: t.name }];
    }
    return [];
  });
  return { ...emptyManifest, tokens, roles };
};

// ─── Generic CSS custom-property projector ────────────────────────────────────

const isDarkSelector = (selector: string): boolean => {
  const s = selector.toLowerCase();
  return s.includes('data-theme=dark') || s.includes('data-theme="dark"') || s.includes('.dark');
};

/**
 * Project a generic :root custom-property block (+ optional dark block) into
 * tokens. Light values keep the bare var name; a dark counterpart is `{name}@dark`.
 * Roles are left unbound — bespoke var names carry no inferable semantic role.
 */
export const projectFromCssCustomProperties = (css: string): ThemeManifest => {
  const blocks = scanCssBlocks(css);
  const light = blocks
    .filter((b) => !isDarkSelector(b.selector))
    .flatMap((b) => b.declarations)
    .map(([name, value]) => token(name.replace(/^-+/, ''), value));
  const dark = blocks
    .filter((b) => isDarkSelector(b.selector))
    .flatMap((b) => b.declarations)
    .map(([name, value]) => token(`${name.replace(/^-+/, '')}@dark`, value));
  return { ...emptyManifest, tokens: dedupeTokens([...light, ...dark]) };
};

// ─── DTCG projector ───────────────────────────────────────────────────────────

/** Project a DTCG / tokens.json file into a manifest (values lossless; roles unmined). */
export const projectFromDtcg = (json: string): DecodeManifestResult => decodeManifest(json);

// ─── Merge ─────────────────────────────────────────────────────────────────────

const roleKey = (role: ManifestRole): string =>
  role.kind === 'Tone' ? `tone:${role.tone}` : `named:${role.name}`;

/**
 * Merge an override manifest onto a base with last-write-wins precedence matching
 * the CSS cascade. Tokens + role bindings from `over` replace same-keyed entries;
 * invariants are unioned (override-first, de-duplicated).
 */
export const merge = (base: ThemeManifest, over: ThemeManifest): ThemeManifest => {
  const overTokenNames = new Set(over.tokens.map((t) => t.name));
  const tokens = [...base.tokens.filter((t) => !overTokenNames.has(t.name)), ...over.tokens];

  const overRoleKeys = new Set(over.roles.map((r) => roleKey(r.role)));
  const roles = [...base.roles.filter((r) => !overRoleKeys.has(roleKey(r.role))), ...over.roles];

  const seen = new Set<string>();
  const invariants = [...over.invariants, ...base.invariants].filter((inv) => {
    const key = JSON.stringify(inv);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const metaIsAnonymous =
    over.meta.name === '' && over.meta.version === '' && over.meta.description === undefined;
  const meta = metaIsAnonymous ? base.meta : over.meta;

  return { meta, tokens, roles, invariants };
};
