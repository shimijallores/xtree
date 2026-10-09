import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./analyzer/symbols";

/** Bump when prompt wording changes so old summaries are regenerated. */
export const PROMPT_VERSION = 1;

interface CacheFile {
  version: 1;
  entries: Record<string, { summary: string; model: string; at: number }>;
}

/** Content-hash keyed summary cache stored at <target>/.xtree/cache.json (spec F4). */
export class SummaryCache {
  private data: CacheFile = { version: 1, entries: {} };
  private dir: string;
  private file: string;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: string) {
    this.dir = join(root, ".xtree");
    this.file = join(this.dir, "cache.json");
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8"));
        if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object") this.data = parsed;
      }
    } catch {
      // corrupt cache: start fresh, it is only an optimisation
    }
  }

  static key(source: string, model: string) {
    return sha256(`${source}\u0000${model}\u0000${PROMPT_VERSION}`);
  }

  get(source: string, model: string): string | undefined {
    return this.data.entries[SummaryCache.key(source, model)]?.summary;
  }

  set(source: string, model: string, summary: string) {
    this.data.entries[SummaryCache.key(source, model)] = { summary, model, at: Date.now() };
    this.scheduleSave();
  }

  get size() {
    return Object.keys(this.data.entries).length;
  }

  private scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 500);
  }

  save() {
    try {
      if (!existsSync(this.dir)) {
        mkdirSync(this.dir, { recursive: true });
        // keep the cache out of the user's commits
        writeFileSync(join(this.dir, ".gitignore"), "*\n");
      }
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`xtree: could not write summary cache: ${(err as Error).message}`);
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.save();
    }
  }
}
