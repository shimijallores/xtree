import { createHash } from "node:crypto";
import ts from "typescript";
import type { CodeSymbol, SymbolField, SymbolKind, Visibility } from "../types";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const MAX_TYPE = 60;
const MAX_SIG = 160;

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** A symbol plus the AST nodes needed to compute its edges. */
export interface ExtractedSymbol {
  symbol: CodeSymbol;
  /** Declaration nodes that resolve to this symbol (overloads, variable decls). */
  decls: ts.Node[];
  /** Node whose subtree is scanned for calls (function/method body), if any. */
  body?: ts.Node;
  /** Nodes whose type references produce `uses-type` edges. */
  typeNodes: ts.Node[];
  /** Heritage clauses for extends/implements. */
  heritage?: ts.NodeArray<ts.HeritageClause>;
}

export interface FileSymbols {
  symbols: ExtractedSymbol[];
}

function lineOf(sf: ts.SourceFile, pos: number) {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function visibilityOf(member: ts.ClassElement | ts.ParameterDeclaration): Visibility {
  if (member.name && ts.isPrivateIdentifier(member.name)) return "private";
  const flags = ts.getCombinedModifierFlags(member as ts.Declaration);
  if (flags & ts.ModifierFlags.Private) return "private";
  if (flags & ts.ModifierFlags.Protected) return "protected";
  return "public";
}

function nameText(name: ts.PropertyName | ts.BindingName | undefined, sf: ts.SourceFile): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return `[${clip(name.expression.getText(sf), 30)}]`;
  return null;
}

type FnLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function paramText(p: ts.ParameterDeclaration, sf: ts.SourceFile, checker: ts.TypeChecker): string {
  const rest = p.dotDotDotToken ? "..." : "";
  let name = ts.isIdentifier(p.name) ? p.name.text : ts.isObjectBindingPattern(p.name) ? "{…}" : "[…]";
  if (p.questionToken || p.initializer) name += "?";
  let type = "";
  if (p.type) type = p.type.getText(sf);
  else {
    try {
      const t = checker.typeToString(checker.getTypeAtLocation(p));
      if (t && t !== "any") type = t;
    } catch {
      // type inference is best-effort
    }
  }
  return `${rest}${name}${type ? `: ${clip(type, MAX_TYPE)}` : ""}`;
}

function returnText(fn: FnLike, sf: ts.SourceFile, checker: ts.TypeChecker): string {
  if (fn.type) return clip(fn.type.getText(sf), MAX_TYPE);
  try {
    const sig = checker.getSignatureFromDeclaration(fn);
    if (sig) return clip(checker.typeToString(checker.getReturnTypeOfSignature(sig)), MAX_TYPE);
  } catch {
    // best-effort
  }
  return "";
}

function fnSignature(name: string, fn: FnLike, sf: ts.SourceFile, checker: ts.TypeChecker, prefix = "") {
  const params = fn.parameters.map((p) => paramText(p, sf, checker)).join(", ");
  const ret = ts.isConstructorDeclaration(fn) || ts.isSetAccessorDeclaration(fn) ? "" : returnText(fn, sf, checker);
  const asyncMark = fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ? "async " : "";
  return clip(`${prefix}${asyncMark}${name}(${params})${ret ? `: ${ret}` : ""}`, MAX_SIG);
}

function typeOfMember(
  node: ts.PropertyDeclaration | ts.PropertySignature | ts.ParameterDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
): string {
  if (node.type) return clip(node.type.getText(sf), MAX_TYPE);
  try {
    return clip(checker.typeToString(checker.getTypeAtLocation(node)), MAX_TYPE);
  } catch {
    return "";
  }
}

const isFunctionInit = (e: ts.Expression | undefined): e is ts.ArrowFunction | ts.FunctionExpression => {
  if (!e) return false;
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
  return ts.isArrowFunction(x) || ts.isFunctionExpression(x);
};

/** `const Card = memo(function Card() {...})`, `forwardRef((p, ref) => ...)`: a component wrapped by a HOC. */
const wrappedFn = (name: string, e: ts.Expression | undefined): ts.ArrowFunction | ts.FunctionExpression | null => {
  if (!e || !/^[A-Z]/.test(name)) return null;
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
  if (!ts.isCallExpression(x)) return null;
  const first = x.arguments[0];
  return first && isFunctionInit(first) ? unwrapFn(first) : null;
};

/** `exports.name` / `module.exports.name` -> "name"; anything else -> null. */
const cjsExportName = (left: ts.Expression): string | null => {
  if (!ts.isPropertyAccessExpression(left)) return null;
  const obj = left.expression;
  const isExports = ts.isIdentifier(obj) && obj.text === "exports";
  const isModuleExports =
    ts.isPropertyAccessExpression(obj) &&
    ts.isIdentifier(obj.expression) &&
    obj.expression.text === "module" &&
    obj.name.text === "exports";
  return isExports || isModuleExports ? left.name.text : null;
};

const isModuleExportsRoot = (e: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(e) &&
  ts.isIdentifier(e.expression) &&
  e.expression.text === "module" &&
  e.name.text === "exports";

const unwrapFn = (e: ts.Expression): ts.ArrowFunction | ts.FunctionExpression => {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
  return x as ts.ArrowFunction | ts.FunctionExpression;
};

function isDefaultExport(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

/** Extracts functions, classes (+ members), interfaces, type aliases and enums from one file. */
export function extractSymbols(sf: ts.SourceFile, rel: string, checker: ts.TypeChecker): FileSymbols {
  const out: ExtractedSymbol[] = [];
  const used = new Set<string>();

  const make = (
    qname: string,
    kind: SymbolKind,
    node: ts.Node,
    signature: string,
    extra: Partial<CodeSymbol> = {},
  ): CodeSymbol | null => {
    const id = `${rel}#${qname}`;
    if (used.has(id)) return null;
    used.add(id);
    const start = node.getStart(sf);
    const source = sf.text.slice(start, node.getEnd());
    return {
      id,
      kind,
      name: qname.includes(".") ? qname.slice(qname.indexOf(".") + 1) : qname,
      file: rel,
      range: { start: lineOf(sf, start), end: lineOf(sf, node.getEnd()) },
      signature,
      source,
      hash: sha256(source),
      ...extra,
    };
  };

  const addFunction = (name: string, node: ts.Node, fn: FnLike, decls: ts.Node[]) => {
    const sym = make(name, "function", node, fnSignature(name, fn, sf, checker));
    if (!sym) {
      // overload or duplicate: still map this declaration to the existing symbol
      const existing = out.find((x) => x.symbol.id === `${rel}#${name}`);
      if (!existing) return;
      existing.decls.push(...decls);
      if (!existing.body && fn.body) {
        // implementation after overload signatures: its source is the interesting part
        const start = node.getStart(sf);
        existing.body = fn.body;
        existing.symbol.source = sf.text.slice(start, node.getEnd());
        existing.symbol.hash = sha256(existing.symbol.source);
        existing.symbol.range = { start: existing.symbol.range.start, end: lineOf(sf, node.getEnd()) };
        existing.typeNodes.push(...fn.parameters, ...(fn.type ? [fn.type] : []));
      }
      return;
    }
    out.push({ symbol: sym, decls, body: fn.body, typeNodes: [...fn.parameters, ...(fn.type ? [fn.type] : [])] });
  };

  const addClass = (cls: ts.ClassDeclaration | ts.ClassExpression, name: string, node: ts.Node, decls: ts.Node[]) => {
    const fields: SymbolField[] = [];
    const typeNodes: ts.Node[] = [];
    const heritageText = (cls.heritageClauses ?? []).map((h) => clip(h.getText(sf), 80)).join(" ");
    const cSym = make(name, "class", node, clip(`class ${name}${heritageText ? ` ${heritageText}` : ""}`, MAX_SIG));
    if (!cSym) return;
    const members: ExtractedSymbol[] = [];

    for (const m of cls.members) {
      if (ts.isPropertyDeclaration(m)) {
        const mName = nameText(m.name, sf);
        if (!mName) continue;
        if (isFunctionInit(m.initializer)) {
          const fn = unwrapFn(m.initializer!);
          const q = `${name}.${mName}`;
          const s = make(q, "method", m, fnSignature(mName, fn, sf, checker), {
            parentId: cSym.id,
            visibility: visibilityOf(m),
          });
          if (s) members.push({ symbol: s, decls: [m], body: fn.body, typeNodes: [...fn.parameters, ...(fn.type ? [fn.type] : [])] });
          continue;
        }
        const isStatic = ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static;
        fields.push({
          name: `${isStatic ? "static " : ""}${mName}`,
          type: typeOfMember(m, sf, checker),
          visibility: visibilityOf(m),
        });
        if (m.type) typeNodes.push(m.type);
      } else if (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
        const mName = nameText(m.name, sf);
        if (!mName) continue;
        const q = `${name}.${mName}`;
        const prefix = ts.isGetAccessorDeclaration(m) ? "get " : ts.isSetAccessorDeclaration(m) ? "set " : "";
        const existing = members.find((x) => x.symbol.id === `${rel}#${q}`);
        if (existing) {
          existing.decls.push(m); // overload / accessor pair
          if (!existing.body && m.body) existing.body = m.body;
          continue;
        }
        const s = make(q, "method", m, fnSignature(mName, m, sf, checker, prefix), {
          parentId: cSym.id,
          visibility: visibilityOf(m),
        });
        if (s) members.push({ symbol: s, decls: [m], body: m.body, typeNodes: [...m.parameters, ...(m.type ? [m.type] : [])] });
      } else if (ts.isConstructorDeclaration(m)) {
        // parameter properties (constructor(private repo: Repo)) are fields too
        for (const p of m.parameters) {
          if (ts.isParameterPropertyDeclaration(p, m)) {
            const pName = nameText(p.name, sf);
            if (pName) fields.push({ name: pName, type: typeOfMember(p, sf, checker), visibility: visibilityOf(p) });
          }
        }
        const q = `${name}.constructor`;
        const existing = members.find((x) => x.symbol.id === `${rel}#${q}`);
        if (existing) {
          existing.decls.push(m);
          if (!existing.body && m.body) existing.body = m.body;
          continue;
        }
        const s = make(q, "method", m, fnSignature("constructor", m, sf, checker), {
          parentId: cSym.id,
          visibility: visibilityOf(m),
        });
        if (s) members.push({ symbol: s, decls: [m], body: m.body, typeNodes: [...m.parameters] });
      }
    }
    cSym.fields = fields;
    out.push({ symbol: cSym, decls, typeNodes, heritage: cls.heritageClauses });
    out.push(...members);
  };

  const addInterface = (node: ts.InterfaceDeclaration) => {
    const name = node.name.text;
    const heritageText = (node.heritageClauses ?? []).map((h) => clip(h.getText(sf), 80)).join(" ");
    const fields: SymbolField[] = [];
    for (const m of node.members) {
      const mName = nameText((m as ts.TypeElement).name, sf);
      if (ts.isPropertySignature(m) && mName) {
        fields.push({ name: `${mName}${m.questionToken ? "?" : ""}`, type: typeOfMember(m, sf, checker), visibility: "public" });
      } else if (ts.isMethodSignature(m) && mName) {
        const params = m.parameters.map((p) => paramText(p, sf, checker)).join(", ");
        const ret = m.type ? clip(m.type.getText(sf), MAX_TYPE) : "void";
        fields.push({ name: mName, type: clip(`(${params}) => ${ret}`, MAX_TYPE), visibility: "public" });
      } else if (ts.isIndexSignatureDeclaration(m)) {
        fields.push({ name: clip(m.getText(sf).replace(/;$/, ""), MAX_TYPE), type: "", visibility: "public" });
      }
    }
    const sym = make(name, "interface", node, clip(`interface ${name}${heritageText ? ` ${heritageText}` : ""}`, MAX_SIG), { fields });
    if (sym) out.push({ symbol: sym, decls: [node], typeNodes: [...node.members], heritage: node.heritageClauses });
  };

  const addTypeAlias = (node: ts.TypeAliasDeclaration) => {
    const name = node.name.text;
    const fields: SymbolField[] = [];
    const t = node.type;
    if (ts.isTypeLiteralNode(t)) {
      for (const m of t.members) {
        const mName = nameText((m as ts.TypeElement).name, sf);
        if (ts.isPropertySignature(m) && mName) {
          fields.push({ name: `${mName}${m.questionToken ? "?" : ""}`, type: typeOfMember(m, sf, checker), visibility: "public" });
        } else if (ts.isMethodSignature(m) && mName) {
          fields.push({ name: mName, type: clip(m.getText(sf).replace(/;$/, ""), MAX_TYPE), visibility: "public" });
        }
      }
    } else if (ts.isUnionTypeNode(t)) {
      for (const u of t.types) fields.push({ name: clip(u.getText(sf), MAX_TYPE), type: "", visibility: "public" });
    }
    const sym = make(name, "type", node, clip(`type ${name} = ${t.getText(sf)}`, MAX_SIG), { fields });
    if (sym) out.push({ symbol: sym, decls: [node], typeNodes: [t] });
  };

  const addEnum = (node: ts.EnumDeclaration) => {
    const name = node.name.text;
    const fields: SymbolField[] = node.members.map((m) => ({
      name: nameText(m.name, sf) ?? m.name.getText(sf),
      type: m.initializer ? clip(m.initializer.getText(sf), MAX_TYPE) : "",
      visibility: "public",
    }));
    const sym = make(name, "enum", node, `enum ${name}`, { fields });
    if (sym) out.push({ symbol: sym, decls: [node], typeNodes: [] });
  };

  const visitStatements = (statements: ts.NodeArray<ts.Statement>) => {
    for (const st of statements) {
      if (ts.isFunctionDeclaration(st)) {
        const name = st.name?.text ?? (isDefaultExport(st) ? "default" : null);
        if (!name) continue;
        // overload signatures without a body map to the implementation's symbol
        addFunction(name, st, st, [st]);
      } else if (ts.isClassDeclaration(st)) {
        const name = st.name?.text ?? (isDefaultExport(st) ? "default" : null);
        if (name) addClass(st, name, st, [st]);
      } else if (ts.isInterfaceDeclaration(st)) {
        addInterface(st);
      } else if (ts.isTypeAliasDeclaration(st)) {
        addTypeAlias(st);
      } else if (ts.isEnumDeclaration(st)) {
        addEnum(st);
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          const wrapped = wrappedFn(d.name.text, d.initializer);
          if (isFunctionInit(d.initializer)) {
            addFunction(d.name.text, st.declarationList.declarations.length === 1 ? st : d, unwrapFn(d.initializer), [d]);
          } else if (wrapped) {
            addFunction(d.name.text, st.declarationList.declarations.length === 1 ? st : d, wrapped, [d]);
          } else if (ts.isClassExpression(d.initializer)) {
            addClass(d.initializer, d.name.text, st, [d, d.initializer]);
          }
        }
      } else if (
        ts.isExpressionStatement(st) &&
        ts.isBinaryExpression(st.expression) &&
        st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        // CommonJS: exports.name = function () {}, module.exports.name = () => {}
        const { left, right } = st.expression;
        const name = cjsExportName(left);
        if (name && isFunctionInit(right)) {
          addFunction(name, st, unwrapFn(right), [st.expression, left, right]);
        } else if (isModuleExportsRoot(left)) {
          if (isFunctionInit(right)) {
            addFunction("default", st, unwrapFn(right), [st.expression, left, right]);
          } else if (ts.isObjectLiteralExpression(right)) {
            // module.exports = { a() {}, b: () => {} }
            for (const p of right.properties) {
              if (ts.isMethodDeclaration(p)) {
                const pn = nameText(p.name, sf);
                if (pn) addFunction(pn, p, p, [p]);
              } else if (ts.isPropertyAssignment(p) && isFunctionInit(p.initializer)) {
                const pn = nameText(p.name, sf);
                if (pn) addFunction(pn, p, unwrapFn(p.initializer), [p, p.initializer]);
              }
            }
          }
        }
      } else if (ts.isModuleDeclaration(st) && st.body && ts.isModuleBlock(st.body)) {
        visitStatements(st.body.statements);
      } else if (ts.isExportAssignment(st) && isFunctionInit(st.expression)) {
        addFunction("default", st, unwrapFn(st.expression), [st]);
      }
    }
  };

  visitStatements(sf.statements);
  return { symbols: out };
}
