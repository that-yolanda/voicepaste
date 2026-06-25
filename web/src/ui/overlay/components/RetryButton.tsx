import { retryLabel } from "../overlayText";

interface RetryButtonProps {
  hotkey: string;
  disabled: boolean;
  onClick: () => void;
}

/** Retry affordance, shown only in the failed (error + retryable) state. The
 * countdown ring / spin are driven by the parent stage's data-retry and
 * data-retrying attributes; this component owns only the label + click. */
export function RetryButton({ hotkey, disabled, onClick }: RetryButtonProps) {
  return (
    <button
      className="retry-button"
      type="button"
      aria-label="重试转写"
      disabled={disabled}
      onClick={onClick}
    >
      <svg className="retry-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20 12a8 8 0 1 1-2.34-5.66"></path>
        <path d="M20 4v6h-6"></path>
      </svg>
      <span className="retry-label">{retryLabel(hotkey)}</span>
    </button>
  );
}
