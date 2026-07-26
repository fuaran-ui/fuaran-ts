// ============================================================================
//  @fuaran-ui/validator — programmatic API.
//
//  Orchestrates the walker + rules over a set of source files and returns the
//  merged finding list. The TS twin of the F# tier's `Validator.run`. Two
//  entry points:
//
//    validateSources(sources, opts)  — validate in-memory { fileName, source }
//                                       pairs (used by tests + editor plugins).
//    validateProject(opts)           — read files from disk (glob or explicit
//                                       paths), discover the manifest, validate.
//
//  Both return a `RunResult` so callers decide formatting + exit-code policy
//  (the API never calls `process.exit`). Manifest-coupled rules (FUARAN010 /
//  FUARAN020) are silenced without a manifest, and a single FUARAN900 warning
//  surfaces the silenced state — exactly the F# tier's posture.
// ============================================================================

import { readFileSync } from 'node:fs';

import { create, type Finding } from './findings.js';
import { discoverManifest, emptyManifest, loadManifest, type Manifest } from './manifest.js';
import {
  bindingQueryRule,
  buttonDisabledRule,
  currencyRule,
  dispatchRule,
  extraAttributeRule,
  gridTemplateRule,
  linkHrefRule,
  nodeIdRules,
  progressRangeRule,
  tabsRules,
} from './rules.js';
import { mergeWalks, walkSource, type WalkResult } from './walker.js';

export interface RunResult {
  readonly findings: readonly Finding[];
  readonly manifestPath: string | undefined;
  readonly manifestLoaded: boolean;
  readonly filesWalked: number;
}

export interface SourceFile {
  readonly fileName: string;
  readonly source: string;
}

export interface ValidateSourcesOptions {
  /** The contract to gate FUARAN010 / FUARAN020 against. */
  readonly manifest?: Manifest;
  /**
   * Path to surface in the FUARAN900 warning when no manifest is supplied
   * (cosmetic — the warning's location). Defaults to `"<sources>"`.
   */
  readonly manifestProbePath?: string;
}

/** Run every rule over an already-parsed fact set + manifest. */
function runRules(walk: WalkResult, manifest: Manifest): Finding[] {
  return [
    ...nodeIdRules(walk.ctorCalls),
    ...bindingQueryRule(manifest, walk),
    ...dispatchRule(manifest, walk),
    ...tabsRules(walk.ctorCalls),
    ...progressRangeRule(walk.ctorCalls),
    ...linkHrefRule(walk.ctorCalls),
    ...buttonDisabledRule(walk.ctorCalls),
    ...gridTemplateRule(walk.ctorCalls),
    ...extraAttributeRule(walk),
    ...currencyRule(walk),
  ];
}

/** Validate in-memory sources (no disk access for the sources themselves). */
export function validateSources(
  sources: readonly SourceFile[],
  options: ValidateSourcesOptions = {},
): RunResult {
  const manifest = options.manifest ?? emptyManifest;
  const manifestLoaded = options.manifest !== undefined;
  const walk = mergeWalks(sources.map((s) => walkSource(s.fileName, s.source)));

  const preamble: Finding[] = manifestLoaded
    ? []
    : [
        create(
          'warning',
          'FUARAN900',
          { file: options.manifestProbePath ?? '<sources>', line: 1, column: 1 },
          'No fuaran-validator.manifest.json found — schema-coupled checks (binding.query name resolution, action.dispatch case names) are silenced. See fuaran-dotnet/docs/VALIDATOR-MANIFEST.md.',
        ),
      ];

  return {
    findings: [...preamble, ...runRules(walk, manifest)],
    manifestPath: undefined,
    manifestLoaded,
    filesWalked: sources.length,
  };
}

export interface ValidateProjectOptions {
  /** Absolute or relative paths to the `.ts` / `.tsx` files to validate. */
  readonly files: readonly string[];
  /**
   * Directory used for convention-based manifest discovery
   * (`fuaran-validator.manifest.json`). Defaults to `process.cwd()`.
   */
  readonly projectDir?: string;
  /** Explicit manifest path; overrides discovery. */
  readonly manifestPath?: string;
}

/** Read `files` from disk, discover the manifest, and validate. */
export function validateProject(options: ValidateProjectOptions): RunResult {
  const projectDir = options.projectDir ?? process.cwd();
  const manifestPath =
    options.manifestPath !== undefined ? options.manifestPath : discoverManifest(projectDir);
  const manifest = manifestPath !== undefined ? loadManifest(manifestPath) : emptyManifest;

  const walk = mergeWalks(
    options.files.map((file) => walkSource(file, readFileSync(file, 'utf8'))),
  );

  const preamble: Finding[] =
    manifestPath !== undefined
      ? []
      : [
          create(
            'warning',
            'FUARAN900',
            { file: projectDir, line: 1, column: 1 },
            'No fuaran-validator.manifest.json found in the project directory — schema-coupled checks (binding.query name resolution, action.dispatch case names) are silenced. See fuaran-dotnet/docs/VALIDATOR-MANIFEST.md.',
          ),
        ];

  return {
    findings: [...preamble, ...runRules(walk, manifest)],
    manifestPath,
    manifestLoaded: manifestPath !== undefined,
    filesWalked: options.files.length,
  };
}
