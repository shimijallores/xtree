import { existsSync, realpathSync, statSync } from "node:fs";
import ts from "typescript";
import { relativeInside, toPosix } from "../paths";
import { isIgnoredPath, isSupportedFile, loadGitignore } from "../scanner";
import type { CodeEdge, CodeSymbol, Graph } from "../types";
import { buildEdges } from "./callGraph";
import { CachingHost, createProgram, importClosure, loadCompilerOptions } from "./program";
import { type ExtractedSymbol, extractSymbols } from "./symbols";

export interface AnalysisResult {
  graph: Graph;
  /** Relative paths of every file in the analysed import closure. */
  files: string[];
}

const CACHE_LIMIT = 1500;

/** Files above this size (bundles, generated code) are skipped: they would stall the server. */
export const MAX_FILE_BYTES = 1_000_000;

export class AnalyzeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface FileResult {
  symbols: CodeSymbol[];
  edges: CodeEdge[];
  externals: CodeSymbol[];
}

/**
 * Static analyzer built on the TypeScript Compiler API. The parser is the source of
 * truth for structure: every node and edge here comes from the AST and the checker.
 */
export class Analyzer {
  private options: ts.CompilerOptions;
  private host: CachingHost;
  private program?: ts.Program;
  private gitignore;
  /** Last successfully parsed result per file, kept when a file has syntax errors. */
  private lastGood = new Map<string, FileResult>();

  constructor(readonly root: string) {
    this.options = loadCompilerOptions(root);
    this.host = new CachingHost(root, this.options);
    this.gitignore = loadGitignore(root);
  }

  /** Call after tsconfig / .gitignore changes. */
  reload() {
    this.options = loadCompilerOptions(this.root);
    this.host = new CachingHost(this.root, this.options);
    this.gitignore = loadGitignore(this.root);
    this.program = undefined;
  }

  /** True if the relative path is a supported, non-ignored project file. */
  accepts(rel: string): boolean {
    return isSupportedFile(rel) && !isIgnoredPath(rel, this.gitignore);
  }

  analyze(entryRel: string, depth: number): AnalysisResult {
    if (!this.accepts(entryRel)) throw new AnalyzeError(`Unsupported or ignored file: ${entryRel}`, 400);
    const entryAbs = `${this.root}/${entryRel}`;
    if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
      throw new AnalyzeError(`File not found: ${entryRel}`, 404);
    }
    // A symlink inside the project could point at a file elsewhere on disk; never read through it.
    const real = (() => {
      try {
        return toPosix(realpathSync.native(entryAbs));
      } catch {
        return null;
      }
    })();
    if (real === null || relativeInside(this.root, real) === null) {
      throw new AnalyzeError(`File is outside the project: ${entryRel}`, 403);
    }

    const entrySize = statSync(entryAbs).size;
    if (entrySize > MAX_FILE_BYTES) {
      throw new AnalyzeError(
        `${entryRel} is ${(entrySize / 1e6).toFixed(1)} MB, over the ${MAX_FILE_BYTES / 1e6} MB analysis limit (generated or bundled file?)`,
        413,
      );
    }
    const skipped: string[] = [];
    const accept = (abs: string) => {
      const rel = relativeInside(this.root, abs);
      if (rel === null || !this.accepts(rel)) return false;
      try {
        if (statSync(abs).size > MAX_FILE_BYTES) {
          skipped.push(rel);
          return false;
        }
      } catch {
        return false;
      }
      return true;
    };
    const closure = importClosure(entryAbs, depth, this.options, this.host, this.root, accept);
    const program = createProgram(closure.files, this.options, this.host, this.program);
    this.program = program;
    // Bound memory: after many different entries, keep only what the current program uses.
    if (this.host.size > CACHE_LIMIT) {
      this.host.prune(new Set(closure.files));
      const keep = new Set(closure.files.map((f) => relativeInside(this.root, f)));
      for (const rel of this.lastGood.keys()) if (!keep.has(rel)) this.lastGood.delete(rel);
    }
    const checker = program.getTypeChecker();

    const relOf = (abs: string) => relativeInside(this.root, abs) ?? abs;
    const errors: { file: string; message: string }[] = [];
    const extracted: ExtractedSymbol[] = [];
    const perFile = new Map<string, ExtractedSymbol[]>();
    const reused = new Map<string, FileResult>();

    for (const abs of closure.files) {
      const rel = relOf(abs);
      const sf = program.getSourceFile(abs);
      if (!sf) continue;
      const diags = program.getSyntacticDiagnostics(sf);
      if (diags.length) {
        const d = diags[0];
        const line = d.start !== undefined ? sf.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
        errors.push({ file: rel, message: `${ts.flattenDiagnosticMessageText(d.messageText, " ")} (line ${line})` });
        const prev = this.lastGood.get(rel);
        if (prev) {
          reused.set(rel, prev);
          continue;
        }
      }
      const fileSymbols = extractSymbols(sf, rel, checker).symbols;
      perFile.set(rel, fileSymbols);
      extracted.push(...fileSymbols);
    }

    const declToId = new Map<ts.Node, string>();
    for (const x of extracted) for (const d of x.decls) declToId.set(d, x.symbol.id);

    const isProjectFile = (fileName: string) =>
      relativeInside(this.root, fileName) !== null && !fileName.includes("/node_modules/");
    const { edges, externals } = buildEdges(extracted, { checker, declToId, isProjectFile });

    // Remember per-file results (symbols + edges that start in the file) for error recovery.
    const fileOfSymbol = new Map<string, string>();
    for (const x of extracted) fileOfSymbol.set(x.symbol.id, x.symbol.file);
    for (const [rel, xs] of perFile) {
      const ids = new Set(xs.map((x) => x.symbol.id));
      const fileEdges = edges.filter((e) => ids.has(e.from));
      const extIds = new Set(fileEdges.map((e) => e.to).filter((t) => externals.has(t)));
      if (!errors.some((e) => e.file === rel)) {
        this.lastGood.set(rel, {
          symbols: xs.map((x) => x.symbol),
          edges: fileEdges,
          externals: [...extIds].map((id) => externals.get(id)!),
        });
      }
    }

    const symbols: CodeSymbol[] = extracted.map((x) => x.symbol);
    const allEdges = [...edges];
    for (const r of reused.values()) {
      symbols.push(...r.symbols);
      allEdges.push(...r.edges);
      for (const ext of r.externals) if (!externals.has(ext.id)) externals.set(ext.id, ext);
    }
    symbols.push(...externals.values());

    // Drop edges whose endpoints are gone (e.g. after recovering a broken file).
    const ids = new Set(symbols.map((s) => s.id));
    const seenEdge = new Set<string>();
    const finalEdges = allEdges.filter((e) => {
      if (seenEdge.has(e.id) || !ids.has(e.from) || !ids.has(e.to)) return false;
      seenEdge.add(e.id);
      return true;
    });

    // File-level import edges (endpoints are file paths, not symbols).
    for (const [a, b] of closure.imports) {
      const from = relOf(a);
      const to = relOf(b);
      finalEdges.push({ id: `imports:${from}->${to}`, kind: "imports", from, to });
    }

    for (const rel of new Set(skipped)) {
      errors.push({ file: rel, message: `skipped: larger than ${MAX_FILE_BYTES / 1e6} MB (generated or bundled file?)` });
    }

    return {
      graph: { entry: entryRel, symbols, edges: finalEdges, ...(errors.length ? { errors } : {}) },
      files: closure.files.map(relOf),
    };
  }
}
