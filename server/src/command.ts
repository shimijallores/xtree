import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { type CliFlags, ConfigError, isLoopbackUrl, resolveConfig } from "./config";
import { canonicalRoot } from "./paths";
import { looksLikeProject } from "./scanner";
import { startServer } from "./server";
import { Session } from "./session";
import { watchProject } from "./watcher";

export const VERSION = "0.1.0";
const COMMANDS = ["start", "help"];

/** Levenshtein distance, for "did you mean" hints. */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

export class CliError extends Error {}

/** Validates the target directory and returns its canonical path. */
export function resolveTarget(rawPath: string | undefined, cwd: string, force: boolean): string {
  const input = rawPath ?? ".";
  const abs = resolve(cwd, input);
  if (!existsSync(abs)) {
    const pathLike = /^(\.{1,2}[\\/]|[\\/]|[a-zA-Z]:)/.test(input) || /[\\/]/.test(input);
    const close = pathLike ? undefined : COMMANDS.find((c) => distance(input.toLowerCase(), c) <= 2);
    throw new CliError(close ? `Path not found: "${input}". Did you mean "xtree ${close}"?` : `Path not found: "${input}"`);
  }
  if (!statSync(abs).isDirectory()) throw new CliError(`Not a directory: "${input}"`);
  const root = canonicalRoot(abs);
  if (!force && !looksLikeProject(root)) {
    throw new CliError(
      `"${root}" doesn't look like a JS/TS project (no package.json, tsconfig.json, jsconfig.json or source files in the top two levels).\n` +
        "       Pass --force to start anyway.",
    );
  }
  return root;
}

/** OS command that opens a URL in the default browser (no shell, so no quoting pitfalls). */
export function browserCommand(url: string, platform: string = process.platform): string[] {
  if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler", url];
  if (platform === "darwin") return ["open", url];
  return ["xdg-open", url];
}

function openBrowser(url: string) {
  try {
    const p = Bun.spawn(browserCommand(url), { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    p.unref();
  } catch {
    console.log(`  Open ${url} in your browser.`);
  }
}

async function start(rawPath: string | undefined, flags: CliFlags) {
  const root = resolveTarget(rawPath, process.cwd(), flags.force === true);
  const config = resolveConfig(root, flags);
  const session = new Session(config);

  if (!isLoopbackUrl(config.ollama)) {
    console.warn(`  ! Ollama host ${config.ollama} is not on this machine: source code will be sent there.`);
  }

  const srv = startServer(session, config.port);
  const info = session.files();
  console.log("");
  console.log(`  XTree ${VERSION}`);
  console.log(`  > Local:   ${srv.url}${srv.port !== config.port ? `  (port ${config.port} was busy)` : ""}`);
  console.log(`  > Project: ${root}`);
  console.log(`  > Files:   ${info.fileCount} supported file(s)`);
  if (info.truncated) {
    console.warn(`  ! Stopped scanning at ${config.maxFiles} files. Use --max-files <n> to raise the limit.`);
  }
  console.log(`  > Model:   ${config.model} via ${config.ollama}`);

  const watcher = watchProject(root, (batch) => session.applyChanges(batch));

  await session.llm.start();
  if (!session.llm.reachable) {
    console.log(`  ! Ollama is not running. The graph works without it; for summaries start Ollama and run: ollama pull ${config.model}`);
  } else if (!session.llm.modelInstalled) {
    console.log(`  ! Model not installed. Run: ollama pull ${config.model}`);
  } else {
    console.log("  ✓ Ollama connected, running 100% locally");
  }
  console.log("  Press Ctrl+C to stop.\n");

  if (config.open) openBrowser(srv.url);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    session.close();
    srv.stop();
    await watcher.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export type StartAction = (path: string | undefined, flags: CliFlags) => Promise<void>;

/** `start` is the default command, so `xtree [path]` and `xtree start [path]` are the same. */
export function buildProgram(action: StartAction = start): Command {
  const program = new Command();
  program
    .name("xtree")
    .description("UML-driven code comprehension for JS/TS projects, explained by a local LLM.")
    .version(VERSION, "-v, --version")
    .showSuggestionAfterError(true);

  program
    .command("start", { isDefault: true })
    .description("analyze a project and open the visualizer (default command)")
    .argument("[path]", "project directory to analyze (default: current directory)")
    .option("-p, --port <number>", "preferred HTTP / WebSocket port (default: 4317)")
    .option("-d, --depth <number>", "import traversal depth (default: 2)")
    .option("-m, --model <name>", "Ollama model (default: qwen2.5-coder:3b)")
    .option("--ollama <url>", "Ollama API host (default: http://127.0.0.1:11434)")
    .option("--no-open", "don't open the browser")
    .option("--force", "start even if the folder doesn't look like a JS/TS project")
    .option("--max-files <number>", "maximum supported files to scan (default: 5000)")
    .addHelpText(
      "after",
      "\nExamples:\n  xtree start .\n  xtree ./my-app --no-open\n  xtree start ./start    a folder named like a command needs ./",
    )
    .action(async (path: string | undefined, opts: CliFlags) => action(path, opts));

  return program;
}

export async function main(argv = process.argv, action?: StartAction) {
  const program = buildProgram(action);
  program.exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) process.exit(err.exitCode);
    if (err instanceof CliError || err instanceof ConfigError) {
      console.error(`xtree: ${err.message}`);
      process.exit(1);
    }
    console.error("xtree: failed to start:", err);
    process.exit(1);
  }
}
