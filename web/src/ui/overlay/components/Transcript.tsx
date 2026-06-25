import { forwardRef } from "react";

interface TranscriptProps {
  finalText: string;
  partialText: string;
}

/** Final (confirmed) + partial (in-flight) recognition text. The element ref is
 * forwarded so the layout hook can measure single-line overflow when sizing the
 * pill. Auto-scroll is handled by the parent (it owns the same ref). */
export const Transcript = forwardRef<HTMLDivElement, TranscriptProps>(function Transcript(
  { finalText, partialText },
  ref,
) {
  return (
    <div className="transcript" ref={ref}>
      <span className="final-text">{finalText}</span>
      <span className="partial-text">{partialText}</span>
    </div>
  );
});
