import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalRoot, safeRelative } from "../src/paths";
import { scan } from "../src/scanner";

const dir = mkdtempSync(join(tmpdir(), "xtree-scan-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const touch = (rel: string, text = "export const x = 1;\n") => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

touch("src/a.ts");
touch("src/b.tsx");
touch("src/c.js");
touch("src/types.d.ts");
touch("src/readme.md");
touch("src/nested/deep.jsx");
touch("node_modules/lib/index.js");
touch("dist/out.js");
touch(".next/x.js");
touch("generated/gen.ts");
touch(".xtree/cache.ts");
writeFileSync(join(dir, ".gitignore"), "generated/\n*.secret.ts\n");
touch("src/key.secret.ts");

describe("scanner", () => {
  const root = canonicalRoot(dir);

  test("lists supported files only, respecting ignore rules and .gitignore", () => {
    const r = scan(root, 5000);
    expect(r.files.sort()).toEqual(["src/a.ts", "src/b.tsx", "src/c.js", "src/nested/deep.jsx"]);
    expect(r.truncated).toBe(false);
  });

  test("builds a nested tree with directories first", () => {
    const r = scan(root, 5000);
    expect(r.tree.map((n) => n.name)).toEqual(["src"]);
    expect(r.tree[0].children!.map((n) => n.name)).toEqual(["nested", "a.ts", "b.tsx", "c.js"]);
    expect(r.tree[0].children![0].children![0].path).toBe("src/nested/deep.jsx");
  });

  test("stops at the file cap", () => {
    const r = scan(root, 2);
    expect(r.files.length).toBe(2);
    expect(r.truncated).toBe(true);
  });
});

describe("safeRelative", () => {
  test("accepts normal relative paths", () => {
    expect(safeRelative("src/a.ts")).toBe("src/a.ts");
    expect(safeRelative("./src/a.ts")).toBe("src/a.ts");
    expect(safeRelative("src\\a.ts")).toBe("src/a.ts");
  });
  test("rejects traversal and absolute paths", () => {
    for (const bad of ["../x.ts", "src/../../x.ts", "/etc/passwd", "C:/Windows/win.ini", "C:\\x.ts", "a\0b", "", 5, null]) {
      expect(safeRelative(bad)).toBeNull();
    }
  });
});
