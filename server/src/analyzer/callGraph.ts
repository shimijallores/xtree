import ts from "typescript";
import type { CodeEdge, CodeSymbol } from "../types";
import type { ExtractedSymbol } from "./symbols";

export interface EdgeContext {
  checker: ts.TypeChecker;
  /** Declaration node -> symbol id. */
  declToId: Map<ts.Node, string>;
  /** True if an absolute file name belongs to the analysed project (not lib / node_modules). */
  isProjectFile: (fileName: string) => boolean;
}

export interface EdgeResult {
  edges: CodeEdge[];
  externals: Map<string, CodeSymbol>;
}

const edgeId = (kind: string, from: string, to: string) => `${kind}:${from}->${to}`;
const EXTERNAL_PREFIX = "external#";

function followAlias(checker: ts.TypeChecker, sym: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try {
      const target = checker.getAliasedSymbol(sym);
      // unresolved imports alias to the "unknown" symbol, which has no declarations
      return target.declarations?.length ? target : undefined;
    } catch {
      return undefined;
    }
  }
  return sym;
}

function containerName(decl: ts.Node): string | null {
  let p: ts.Node | undefined = decl.parent;
  while (p) {
    if ((ts.isInterfaceDeclaration(p) || ts.isClassDeclaration(p)) && p.name) return p.name.text;
    if (ts.isModuleDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isSourceFile(p)) return null;
    p = p.parent;
  }
  return null;
}

/** Human-readable name for a call that does not resolve to a project symbol. */
function externalName(
  callee: ts.Expression,
  decl: ts.Node | undefined,
  sf: ts.SourceFile,
  ctx: EdgeContext,
): string {
  let e = callee;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isPropertyAccessExpression(e)) {
    const member = e.name.text;
    const recv = e.expression;
    // Globals (console, Math, JSON) and imported modules (fs, express) read best by
    // their own name; locals (items.reduce) read best by their type (Array.reduce).
    if (ts.isIdentifier(recv) && !isProjectLocal(recv, ctx)) return `${recv.text}.${member}`;
    if (decl) {
      const owner = containerName(decl);
      if (owner) return `${owner}.${member}`;
    }
    return ts.isIdentifier(recv) ? `${recv.text}.${member}` : member;
  }
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isElementAccessExpression(e)) return clipName(e.getText(sf));
  return clipName(e.getText(sf));
}

/** True if the identifier refers to a variable/parameter declared in project code (not an import). */
function isProjectLocal(id: ts.Identifier, ctx: EdgeContext): boolean {
  let sym: ts.Symbol | undefined;
  try {
    sym = ctx.checker.getSymbolAtLocation(id);
  } catch {
    return false;
  }
  if (!sym || sym.flags & ts.SymbolFlags.Alias) return false;
  const d = sym.declarations?.[0];
  return !!d && ctx.isProjectFile(d.getSourceFile().fileName);
}

const clipName = (s: string) => {
  const one = s.replace(/\s+/g, " ");
  return one.length > 40 ? `${one.slice(0, 39)}…` : one;
};

function calleeTarget(callee: ts.Expression): ts.Node {
  let e = callee;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isPropertyAccessExpression(e)) return e.name;
  if (ts.isElementAccessExpression(e)) return e.argumentExpression;
  return e;
}

/** Resolves a name/type reference to a project symbol id, if any. */
function resolveToId(ctx: EdgeContext, node: ts.Node): { id?: string; decl?: ts.Node; inProject: boolean } {
  let sym: ts.Symbol | undefined;
  try {
    sym = followAlias(ctx.checker, ctx.checker.getSymbolAtLocation(node));
  } catch {
    sym = undefined;
  }
  const decls = sym?.declarations ?? [];
  for (const d of decls) {
    const id = ctx.declToId.get(d);
    if (id) return { id, decl: d, inProject: true };
  }
  if (decls.length) {
    const decl = decls[0];
    return { decl, inProject: ctx.isProjectFile(decl.getSourceFile().fileName) };
  }
  return { inProject: false };
}

/**
 * Builds calls / contains / uses-type / extends / implements edges for the extracted
 * symbols. Calls that cannot be resolved to a project symbol become external stubs;
 * calls into project code that is not a symbol (local helpers, interface members via
 * dynamic dispatch) are omitted, never guessed.
 */
export function buildEdges(all: ExtractedSymbol[], ctx: EdgeContext): EdgeResult {
  const edges = new Map<string, CodeEdge>();
  const externals = new Map<string, CodeSymbol>();
  const add = (kind: CodeEdge["kind"], from: string, to: string, order?: number) => {
    if (from === to && kind !== "calls") return;
    const id = edgeId(kind, from, to);
    if (edges.has(id)) return;
    edges.set(id, { id, kind, from, to, ...(order !== undefined ? { order } : {}) });
  };

  for (const x of all) {
    const s = x.symbol;
    const sf = (x.decls[0] ?? x.body)?.getSourceFile();
    if (!sf) continue;

    // contains: class -> member
    if (s.parentId) add("contains", s.parentId, s.id);

    // calls, in execution order (post-order: arguments run before the call that uses them)
    if (x.body) {
      const targets: string[] = [];
      const record = (to: string) => {
        if (!targets.includes(to)) targets.push(to);
      };
      const recordCallee = (callee: ts.Expression) => {
        const r = resolveToId(ctx, calleeTarget(callee));
        if (r.id) {
          record(r.id);
        } else if (!r.inProject) {
          const name = externalName(callee, r.decl, sf, ctx);
          if (!name) return;
          const id = `${EXTERNAL_PREFIX}${name}`;
          if (!externals.has(id)) {
            externals.set(id, {
              id,
              kind: "external",
              name,
              file: "external",
              range: { start: 0, end: 0 },
              signature: `${name}(…)`,
              source: "",
              hash: "external",
            });
          }
          record(id);
        }
      };
      const visit = (n: ts.Node) => {
        ts.forEachChild(n, visit);
        if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
          const callee = n.expression;
          if (callee.kind === ts.SyntaxKind.SuperKeyword || callee.kind === ts.SyntaxKind.ImportKeyword) return;
          recordCallee(callee);
        } else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
          // <Button /> renders (calls) the Button component. Lowercase tags are DOM elements.
          const tag = n.tagName;
          if (tag.kind === ts.SyntaxKind.ThisKeyword) return;
          if (ts.isIdentifier(tag) && !/^[A-Z_$]/.test(tag.text)) return;
          recordCallee(tag as ts.Expression);
        }
      };
      visit(x.body);
      targets.forEach((to, i) => add("calls", s.id, to, i + 1));
    }

    // uses-type: type references in parameters, return types, fields, members
    const typeTargets = new Set<string>();
    const visitType = (n: ts.Node) => {
      if (ts.isTypeReferenceNode(n)) {
        const name = ts.isQualifiedName(n.typeName) ? n.typeName.right : n.typeName;
        const r = resolveToId(ctx, name);
        if (r.id && r.id !== s.id) typeTargets.add(r.id);
      } else if (ts.isExpressionWithTypeArguments(n) && !ts.isHeritageClause(n.parent)) {
        const r = resolveToId(ctx, n.expression);
        if (r.id && r.id !== s.id) typeTargets.add(r.id);
      }
      // function bodies inside type nodes (e.g. default values) are not types
      if (ts.isBlock(n)) return;
      ts.forEachChild(n, visitType);
    };
    for (const t of x.typeNodes) {
      if (ts.isParameter(t)) {
        if (t.type) visitType(t.type);
      } else if (ts.isPropertySignature(t) || ts.isMethodSignature(t)) {
        ts.forEachChild(t, visitType);
      } else visitType(t);
    }
    for (const to of typeTargets) {
      // a method's own class is not a "used type"
      if (to === s.parentId) continue;
      add("uses-type", s.id, to);
    }

    // extends / implements
    for (const h of x.heritage ?? []) {
      const kind = h.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends";
      for (const t of h.types) {
        const r = resolveToId(ctx, t.expression);
        if (r.id && r.id !== s.id) add(kind, s.id, r.id);
      }
    }
  }

  return { edges: [...edges.values()], externals };
}
