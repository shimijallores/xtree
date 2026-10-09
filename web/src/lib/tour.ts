import { useStore } from "../store";
import { isCallable } from "./util";

export const TOUR_KEY = "xtree.tour.v1";

export type Placement = "center" | "right" | "left" | "top" | "bottom";

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** value of a data-tour attribute; omitted = centered */
  target?: string;
  placement: Placement;
  /** puts the UI in the state this step talks about (existing store actions only) */
  prepare?: () => void;
}

const firstCallable = () => {
  const { graph, entry } = useStore.getState();
  return graph.symbols.find((x) => x.file === entry && isCallable(x.kind));
};

export const tourSteps: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to XTree",
    body: "XTree maps your code as a graph so you can see what calls what. This quick tour shows you around. It takes about a minute.",
    placement: "center",
  },
  {
    id: "rail",
    title: "Main toolbar",
    body: "Use these buttons to show files, switch between Graph and UML views, and open Explain flow.",
    target: "rail",
    placement: "right",
  },
  {
    id: "files",
    title: "Pick an entry file",
    body: "Click any file to make it the starting point. The map shows that file and what it reaches.",
    target: "files",
    placement: "right",
    prepare: () => {
      const s = useStore.getState();
      if (!s.fileSidebarOpen) s.toggleFileSidebar();
    },
  },
  {
    id: "canvas",
    title: "Explore the graph",
    body: "Each dot is a function, class or type. Click to select, double-click to open it in UML, and drag to move things around.",
    target: "canvas",
    placement: "center",
    prepare: () => {
      const s = useStore.getState();
      s.setFlowOpen(false);
      s.select(null);
      s.setView("graph");
    },
  },
  {
    id: "select-card",
    title: "Symbol details",
    body: "Selecting something opens this card with its signature, location and a short summary.",
    target: "select-card",
    placement: "top",
    prepare: () => {
      const s = useStore.getState();
      s.setView("graph");
      const sym = firstCallable();
      if (sym) s.select(sym.id);
    },
  },
  {
    id: "flow",
    title: "Explain flow",
    body: "Walk through the code step by step. Use Prev and Next, and the map follows along.",
    target: "flow",
    placement: "left",
    prepare: () => {
      const sym = firstCallable();
      if (sym) useStore.getState().startFlowFor(sym.id);
    },
  },
  {
    id: "uml",
    title: "UML view",
    body: "Switch to UML for detailed cards with fields, methods and source code.",
    target: "uml",
    placement: "right",
    prepare: () => {
      const s = useStore.getState();
      s.setFlowOpen(false);
      s.setView("uml");
    },
  },
  {
    id: "settings",
    title: "Filters and display",
    body: "Search for symbols, hide types or externals, and tune how the graph looks.",
    target: "settings",
    placement: "left",
    prepare: () => {
      const s = useStore.getState();
      s.setView("graph");
      if (!s.panelOpen) s.togglePanel();
    },
  },
  {
    id: "status",
    title: "Summary progress",
    body: "Each symbol gets a short plain-English summary. This counter shows how many are ready out of the total.",
    target: "status",
    placement: "bottom",
  },
  {
    id: "done",
    title: "You're all set",
    body: "Click the ? button anytime to see this tour again.",
    target: "help",
    placement: "right",
    prepare: () => useStore.getState().select(null),
  },
];

export function tourSeen(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) === "done";
  } catch {
    return false;
  }
}
