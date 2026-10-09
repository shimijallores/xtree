import chokidar, { type FSWatcher } from "chokidar";
import { relativeInside, toPosix } from "./paths";
import { isIgnoredPath, isSupportedFile, loadGitignore } from "./scanner";
import type { ChangeBatch } from "./session";

const CONFIG_FILES = new Set(["tsconfig.json", "jsconfig.json", ".gitignore"]);

/**
 * Watches the target project with chokidar and delivers debounced change batches
 * (~150ms quiet period) so a save that touches several files is analysed once.
 */
export function watchProject(root: string, onBatch: (b: ChangeBatch) => void, debounceMs = 150): FSWatcher {
  let pending: ChangeBatch = { changed: new Set(), structural: false, configChanged: false };
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const batch = pending;
    pending = { changed: new Set(), structural: false, configChanged: false };
    try {
      onBatch(batch);
    } catch (err) {
      console.error("xtree: failed to apply file changes:", err);
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  const relOf = (p: string) => relativeInside(root, toPosix(p));
  // Same rules as the scanner, so gitignored folders (out/, .venv, storybook-static…)
  // are never watched. Reloaded when .gitignore itself changes.
  let gitignore = loadGitignore(root);

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: true,
    ignored: (p, stats) => {
      const rel = relOf(p);
      if (rel === null) return false; // the root itself
      if (CONFIG_FILES.has(rel)) return false;
      const isDir = stats ? stats.isDirectory() : undefined;
      if (isIgnoredPath(rel, gitignore, isDir)) return true;
      if (stats?.isFile()) return !isSupportedFile(rel);
      return false;
    },
  });

  watcher.on("all", (event, p) => {
    const rel = relOf(p);
    if (!rel) return;
    if (CONFIG_FILES.has(rel)) {
      if (rel === ".gitignore") gitignore = loadGitignore(root);
      pending.configChanged = true;
    } else if (event === "addDir" || event === "unlinkDir") {
      pending.structural = true;
    } else if (isSupportedFile(rel)) {
      if (event === "add" || event === "unlink") pending.structural = true;
      pending.changed.add(rel);
    } else return;
    schedule();
  });
  watcher.on("error", (err) => console.warn("xtree: watcher error:", (err as Error).message));
  return watcher;
}
