import { AnimatePresence, motion } from "motion/react";
import type { KeyboardEvent } from "react";
import { useVisible } from "../hooks";
import { EASE_ENTER, enterT, exitT, fadeScale } from "../lib/motion";
import { qualified } from "../lib/util";
import { useStore } from "../store";
import type { DisplaySettings, UmlDirection } from "../types";
import { ChevronDown, ChevronRight, CloseIcon, GearIcon, ResetIcon, SearchIcon } from "./icons";

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={"switch" + (checked ? " is-on" : "")}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-knob" />
      </button>
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="slider-row">
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Section({
  title,
  open,
  onToggle,
  actions,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel-section">
      <header>
        <button className="section-title" onClick={onToggle} aria-expanded={open}>
          {open ? <ChevronDown /> : <ChevronRight />}
          <span>{title}</span>
        </button>
        {actions}
      </header>
      {/* Height 0 <-> auto is the one sanctioned layout tween (Motion measures auto). */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            className="section-collapse"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: { duration: 0.2, ease: EASE_ENTER } }}
            exit={{ height: 0, opacity: 0, transition: exitT }}
          >
            <div className="section-body">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

const DIRECTIONS: { value: UmlDirection; label: string }[] = [
  { value: "UP", label: "↑ Entry at bottom" },
  { value: "DOWN", label: "↓ Entry at top" },
];

function DirectionControl() {
  const value = useStore((s) => s.umlDirection);
  const setValue = useStore((s) => s.setUmlDirection);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const i = DIRECTIONS.findIndex((d) => d.value === value);
    const next = DIRECTIONS[(i + step + DIRECTIONS.length) % DIRECTIONS.length];
    setValue(next.value);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-dir="${next.value}"]`)?.focus();
  };
  return (
    <div className="seg" role="radiogroup" aria-label="Layout direction" onKeyDown={onKey}>
      {DIRECTIONS.map((d) => {
        const on = d.value === value;
        return (
          <button
            key={d.value}
            data-dir={d.value}
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={"seg-btn" + (on ? " is-on" : "")}
            onClick={() => setValue(d.value)}
          >
            {on && (
              <motion.span
                layoutId="uml-dir-pill"
                className="seg-pill"
                transition={{ duration: 0.2, ease: EASE_ENTER }}
              />
            )}
            <span className="seg-label">{d.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function FloatingPanel() {
  const view = useStore((s) => s.view);
  const open = useStore((s) => s.panelOpen);
  const toggle = useStore((s) => s.togglePanel);
  const sections = useStore((s) => s.sections);
  const toggleSection = useStore((s) => s.toggleSection);
  const display = useStore((s) => s.display);
  const setDisplay = useStore((s) => s.setDisplay);
  const reset = useStore((s) => s.resetDisplay);
  const query = useStore((s) => s.symbolQuery);
  const setQuery = useStore((s) => s.setSymbolQuery);
  const focusNode = useStore((s) => s.focusNode);
  const animate = useStore((s) => s.animate);
  const { symbols } = useVisible();

  const set = (patch: Partial<DisplaySettings>) => setDisplay(patch);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    const q = query.trim().toLowerCase();
    const hit = symbols.find((s) => qualified(s.id).toLowerCase().includes(q));
    if (q && hit) focusNode(hit.id);
  };

  const isGraph = view === "graph";

  // Panel and its gear share the top-right corner; the panel grows out of the gear.
  return (
    <AnimatePresence initial={false}>
      {!open ? (
        <motion.button
          key="reopen"
          className="panel-reopen"
          onClick={toggle}
          aria-label="Open graph settings"
          title="Graph settings"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: enterT }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
        >
          <GearIcon />
        </motion.button>
      ) : (
    <motion.aside
      key="panel"
      className="floating-panel"
      aria-label="Graph settings"
      data-tour="settings"
      variants={fadeScale("top right")}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <Section
        title="Filters"
        open={sections.filters}
        onToggle={() => toggleSection("filters")}
        actions={
          <div className="panel-actions">
            <button onClick={reset} aria-label="Reset settings" title="Reset">
              <ResetIcon />
            </button>
            <button onClick={toggle} aria-label="Close panel" title="Close">
              <CloseIcon />
            </button>
          </div>
        }
      >
        <label className="search-box">
          <SearchIcon />
          <input
            placeholder="Search symbols…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            aria-label="Search symbols"
          />
        </label>
        <Toggle label="Types" checked={display.showTypes} onChange={(v) => set({ showTypes: v })} />
        <Toggle
          label="Externals"
          checked={display.showExternals}
          onChange={(v) => set({ showExternals: v })}
        />
        <Toggle
          label="Orphans"
          checked={display.showOrphans}
          onChange={(v) => set({ showOrphans: v })}
        />
      </Section>

      {!isGraph && (
        <Section title="Layout" open={sections.uml} onToggle={() => toggleSection("uml")}>
          <DirectionControl />
        </Section>
      )}

      {isGraph && (
        <>
          <Section
            title="Display"
            open={sections.display}
            onToggle={() => toggleSection("display")}
          >
            <Toggle
              label="Arrows"
              checked={display.showArrows}
              onChange={(v) => set({ showArrows: v })}
            />
            <Slider
              label="Text fade threshold"
              value={display.textFadeThreshold}
              onChange={(v) => set({ textFadeThreshold: v })}
            />
            <Slider
              label="Node size"
              value={display.nodeSize}
              onChange={(v) => set({ nodeSize: v })}
            />
            <Slider
              label="Link thickness"
              value={display.linkThickness}
              onChange={(v) => set({ linkThickness: v })}
            />
            <button className="btn-animate" onClick={animate}>
              Animate
            </button>
          </Section>

          <Section title="Layout" open={sections.forces} onToggle={() => toggleSection("forces")}>
            <Slider
              label="Center force"
              value={display.centerForce}
              onChange={(v) => set({ centerForce: v })}
            />
            <Slider
              label="Repel force"
              value={display.repelForce}
              onChange={(v) => set({ repelForce: v })}
            />
            <Slider
              label="Link distance"
              value={display.linkDistance}
              onChange={(v) => set({ linkDistance: v })}
            />
          </Section>
        </>
      )}
    </motion.aside>
      )}
    </AnimatePresence>
  );
}
