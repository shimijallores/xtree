import { AnimatePresence, motion } from "motion/react";
import { riseIn } from "../lib/motion";
import { isCallable, qualified } from "../lib/util";
import { useStore } from "../store";
import type { CodeSymbol } from "../types";
import { CloseIcon } from "./icons";
import { SummaryLine } from "./uml/UmlNodes";

// Small info card for the selected symbol (name, kind, signature, streamed summary).
// The card animates only when it appears/disappears; switching selection swaps the
// content in place (stable key) so frequent clicks stay instant.
export function SelectCard() {
  const selectedId = useStore((s) => s.selectedId);
  const sym = useStore((s) => s.graph.symbols.find((x) => x.id === s.selectedId));

  return (
    <AnimatePresence>
      {selectedId && sym && <Card key="select-card" sym={sym} />}
    </AnimatePresence>
  );
}

function Card({ sym }: { sym: CodeSymbol }) {
  const view = useStore((s) => s.view);
  const select = useStore((s) => s.select);
  const openInUml = useStore((s) => s.openInUml);
  const startFlowFor = useStore((s) => s.startFlowFor);
  const pinned = useStore((s) => s.pinned.includes(sym.id));
  const togglePin = useStore((s) => s.togglePin);
  const setChatOpen = useStore((s) => s.setChatOpen);

  return (
    <motion.div
      className="select-card"
      role="region"
      aria-label="Selected symbol"
      data-tour="select-card"
      variants={riseIn}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <div className="select-head">
        <div>
          <div className="select-kind">{sym.kind}</div>
          <div className="select-name">{qualified(sym.id)}</div>
        </div>
        <button className="icon-btn" onClick={() => select(null)} aria-label="Close">
          <CloseIcon />
        </button>
      </div>
      {sym.kind !== "external" && (
        <>
          <div className="select-sig">{sym.signature}</div>
          <div className="select-file">
            {sym.file}:{sym.range.start}-{sym.range.end}
          </div>
          <SummaryLine id={sym.id} />
        </>
      )}
      <div className="select-actions">
        {view === "graph" && sym.kind !== "external" && (
          <button className="btn" onClick={() => openInUml(sym.id)}>
            Open in UML
          </button>
        )}
        {sym.kind !== "external" && (
          <button
            className="btn"
            aria-pressed={pinned}
            title="Pinned symbols (and their neighbours) are the chat's context"
            onClick={() => {
              togglePin(sym.id);
              if (!pinned) setChatOpen(true);
            }}
          >
            {pinned ? "Unpin" : "Pin to chat"}
          </button>
        )}
        {isCallable(sym.kind) && (
          <button className="btn btn-primary" onClick={() => startFlowFor(sym.id)}>
            Explain flow
          </button>
        )}
      </div>
    </motion.div>
  );
}
