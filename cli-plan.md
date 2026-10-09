# XTree CLI Architecture & Implementation Plan

> **Goal:** Transform XTree into a production-grade CLI devtool runnable via `bunx xtree start [path]` (or the shortcut `bunx xtree [path]`) or the globally linked command `xtree start [path]`, connecting a single-port Bun server, TypeScript Compiler API analyzer, live file watcher, and local Ollama LLM runtime (`qwen2.5-coder:3b`) with the React web visualizer.

---

## 0. Decisions & Conflict Resolution

This plan merges `cli-plan.md` and `specs.md`. Where they disagreed, the decisions below apply.

| Topic | Decision |
|---|---|
| Default model | `qwen2.5-coder:3b` (7b is too heavy for the target GPU). Override with `--model`. |
| Feature scope | **Full**: F1 to F9 from `specs.md`, including `/api/explain-flow`, `/api/chat`, status/offline indicator, the `imports` edge, enums, and external stubs. |
| Runtime & tooling | **Bun only.** Entry is `bunx xtree`. Bun workspaces, a single `bun.lock`, no `package-lock.json`. Requires Bun to be installed. |
| TypeScript versions | `server/` pins an exact stable TypeScript 5.x or 6.x (chosen in the Phase 1 spike) for the Compiler API. `web/` stays on its own version (currently 7.x). Versions must not be hoisted across workspaces. |
| Command forms | Both `xtree start [path]` (canonical) and `xtree [path]` (shortcut). `start` is the default subcommand. |
| Ports | One port (`4317`) in production. `5173` is only for `web` dev, with Vite proxying `/api` and `/ws` to 4317. |
| Wrong-folder protection | Directories that do not look like a project are refused unless `--force`. Scans are capped at 5,000 supported files, raised with `--max-files <n>`. |

### Implementation notes (as built)

- **Server TypeScript is pinned to `6.0.3`.** TypeScript 7.x ships no JS Compiler API (its `main` is only `lib/version.cjs`), so it cannot power the analyzer. `web/` keeps 7.0.2 for its own `tsc`.
- **HTTP + WebSocket use `Bun.serve`, not Express + `ws`.** The runtime is Bun-only, and the Phase 1 spike showed Bun's native server and WebSocket work on Windows. This drops two dependencies. The routes and the protocol are unchanged.
- **Browser launch spawns the OS opener** (`cmd /c start`, `open`, `xdg-open`) instead of the `open` package.
- **Bundling.** The server is bundled into `server/dist/cli.js` with `bun build --target=bun`. The only runtime dependency of the published package is `typescript`.
- **Extra endpoint:** `POST /api/summarize { symbolIds, entry }` re-queues summaries (the card's Retry button).
- **Explain flow.** Static analysis fixes the step order (depth-first over ordered calls); the model only writes the text for each step. Without a model, the steps fall back to parser-generated text, so Explain flow works offline.
- **Phase order.** Phases were built as 1, 2, 3, the static part of 6, then 4, 5 and the rest of 6.

---

## 1. Executive Summary & User Experience

When a developer runs XTree in any project directory:

```bash
# Direct execution on any codebase (Bun required)
cd ~/projects/my-ecommerce-app
bunx xtree start .

# Shortcut: `start` is the default command
bunx xtree .

# Or via locally linked binary (bun link):
xtree start .
```

### The End-to-End Execution Flow:
1. **Target Directory Resolution:** Resolves target path (defaults to current working directory `.` if omitted), checks that it looks like a project, and scans for `.js`, `.jsx`, `.ts`, `.tsx` files while strictly ignoring `node_modules`, `dist`, `.git`, `.next`, etc.
2. **Unified Single-Port Server:** Boots a local HTTP + WebSocket server at `127.0.0.1:4317` (auto-detects port conflicts and increments port if occupied).
3. **Static UI & API Co-Hosting:** The same server serves both the pre-compiled React visualizer SPA (`web/dist`) and the REST + WebSocket APIs. Zero CORS issues, zero dual-server configuration.
4. **Automatic Browser Launch:** Uses the `open` library to pop open `http://localhost:4317` in the user's default browser automatically.
5. **Real Code Rendering:** The left sidebar displays the target project's real directory tree. Clicking any file (e.g. `src/AddToCart.ts`) triggers the TypeScript Compiler API AST analyzer to extract functions, classes, and call relationships, instantly drawing the diagram.
6. **Local LLM Summaries (`qwen2.5-coder:3b`):** Summaries stream directly onto the cards via WebSocket. If Ollama is offline or the model is not yet downloaded, the static graph operates with zero degradation, displaying a helpful terminal and status bar hint.

---

## 2. Model & Runtime Specifications

- **Default LLM Model:** `qwen2.5-coder:3b`
  - **VRAM Footprint:** ~1.9 GB – 2.2 GB (runs easily on laptops, RTX 3050, or integrated GPUs).
  - **Inference Speed:** High token generation rate (~40–80 tokens/sec on modern GPUs), ensuring card summaries appear almost instantly.
  - **Runtime:** Local Ollama instance at `http://127.0.0.1:11434`.
  - **Offline Requirement:** 100% offline once the model is pulled (`ollama pull qwen2.5-coder:3b`). No data leaves the machine.
  - **Fallback:** Fully functional static graph and file navigation even if Ollama is not running.
  - **Larger models:** Optional, via `--model` (for example `qwen2.5-coder:7b` on machines with more VRAM).
- **Process Runtime:** Bun. The CLI is launched with `bunx xtree`. The bin file uses a `bun` shebang so that `bunx` runs it under Bun and not Node.
- **Ollama options:** `keep_alive: "30m"`, `num_ctx: 8192`.

---

## 3. Monorepo & Packaging Structure

```
xtree/
├── package.json              # Root workspace orchestrator + bin definition
├── bun.lock                  # Single lockfile (no package-lock.json)
├── bin/
│   └── xtree.js              # Executable entrypoint (#!/usr/bin/env bun)
├── server/                   # Backend & CLI package
│   ├── package.json          # Pins its own `typescript` 5.x/6.x
│   ├── tsconfig.json
│   └── src/
│       ├── cli.ts            # Commander CLI argument parser, project guards
│       ├── config.ts         # Flags > env vars > xtree.config.json > defaults
│       ├── server.ts         # Express + WS + static web server + Host/Origin checks
│       ├── scanner.ts        # Target folder scanner (file tree generator, file cap)
│       ├── analyzer/         # TypeScript Compiler API AST extractor
│       │   ├── program.ts    # ts.createProgram & AST traversal
│       │   ├── symbols.ts    # Symbol extraction (functions, classes, types, enums)
│       │   └── callGraph.ts  # Call graph & relationship edge resolution
│       ├── watcher.ts        # Chokidar live file watcher & diff engine
│       ├── llm/              # Ollama client, prompt templates, worker queue
│       │   ├── ollama.ts
│       │   ├── prompts.ts    # Summary, flow and chat prompts
│       │   └── queue.ts
│       └── cache.ts          # Content-hash cache (.xtree/cache.json)
├── web/                      # React frontend visualizer
│   ├── package.json
│   ├── dist/                 # Pre-built static assets (HTML, CSS, JS)
│   └── src/
└── examples/
    └── shop-app/             # Built-in demo sample project
```

### Root `package.json`
Dependency versions are pinned exactly. The TypeScript version for the server is chosen in the Phase 1 spike.

```json
{
  "name": "xtree",
  "version": "0.1.0",
  "description": "UML-driven code comprehension engine for Vibe Coders",
  "type": "module",
  "bin": {
    "xtree": "./bin/xtree.js"
  },
  "workspaces": [
    "server",
    "web"
  ],
  "files": [
    "bin",
    "server/dist",
    "web/dist"
  ],
  "scripts": {
    "build:web": "bun run --filter xtree-web build",
    "build:server": "bun run --filter xtree-server build",
    "build": "bun run build:web && bun run build:server",
    "dev:web": "bun run --filter xtree-web dev",
    "dev:server": "bun run --filter xtree-server dev",
    "prepublishOnly": "bun run build"
  }
}
```

### Executable Binary (`bin/xtree.js`)
```javascript
#!/usr/bin/env bun
import "../server/dist/cli.js";
```

> `bunx` respects shebangs: a `node` shebang would make `bunx` run the script under Node when it is installed. The `bun` shebang forces Bun.

---

## 4. CLI Command Specification

### Command Syntax:
```bash
xtree start [path] [options]     # canonical form
xtree [path] [options]           # shortcut, `start` is the default command
```

### Arguments & Flags:
| Argument / Flag | Default | Description |
|---|---|---|
| `[path]` | `.` (`process.cwd()`) | Target project directory to analyze |
| `-p, --port <number>` | `4317` | Preferred HTTP / WebSocket port |
| `-d, --depth <number>` | `2` | Traversal depth for relative imports |
| `-m, --model <name>` | `qwen2.5-coder:3b` | Ollama model to use for summaries and chat |
| `--ollama <url>` | `http://127.0.0.1:11434` | Ollama API host |
| `--no-open` | `false` | Disable automatic browser opening |
| `--force` | `false` | Start even if the directory does not look like a JS/TS project |
| `--max-files <number>` | `5000` | Maximum supported files to scan before stopping with a warning |
| `-h, --help` | — | Display CLI usage help |

### Configuration Precedence
Flags, then env vars (`XTREE_MODEL`, `OLLAMA_HOST`), then `xtree.config.json` in the target directory, then built-in defaults.

### Default Command Rules (`start` + bare `xtree`)
`start` is registered in Commander with `isDefault: true`.
- Arguments starting with `./`, `../`, `/`, or a drive letter (`C:\`) are always treated as paths.
- A folder named like a command (for example `start`) must be written `./start`. The same applies to future commands.
- An unknown word that is not an existing path (for example `xtree strat`) prints: `Path not found: "strat". Did you mean "xtree start"?`
- Flags work in both forms: `xtree --no-open .` and `xtree start --no-open .`.
- `xtree --help` lists `start` as the default command.

### Wrong-Folder Guards
Running XTree in the wrong place (for example the home directory) would trigger a huge scan and watch.
- **Project check:** The target looks like a project if it contains `package.json`, `tsconfig.json` or `jsconfig.json`, or if supported source files exist within the top two directory levels. Otherwise the CLI exits with a message and a hint to pass `--force`.
- **File cap:** The scanner stops at `--max-files` (default 5,000) supported files, logs a terminal warning, and the UI shows "showing first N files". The default is an estimate and is tunable after real-world measurement.

---

## 5. Server & Runtime Architecture

### A. Unified Single-Port Hosting
The Express + WebSocket server binds strictly to `127.0.0.1:<port>` and must never bind to `0.0.0.0`:
- **Static Assets:** Serves `web/dist` directly at `/`, resolved relative to the installed package. Non-API routes fall back to `index.html` (SPA routing).
- **REST Endpoints:**
  - `GET /api/files`: Returns nested file tree of the target project directory.
  - `POST /api/graph`: Body `{ entry: "src/AddToCart.ts", depth: 2 }` -> runs TypeScript Compiler API on target project files and returns `{ entry, symbols, edges }`.
  - `POST /api/explain-flow`: Body `{ symbolId }` -> streams via WS, returns final step-by-step JSON `[{ step, symbolId, text }]`. Unknown `symbolId`s are dropped.
  - `POST /api/chat`: Body `{ message, pinned, history }` -> grounded local LLM chat, streamed via WS.
  - `GET /api/status`: Reports Ollama reachability, active model, and queued summaries.
- **WebSocket Protocol (`/ws`), server to client:**
  - `summary.token`: `{ symbolId, token }` streams summary tokens onto node cards in real-time.
  - `summary.done`: `{ symbolId, summary }` finalizes node summary.
  - `graph.diff`: Pushed when Chokidar detects a file change, carrying `{ added, removed, changed, edges }` so the UI animates the update live.
  - `flow.token` / `chat.token`: `{ requestId, token }`.
  - `flow.done`: `{ requestId, steps }` and `chat.done`: `{ requestId, text }`.
  - `status`: `{ ollama, model, queued }`.

### B. Security (local-only service, no authentication)
The server has **no authentication** because it is local-only. That makes these controls mandatory:
- Bind to `127.0.0.1` only.
- Reject any HTTP or WebSocket request whose `Host` or `Origin` header is not `localhost` or `127.0.0.1` with the active port. This blocks DNS-rebinding and cross-site WebSocket attacks from web pages.
- Resolve every `entry` path against the target root and reject traversal (`..`, absolute paths outside the root). Never read files outside the root.
- Do not send source code anywhere except the configured Ollama host. Warn in the terminal if `--ollama` points to a non-loopback host.

### C. Error Handling
- **Ollama down or model missing:** Graph works, cards show "Local model unavailable", the status bar and terminal show `ollama pull qwen2.5-coder:3b`.
- **Parse errors:** The file gets a warning badge, and the last good graph for that file is kept.
- **LLM timeout (60 s):** The job is marked failed, with a retry button on the card.
- **Very large graph (> 150 nodes):** Method bodies collapse by default and a warning is shown.
- **Port busy:** Increment the port until a free one is found, and print the final URL.

---

## 6. Core Engine Components

### 1. Target File Scanner (`server/src/scanner.ts`)
- Recursively traverses the target project directory.
- Filters for supported extensions: `.js`, `.jsx`, `.ts`, `.tsx`.
- Ignores directories: `node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, `coverage`.
- Respects `.gitignore` if present in the target directory.
- Enforces the `--max-files` cap.
- Emits forward-slash relative paths so symbol ids are stable on Windows.
- Builds a hierarchical `FileNode[]` tree consumed by `web/src/components/FileTree.tsx`.

### 2. Static AST Analyzer (`server/src/analyzer/`)
- Powered by the `typescript` package pinned in `server/` (`ts.createProgram` / AST visitor).
- Resolves module imports starting from the selected entry file up to the configured depth (default 2).
- Extracts `CodeSymbol` records:
  - Functions (declarations, exported const arrow functions).
  - Classes (fields, constructors, methods with visibility: `public`, `private`, `protected`, `#private`).
  - Interfaces, type aliases and enums.
  - External stubs for calls that cannot be resolved (library calls, dynamic dispatch). These are never guessed.
- Extracts `CodeEdge` records:
  - `calls`: Resolved function/method calls with ordered sequence index (`order: 1, 2, ...`).
  - `contains`: Class membership for methods/fields.
  - `uses-type`: Referenced types in parameters/returns.
  - `extends` / `implements`: Object-oriented inheritance.
  - `imports`: File-level dependency from import statements.
- Computes SHA-256 hash of each symbol's source text for deterministic caching.
- Symbol id format: `${relPath}#${qualifiedName}`, for example `src/cart.ts#Inventory.reserve`.

### 3. Live File Watcher (`server/src/watcher.ts`)
- Uses `chokidar` to monitor the target directory.
- Debounces file modification events (~150ms).
- Re-analyzes affected files and diffs new symbol set against previous graph:
  - Identifies `added`, `removed`, and `changed` symbols.
- Emits `graph.diff` over WebSocket, triggering the UI highlight badge (fades after 10 s) and queued re-summary.
- Fallback if chokidar misbehaves under Bun on Windows: Node `fs.watch` with manual recursion.

### 4. Local LLM Service & Cache (`server/src/llm/` & `server/src/cache.ts`)
- Target model: `qwen2.5-coder:3b`.
- Connection to Ollama HTTP API (`/api/chat` with `stream: true`).
- **System prompt:** "You explain code to a developer. Only describe what the given code does. If information is missing, say so. Never invent functions or calls."
- **Prompts:**
  - *Summary:* signature, source, callers and callees in; one sentence of at most 20 words out, no code (`temperature: 0.2`, `num_predict: 60`).
  - *Flow:* ordered call subgraph sources in; strict JSON steps out (`format: "json"`).
  - *Chat:* pinned nodes plus neighbors with parser facts (callers, callees, types), capped at about 6k tokens, trimming the farthest neighbors first.
- **Worker Queue:** Concurrency 1 to prevent GPU memory spikes or contention. Background summaries run breadth-first from the entry file.
- **Priority Queue:** Interactive user requests (Explain Flow, Chat) take priority over background card summaries.
- **Persistent Disk Cache:** Stored in `<target-folder>/.xtree/cache.json`, keyed by `sha256(source + model + promptVersion)`.
- If a symbol's code hasn't changed, its summary loads from cache instantly without invoking Ollama.

---

## 7. Frontend Integration (`web/`)

- Update `web/src/store.ts` and add `web/src/lib/api.ts` to connect to real endpoints:
  - `fetch('/api/files')` on initial load.
  - `fetch('/api/graph', { method: 'POST', body: JSON.stringify({ entry, depth }) })` when a file is selected.
  - Persistent WebSocket connection to `ws://${window.location.host}/ws`.
- Status bar shows the model name, Ollama connection state, summary queue progress and a "Running 100% locally" badge.
- Flow walkthrough and chat panels, with symbol names in answers rendered as clickable chips that pan to the node.
- Retain mock fixtures as an offline fallback when developing the UI in isolation (`bun dev` at port 5173). Vite proxies `/api` and `/ws` to `127.0.0.1:4317` during dev.

---

## 8. Step-by-Step Implementation Roadmap

| Phase | Milestone | Deliverables |
@

---

## 9. Acceptance Criteria

1. `bunx xtree start examples/shop-app` opens the UI with no errors, and so does `bunx xtree examples/shop-app`.
2. Running in a folder that is not a project refuses to start unless `--force` is passed.
3. A folder above the file cap logs a warning and the UI shows the partial-tree notice, until `--max-files` is raised.
4. Selecting `AddToCart.ts` renders all symbols to depth 2 within 2 s, with correct `calls`, `contains`, `uses-type`, `implements` and `imports` edges.
5. Summaries stream onto cards, and a reload serves them from cache instantly.
6. Editing `calculateOrderTotal` and saving updates only that card (badge plus new summary) within 5 s, plus model time.
7. Explain flow highlights existing nodes only, and chat answers include clickable symbol chips.
8. With the network disabled, items 4 to 7 still work.
9. The server listens on `127.0.0.1` only and rejects foreign `Host`/`Origin` headers and path traversal.
10. Without Ollama running, the static graph works and the UI and terminal show the `ollama pull qwen2.5-coder:3b` hint.

---

## 10. Open Risks

- ~~TS Compiler API / chokidar / WebSocket under Bun on Windows~~: verified in the Phase 1 spike and by the test suite.
- ~~Commander `isDefault` with optional `[path]`~~: covered by `server/test/cli.test.ts`.
- Not yet measured: the 5,000-file cap, and `qwen2.5-coder:3b` summary quality against a real Ollama (the test suite uses a mock Ollama server).

## 10b. Known Limitations (after the backend audit)

- **Object-literal methods** (`const api = { get() {} }`) and **class-style prototype assignments** are not extracted as symbols. Top-level functions, classes, `memo`/`forwardRef`-wrapped components, and CommonJS `exports.x` / `module.exports = {…}` are.
- **Calls through variables or dynamic dispatch** (`obj[key]()`, callbacks passed around) are omitted, never guessed.
- **Analysis is synchronous.** A very large first analysis (about 1 to 3 seconds for thousands of files) blocks the server briefly.
- **Files over 1 MB** (bundles, generated code) are skipped with a visible warning; an oversized entry file is rejected with HTTP 413.
- **The 5,000-file cap** and the 3b model's summary length (it often exceeds the 20-word hint) are untuned.
- **`XTREE_DEV=1`** is required for the Vite dev server (port 5173) to talk to the API and WebSocket; `bun run dev:server` sets it.
- **`xtree.config.json` cannot point Ollama at a remote host** (a cloned repo could otherwise exfiltrate your source). Use `--ollama` or `OLLAMA_HOST`.

## 11. Development

```bash
bun install                 # one bun.lock at the root
bun run build               # web/dist + server/dist
bun run test                # server tests (analyzer, CLI, scanner, LLM queue/prompts, HTTP/WS integration)
bun run typecheck
bun bin/xtree.js start examples/shop-app   # run the built CLI
bun run dev:server          # API on 4317 with --watch (no browser)
bun run dev:web             # UI on 5173, proxies /api and /ws to 4317; falls back to mock data without a server
bun link                    # then `xtree start <folder>` anywhere
```
