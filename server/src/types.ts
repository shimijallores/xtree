// Shared data model (specs.md section 7). Mirrored in web/src/types.ts.

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "external";
export type EdgeKind = "calls" | "contains" | "uses-type" | "extends" | "implements" | "imports";
export type Visibility = "public" | "private" | "protected";

export interface SymbolField {
  name: string;
  type: string;
  visibility: Visibility;
}

export interface CodeSymbol {
  id: string; // `${relPath}#${qualifiedName}`
  kind: SymbolKind;
  name: string;
  file: string;
  range: { start: number; end: number };
  signature: string;
  source: string;
  hash: string;
  parentId?: string;
  visibility?: Visibility;
  fields?: SymbolField[];
  summary?: string;
  changed?: boolean;
}

export interface CodeEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  order?: number;
}

export interface Graph {
  entry: string;
  symbols: CodeSymbol[];
  edges: CodeEdge[];
  /** Files that failed to parse; the last good symbols for them are kept. */
  errors?: { file: string; message: string }[];
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileNode[];
}

export interface FlowStep {
  step: number;
  symbolId: string;
  text: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StatusInfo {
  ollama: boolean;
  model: string;
  modelInstalled: boolean;
  queued: number;
  done: number;
  total: number;
  root: string;
  truncated: boolean;
  fileCount: number;
  maxFiles: number;
}

/** Server -> client WebSocket messages. */
export type ServerMessage =
  | { type: "summary.token"; symbolId: string; token: string }
  | { type: "summary.done"; symbolId: string; summary: string; cached: boolean }
  | { type: "summary.error"; symbolId: string; error: string }
  | {
      type: "graph.diff";
      entry: string;
      added: CodeSymbol[];
      removed: string[];
      changed: CodeSymbol[];
      edges: CodeEdge[];
      errors: { file: string; message: string }[];
    }
  | { type: "files"; files: FileNode[] }
  | { type: "flow.token" | "chat.token"; requestId: string; token: string }
  | { type: "flow.done"; requestId: string; steps: FlowStep[] }
  | { type: "chat.done"; requestId: string; text: string }
  | { type: "flow.error" | "chat.error"; requestId: string; error: string }
  | ({ type: "status" } & StatusInfo);
