import { motion } from "motion/react";
import { useState } from "react";
import { slideX } from "../lib/motion";
import { useStore } from "../store";
import type { FileNode } from "../types";
import { ChevronDown, ChevronRight, CodeIcon, FolderIcon, SearchIcon } from "./icons";

const SUPPORTED = /\.(js|jsx|ts|tsx)$/;

function matches(node: FileNode, q: string): boolean {
  if (!q) return true;
  if (node.type === "file") return node.name.toLowerCase().includes(q);
  return (node.children ?? []).some((c) => matches(c, q));
}

function Node({ node, depth, q }: { node: FileNode; depth: number; q: string }) {
  const entry = useStore((s) => s.entry);
  const setEntry = useStore((s) => s.setEntry);
  const [open, setOpen] = useState(true);

  if (!matches(node, q)) return null;
  const pad = { paddingLeft: 10 + depth * 14 };

  if (node.type === "dir") {
    return (
      <div>
        <button
          className="tree-row"
          style={pad}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          <FolderIcon />
          <span>{node.name}</span>
        </button>
        {open && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} q={q} />)}
      </div>
    );
  }

  const supported = SUPPORTED.test(node.name);
  return (
    <button
      className={
        "tree-row" + (entry === node.path ? " is-active" : "") + (supported ? "" : " is-disabled")
      }
      style={pad}
      disabled={!supported}
      title={supported ? "Set as entry file" : "Unsupported file type"}
      onClick={() => setEntry(node.path)}
    >
      <span className="tree-gap" />
      <CodeIcon />
      <span>{node.name}</span>
    </button>
  );
}

export function FileTree() {
  const files = useStore((s) => s.files);
  const query = useStore((s) => s.fileQuery);
  const setQuery = useStore((s) => s.setFileQuery);
  const truncated = useStore((s) => s.filesTruncated);
  const maxFiles = useStore((s) => s.maxFiles);
  const q = query.trim().toLowerCase();

  return (
    <motion.aside
      className="file-sidebar"
      aria-label="Files"
      data-tour="files"
      variants={slideX(-1)}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <header className="side-head">
        <span>Files</span>
      </header>
      <label className="search-box side-search">
        <SearchIcon />
        <input
          placeholder="Filter files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter files"
        />
      </label>
      <div className="tree">
        {files.map((f) => (
          <Node key={f.path} node={f} depth={0} q={q} />
        ))}
      </div>
      <footer className="side-foot">
        {truncated ? (
          <span className="hint">
            Showing the first {maxFiles.toLocaleString()} files. Restart with --max-files to see more.
          </span>
        ) : (
          "Click a file to set it as the entry."
        )}
      </footer>
    </motion.aside>
  );
}
