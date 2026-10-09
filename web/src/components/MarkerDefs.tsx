// Shared SVG markers for both canvases (dot arrows and UML heads).
export function MarkerDefs() {
  return (
    <svg className="marker-defs" width="0" height="0" aria-hidden="true">
      <defs>
        <marker
          id="xt-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M0 1 L10 5 L0 9 z" fill="#6b6b6b" />
        </marker>
        <marker
          id="xt-arrow-hot"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="9"
          markerHeight="9"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M0 1 L10 5 L0 9 z" fill="#d6d6d6" />
        </marker>
        <marker
          id="xt-uml-arrow"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="10"
          markerHeight="10"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M0 1 L10 5 L0 9 z" fill="#9aa4ae" />
        </marker>
        <marker
          id="xt-uml-arrow-hot"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="11"
          markerHeight="11"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M0 1 L10 5 L0 9 z" fill="#b9a9e8" />
        </marker>
        <marker
          id="xt-uml-open"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="10"
          markerHeight="10"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M1 1 L9 5 L1 9" fill="none" stroke="#7d8893" strokeWidth="1.4" />
        </marker>
        <marker
          id="xt-uml-open-hot"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="11"
          markerHeight="11"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M1 1 L9 5 L1 9" fill="none" stroke="#b9a9e8" strokeWidth="1.6" />
        </marker>
        <marker
          id="xt-uml-tri"
          viewBox="0 0 12 12"
          refX="11"
          refY="6"
          markerWidth="13"
          markerHeight="13"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M1 1 L11 6 L1 11 z" fill="#1e1e1e" stroke="#9aa4ae" strokeWidth="1.3" />
        </marker>
        <marker
          id="xt-uml-tri-hot"
          viewBox="0 0 12 12"
          refX="11"
          refY="6"
          markerWidth="14"
          markerHeight="14"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M1 1 L11 6 L1 11 z" fill="#1e1e1e" stroke="#b9a9e8" strokeWidth="1.5" />
        </marker>
      </defs>
    </svg>
  );
}
