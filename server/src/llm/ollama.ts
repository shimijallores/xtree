export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMsg[];
  temperature?: number;
  numPredict?: number;
  format?: "json";
  signal?: AbortSignal;
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "model-missing" | "bad-response" | "aborted",
  ) {
    super(message);
  }
}

export interface OllamaHealth {
  reachable: boolean;
  modelInstalled: boolean;
}

/** Minimal Ollama HTTP client: streaming /api/chat and /api/tags health checks. */
export class OllamaClient {
  constructor(
    readonly host: string,
    readonly model: string,
  ) {}

  async health(timeoutMs = 2000): Promise<OllamaHealth> {
    try {
      const res = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { reachable: false, modelInstalled: false };
      const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
      const want = normalizeModel(this.model);
      const installed = (body.models ?? []).some(
        (m) => normalizeModel(m.name ?? "") === want || normalizeModel(m.model ?? "") === want,
      );
      return { reachable: true, modelInstalled: installed };
    } catch {
      return { reachable: false, modelInstalled: false };
    }
  }

  /** Streams a chat completion, calling onToken per chunk. Resolves with the full text. */
  async chat(req: ChatRequest, onToken?: (t: string) => void): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: req.signal,
        body: JSON.stringify({
          model: this.model,
          messages: req.messages,
          stream: true,
          keep_alive: "30m",
          ...(req.format ? { format: req.format } : {}),
          options: {
            num_ctx: 8192,
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            ...(req.numPredict !== undefined ? { num_predict: req.numPredict } : {}),
          },
        }),
      });
    } catch (err) {
      if (req.signal?.aborted) throw new OllamaError("Request aborted", "aborted");
      throw new OllamaError(`Ollama unreachable at ${this.host}: ${(err as Error).message}`, "unreachable");
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      if (res.status === 404 || /not found/i.test(text)) {
        throw new OllamaError(`Model "${this.model}" is not installed. Run: ollama pull ${this.model}`, "model-missing");
      }
      throw new OllamaError(`Ollama returned ${res.status}: ${text.slice(0, 200)}`, "bad-response");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let msg: { message?: { content?: string }; error?: string; done?: boolean };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.error) throw new OllamaError(msg.error, "bad-response");
      const t = msg.message?.content ?? "";
      if (t) {
        full += t;
        onToken?.(t);
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          handleLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
      }
      handleLine(buf + decoder.decode());
    } catch (err) {
      if (err instanceof OllamaError) throw err;
      if (req.signal?.aborted) throw new OllamaError("Request aborted", "aborted");
      throw new OllamaError(`Stream failed: ${(err as Error).message}`, "bad-response");
    }
    return full;
  }
}

/** "qwen2.5-coder" and "qwen2.5-coder:latest" are the same model. */
export function normalizeModel(name: string): string {
  const n = name.trim().toLowerCase();
  return n.includes(":") ? n : `${n}:latest`;
}
