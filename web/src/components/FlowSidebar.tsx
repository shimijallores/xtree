import { AnimatePresence, motion, type Variants } from "motion/react";
import { useEffect, useRef } from "react";
import { enterT, exitT, moveT, slideX } from "../lib/motion";
import { qualified } from "../lib/util";
import { useStore } from "../store";
import { CloseIcon, NextIcon, PrevIcon } from "./icons";

// custom = direction (1 forward, -1 back); AnimatePresence passes the latest value to exits.
const countVariants: Variants = {
  initial: (d: number) => ({ opacity: 0, x: d * 6 }),
  animate: { opacity: 1, x: 0, transition: enterT },
  exit: (d: number) => ({ opacity: 0, x: d * -6, transition: exitT }),
};

export function FlowSidebar() {
  const steps = useStore((s) => s.flowSteps);
  const active = useStore((s) => s.flowActive);
  const stepFlow = useStore((s) => s.stepFlow);
  const setOpen = useStore((s) => s.setFlowOpen);
  const symbols = useStore((s) => s.graph.symbols);
  const loading = useStore((s) => s.flowLoading);
  const error = useStore((s) => s.flowError);
  const ollamaUp = useStore((s) => s.ollamaUp);
  const mock = useStore((s) => s.mode === "mock");

  // Direction of the last step change, so the counter slides the matching way.
  const prev = useRef(active);
  const dir = active >= prev.current ? 1 : -1;
  useEffect(() => {
    prev.current = active;
  }, [active]);

  // Steps that point at unknown symbols are dropped (spec F6).
  const known = new Set(symbols.map((s) => s.id));
  const valid = steps.filter((st) => known.has(st.symbolId));

  return (
    <motion.aside
      className="flow-sidebar"
      aria-label="Explain flow"
      data-tour="flow"
      variants={slideX(1)}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <header className="side-head">
        <span>Explain flow</span>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
          <CloseIcon />
        </button>
      </header>

      {(loading || error || (!ollamaUp && !mock && valid.length > 0)) && (
        <div className={"flow-note" + (error ? " is-error" : "")} role="status">
          {error ??
            (loading
              ? "Writing the walkthrough with the local model… steps below come from the parser."
              : "Local model unavailable: steps are built from the call graph only.")}
        </div>
      )}
      {!loading && !error && valid.length === 0 && (
        <div className="flow-note">No calls to walk through from this symbol.</div>
      )}

      <ol className="flow-list">
        {valid.map((st, i) => (
          <li key={st.step}>
            <button
              className={"flow-step" + (i === active ? " is-active" : "")}
              onClick={() => stepFlow(i - active)}
              aria-current={i === active ? "step" : undefined}
            >
              {/* Shared highlight glides to the active step instead of jumping. */}
              {i === active && (
                <motion.span
                  className="flow-step-hl"
                  layoutId="flow-active"
                  transition={moveT}
                  aria-hidden="true"
                />
              )}
              <span className="flow-num">{st.step}</span>
              <span className="flow-body">
                <span className="flow-sym">{qualified(st.symbolId)}</span>
                <span className="flow-text">{st.text}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      <footer className="flow-nav">
        <button className="btn" onClick={() => stepFlow(-1)} disabled={active <= 0}>
          <PrevIcon /> Prev
        </button>
        <span className="flow-count">
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            <motion.span
              key={active}
              className="flow-count-num"
              custom={dir}
              variants={countVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              {active + 1}
            </motion.span>
          </AnimatePresence>{" "}
          / {valid.length}
        </span>
        <button
          className="btn btn-primary"
          onClick={() => stepFlow(1)}
          disabled={active >= valid.length - 1}
        >
          Next <NextIcon />
        </button>
      </footer>
    </motion.aside>
  );
}
