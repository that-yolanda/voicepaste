/** Left-side status indicator: a green dot while recording (with ripple), an
 * arc spinner while connecting/finishing, or a red dot on error. Visibility is
 * driven by the parent stage's data-state / data-level attributes (see
 * overlay.css), so this component is pure structure. */
export function Indicator() {
  return (
    <span className="indicator" aria-hidden="true">
      <span className="ind-dot"></span>
      <svg className="ind-spinner" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle className="track" cx="8" cy="8" r="6.5"></circle>
        <circle className="arc" cx="8" cy="8" r="6.5"></circle>
      </svg>
    </span>
  );
}
