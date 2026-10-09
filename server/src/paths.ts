import { realpathSync } from "node:fs";
import { isAbsolute, posix, resolve } from "node:path";

/** Forward-slash form of a path (TypeScript and our symbol ids use forward slashes). */
export const toPosix = (p: string) => p.replace(/\\/g, "/");

/** Real, absolute, forward-slash path. Resolves 8.3 short names and symlinks on Windows. */
export function canonicalRoot(p: string): string {
  const abs = resolve(p);
  try {
    return toPosix(realpathSync.native(abs));
  } catch {
    return toPosix(abs);
  }
}

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

/** Path of `absFile` relative to `root` (both forward slash), or null if it is outside the root. */
export function relativeInside(root: string, absFile: string): string | null {
  const a = toPosix(absFile);
  const r = root.endsWith("/") ? root : `${root}/`;
  const inside = caseInsensitive ? a.toLowerCase().startsWith(r.toLowerCase()) : a.startsWith(r);
  if (!inside) return null;
  const rel = a.slice(r.length);
  if (!rel || rel.split("/").some((seg) => seg === ".." || seg === "")) return null;
  return rel;
}

/**
 * Validates a client-supplied relative path. Rejects absolute paths, drive letters,
 * traversal, NUL bytes and backslash tricks. Returns the normalized relative path.
 */
export function safeRelative(input: unknown): string | null {
  if (typeof input !== "string" || !input || input.length > 1024) return null;
  if (input.includes("\0")) return null;
  const p = toPosix(input);
  if (isAbsolute(p) || /^[a-zA-Z]:/.test(p) || p.startsWith("/")) return null;
  const norm = posix.normalize(p);
  if (norm === "." || norm.startsWith("../") || norm === ".." || norm.split("/").includes("..")) return null;
  return norm.replace(/^\.\//, "");
}
