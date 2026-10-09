import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { AnalyzeError } from "./analyzer";
import { LlmUnavailableError } from "./llm/service";
import { safeRelative } from "./paths";
import type { Session } from "./session";
import type { ChatMessage } from "./types";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/**
 * Vite dev server (proxies /api and /ws here). Only trusted when XTREE_DEV=1, so in normal
 * use another app on localhost:5173 can't open the WebSocket and read your code.
 */
const DEV_PORTS = new Set(process.env.XTREE_DEV === "1" ? [5173] : []);
const MAX_BODY = 256 * 1024;

export interface StartedServer {
  server: Server<unknown>;
  port: number;
  url: string;
  stop: () => void;
}

/** Locates the built web UI (web/dist) relative to this module, in dev and when packaged. */
export function findWebDist(): string | null {
  const here = import.meta.dir;
  for (const candidate of [resolve(here, "../../web/dist"), resolve(here, "../web/dist")]) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

function hostAllowed(host: string | null, port: number): boolean {
  if (!host) return false;
  const m = host.toLowerCase().match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return false;
  const [, name, p] = m;
  return LOOPBACK_HOSTS.has(name) && (p === undefined ? port === 80 : Number(p) === port);
}

function originAllowed(origin: string | null, port: number): boolean {
  if (origin === null) return true; // same-origin navigations and non-browser clients
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:") return false;
    const host = u.hostname === "::1" ? "[::1]" : u.hostname;
    const p = Number(u.port || 80);
    return LOOPBACK_HOSTS.has(host) && (p === port || DEV_PORTS.has(p));
  } catch {
    return false;
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const error = (message: string, status: number) => json({ error: message }, status);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  // Requiring JSON forces a CORS preflight for any cross-origin POST.
  if (!type.toLowerCase().startsWith("application/json")) throw new HttpError("Expected application/json", 415);
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) throw new HttpError("Request body too large", 413);
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError("Request body too large", 413);
  try {
    const body = JSON.parse(text || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError("Invalid JSON body", 400);
  }
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

function serveStatic(dist: string | null, pathname: string): Response {
  if (!dist) {
    return new Response(
      "<!doctype html><title>XTree</title><body style='font-family:system-ui;background:#1e1e1e;color:#ddd;padding:2rem'>" +
        "<h1>XTree UI is not built</h1><p>Run <code>bun run build</code> in the XTree repo, then restart.</p>",
      { status: 503, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } },
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (decoded.includes("\0")) return new Response("Bad request", { status: 400 });
  const target = normalize(join(dist, decoded));
  const inside = target === dist || target.startsWith(dist.endsWith(sep) ? dist : dist + sep);
  if (inside && existsSync(target) && statSync(target).isFile()) {
    const immutable = decoded.startsWith("/assets/");
    return new Response(Bun.file(target), {
      headers: {
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        ...SECURITY_HEADERS,
      },
    });
  }
  // SPA fallback: unknown non-file routes get index.html
  if (/\.[a-z0-9]+$/i.test(decoded)) return new Response("Not found", { status: 404 });
  return new Response(Bun.file(join(dist, "index.html")), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...SECURITY_HEADERS },
  });
}

function parseHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (m): m is ChatMessage =>
        !!m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    )
    .slice(-20);
}

const strings = (raw: unknown, max = 50) =>
  Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, max) : [];

async function handleApi(req: Request, url: URL, session: Session): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case "GET /api/files":
      return json(session.files());
    case "GET /api/status":
      return json(session.status());
    case "POST /api/graph": {
      const body = await readJson(req);
      const entry = safeRelative(body.entry);
      if (!entry) return error("Invalid entry path", 400);
      let depth = session.config.depth;
      if (body.depth !== undefined) {
        const d = Number(body.depth);
        if (!Number.isInteger(d) || d < 0 || d > 10) return error("depth must be an integer from 0 to 10", 400);
        depth = d;
      }
      return json(session.graph(entry, depth));
    }
    case "POST /api/explain-flow": {
      const body = await readJson(req);
      if (typeof body.symbolId !== "string") return error("symbolId is required", 400);
      const entry = typeof body.entry === "string" ? body.entry : undefined;
      const graph = session.graphFor(entry, body.symbolId);
      if (!graph) return error("Unknown symbol; load its graph first", 404);
      const sym = graph.symbols.find((s) => s.id === body.symbolId);
      if (!sym || (sym.kind !== "function" && sym.kind !== "method")) {
        return error("Explain flow needs a function or method", 400);
      }
      return json(session.llm.explainFlow(graph, body.symbolId));
    }
    case "POST /api/chat": {
      const body = await readJson(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) return error("message is required", 400);
      if (message.length > 8000) return error("message is too long", 413);
      const entry = typeof body.entry === "string" ? body.entry : undefined;
      const graph = session.graphFor(entry);
      if (!graph) return error("Open a file first", 409);
      try {
        return json(session.llm.chat(graph, strings(body.pinned), parseHistory(body.history), message));
      } catch (err) {
        if (err instanceof LlmUnavailableError) return error(err.message, 503);
        throw err;
      }
    }
    case "POST /api/summarize": {
      const body = await readJson(req);
      const entry = typeof body.entry === "string" ? body.entry : undefined;
      const ids = strings(body.symbolIds, 200);
      const graph = session.graphFor(entry, ids[0]);
      if (!graph) return error("Unknown symbol", 404);
      session.llm.retry(graph, ids);
      return json({ ok: true });
    }
  }
  return error("Not found", 404);
}

/** Starts the HTTP + WebSocket server on 127.0.0.1, moving to the next free port if taken. */
export function startServer(session: Session, preferredPort: number, attempts = 20): StartedServer {
  const dist = findWebDist();
  const sockets = new Set<ServerWebSocket<unknown>>();
  const unsubscribe = session.subscribe((m) => {
    const payload = JSON.stringify(m);
    for (const ws of sockets) ws.send(payload);
  });

  let lastErr: unknown;
  for (let port = preferredPort; port < preferredPort + attempts && port <= 65535; port++) {
    try {
      const server = Bun.serve({
        hostname: "127.0.0.1", // never 0.0.0.0: the API has no authentication
        port,
        reusePort: false,
        idleTimeout: 120,
        async fetch(req, srv) {
          const url = new URL(req.url);
          const host = req.headers.get("host");
          const origin = req.headers.get("origin");
          // DNS-rebinding and cross-site protection
          if (!hostAllowed(host, srv.port ?? port) || !originAllowed(origin, srv.port ?? port)) {
            return new Response("Forbidden", { status: 403 });
          }
          if (url.pathname === "/ws") {
            if (srv.upgrade(req)) return undefined;
            return new Response("WebSocket upgrade required", { status: 426 });
          }
          if (url.pathname.startsWith("/api/")) {
            try {
              return await handleApi(req, url, session);
            } catch (err) {
              if (err instanceof HttpError || err instanceof AnalyzeError) return error(err.message, err.status);
              console.error("xtree: request failed:", err);
              return error("Internal error", 500);
            }
          }
          if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
          return serveStatic(dist, url.pathname);
        },
        websocket: {
          open(ws) {
            sockets.add(ws);
            ws.send(JSON.stringify({ type: "status", ...session.status() }));
          },
          close(ws) {
            sockets.delete(ws);
          },
          message() {
            // the protocol is server -> client only
          },
        },
      });
      const actual = server.port ?? port;
      return {
        server,
        port: actual,
        url: `http://localhost:${actual}`,
        stop: () => {
          unsubscribe();
          server.stop(true);
        },
      };
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string }).code;
      const msg = String((err as Error).message ?? "");
      if (code !== "EADDRINUSE" && !/in use|EADDRINUSE/i.test(msg)) break;
    }
  }
  unsubscribe();
  throw new Error(`Could not start server near port ${preferredPort}: ${(lastErr as Error)?.message ?? lastErr}`);
}
