import { motion } from "motion/react";
import { tourSteps } from "../lib/tour";
import { isCallable } from "../lib/util";
import { useStore } from "../store";
import {
  BoltIcon,
  CloseIcon,
  FilesIcon,
  FlowIcon,
  GraphIcon,
  HelpIcon,
  SidebarIcon,
  SparkIcon,
  UmlIcon,
} from "./icons";

export function IconRail() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const toggleFiles = useStore((s) => s.toggleFileSidebar);
  const filesOpen = useStore((s) => s.fileSidebarOpen);
  const flowOpen = useStore((s) => s.flowOpen);
  const setFlowOpen = useStore((s) => s.setFlowOpen);
  const startFlowFor = useStore((s) => s.startFlowFor);
  const simulateEdit = useStore((s) => s.simulateEdit);
  const startTour = useStore((s) => s.startTour);
  const mock = useStore((s) => s.mode === "mock");
  const chatOpen = useStore((s) => s.chatOpen);
  const setChatOpen = useStore((s) => s.setChatOpen);
  const helpPulse = useStore((s) => s.tourOpen && s.tourStep === tourSteps.length - 1);

  const flow = () => {
    if (flowOpen) return setFlowOpen(false);
    const { selectedId, graph, entry } = useStore.getState();
    const sel = graph.symbols.find((x) => x.id === selectedId);
    const fallback = graph.symbols.find((x) => x.file === entry && isCallable(x.kind));
    startFlowFor((sel && isCallable(sel.kind) ? sel : fallback)?.id ?? "");
  };

  const Btn = ({
    label,
    active,
    onClick,
    tour,
    children,
  }: {
    label: string;
    active?: boolean;
    onClick: () => void;
    tour?: string;
    children: React.ReactNode;
  }) => (
    <button
      className={"rail-btn" + (active ? " is-active" : "")}
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      data-tour={tour}
    >
      {children}
    </button>
  );

  return (
    <nav className="icon-rail" aria-label="Main" data-tour="rail">
      <Btn label="Toggle file tree" active={filesOpen} onClick={toggleFiles}>
        <SidebarIcon />
      </Btn>
      <div className="rail-group">
        <Btn label="Files" active={filesOpen} onClick={toggleFiles}>
          <FilesIcon />
        </Btn>
        <Btn label="Graph view" active={view === "graph"} onClick={() => setView("graph")}>
          <GraphIcon />
        </Btn>
        <Btn label="UML view" active={view === "uml"} onClick={() => setView("uml")} tour="uml">
          <UmlIcon />
        </Btn>
        <Btn label="Explain flow" active={flowOpen} onClick={flow}>
          <FlowIcon />
        </Btn>
        <Btn label="Ask about this code" active={chatOpen} onClick={() => setChatOpen(!chatOpen)}>
          <SparkIcon />
        </Btn>
      </div>
      <div className="rail-spacer" />
      {mock && (
        <Btn label="Simulate a file edit (mock)" onClick={simulateEdit}>
          <BoltIcon />
        </Btn>
      )}
      {/* Replay onboarding. Pulses once (spring) when the tour reaches its last step. */}
      <button
        className="rail-btn"
        onClick={startTour}
        aria-label="Show tour"
        title="Show tour"
        data-tour="help"
      >
        {/* inner wrapper so Motion's inline transform doesn't override the CSS :active press */}
        <motion.span
          className="rail-icon"
          animate={helpPulse ? { scale: [1, 1.22, 1] } : { scale: 1 }}
          transition={helpPulse ? { duration: 0.5, ease: "easeOut", delay: 0.3 } : { duration: 0 }}
        >
          <HelpIcon />
        </motion.span>
      </button>
    </nav>
  );
}

export function TabBar() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);

  const Tab = ({
    id,
    label,
    icon,
  }: {
    id: "graph" | "uml";
    label: string;
    icon: React.ReactNode;
  }) => (
    <button
      role="tab"
      aria-selected={view === id}
      className={"tab" + (view === id ? " is-active" : "")}
      onClick={() => setView(id)}
    >
      {icon}
      <span>{label}</span>
      {view === id && (
        <span className="tab-close" aria-hidden="true">
          <CloseIcon />
        </span>
      )}
    </button>
  );

  return (
    <div className="tab-bar" role="tablist">
      <Tab id="graph" label="Graph view" icon={<GraphIcon />} />
      <Tab id="uml" label="UML view" icon={<UmlIcon />} />
    </div>
  );
}

export function CanvasToolbar() {
  const entry = useStore((s) => s.entry);
  const mock = useStore((s) => s.mode === "mock");
  const loading = useStore((s) => s.graphLoading);
  const simulateEdit = useStore((s) => s.simulateEdit);
  const replay = useStore((s) => s.startSummaries);
  return (
    <div className="canvas-toolbar">
      <span className="crumb" title="Entry file">
        {entry || "No entry file"}
      </span>
      {loading && <span className="muted toolbar-note">analyzing…</span>}
      {mock && <span className="muted toolbar-note">mock data (no XTree server)</span>}
      <span className="toolbar-spacer" />
      {mock && (
        <>
          <button className="btn btn-ghost" onClick={replay}>
            Replay summaries
          </button>
          <button className="btn btn-ghost" onClick={simulateEdit}>
            Simulate edit
          </button>
        </>
      )}
    </div>
  );
}
