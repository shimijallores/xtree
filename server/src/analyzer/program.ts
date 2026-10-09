import { existsSync } from "node:fs";
import ts from "typescript";
import { relativeInside, toPosix } from "../paths";

/** Options XTree always forces, whatever the project's tsconfig says. */
const FORCED: ts.CompilerOptions = {
  noEmit: true,
  allowJs: true,
  checkJs: false,
  // Only the import closure is loaded; imports outside it (node_modules) stay unresolved
  // and become external stubs instead of pulling in whole dependency trees.
  noResolve: true,
  skipLibCheck: true,
  types: [],
  composite: false,
  incremental: false,
  declaration: false,
  declarationMap: false,
  sourceMap: false,
  tsBuildInfoFile: undefined,
  plugins: [],
};

const FALLBACK: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  esModuleInterop: true,
  allowImportingTsExtensions: true,
  resolveJsonModule: false,
};

/** Reads tsconfig.json / jsconfig.json at the root for module resolution (paths, baseUrl, jsx). */
export function loadCompilerOptions(root: string): ts.CompilerOptions {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = `${root}/${name}`;
    if (!existsSync(file)) continue;
    const read = ts.readConfigFile(file, ts.sys.readFile);
    if (read.error) break;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, file);
    const opts = { ...FALLBACK, ...parsed.options };
    // Classic resolution can't follow most modern imports; upgrade it.
    if (
      opts.moduleResolution === undefined ||
      opts.moduleResolution === ts.ModuleResolutionKind.Classic
    ) {
      opts.moduleResolution = ts.ModuleResolutionKind.Bundler;
      opts.module = ts.ModuleKind.ESNext;
    }
    return { ...opts, ...FORCED };
  }
  return { ...FALLBACK, ...FORCED };
}

interface CachedFile {
  text: string;
  sf: ts.SourceFile;
}

/**
 * Compiler host with a SourceFile cache. Lib files are parsed once per process; project
 * files are re-parsed only when their text changes, so re-analysis after a save is fast.
 */
export class CachingHost {
  readonly host: ts.CompilerHost;
  private cache = new Map<string, CachedFile>();
  private libCache = new Map<string, ts.SourceFile>();

  constructor(
    private root: string,
    options: ts.CompilerOptions,
  ) {
    const base = ts.createCompilerHost(options, true);
    this.host = {
      ...base,
      getSourceFile: (fileName, languageVersion, onError) => {
        const inProject = relativeInside(this.root, fileName) !== null && !fileName.includes("/node_modules/");
        if (!inProject) {
          const hit = this.libCache.get(fileName);
          if (hit) return hit;
          const sf = base.getSourceFile(fileName, languageVersion, onError);
          if (sf) this.libCache.set(fileName, sf);
          return sf;
        }
        const text = base.readFile(fileName);
        if (text === undefined) return undefined;
        const hit = this.cache.get(fileName);
        if (hit && hit.text === text) return hit.sf;
        const sf = ts.createSourceFile(fileName, text, languageVersion, true, scriptKindOf(fileName));
        this.cache.set(fileName, { text, sf });
        return sf;
      },
    };
  }

  readFile(fileName: string): string | undefined {
    return this.host.readFile(fileName);
  }

  forget(fileName: string) {
    this.cache.delete(fileName);
  }

  get size() {
    return this.cache.size;
  }

  /** Drops cached parses for files outside `keep` (long sessions across many entry files). */
  prune(keep: Set<string>) {
    for (const f of this.cache.keys()) if (!keep.has(f)) this.cache.delete(f);
  }
}

function scriptKindOf(fileName: string): ts.ScriptKind {
  const f = fileName.toLowerCase();
  if (f.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (f.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(f)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export interface Closure {
  /** Absolute forward-slash paths, entry first, breadth-first. */
  files: string[];
  /** File-level import edges between closure files (absolute paths). */
  imports: [string, string][];
}

/**
 * Follows imports from `entry` breadth-first up to `depth` levels, keeping only files
 * inside the project root that pass `accept`.
 */
export function importClosure(
  entry: string,
  depth: number,
  options: ts.CompilerOptions,
  host: CachingHost,
  root: string,
  accept: (abs: string) => boolean,
): Closure {
  const seen = new Set<string>([entry]);
  const files = [entry];
  const imports: [string, string][] = [];
  const resolutionCache = ts.createModuleResolutionCache(root, (f) => f.toLowerCase(), options);
  let frontier = [entry];
  for (let level = 0; level < depth && frontier.length; level++) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const target of resolveImports(file, options, host, resolutionCache, root, accept)) {
        imports.push([file, target]);
        if (seen.has(target)) continue;
        seen.add(target);
        files.push(target);
        next.push(target);
      }
    }
    frontier = next;
  }
  // Imports between files already in the closure (including the last level).
  for (const file of frontier) {
    for (const target of resolveImports(file, options, host, resolutionCache, root, accept)) {
      if (seen.has(target)) imports.push([file, target]);
    }
  }
  return { files, imports: dedupePairs(imports) };
}

function dedupePairs(pairs: [string, string][]): [string, string][] {
  const keys = new Set<string>();
  return pairs.filter(([a, b]) => {
    const k = `${a}\n${b}`;
    if (keys.has(k) || a === b) return false;
    keys.add(k);
    return true;
  });
}

function resolveImports(
  file: string,
  options: ts.CompilerOptions,
  host: CachingHost,
  cache: ts.ModuleResolutionCache,
  root: string,
  accept: (abs: string) => boolean,
): string[] {
  const text = host.readFile(file);
  if (text === undefined) return [];
  const info = ts.preProcessFile(text, true, true);
  const out: string[] = [];
  for (const imp of info.importedFiles) {
    const res = ts.resolveModuleName(imp.fileName, file, options, host.host, cache);
    const resolved = res.resolvedModule;
    if (!resolved || resolved.isExternalLibraryImport) continue;
    const abs = toPosix(resolved.resolvedFileName);
    if (abs.includes("/node_modules/") || /\.d\.[mc]?ts$/i.test(abs)) continue;
    if (relativeInside(root, abs) === null || !accept(abs)) continue;
    out.push(abs);
  }
  return out;
}

export function createProgram(
  files: string[],
  options: ts.CompilerOptions,
  host: CachingHost,
  oldProgram?: ts.Program,
): ts.Program {
  return ts.createProgram({ rootNames: files, options, host: host.host, oldProgram });
}
