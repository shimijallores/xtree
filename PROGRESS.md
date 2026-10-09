# XTree Progress

Last updated: October 10, 2026

XTree turns a JS/TS project into live UML-style diagrams and explains each node with a local LLM (`qwen2.5-coder:3b` through Ollama). The parser draws the structure; the model only writes the explanations.

## Status at a glance

| Area | Status |
|---|---|
| CLI (`xtree start [path]` and `xtree [path]`) | Done |
| Server, scanner, security checks | Done |
| TypeScript analyzer (symbols, edges) | Done |
| Live file watching (`graph.diff`) | Done |
| Ollama / Qwen summaries, queue, disk cache | Done, verified with the real model |
| Explain flow and grounded chat | Done, verified with the real model |
| Frontend wired to the live backend | Done |
| Backend audit and fixes | Done |
| README and clean-clone setup | **Not done** |
| Stable layout on live edits | **Not done** |
| Drawing `imports` edges in the UI | **Not done** |

## Environment

| Item | Value |
|---|---|
| Runtime and package manager | Bun 1.4.2 (Bun only, no npm) |
| Server TypeScript | 6.0.3 (TypeScript 7.x has no JS Compiler API) |
| Web TypeScript | 7.0.2 |
| Ollama | 0.40.2, installed with winget |
| Model | `qwen2.5-coder:3b` (1.9 GB, pulled and answering) |
| GPU | RTX 3050 6 GB laptop |

## What has been built

### CLI
- `xtree start [path]` and the shortcut `xtree [path]`; `start` is the default command.
- Flags: `-p/--port`, `-d/--depth`, `-m/--model`, `--ollama`, `--no-open`, `--force`, `--max-files`.
- Config order: flags, then environment variables (`XTREE_MODEL`, `OLLAMA_HOST`), then `xtree.config.json`, then defaults.
- Refuses folders that do not look like a JS/TS project unless `--force` is passed.
- Typo hint: `xtree strat` suggests `xtree start`.

### Server
- One port (default 4317) serving the UI, the REST API and the WebSocket. Moves to the next free port if busy.
- Binds to `127.0.0.1` only. There is no authentication because the service is local-only.
- Rejects foreign `Host` and `Origin` headers, path traversal, non-JSON bodies, oversized bodies and symlinked entry files that point outside the project.

### Scanner
- Supports `.js`, `.jsx`, `.ts`, `.tsx` and related module extensions.
- Skips `node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, `coverage`, `.xtree` and anything in `.gitignore`.
- Stops at 5,000 files (`--max-files` raises it) and tells the UI.

### Analyzer
- Built on the TypeScript Compiler API, following imports to depth 2.
- Symbols: functions, arrow functions, classes (fields, constructor, methods, `public` / `private` / `protected` / `#private`), interfaces, type aliases, enums, external stubs.
- Edges: `calls` (numbered in order), `contains`, `uses-type`, `extends`, `implements`, `imports`.
- Also handles JSX components (`<Button />` counts as a call), `memo` / `forwardRef` components and CommonJS `exports.x` / `module.exports = {...}`.
- Unresolved calls become external stubs and are never guessed.
- A syntax error keeps the last good version of that file and shows a warning.
- Files over 1 MB are skipped with a warning.

### Live updates
- Chokidar watcher with a 150 ms debounce that follows `.gitignore`.
- Sends `graph.diff` with added, removed and changed symbols; changed cards get a badge that fades after 10 seconds and are re-summarized.
- After a server restart the page reconnects and reloads the graph without a manual refresh.

### LLM
- Streaming Ollama client, one job at a time, Explain flow and chat ahead of background summaries, 60-second timeout with a retry button on the card.
- Summaries are cached in `<project>/.xtree/cache.json` by `sha256(source + model + prompt version)`, so unchanged code is never explained twice.
- Explain flow: the parser fixes the step order; the model writes the text. Without a model the steps are built from the call graph.
- Chat: pinned symbols plus their neighbours, capped at about 6k tokens, with clickable symbol chips in answers.
- If Ollama is down or the model is missing, the graph still works and the status bar shows how to fix it.

### Frontend
- React UI connected to the live API and WebSocket: file tree, graph view, UML view, streamed summaries, Explain flow panel, chat panel, status bar, parse-error banner.
- Falls back to mock data when no server is running (for example with `bun dev` inside `web/`).

### Demo project
`examples/shop-app` is about 150 lines of interconnected TypeScript with one class, an `implements` relationship, private members, an enum and an ordered call chain starting at `AddToCart.ts`.

## Verification

- **56 server tests pass** across 6 files: analyzer, CLI routing and guards, config, scanner, LLM queue and prompts, HTTP and WebSocket integration, and regression tests from the audit.
- Both workspaces typecheck, and `bun run build` succeeds.
- Headless-browser run with a mock Ollama: graph, UML view, streamed summaries, cache on reload, changed badge, Explain flow, chat chips, switching entry files, and recovery after a server restart.
- Packed tarball run through `bunx --package`: serves the UI and the graph.
- Real Qwen run on `shop-app`:
  - 23 of 23 summaries in about 30 seconds
  - Explain flow returned 9 steps in 7.3 seconds, all with model-written text
  - Chat answered "What happens if stock runs out?" correctly in 1.1 seconds

## Backend audit

Bugs found and fixed:

| Problem | Fix |
|---|---|
| A failed summary job could never retry, so summaries were lost if Ollama restarted | The error handler now runs after the job is no longer "running" |
| A 2 MB bundle took 7 s and produced 60,000 nodes | Files over 1 MB are skipped with a warning; an oversized entry returns 413 |
| The watcher followed gitignored folders (11,006 entries in a test) | It uses the `.gitignore` rules (1,503 entries in the same test) |
| Live updates stopped for good if the entry file was briefly missing | A missing file is retried on the next change |
| The browser-open command was mangled on Windows | Now uses `rundll32 url.dll,FileProtocolHandler` and was verified |
| `xtree.config.json` in a cloned repo could point Ollama at a remote host | Remote hosts there are ignored; use `--ollama` or `OLLAMA_HOST` |
| The WebSocket trusted `localhost:5173` in production | Trusted only when `XTREE_DEV=1` |
| A symlinked entry file could escape the project | The real path must stay inside the project |
| Analyzer caches grew without limit | Pruned above 1,500 entries |
| React components had no edges; `memo` and CommonJS exports were missed | Added to the analyzer |
| The UI did not reload after a server restart | It reloads the file tree and graph on reconnect |

## Differences from `specs.md` (intentional)

- Default model is `qwen2.5-coder:3b` instead of 7b, because the GPU is too small for 7b.
- Runtime is Bun (`bunx xtree`), the server uses `Bun.serve` instead of Express and `ws`, and everything runs on one port.
- The model writes Explain flow text only; the parser decides the steps.
- Extra additions: radial graph view, onboarding tour, file-size cap, project check with `--force`, `POST /api/summarize` for the Retry button.

## Known gaps

1. **Clean clone does not start.** `server/dist` and `web/dist` are gitignored, so `bun run start examples/shop-app` fails until `bun run build` has been run. There is also no `README.md`.
2. **Layout is not stable on edits.** The UML view re-runs the whole layout when symbols or edges change, so cards move and manual drags are lost (spec F5 asks for stable positions).
3. **`imports` edges are not drawn.** The server sends them, but the UI drops edges whose ends are files.
4. **UML layout direction** is bottom-up, while the spec says left-to-right.
5. Parse errors show as a banner, not a badge on the file in the tree.
6. The pin button is on the selection card, not on every card.
7. The 3b model often writes summaries longer than 20 words; they are capped at 28 words.
8. Not yet tested: switching Wi-Fi off, the 5,000-file cap on a very large repo, and summary quality on real projects.
9. Methods inside plain object literals and calls through variables are not extracted.
10. `specs.md` is out of date (still mentions `npx`, Express, ports 5173 and 4317, Qwen 7b, an 8 GB GPU) and its submission disclosures need updating.

## How to run

```bash
bun install
bun run build
bun bin/xtree.js start examples/shop-app      # opens http://localhost:4317
```

For development with hot reload:

```bash
bun run dev      # API on 4317 plus UI on 5173; open http://127.0.0.1:5173
```

Other commands:

```bash
bun run test        # 56 server tests
bun run typecheck
ollama pull qwen2.5-coder:3b   # one-time, if the model is missing
```

## Next steps

1. Make a clean clone start (build step in `start`) and add a short `README.md`.
2. Keep card positions stable during live edits.
3. Draw `imports` edges, or remove them from the spec.
4. Update `specs.md` and the submission disclosures.
5. Run the offline test with Wi-Fi off, and try XTree on a real project.
