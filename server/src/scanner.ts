import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { FileNode } from "./types";

export const SUPPORTED_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i;
const DECLARATION = /\.d\.[mc]?ts$/i;

/** Directories that are never scanned or watched. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".xtree",
  ".svelte-kit",
  ".nuxt",
  ".output",
  ".cache",
  ".vercel",
]);

export const isSupportedFile = (name: string) => SUPPORTED_EXT.test(name) && !DECLARATION.test(name);

export interface ScanResult {
  tree: FileNode[];
  files: string[]; // relative, forward-slash paths
  truncated: boolean;
}

export function loadGitignore(root: string): Ignore {
  const ig = ignore();
  const file = join(root, ".gitignore");
  if (existsSync(file)) {
    try {
      ig.add(readFileSync(file, "utf8"));
    } catch {
      // unreadable .gitignore: fall back to the built-in ignore list only
    }
  }
  return ig;
}

/** True if a relative path (forward slashes) should be skipped. */
export function isIgnoredPath(rel: string, ig: Ignore, isDir?: boolean): boolean {
  if (!rel) return false;
  const parts = rel.split("/");
  if (parts.some((p) => IGNORED_DIRS.has(p))) return true;
  try {
    // Unknown kind (the watcher is asked before stat): treat "out/" patterns as matching "out".
    if (isDir === undefined) return ig.ignores(rel) || ig.ignores(`${rel}/`);
    return ig.ignores(isDir ? `${rel}/` : rel);
  } catch {
    return false;
  }
}

const byName = (a: FileNode, b: FileNode) =>
  a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name);

/**
 * Walks the target directory and returns a tree of supported source files.
 * Stops after `maxFiles` files. Symlinks are skipped to avoid cycles and escapes.
 */
export function scan(root: string, maxFiles: number): ScanResult {
  const ig = loadGitignore(root);
  const files: string[] = [];
  let truncated = false;

  const walk = (abs: string, rel: string): FileNode[] => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const out: FileNode[] = [];
    for (const d of entries) {
      if (truncated) break;
      if (d.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (isIgnoredPath(childRel, ig, true)) continue;
        const children = walk(join(abs, d.name), childRel);
        if (children.length) out.push({ name: d.name, path: childRel, type: "dir", children });
      } else if (d.isFile() && isSupportedFile(d.name)) {
        if (isIgnoredPath(childRel, ig)) continue;
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        files.push(childRel);
        out.push({ name: d.name, path: childRel, type: "file" });
      }
    }
    return out.sort(byName);
  };

  const tree = walk(root, "");
  return { tree, files, truncated };
}

/**
 * A directory "looks like a project" if it has a package.json / tsconfig.json /
 * jsconfig.json, or supported source files within the top two directory levels.
 */
export function looksLikeProject(root: string): boolean {
  for (const f of ["package.json", "tsconfig.json", "jsconfig.json"]) {
    if (existsSync(join(root, f))) return true;
  }
  const ig = loadGitignore(root);
  const hasSource = (abs: string, rel: string, level: number): boolean => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const d of entries) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isFile() && isSupportedFile(d.name) && !isIgnoredPath(childRel, ig)) return true;
    }
    // root + two directory levels below it (e.g. src/components/App.tsx)
    if (level >= 3) return false;
    for (const d of entries) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (isIgnoredPath(childRel, ig, true)) continue;
      if (hasSource(join(abs, d.name), childRel, level + 1)) return true;
    }
    return false;
  };
  return hasSource(root, "", 1);
}
