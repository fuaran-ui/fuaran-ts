// ============================================================================
//  The core-twins boundary rule, as a pure checker over source text.
//
//  The rule (Phase 1861): nothing inside `packages/core-twins/src` imports from
//  this host's domain packages. Stated as what IS admitted, because an
//  allowlist cannot be dodged by a spelling the author of a denylist did not
//  think of:
//
//    1. a RELATIVE specifier that stays inside `src/`;
//    2. an ERASED, type-only import of `@fuaran-ui/schema`, naming only types
//       in `SCHEMA_TYPE_ALLOWLIST` — the declarations the twins range over.
//
//  Everything else is a violation: any other `@fuaran-ui/*` package, any value
//  (runtime) import from `@fuaran-ui/schema`, any third-party or `node:` module,
//  a relative path that climbs out of `src/`, `export … from`, dynamic
//  `import()` / `require()`, and `import('…').T` type queries. The walk is over
//  the TypeScript AST, so a specifier cannot hide in a comment or a string.
// ============================================================================

import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';

/** The only host package the boundary may name, and only for erased type imports. */
export const SCHEMA_PACKAGE = '@fuaran-ui/schema';

/**
 * The exact set of `@fuaran-ui/schema` types the twins import. Pinned EXACTLY
 * (the test fails on an unused entry as well as on a missing one), so this list
 * is always the precise type surface a future per-language Core package must
 * carry alongside `src/`.
 */
export const SCHEMA_TYPE_ALLOWLIST: readonly string[] = [
  'Agg',
  'AggFn',
  'Capability',
  'CapabilitySigEntry',
  'CapabilitySignature',
  'Cell',
  'ColExpr',
  'ColumnType',
  'DataColumn',
  'DataSource',
  'DeterminismSource',
  'EffectClass',
  'EvalError',
  'HoleValueSpace',
  'HostEffect',
  'InvokeArg',
  'Placement',
  'Result',
  'SchemaEntry',
  'SortKey',
  'Table',
  'Transform',
];

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly reason: string;
}

export interface FileReport {
  readonly violations: readonly Violation[];
  /** Every `@fuaran-ui/schema` type name this file imports (admitted or not). */
  readonly schemaTypes: readonly string[];
}

const isRelative = (s: string): boolean => s.startsWith('./') || s.startsWith('../');

/**
 * Check one source file. `srcRoot` is the absolute `src/` directory; `file` is
 * the file's absolute path (it anchors relative specifiers).
 */
export const checkSource = (srcRoot: string, file: string, text: string): FileReport => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: Violation[] = [];
  const schemaTypes: string[] = [];
  const at = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const flag = (node: ts.Node, specifier: string, reason: string): void => {
    violations.push({ file, line: at(node), specifier, reason });
  };

  const checkRelative = (node: ts.Node, spec: string): void => {
    const target = resolve(dirname(file), spec);
    const rel = relative(srcRoot, target);
    if (rel.startsWith('..') || resolve(srcRoot, rel) !== target)
      flag(node, spec, 'relative import leaves the core-twins src/ directory');
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (isRelative(spec)) checkRelative(node, spec);
      else if (spec !== SCHEMA_PACKAGE) flag(node, spec, 'imports a module outside the boundary');
      else {
        const clause = node.importClause;
        if (clause === undefined) flag(node, spec, 'side-effect import of a host package');
        else {
          if (clause.name !== undefined && !clause.isTypeOnly)
            flag(node, spec, 'default value import from a host package');
          const bindings = clause.namedBindings;
          if (bindings !== undefined && ts.isNamespaceImport(bindings) && !clause.isTypeOnly)
            flag(node, spec, 'namespace value import from a host package');
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
              const name = (el.propertyName ?? el.name).text;
              schemaTypes.push(name);
              if (!clause.isTypeOnly && !el.isTypeOnly)
                flag(
                  el,
                  spec,
                  `value import '${name}' from a host package (only erased types may cross)`,
                );
              if (!SCHEMA_TYPE_ALLOWLIST.includes(name))
                flag(el, spec, `type '${name}' is not in SCHEMA_TYPE_ALLOWLIST`);
            }
          }
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      if (isRelative(spec)) checkRelative(node, spec);
      else flag(node, spec, 're-exports a module outside the boundary');
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression)) {
        const spec = ref.expression.text;
        if (isRelative(spec)) checkRelative(node, spec);
        else flag(node, spec, 'imports a module outside the boundary');
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamic || isRequire) {
        const arg = node.arguments[0];
        const spec = arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : '<computed>';
        if (spec !== '<computed>' && isRelative(spec)) checkRelative(node, spec);
        else
          flag(
            node,
            spec,
            `${isDynamic ? 'dynamic import()' : 'require()'} of a module outside the boundary`,
          );
      }
    } else if (ts.isImportTypeNode(node)) {
      const lit = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      const spec = lit !== undefined && ts.isStringLiteral(lit) ? lit.text : '<computed>';
      if (spec !== '<computed>' && isRelative(spec)) checkRelative(node, spec);
      else flag(node, spec, "import('…') type query of a module outside the boundary");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { violations, schemaTypes };
};

/**
 * A published artefact must never NAME the private package: a reference would
 * resolve for nobody who installs from the registry. Matches the module
 * specifier forms a bundler or declaration emitter can produce (static
 * `import`/`export … from`, bare `import '…'`, `require('…')`, `import('…')`),
 * and deliberately not a path in a comment — esbuild's region comments name the
 * source file they inlined, and that is provenance, not a reference.
 */
const LEAK_RE =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']@fuaran-ui\/core-twins(?:\/[^"']*)?["']/;

export const leaksPrivatePackage = (distText: string): boolean => LEAK_RE.test(distText);
