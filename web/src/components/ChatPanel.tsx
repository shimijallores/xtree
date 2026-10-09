import { motion } from "motion/react";
import { type FormEvent, Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { slideX } from "../lib/motion";
import { qualified } from "../lib/util";
import { type ChatEntry, useStore } from "../store";
import type { CodeSymbol } from "../types";
import { CloseIcon } from "./icons";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Splits answer text into plain text and symbol chips. A chip is any exact match of a
 * graph symbol's qualified name (Inventory.reserve) or unique short name (reserve).
 */
function useChipper(symbols: CodeSymbol[]) {
  return useMemo(() => {
    const byName = new Map<string, string>();
    const shortCount = new Map<string, number>();
    for (const s of symbols) {
      if (s.kind === "external") continue;
      shortCount.set(s.name, (shortCount.get(s.name) ?? 0) + 1);
    }
    for (const s of symbols) {
      if (s.kind === "external") continue;
      byName.set(qualified(s.id), s.id);
      if (shortCount.get(s.name) === 1 && s.name.length > 3 && !byName.has(s.name)) byName.set(s.name, s.id);
    }
    const names = [...byName.keys()].sort((a, b) => b.length - a.length);
    if (!names.length) return null;
    const re = new RegExp(`(?<![\\w#.])(${names.map(escapeRe).join("|")})(?![\\w])`, "g");
    return { re, byName };
  }, [symbols]);
}

function Chip({ id, label }: { id: string; label: string }) {
  const focusNode = useStore((s) => s.focusNode);
  return (
    <button type="button" className="sym-chip" onClick={() => focusNode(id)} title={`Show ${qualified(id)} on the canvas`}>
      {label}
    </button>
  );
}

function renderWithChips(text: string, chipper: ReturnType<typeof useChipper>): ReactNode {
  // inline code spans first, so `addToCart()` also becomes a chip
  const parts = text.split(/(`[^`\n]+`)/g);
  let offset = 0;
  return parts.map((part) => {
    const at = offset; // character offset: a stable key for this segment
    offset += part.length;
    const code = part.startsWith("`") && part.endsWith("`") && part.length > 2;
    const body = code ? part.slice(1, -1) : part;
    if (!chipper) return code ? <code key={`c${at}`}>{body}</code> : <Fragment key={`t${at}`}>{body}</Fragment>;
    const out: ReactNode[] = [];
    let last = 0;
    chipper.re.lastIndex = 0;
    for (let m = chipper.re.exec(body); m; m = chipper.re.exec(body)) {
      if (m.index > last) out.push(body.slice(last, m.index));
      const id = chipper.byName.get(m[1]);
      out.push(id ? <Chip key={`k${at}-${m.index}`} id={id} label={m[1]} /> : m[1]);
      last = m.index + m[1].length;
    }
    if (last < body.length) out.push(body.slice(last));
    if (code && out.length === 1 && typeof out[0] === "string") return <code key={`c${at}`}>{body}</code>;
    return <Fragment key={`t${at}`}>{out}</Fragment>;
  });
}

function Message({ m, chipper, streaming }: { m: ChatEntry; chipper: ReturnType<typeof useChipper>; streaming: boolean }) {
  const lines = m.content.split("\n");
  return (
    <div className={`chat-msg is-${m.role}${m.error ? " is-error" : ""}`}>
      {m.role === "assistant" && !m.content && streaming ? (
        <span className="muted shimmer">Thinking locally…</span>
      ) : (
        lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of one message never reorder
          <p key={`l${i}`}>{m.role === "assistant" && !m.error ? renderWithChips(line, chipper) : line}</p>
        ))
      )}
      {streaming && m.content && <span className="caret" />}
    </div>
  );
}

export function ChatPanel() {
  const chat = useStore((s) => s.chat);
  const pending = useStore((s) => s.chatPending);
  const pinned = useStore((s) => s.pinned);
  const symbols = useStore((s) => s.graph.symbols);
  const ollamaUp = useStore((s) => s.ollamaUp);
  const model = useStore((s) => s.model);
  const send = useStore((s) => s.sendChat);
  const clear = useStore((s) => s.clearChat);
  const togglePin = useStore((s) => s.togglePin);
  const setOpen = useStore((s) => s.setChatOpen);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const chipper = useChipper(symbols);

  // keep the newest message in view while tokens stream in
  const lastLen = chat[chat.length - 1]?.content.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, lastLen]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || pending) return;
    send(text);
    setText("");
  };

  return (
    <motion.aside
      className="flow-sidebar chat-panel"
      aria-label="Chat"
      variants={slideX(1)}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <header className="side-head">
        <span>Ask about this code</span>
        <span className="chat-head-actions">
          {chat.length > 0 && (
            <button className="btn btn-ghost btn-small" onClick={clear} disabled={!!pending}>
              Clear
            </button>
          )}
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close chat">
            <CloseIcon />
          </button>
        </span>
      </header>

      <div className="chat-context">
        {pinned.length ? (
          <>
            <span className="muted">Context:</span>
            {pinned.map((id) => (
              <span className="pin-chip" key={id}>
                {qualified(id)}
                <button onClick={() => togglePin(id)} aria-label={`Unpin ${qualified(id)}`}>
                  ×
                </button>
              </span>
            ))}
          </>
        ) : (
          <span className="muted">Context: the entry file's flow. Pin cards to focus the answer.</span>
        )}
      </div>

      <div className="chat-list" ref={listRef} aria-live="polite">
        {chat.length === 0 && (
          <div className="chat-empty muted">
            {ollamaUp
              ? "Ask a question, for example “What happens if stock runs out?”"
              : `Chat needs the local model. Start Ollama and run: ollama pull ${model}`}
          </div>
        )}
        {chat.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: chat history is append-only
          <Message key={`m${i}`} m={m} chipper={chipper} streaming={!!m.requestId && m.requestId === pending} />
        ))}
      </div>

      <form className="chat-form" onSubmit={onSubmit}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) onSubmit(e);
          }}
          placeholder={ollamaUp ? "Ask about the pinned code…" : "Local model unavailable"}
          aria-label="Chat message"
          rows={2}
          maxLength={8000}
        />
        <button className="btn btn-primary" type="submit" disabled={!text.trim() || !!pending}>
          Send
        </button>
      </form>
    </motion.aside>
  );
}
