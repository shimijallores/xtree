import type { ReactNode, SVGProps } from "react";

function Svg({ children, ...p }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...p}
    >
      {children}
    </svg>
  );
}

export const SidebarIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Svg>
);
export const FilesIcon = () => (
  <Svg>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Svg>
);
export const GraphIcon = () => (
  <Svg>
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="18" cy="8" r="2.2" />
    <circle cx="12" cy="18" r="2.2" />
    <path d="M7.8 7.2l8.4.4M7 8l4 8M17 10l-4 6" />
  </Svg>
);
export const UmlIcon = () => (
  <Svg>
    <rect x="3" y="4" width="8" height="7" rx="1" />
    <rect x="13" y="13" width="8" height="7" rx="1" />
    <path d="M7 11v3a2 2 0 0 0 2 2h4" />
  </Svg>
);
export const FlowIcon = () => (
  <Svg>
    <path d="M5 4l14 8-14 8z" />
  </Svg>
);
export const SparkIcon = () => (
  <Svg>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
  </Svg>
);
export const SearchIcon = () => (
  <Svg width="16" height="16">
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.2-4.2" />
  </Svg>
);
export const ChevronDown = () => (
  <Svg width="14" height="14">
    <path d="M6 9l6 6 6-6" />
  </Svg>
);
export const ChevronRight = () => (
  <Svg width="14" height="14">
    <path d="M9 6l6 6-6 6" />
  </Svg>
);
export const CloseIcon = () => (
  <Svg width="16" height="16">
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const ResetIcon = () => (
  <Svg width="16" height="16">
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </Svg>
);
export const FolderIcon = () => (
  <Svg width="15" height="15">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);
export const CodeIcon = () => (
  <Svg width="15" height="15">
    <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />
  </Svg>
);
export const LockIcon = () => (
  <Svg width="13" height="13">
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);
export const GearIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
);
export const PrevIcon = () => (
  <Svg width="16" height="16">
    <path d="M15 6l-6 6 6 6" />
  </Svg>
);
export const NextIcon = () => (
  <Svg width="16" height="16">
    <path d="M9 6l6 6-6 6" />
  </Svg>
);
export const BoltIcon = () => (
  <Svg>
    <path d="M13 3L5 14h6l-1 7 8-11h-6z" />
  </Svg>
);
export const HelpIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.2a2.6 2.6 0 0 1 5 .8c0 1.7-2.5 2.3-2.5 3.8" />
    <path d="M12 17.2h.01" />
  </Svg>
);
