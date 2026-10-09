import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo, type ReactNode, useState } from "react";
import { visMark } from "../../lib/util";
import { useStore } from "../../store";
import type { CodeSymbol, UmlDirection } from "../../types";
import { Code } from "../Code";
import { ChevronDown, ChevronRight } from "../icons";

export interface UmlData {
  symbol: CodeSymbol;
  members: CodeSymbol[];
  /** True for the entry card pinned at the bottom of the tree. */
  entry?: boolean;
  [key: string]: unknown;
}

function useCardState(id: string) {
  const selected = useStore((s) => s.selectedId === id);
  const flow = useStore((s) => s.highlightId === id);
  const changed = useStore((s) => !!s.changed[id]);
  return { selected, flow, changed };
}

function cardClass(base: string, st: { selected: boolean; flow: boolean; changed: boolean }) {
  return [base, st.selected && "is-selected", st.flow && "is-flow", st.changed && "is-changed"]
    .filter(Boolean)
    .join(" ");
}

export function SummaryLine({ id }: { id: string }) {
  const text = useStore((s) => s.summaries[id]);
  const done = useStore((s) => s.summaryDone[id]);
  const up = useStore((s) => s.ollamaUp);
  const error = useStore((s) => s.summaryError[id]);
  const retry = useStore((s) => s.retrySummary);
  if (error && !done) {
    return (
      <div className="summary is-muted is-error">
        Summary failed: {error}{" "}
        <button
          className="link-btn nodrag"
          onClick={(e) => {
            e.stopPropagation();
            retry(id);
          }}
        >
          Retry
        </button>
      </div>
    );
  }
  if (!up && !done) return <div className="summary is-muted">Local model unavailable</div>;
  if (!text) return <div className="summary is-muted shimmer">Waiting for local model…</div>;
  return (
    <div className="summary">
      {text}
      {!done && <span className="caret" />}
    </div>
  );
}

function ChangedBadge({ id }: { id: string }) {
  const changed = useStore((s) => !!s.changed[id]);
  return changed ? <span className="badge-changed">changed</span> : null;
}

function SourceToggle({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="source">
      <button
        className="source-toggle nodrag"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
      >
        {open ? <ChevronDown /> : <ChevronRight />} source
      </button>
      {open && (
        <div className="nodrag nowheel">
          <Code code={code} />
        </div>
      )}
    </div>
  );
}

const HANDLE_POS: Record<UmlDirection, { source: Position; target: Position }> = {
  UP: { source: Position.Top, target: Position.Bottom },
  DOWN: { source: Position.Bottom, target: Position.Top },
};

function Handles() {
  const dir = useStore((s) => s.umlDirection);
  return (
    <>
      <Handle type="target" position={HANDLE_POS[dir].target} isConnectable={false} />
      <Handle type="source" position={HANDLE_POS[dir].source} isConnectable={false} />
    </>
  );
}

function FunctionNodeImpl({ id, data }: NodeProps) {
  const { symbol, entry } = data as UmlData;
  const st = useCardState(id);
  return (
    <div className={cardClass("card card-fn" + (entry ? " is-entry" : ""), st)}>
      <Handles />
      <div className="card-head">
        {entry && <span className="badge-entry">entry</span>}
        <span className="glyph">ƒ</span>
        <span className="sig">{symbol.signature}</span>
        <ChangedBadge id={id} />
      </div>
      <SummaryLine id={id} />
      <SourceToggle code={symbol.source} />
    </div>
  );
}
export const FunctionNode = memo(FunctionNodeImpl);

function MemberRow({ m }: { m: CodeSymbol }) {
  const [open, setOpen] = useState(false);
  const selected = useStore((s) => s.selectedId === m.id);
  const flow = useStore((s) => s.highlightId === m.id);
  const select = useStore((s) => s.select);
  return (
    <div
      className={["row-method", selected && "is-selected", flow && "is-flow"]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        className="row-btn nodrag"
        onClick={(e) => {
          e.stopPropagation();
          select(m.id);
          setOpen((v) => !v);
        }}
        aria-expanded={open}
      >
        <span className="vis">{visMark[m.visibility ?? "public"]}</span>
        <span className="row-sig">{m.signature}</span>
        <ChangedBadge id={m.id} />
      </button>
      {open && (
        <div className="row-body nodrag nowheel">
          <SummaryLine id={m.id} />
          <Code code={m.source} />
        </div>
      )}
    </div>
  );
}

function ClassNodeImpl({ id, data }: NodeProps) {
  const { symbol, members, entry } = data as UmlData;
  const st = useCardState(id);
  return (
    <div className={cardClass("card card-class" + (entry ? " is-entry" : ""), st)}>
      <Handles />
      <div className="uml-head">
        <span className="stereo">«class»</span>
        {entry && <span className="badge-entry">entry</span>}
        <span className="uml-name">{symbol.name}</span>
        <ChangedBadge id={id} />
      </div>
      <SummaryLine id={id} />
      <div className="compartment">
        {(symbol.fields ?? []).map((f) => (
          <div className="row-field" key={f.name}>
            <span className="vis">{visMark[f.visibility]}</span>
            <span>
              {f.name}: <span className="ftype">{f.type}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="compartment">
        {members.map((m) => (
          <MemberRow key={m.id} m={m} />
        ))}
      </div>
    </div>
  );
}
export const ClassNode = memo(ClassNodeImpl);

function TypeNodeImpl({ id, data }: NodeProps) {
  const { symbol } = data as UmlData;
  const st = useCardState(id);
  const isAlias = symbol.kind === "type" || symbol.kind === "enum";
  return (
    <div className={cardClass("card card-type", st)}>
      <Handles />
      <div className="uml-head">
        <span className="stereo">«{symbol.kind}»</span>
        <span className="uml-name">{symbol.name}</span>
      </div>
      <div className="compartment">
        {(symbol.fields ?? []).map((f) => (
          <div className="row-field" key={f.name}>
            {isAlias ? (
              <span className="alias">| {f.name}</span>
            ) : (
              <>
                <span className="vis">{visMark[f.visibility]}</span>
                <span>
                  {f.name}: <span className="ftype">{f.type}</span>
                </span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
export const TypeNode = memo(TypeNodeImpl);

function ExternalNodeImpl({ data }: NodeProps): ReactNode {
  const { symbol } = data as UmlData;
  return (
    <div className="card-ext" title="Unresolved call (library or dynamic dispatch)">
      <Handles />
      {symbol.name}
    </div>
  );
}
export const ExternalNode = memo(ExternalNodeImpl);

export interface BandLabelData {
  label: string;
  [key: string]: unknown;
}

// Faint, non-interactive caption above a layout band.
function BandLabelNodeImpl({ data }: NodeProps): ReactNode {
  return <div className="uml-band-label">{(data as BandLabelData).label}</div>;
}
export const BandLabelNode = memo(BandLabelNodeImpl);