import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DUR, EASE_ENTER, EASE_MOVE, exitT } from "../lib/motion";
import { type Placement, tourSteps } from "../lib/tour";
import { useStore } from "../store";

// Spotlight onboarding tour. Purely presentational: it reads the step list, calls each
// step's prepare() (existing store actions) and highlights the matching [data-tour] node.

const PAD = 6; // cutout padding around the target
const GAP = 12; // distance between cutout and popover
const MARGIN = 12; // keep popover this far from the viewport edge
const POP_W = 320;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const cutoutT = { duration: DUR.cutout, ease: EASE_MOVE };

function measure(target?: string): Rect | null {
  if (!target) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
}

/** Place the popover beside the cutout, flipping to the opposite side when it won't fit. */
function place(rect: Rect | null, placement: Placement, popH: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(POP_W, vw - MARGIN * 2);
  let x: number;
  let y: number;
  let side: Placement = placement;

  if (!rect || placement === "center") {
    const box = rect ?? { x: 0, y: 0, w: vw, h: vh };
    x = box.x + (box.w - w) / 2;
    y = box.y + (box.h - popH) / 2;
    side = "center";
  } else {
    const fits = {
      right: rect.x + rect.w + GAP + w <= vw - MARGIN,
      left: rect.x - GAP - w >= MARGIN,
      bottom: rect.y + rect.h + GAP + popH <= vh - MARGIN,
      top: rect.y - GAP - popH >= MARGIN,
    };
    const opposite = { right: "left", left: "right", top: "bottom", bottom: "top" } as const;
    if (!fits[placement]) {
      const alt = opposite[placement];
      side = fits[alt] ? alt : "center";
    }
    if (side === "right" || side === "left") {
      x = side === "right" ? rect.x + rect.w + GAP : rect.x - GAP - w;
      y = rect.y + rect.h / 2 - popH / 2;
    } else if (side === "top" || side === "bottom") {
      x = rect.x + rect.w / 2 - w / 2;
      y = side === "bottom" ? rect.y + rect.h + GAP : rect.y - GAP - popH;
    } else {
      x = rect.x + (rect.w - w) / 2;
      y = rect.y + (rect.h - popH) / 2;
    }
  }
  x = Math.max(MARGIN, Math.min(x, vw - w - MARGIN));
  y = Math.max(MARGIN, Math.min(y, vh - popH - MARGIN));
  return { x, y, w, side };
}

// Popover grows from the side facing the target.
const originFor: Record<Placement, string> = {
  right: "left center",
  left: "right center",
  top: "bottom center",
  bottom: "top center",
  center: "center",
};

export function Tour() {
  const open = useStore((s) => s.tourOpen);
  return createPortal(<AnimatePresence>{open && <TourOverlay key="tour" />}</AnimatePresence>, document.body);
}

function TourOverlay() {
  const stepIdx = useStore((s) => s.tourStep);
  const nextTour = useStore((s) => s.nextTour);
  const prevTour = useStore((s) => s.prevTour);
  const endTour = useStore((s) => s.endTour);

  const step = tourSteps[stepIdx];
  const total = tourSteps.length;
  const isLast = stepIdx === total - 1;

  const [rect, setRect] = useState<Rect | null>(null);
  const [ready, setReady] = useState(false);
  const [popH, setPopH] = useState(180);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const popRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();

  const next = useCallback(() => (isLast ? endTour() : nextTour(total)), [isLast, endTour, nextTour, total]);

  // Remember what had focus so we can hand it back when the tour closes.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => {
      if (prev && document.contains(prev)) prev.focus();
    };
  }, []);

  // Run the step's prepare(), then measure once panels have mounted and settled.
  // Measured twice: after layout (2 rAFs) and after entrance motion finishes, since
  // transforms mid-animation shift getBoundingClientRect.
  useEffect(() => {
    step.prepare?.();
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setRect(measure(step.target));
        setReady(true);
      });
    });
    const settle = window.setTimeout(() => setRect(measure(step.target)), 320);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(settle);
    };
  }, [step]);

  // Keep the cutout glued to the target on resize / target size changes.
  useEffect(() => {
    const update = () => {
      setVp({ w: window.innerWidth, h: window.innerHeight });
      setRect(measure(step.target));
    };
    window.addEventListener("resize", update);
    const el = step.target ? document.querySelector(`[data-tour="${step.target}"]`) : null;
    const ro = el ? new ResizeObserver(update) : null;
    if (el && ro) ro.observe(el);
    return () => {
      window.removeEventListener("resize", update);
      ro?.disconnect();
    };
  }, [step, ready]);

  // Popover height drives placement; re-read after each text swap.
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPopH(el.offsetHeight));
    ro.observe(el);
    setPopH(el.offsetHeight);
    return () => ro.disconnect();
  }, [ready]);

  // Move focus into the dialog's primary button on each step.
  useEffect(() => {
    if (!ready) return;
    popRef.current?.querySelector<HTMLButtonElement>("[data-primary]")?.focus({ preventScroll: true });
  }, [ready, stepIdx]);

  // Keyboard: ←/→ to navigate, Esc to skip, Tab trapped inside the popover.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        endTour();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prevTour();
      } else if (e.key === "Tab") {
        const nodes = popRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)");
        if (!nodes?.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const inside = popRef.current?.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [next, prevTour, endTour]);

  const pos = place(rect, step.placement, popH);
  // No target: collapse the cutout to a point in the middle so the whole screen dims.
  const hole = rect ?? { x: vp.w / 2, y: vp.h / 2, w: 0, h: 0 };

  return (
    <motion.div
      className="tour-root"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 0.2, ease: EASE_ENTER } }}
      exit={{ opacity: 0, transition: exitT }}
    >
      {/* Dim layer with a rounded cutout. It also swallows clicks so the UI can't be
          changed mid-step; the highlighted area is view-only. */}
      <svg className="tour-mask" width={vp.w} height={vp.h} aria-hidden="true">
        <defs>
          <mask id="tour-cutout">
            <rect width="100%" height="100%" fill="white" />
            <motion.rect
              rx={8}
              fill="black"
              initial={false}
              animate={{ x: hole.x, y: hole.y, width: hole.w, height: hole.h }}
              transition={cutoutT}
            />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(10,10,12,0.62)" mask="url(#tour-cutout)" />
        <motion.rect
          className="tour-ring"
          rx={8}
          fill="none"
          initial={false}
          animate={{
            x: hole.x,
            y: hole.y,
            width: hole.w,
            height: hole.h,
            opacity: rect ? 1 : 0,
          }}
          transition={cutoutT}
        />
      </svg>

      {ready && (
        <motion.div
          ref={popRef}
          className="tour-pop"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          style={{ width: pos.w, transformOrigin: originFor[pos.side] }}
          initial={{ opacity: 0, scale: 0.96, x: pos.x, y: pos.y }}
          animate={{ opacity: 1, scale: 1, x: pos.x, y: pos.y }}
          transition={{
            opacity: { duration: DUR.enter, ease: EASE_ENTER },
            scale: { duration: DUR.enter, ease: EASE_ENTER },
            x: cutoutT,
            y: cutoutT,
          }}
        >
          <div className="tour-meta" aria-live="polite">
            Step {stepIdx + 1} of {total}
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step.id}
              initial={{ opacity: 0, filter: "blur(2px)" }}
              animate={{ opacity: 1, filter: "blur(0px)", transition: { duration: 0.16, ease: EASE_ENTER } }}
              exit={{ opacity: 0, filter: "blur(2px)", transition: { duration: 0.1 } }}
            >
              <h2 id={titleId} className="tour-title">
                {step.title}
              </h2>
              <p id={bodyId} className="tour-body" aria-live="polite">
                {step.body}
              </p>
            </motion.div>
          </AnimatePresence>

          <div className="tour-dots" aria-hidden="true">
            {tourSteps.map((s, i) => (
              <span key={s.id} className={"tour-dot" + (i === stepIdx ? " is-active" : "")} />
            ))}
          </div>

          <div className="tour-actions">
            {!isLast && (
              <button className="btn btn-ghost" onClick={endTour}>
                Skip
              </button>
            )}
            <span className="toolbar-spacer" />
            <button className="btn" onClick={prevTour} disabled={stepIdx === 0}>
              Back
            </button>
            <button className="btn btn-primary" onClick={next} data-primary>
              {isLast ? "Finish" : stepIdx === 0 ? "Start tour" : "Next"}
            </button>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}
