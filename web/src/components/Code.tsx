import { useEffect, useState } from "react";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Fine-grained shiki setup: only the TypeScript grammar and one theme are bundled.
let highlighter: ReturnType<typeof createHighlighterCore> | null = null;

function getHighlighter() {
  highlighter ??= createHighlighterCore({
    themes: [import("shiki/themes/github-dark.mjs")],
    langs: [import("shiki/langs/typescript.mjs")],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

// Syntax-highlighted source (shiki). Falls back to plain text until loaded.
export function Code({ code }: { code: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getHighlighter()
      .then((h) => {
        if (live)
          setHtml(
            h.codeToHtml(code, {
              lang: "typescript",
              theme: "github-dark",
              // match the card background instead of overriding shiki's inline style
              colorReplacements: { "#24292e": "#1a1a1a" },
            }),
          );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code]);

  if (html) return <div className="code" dangerouslySetInnerHTML={{ __html: html }} />;
  return <pre className="code plain">{code}</pre>;
}
