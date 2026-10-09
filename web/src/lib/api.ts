import type { ChatMessage, FileNode, FlowStep, Graph, ServerMessage, StatusInfo } from "../types";

// Same origin in production (the CLI serves this UI); Vite proxies /api and /ws in dev.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (e.g. the Vite dev server answering for a missing backend)
  }
  if (!res.ok || data === null) {
    const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export interface FilesResponse {
  files: FileNode[];
  truncated: boolean;
  fileCount: number;
  maxFiles: number;
  root: string;
}

export const api = {
  files: (signal?: AbortSignal) => request<FilesResponse>("/api/files", undefined, signal),
  status: () => request<StatusInfo>("/api/status"),
  graph: (entry: string, depth?: number) => request<Graph>("/api/graph", { entry, depth }),
  explainFlow: (symbolId: string, entry: string) =>
    request<{ requestId: string; steps: FlowStep[]; llm: boolean }>("/api/explain-flow", { symbolId, entry }),
  chat: (message: string, pinned: string[], history: ChatMessage[], entry: string) =>
    request<{ requestId: string; contextIds: string[] }>("/api/chat", { message, pinned, history, entry }),
  summarize: (symbolIds: string[], entry: string) =>
    request<{ ok: true }>("/api/summarize", { symbolIds, entry }),
};

/**
 * Persistent WebSocket to /ws with exponential-backoff reconnect.
 * Returns a function that closes the socket for good.
 */
export function connectSocket(
  onMessage: (m: ServerMessage) => void,
  onState: (connected: boolean) => void,
): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: number | undefined;

  const open = () => {
    if (closed) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      onState(true);
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(String(e.data)) as ServerMessage);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      onState(false);
      if (closed) return;
      const delay = Math.min(10_000, 500 * 2 ** retry++);
      timer = window.setTimeout(open, delay);
    };
  };
  open();
  return () => {
    closed = true;
    window.clearTimeout(timer);
    ws?.close();
  };
}
