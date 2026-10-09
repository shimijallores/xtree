import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect } from "react";
import { CanvasState } from "./components/CanvasState";
import { ChatPanel } from "./components/ChatPanel";
import { CanvasToolbar, IconRail, TabBar } from "./components/Chrome";
import { FileTree } from "./components/FileTree";
import { FloatingPanel } from "./components/FloatingPanel";
import { FlowSidebar } from "./components/FlowSidebar";
import { GraphCanvas } from "./components/graph/GraphCanvas";
import { SelectCard } from "./components/SelectCard";
import { StatusBar } from "./components/StatusBar";
import { Tour } from "./components/Tour";
import { UmlCanvas } from "./components/uml/UmlCanvas";
import { crossfade } from "./lib/motion";
import { tourSeen } from "./lib/tour";
import { useStore } from "./store";

export default function App() {
  const view = useStore((s) => s.view);
  const entry = useStore((s) => s.entry);
  const filesOpen = useStore((s) => s.fileSidebarOpen);
  const flowOpen = useStore((s) => s.flowOpen);
  const chatOpen = useStore((s) => s.chatOpen);
  const startSummaries = useStore((s) => s.startSummaries);
  const startTour = useStore((s) => s.startTour);
  const init = useStore((s) => s.init);
  const mode = useStore((s) => s.mode);

  // Connect to the XTree server (or fall back to fixtures when there is none).
  useEffect(() => {
    void init();
  }, [init]);

  // Mock mode only: simulate streamed summaries whenever the entry file changes.
  useEffect(() => {
    if (mode === "mock") startSummaries();
  }, [entry, mode, startSummaries]);

  // Opening Explain flow hides the Filters panel so the flow has room (gear reopens it).
  useEffect(() => {
    if (!flowOpen) return;
    const s = useStore.getState();
    if (s.panelOpen) s.togglePanel();
  }, [flowOpen]);

  // First visit only: start onboarding once the canvas has had time to paint.
  useEffect(() => {
    if (tourSeen()) return;
    const t = window.setTimeout(startTour, 600);
    return () => window.clearTimeout(t);
  }, [startTour]);

  return (
    // reducedMotion="user": Motion drops transform travel when the OS asks for reduced motion.
    <MotionConfig reducedMotion="user">
      <div className="app">
        <IconRail />
        <div className="main">
          <StatusBar />
          <TabBar />
          <CanvasToolbar />
          <div className="body">
            <AnimatePresence initial={false}>
              {filesOpen && <FileTree key="files" />}
            </AnimatePresence>
            <div className="canvas-wrap" data-tour="canvas">
              {/* Both canvases fill the wrapper absolutely, so they overlap during the crossfade. */}
              <AnimatePresence initial={false} mode="popLayout">
                <motion.div
                  key={view}
                  className="view-layer"
                  variants={crossfade}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                >
                  {view === "graph" ? <GraphCanvas /> : <UmlCanvas />}
                </motion.div>
              </AnimatePresence>
              <CanvasState />
              <FloatingPanel />
              <SelectCard />
            </div>
            <AnimatePresence initial={false}>
              {flowOpen && <FlowSidebar key="flow" />}
              {chatOpen && !flowOpen && <ChatPanel key="chat" />}
            </AnimatePresence>
          </div>
        </div>
      </div>
      <Tour />
    </MotionConfig>
  );
}
