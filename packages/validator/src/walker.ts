// ============================================================================
//  @fuaran-ui/validator — TypeScript-AST walker.
//
//  Walks a `.ts` / `.tsx` source file with the TypeScript compiler API (the
//  same engine the consumer already has installed — no extra parser
//  dependency) and extracts the syntactic facts the rules reason against. The
//  TS twin of the F# tier's `AstWalker.fs` (which walks the F# Compiler
//  Services AST). Where the F# walker matches `Fuaran.dashboard` /
//  `binding.query` / `Action.dispatch` call shapes, this walker matches the
//  `@fuaran-ui/ui` object-options surface: `fuaran.dashboard({ id, … })`,
//  `binding.query("name", …)`, `action.dispatch(msg)`, etc.
//
//  Like the F# walker it is deliberately syntactic — it reasons about literal
//  arguments and object-literal properties, never resolving types or chasing
//  let-bindings. A value bound to a variable, query, or computed source leaves
//  the corresponding fact `undefined` and the rule conservatively does not
//  fire. This matches the F# validator's anti-pattern boundary (no full
//  type-checker resolution).
//
//  Identifier convention (v1): the walker matches the canonical namespace
//  identifiers `fuaran` / `binding` / `action` / `node` / `localeFormat` — the
//  names from `import { fuaran, binding, … } from '@fuaran-ui/ui'`. An aliased
//  import (`import { fuaran as f }`) is not tracked, exactly as the F# walker
//  matches the literal `Fuaran.` / `binding.` qualifiers.
// ============================================================================

import ts from 'typescript';

import type { Location } from './findings.js';

/** A `fuaran.<ctor>({ … })` (or positional) smart-constructor call site. */
export interface FuaranCtorCall {
  /** The constructor name, e.g. `"dashboard"`, `"link"`, `"tabs"`, `"button"`. */
  readonly ctor: string;
  readonly location: Location;
  /** The `id` literal, when statically a string. `undefined` otherwise. */
  readonly nodeId: string | undefined;
  /** The enclosing `fuaran.dashboard` `id`, or `undefined` for a loose tree. */
  readonly treeRoot: string | undefined;
  /** Tabs: array-literal lengths + presence flags (`undefined` if not a Tabs ctor). */
  readonly tabs: TabsDetail | undefined;
  /** Link: the statically-known `href` literal. */
  readonly hrefLiteral: string | undefined;
  /** Progress: the statically-known `fraction` numeric literal. */
  readonly fractionLiteral: number | undefined;
  /** gridLayoutTemplated: the statically-known `templateColumns` literal. */
  readonly templateColumns: string | undefined;
  /** Button: `disabled` is bound to `binding.static(false)` — a no-op. */
  readonly disabledStaticFalse: boolean;
}

export interface TabsDetail {
  readonly childrenLength: number | undefined;
  readonly tabHeadersLength: number | undefined;
  readonly tabTagsLength: number | undefined;
  readonly hasTabTags: boolean;
  readonly hasActiveTag: boolean;
}

/** A `binding.query("name", …)` reference. */
export interface QueryRef {
  readonly name: string;
  readonly location: Location;
}

/** An `action.dispatch(msg)` reference whose case name was statically resolvable. */
export interface DispatchRef {
  readonly caseName: string;
  readonly location: Location;
}

/** A `node.withExtraAttribute("key", …)` call with a literal key. */
export interface ExtraAttrCall {
  readonly keyLiteral: string;
  readonly location: Location;
}

/** A `localeFormat.currency("iso")` call with a literal ISO code. */
export interface CurrencyCall {
  readonly isoLiteral: string;
  readonly location: Location;
}

/** Everything the walker extracts from one source file (or a set). */
export interface WalkResult {
  readonly ctorCalls: readonly FuaranCtorCall[];
  readonly queryRefs: readonly QueryRef[];
  readonly dispatchRefs: readonly DispatchRef[];
  readonly extraAttrCalls: readonly ExtraAttrCall[];
  readonly currencyCalls: readonly CurrencyCall[];
}

const FUARAN_CTORS = new Set([
  'dashboard',
  'stack',
  'gridLayout',
  'gridLayoutTemplated',
  'splitPanel',
  'tabs',
  'tabsTagged',
  'card',
  'stepper',
  'summaryList',
  'disclosure',
  'modal',
  'scrollArea',
  'metric',
  'heading',
  'labelValueRow',
  'markdown',
  'markdownSpec',
  'badge',
  'link',
  'image',
  'list',
  'divider',
  'toast',
  'codeBlock',
  'math',
  'sparkline',
  'callout',
  'progress',
  'skeleton',
  'button',
  'select',
  'form',
  'filters',
  'fileUpload',
  'chart',
  'table',
  'map',
  'grid',
  'custom',
  'errorBoundary',
  'fragmentDecl',
  'fragmentRef',
]);

function mkLocation(sf: ts.SourceFile, node: ts.Node, fileName: string): Location {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { file: fileName, line: line + 1, column: character + 1 };
}

/** `obj.method(...)` where `obj` is a bare identifier → `{ obj, method }`. */
function calleeParts(call: ts.CallExpression): { obj: string; method: string } | undefined {
  const expr = call.expression;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    return { obj: expr.expression.text, method: expr.name.text };
  }
  return undefined;
}

function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function numberLiteralValue(node: ts.Node | undefined): number | undefined {
  if (node === undefined) return undefined;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  return undefined;
}

/** Length of an array-literal initializer; `undefined` if not statically an array. */
function arrayLength(node: ts.Node | undefined): number | undefined {
  if (node !== undefined && ts.isArrayLiteralExpression(node)) return node.elements.length;
  return undefined;
}

function objectArg(call: ts.CallExpression): ts.ObjectLiteralExpression | undefined {
  const first = call.arguments[0];
  return first !== undefined && ts.isObjectLiteralExpression(first) ? first : undefined;
}

/** The initializer of a named property on an object literal, if present. */
function getProp(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propName(p.name) === name) return p.initializer;
    // Shorthand (`{ id }`) carries no static literal — treat as present-but-opaque.
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

function hasProp(obj: ts.ObjectLiteralExpression, name: string): boolean {
  return obj.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) && propName(p.name) === name) ||
      (ts.isShorthandPropertyAssignment(p) && p.name.text === name),
  );
}

function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    return name.text;
  return undefined;
}

/** `binding.static(false)` — the no-op disabled binding FUARAN064 flags. */
function isBindingStaticFalse(node: ts.Expression | undefined): boolean {
  if (node === undefined || !ts.isCallExpression(node)) return false;
  const parts = calleeParts(node);
  if (parts === undefined || parts.obj !== 'binding' || parts.method !== 'static') return false;
  const arg = node.arguments[0];
  return arg !== undefined && arg.kind === ts.SyntaxKind.FalseKeyword;
}

/**
 * Extract a dispatched message's case name when it is statically knowable:
 *   - a discriminated-union object literal: `{ type: "LoadData" }` /
 *     `{ kind: "…" }` / `{ tag: "…" }` (the common TS Elm-style shape);
 *   - a bare string literal: `action.dispatch("LoadData")`;
 *   - a qualified case reference: `Msg.LoadData` / `MsgTag.LoadData`.
 * Anything else (a bound variable, a constructed value) is opaque → `undefined`.
 */
function dispatchCaseName(arg: ts.Expression | undefined): string | undefined {
  if (arg === undefined) return undefined;
  if (ts.isObjectLiteralExpression(arg)) {
    for (const disc of ['type', 'kind', 'tag']) {
      const v = stringLiteralValue(getProp(arg, disc));
      if (v !== undefined) return v;
    }
    return undefined;
  }
  const lit = stringLiteralValue(arg);
  if (lit !== undefined) return lit;
  if (ts.isPropertyAccessExpression(arg)) return arg.name.text;
  return undefined;
}

function readTabsDetail(obj: ts.ObjectLiteralExpression | undefined): TabsDetail {
  if (obj === undefined) {
    return {
      childrenLength: undefined,
      tabHeadersLength: undefined,
      tabTagsLength: undefined,
      hasTabTags: false,
      hasActiveTag: false,
    };
  }
  return {
    childrenLength: arrayLength(getProp(obj, 'children')),
    tabHeadersLength: arrayLength(getProp(obj, 'tabHeaders')),
    tabTagsLength: arrayLength(getProp(obj, 'tabTags')),
    hasTabTags: hasProp(obj, 'tabTags'),
    hasActiveTag: hasProp(obj, 'activeTag'),
  };
}

/** The `id` of a fuaran ctor call — object-options `{ id: "x" }` or positional `("x", …)`. */
function ctorNodeId(call: ts.CallExpression): string | undefined {
  const obj = objectArg(call);
  if (obj !== undefined) return stringLiteralValue(getProp(obj, 'id'));
  return stringLiteralValue(call.arguments[0]);
}

/** Walk one already-parsed source file, accumulating facts into `acc`. */
function walkSourceFile(sf: ts.SourceFile, fileName: string, acc: MutableWalk): void {
  const visit = (node: ts.Node, treeRoot: string | undefined): void => {
    if (ts.isCallExpression(node)) {
      const parts = calleeParts(node);
      if (parts !== undefined) {
        const { obj, method } = parts;
        if (obj === 'fuaran' && FUARAN_CTORS.has(method)) {
          const nodeId = ctorNodeId(node);
          const isDashboard = method === 'dashboard';
          const ownTreeRoot = isDashboard ? nodeId : treeRoot;
          const optionObj = objectArg(node);
          acc.ctorCalls.push({
            ctor: method,
            location: mkLocation(sf, node, fileName),
            nodeId,
            treeRoot: ownTreeRoot,
            tabs:
              method === 'tabs' || method === 'tabsTagged' ? readTabsDetail(optionObj) : undefined,
            hrefLiteral:
              method === 'link' && optionObj !== undefined
                ? stringLiteralValue(getProp(optionObj, 'href'))
                : undefined,
            fractionLiteral:
              method === 'progress' && optionObj !== undefined
                ? numberLiteralValue(getProp(optionObj, 'fraction'))
                : undefined,
            templateColumns:
              method === 'gridLayoutTemplated' && optionObj !== undefined
                ? stringLiteralValue(getProp(optionObj, 'templateColumns'))
                : undefined,
            disabledStaticFalse:
              method === 'button' && optionObj !== undefined
                ? isBindingStaticFalse(getProp(optionObj, 'disabled'))
                : false,
          });
          // Descend with this dashboard's id as the tree root for nested ctors.
          const childRoot = isDashboard ? nodeId : treeRoot;
          ts.forEachChild(node, (c) => visit(c, childRoot));
          return;
        }
        if (obj === 'binding' && method === 'query') {
          const name = stringLiteralValue(node.arguments[0]);
          if (name !== undefined)
            acc.queryRefs.push({ name, location: mkLocation(sf, node, fileName) });
        } else if (obj === 'action' && method === 'dispatch') {
          const caseName = dispatchCaseName(node.arguments[0]);
          if (caseName !== undefined)
            acc.dispatchRefs.push({ caseName, location: mkLocation(sf, node, fileName) });
        } else if (obj === 'node' && method === 'withExtraAttribute') {
          const keyLiteral = stringLiteralValue(node.arguments[0]);
          if (keyLiteral !== undefined)
            acc.extraAttrCalls.push({
              keyLiteral,
              location: mkLocation(sf, node.arguments[0]!, fileName),
            });
        } else if (obj === 'localeFormat' && method === 'currency') {
          const isoLiteral = stringLiteralValue(node.arguments[0]);
          if (isoLiteral !== undefined)
            acc.currencyCalls.push({ isoLiteral, location: mkLocation(sf, node, fileName) });
        }
      }
    }
    ts.forEachChild(node, (c) => visit(c, treeRoot));
  };

  visit(sf, undefined);
}

interface MutableWalk {
  ctorCalls: FuaranCtorCall[];
  queryRefs: QueryRef[];
  dispatchRefs: DispatchRef[];
  extraAttrCalls: ExtraAttrCall[];
  currencyCalls: CurrencyCall[];
}

/** Parse + walk a single source string (used by the API and tests). */
export function walkSource(fileName: string, source: string): WalkResult {
  const acc: MutableWalk = {
    ctorCalls: [],
    queryRefs: [],
    dispatchRefs: [],
    extraAttrCalls: [],
    currencyCalls: [],
  };
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind,
  );
  walkSourceFile(sf, fileName, acc);
  return acc;
}

/** Merge several `WalkResult`s into one (the project-wide fact set). */
export function mergeWalks(results: readonly WalkResult[]): WalkResult {
  return {
    ctorCalls: results.flatMap((r) => r.ctorCalls),
    queryRefs: results.flatMap((r) => r.queryRefs),
    dispatchRefs: results.flatMap((r) => r.dispatchRefs),
    extraAttrCalls: results.flatMap((r) => r.extraAttrCalls),
    currencyCalls: results.flatMap((r) => r.currencyCalls),
  };
}
